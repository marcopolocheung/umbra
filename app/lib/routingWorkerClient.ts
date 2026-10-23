/**
 * Main-thread side of the routing worker (L3c, #263): runs `paretoRoutes` (and
 * H3's `sunReach`) in `app/workers/routing.worker.ts` so a 1–3 s search no
 * longer freezes the map and the timeline.
 *
 * Same function on a faithfully rebuilt graph, so the routes are the ones the
 * main thread would have found. The main thread only pays one O(E) pack; the
 * graph is not kept in the worker, because its shadow factors and virtual snap
 * nodes change every calculation.
 *
 * Whenever the worker cannot answer — no `Worker` (node, tests, SSR),
 * construction throws, the worker errors, or it reports an error — the search
 * runs synchronously here instead, with the same result as before L3c.
 */

import { type DijkstraOptions, paretoRoutes, type RouteResult, type RoutingGraph } from "./routing";
import { type PackedRoutingGraph, packRoutingGraphInSteps, transferList } from "./routingGraphCodec";
import {
  type ParetoCommand,
  type ReachCommand,
  ROUTING_WORKER_PROTOCOL_VERSION,
  type RoutingWorkerEvent,
} from "./routingWorkerProtocol";
import { type SunReachOptions, type SunReachResult, sunReach } from "./sunReach";

/** One in-flight search; `T` is what its command answers with. */
interface Pending<T = unknown> {
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
  runHere: () => T;
}

let worker: Worker | null = null;
/** Set once a worker fails before ever answering: the chunk can't load here, so stop retrying. */
let disabled = false;
let answered = false;
let nextRequestId = 1;
const pending = new Map<number, Pending<any>>();
let warned = false;

function warnOnce(reason: string, detail?: unknown) {
  if (warned || !import.meta.env.DEV) return;
  warned = true;
  console.warn(`[routing] worker unavailable (${reason}); searching on the main thread`, detail ?? "");
}

function settleHere<T>(p: Pending<T>) {
  try {
    p.resolve(p.runHere());
  } catch (e) {
    p.reject(e);
  }
}

/** Terminate the worker; the next request starts a fresh one. Returns what was in flight. */
function dropWorker(): Pending<any>[] {
  worker?.terminate();
  worker = null;
  const inFlight = [...pending.values()];
  pending.clear();
  return inFlight;
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (disabled || typeof Worker === "undefined") return null;
  try {
    const w = new Worker(new URL("../workers/routing.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<RoutingWorkerEvent>) => {
      const p = pending.get(event.data.requestId);
      if (!p) return;
      pending.delete(event.data.requestId);
      answered = true;
      if (event.data.type === "pareto") p.resolve(event.data.routes);
      else if (event.data.type === "reach") p.resolve(event.data.result);
      else {
        warnOnce("worker error event", event.data.error);
        settleHere(p);
      }
    };
    const fail = (event: Event) => {
      warnOnce(event.type, event);
      if (!answered) disabled = true;
      for (const p of dropWorker()) settleHere(p);
    };
    w.onerror = fail;
    w.onmessageerror = fail;
    worker = w;
    return w;
  } catch (e) {
    warnOnce("construction threw", e);
    return null;
  }
}

/** Longest main-thread slice of the pack before yielding to the browser. */
const PACK_SLICE_MS = 25;

const abortError = () => new DOMException("Aborted", "AbortError");

/** Pack in slices of at most ~PACK_SLICE_MS, so the pack is no long task either. */
async function packInSlices(graph: RoutingGraph, signal?: AbortSignal): Promise<PackedRoutingGraph> {
  const steps = packRoutingGraphInSteps(graph);
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - sliceStart < PACK_SLICE_MS) continue;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Superseded: stop packing a graph nobody will search.
    if (signal?.aborted) throw abortError();
    sliceStart = performance.now();
  }
}

type Command = Omit<ParetoCommand, "requestId" | "graph"> | Omit<ReachCommand, "requestId" | "graph">;

/**
 * Run `command` in the worker when it can be, else `runHere` on this thread.
 * `signal` aborting terminates the worker — a running synchronous search
 * cannot be interrupted any other way — and rejects with an `AbortError`.
 * `onPacked` fires after the main-thread pack, before the post.
 */
function search<T>(
  graph: RoutingGraph,
  command: Command,
  runHere: () => T,
  { signal, onPacked }: { signal?: AbortSignal; onPacked?: () => void },
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const w = getWorker();
  if (!w) return new Promise((resolve, reject) => settleHere({ resolve, reject, runHere }));

  return packInSlices(graph, signal).then((packed) => {
    onPacked?.();
    if (signal?.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      // The worker may have failed while the pack was in progress.
      const target = getWorker();
      if (!target) return settleHere({ resolve, reject, runHere });
      const requestId = nextRequestId++;
      const onAbort = () => {
        if (!pending.delete(requestId)) return;
        for (const p of dropWorker()) settleHere(p);
        reject(abortError());
      };
      const done = () => signal?.removeEventListener("abort", onAbort);
      pending.set(requestId, {
        resolve: (result: T) => {
          done();
          resolve(result);
        },
        reject: (error: unknown) => {
          done();
          reject(error);
        },
        runHere,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      target.postMessage({ ...command, requestId, graph: packed }, transferList(packed));
    });
  });
}

/** `paretoRoutes(graph, startId, endId, options)`, off the main thread when it can be. */
export function searchParetoRoutes(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  options: DijkstraOptions,
  opts: { signal?: AbortSignal; onPacked?: () => void } = {},
): Promise<RouteResult[]> {
  return search(
    graph,
    { type: "pareto", protocol: ROUTING_WORKER_PROTOCOL_VERSION, startId, endId, options },
    () => paretoRoutes(graph, startId, endId, options),
    opts,
  );
}

/** H3's `sunReach(graph, startId, options)`, off the main thread when it can be. */
export function searchSunReach(
  graph: RoutingGraph,
  startId: number,
  options: SunReachOptions,
  opts: { signal?: AbortSignal } = {},
): Promise<SunReachResult> {
  return search(
    graph,
    { type: "reach", protocol: ROUTING_WORKER_PROTOCOL_VERSION, startId, options },
    () => sunReach(graph, startId, options),
    opts,
  );
}

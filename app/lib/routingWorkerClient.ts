/**
 * Main-thread side of the routing worker (L3c, #263): runs `paretoRoutes` in
 * `app/workers/routing.worker.ts` so a 1–3 s search no longer freezes the map
 * and the timeline.
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
import { ROUTING_WORKER_PROTOCOL_VERSION, type RoutingWorkerCommand, type RoutingWorkerEvent } from "./routingWorkerProtocol";

interface Pending {
  resolve: (routes: RouteResult[]) => void;
  reject: (error: unknown) => void;
  runHere: () => RouteResult[];
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();
let warned = false;

function warnOnce(reason: string, detail?: unknown) {
  if (warned || !import.meta.env.DEV) return;
  warned = true;
  console.warn(`[routing] worker unavailable (${reason}); searching on the main thread`, detail ?? "");
}

function settleHere(p: Pending) {
  try {
    p.resolve(p.runHere());
  } catch (e) {
    p.reject(e);
  }
}

/** Terminate the worker; the next request starts a fresh one. Returns what was in flight. */
function dropWorker(): Pending[] {
  worker?.terminate();
  worker = null;
  const inFlight = [...pending.values()];
  pending.clear();
  return inFlight;
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    const w = new Worker(new URL("../workers/routing.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<RoutingWorkerEvent>) => {
      const p = pending.get(event.data.requestId);
      if (!p) return;
      pending.delete(event.data.requestId);
      if (event.data.type === "pareto") p.resolve(event.data.routes);
      else {
        warnOnce("worker error event", event.data.error);
        settleHere(p);
      }
    };
    const fail = (event: Event) => {
      warnOnce(event.type, event);
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
    // A superseding calculation aborts before it touches the shared graph.
    if (signal?.aborted) throw abortError();
    sliceStart = performance.now();
  }
}

/**
 * `paretoRoutes(graph, startId, endId, options)`, off the main thread when it
 * can be. `signal` aborting terminates the worker — a running synchronous
 * search cannot be interrupted any other way — and rejects with an
 * `AbortError`. `onPacked` fires after the main-thread pack, before the post.
 */
export function searchParetoRoutes(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  options: DijkstraOptions,
  { signal, onPacked }: { signal?: AbortSignal; onPacked?: () => void } = {},
): Promise<RouteResult[]> {
  const runHere = () => paretoRoutes(graph, startId, endId, options);
  if (signal?.aborted) return Promise.reject(abortError());
  const w = getWorker();
  if (!w) return new Promise((resolve, reject) => settleHere({ resolve, reject, runHere }));

  return packInSlices(graph, signal).then((packed) => {
    onPacked?.();
    if (signal?.aborted) throw abortError();
    return new Promise<RouteResult[]>((resolve, reject) => {
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
        resolve: (routes) => {
          done();
          resolve(routes);
        },
        reject: (error) => {
          done();
          reject(error);
        },
        runHere,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const command: RoutingWorkerCommand = {
        type: "pareto",
        protocol: ROUTING_WORKER_PROTOCOL_VERSION,
        requestId,
        graph: packed,
        startId,
        endId,
        options,
      };
      target.postMessage(command, transferList(packed));
    });
  });
}

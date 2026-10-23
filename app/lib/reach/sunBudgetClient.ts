/**
 * Main-thread side of `app/workers/sunBudget.worker.ts` (#377): Sun Budget's
 * graph build and its searches, off the main thread.
 *
 * Whenever the worker cannot answer — no `Worker` (node, tests, SSR),
 * construction throws, or it errors before ever answering — both run here
 * instead, through the same handler, so the answers are the same either way.
 *
 * A superseded request is ignored, never cancelled by terminating the worker:
 * that would discard the graph it keeps, and a search is 0.2–0.4 s.
 */

import {
  type BuiltReachGraph,
  createSunBudgetHandler,
  SUN_BUDGET_WORKER_PROTOCOL_VERSION,
  type SunBudgetCommand,
  type SunBudgetEvent,
} from "./sunBudgetWorkerProtocol";
import type { SunReachOptions, SunReachResult, SunReachWalk } from "../sunReach";

type Payload =
  | Omit<Extract<SunBudgetCommand, { type: "build" }>, "requestId" | "protocol">
  | Omit<Extract<SunBudgetCommand, { type: "search" }>, "requestId" | "protocol">
  | Omit<Extract<SunBudgetCommand, { type: "walk" }>, "requestId" | "protocol">;

let worker: Worker | null = null;
let disabled = false;
let answered = false;
let nextRequestId = 1;
const pending = new Map<number, (event: SunBudgetEvent) => void>();
/** The same handler the worker runs, for when there is no worker. */
let local: ReturnType<typeof createSunBudgetHandler> | null = null;

function getWorker(): Worker | null {
  if (worker) return worker;
  if (disabled || typeof Worker === "undefined") return null;
  try {
    const w = new Worker(new URL("../../workers/sunBudget.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<SunBudgetEvent>) => {
      answered = true;
      const settle = pending.get(event.data.requestId);
      pending.delete(event.data.requestId);
      settle?.(event.data);
    };
    w.onerror = w.onmessageerror = () => {
      // A worker that never answered cannot load here: stop retrying. Either
      // way the kept graph is gone, so callers in flight get an error and rebuild.
      if (!answered) disabled = true;
      worker?.terminate();
      worker = null;
      for (const [requestId, settle] of pending) settle({ type: "error", requestId, error: "sun budget worker failed" });
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    disabled = true;
    return null;
  }
}

function send(payload: Payload, signal?: AbortSignal): Promise<SunBudgetEvent> {
  const command = { ...payload, protocol: SUN_BUDGET_WORKER_PROTOCOL_VERSION, requestId: nextRequestId++ } as SunBudgetCommand;
  const w = getWorker();
  if (!w && !local) local = createSunBudgetHandler();
  const answer = w
    ? new Promise<SunBudgetEvent>((resolve) => {
        pending.set(command.requestId, resolve);
        w.postMessage(command);
      })
    : local!(command);
  return answer.then((event) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (event.type === "error") throw new Error(event.error);
    return event;
  });
}

/** Build and keep the graph for a start; resolves with what the map needs to draw. */
export async function buildSunReachGraph(
  args: { center: [number, number]; timeBudgetSec: number; departure: Date },
  { signal }: { signal?: AbortSignal } = {},
): Promise<BuiltReachGraph> {
  const event = await send(
    { type: "build", center: args.center, timeBudgetSec: args.timeBudgetSec, departureMs: args.departure.getTime() },
    signal,
  );
  if (event.type !== "built") throw new Error(`unexpected ${event.type}`);
  return event.built;
}

/** Search the kept graph `graphId`; rejects if a newer build replaced it. */
export async function searchSunReachGraph(
  graphId: number,
  options: Omit<SunReachOptions, "timeAware">,
  { signal }: { signal?: AbortSignal } = {},
): Promise<SunReachResult> {
  const event = await send({ type: "search", graphId, options: options as SunReachOptions }, signal);
  if (event.type !== "searched") throw new Error(`unexpected ${event.type}`);
  return event.result;
}

/**
 * The walk behind a proven street of the last search on `graphId` (#379); null
 * if that street was not proven by it.
 */
export async function sunReachWalk(
  graphId: number,
  budgets: { sunBudgetSec: number; timeBudgetSec: number },
  edge: { fromId: number; toId: number; side?: string },
): Promise<SunReachWalk | null> {
  const event = await send({ type: "walk", graphId, budgets, edge });
  if (event.type !== "walked") throw new Error(`unexpected ${event.type}`);
  return event.walk;
}


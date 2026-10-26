/**
 * Wire contract for `app/workers/sunBudget.worker.ts` (#377).
 *
 * Sun Budget builds one graph per start and searches it on every slider step,
 * so the worker builds it and keeps it: the main thread pays neither the
 * ~0.8 s build nor a pack per step. A worker of its own, not the routing one —
 * that one is terminated whenever a route calculation is cancelled, which would
 * throw the kept graph away under the user.
 */

import { buildReachGraph } from "../navigationData/reachGraph";
import { type SunReachOptions, type SunReachResult, type SunReachRun, type SunReachWalk, sunReachRun } from "../sunReach";
import { FEASIBILITY_MODEL_VERSION, type FeasibilityCertificate, type FeasibilityQuestion, feasibilityCertificate } from "./feasibility";
import type { ReachGraph } from "../navigationData/reachGraph";

export const SUN_BUDGET_WORKER_PROTOCOL_VERSION = "umbra-sun-budget-worker-v1";

export type SunBudgetCommand =
  | {
      type: "build";
      protocol: typeof SUN_BUDGET_WORKER_PROTOCOL_VERSION;
      requestId: number;
      center: [number, number];
      timeBudgetSec: number;
      /** How long an outing can last, stops included (H5c); defaults to `timeBudgetSec`. */
      horizonSec?: number;
      departureMs: number;
    }
  | {
      type: "search";
      protocol: typeof SUN_BUDGET_WORKER_PROTOCOL_VERSION;
      requestId: number;
      graphId: number;
      options: SunReachOptions;
    }
  | {
      /** The walk behind one proven street of the last search on `graphId` (#379). */
      type: "walk";
      protocol: typeof SUN_BUDGET_WORKER_PROTOCOL_VERSION;
      requestId: number;
      graphId: number;
      /** The budgets (and trip) of the region the user tapped; a newer search answers nothing. */
      budgets: Pick<SunReachOptions, "sunBudgetSec" | "timeBudgetSec" | "roundTrip">;
      edge: { fromId: number; toId: number; side?: string };
    }
  | {
      /**
       * H6: answer one outing question on a graph of its own, built and
       * dropped here — the panel's kept graph is left alone.
       */
      type: "feasibility";
      protocol: typeof SUN_BUDGET_WORKER_PROTOCOL_VERSION;
      requestId: number;
      question: FeasibilityQuestion;
      inputVersion: number;
    };

/**
 * What the main thread needs from a built graph: whether it is usable, where
 * the search starts, and node positions to draw region edges with — never the
 * edges themselves, which stay in the worker.
 */
export type BuiltReachGraph =
  | { status: "uncovered"; reason: string }
  | {
      status: "ok";
      graphId: number;
      startPoint: [number, number];
      /** Metres from the start to the data's edge when the graph was cut there, else null (#380). */
      edgeM: number | null;
      /** Node ids with their positions, parallel arrays (transferred). */
      nodeIds: Float64Array;
      nodeLon: Float64Array;
      nodeLat: Float64Array;
    };

export type SunBudgetEvent =
  | { type: "built"; requestId: number; built: BuiltReachGraph }
  | { type: "searched"; requestId: number; result: SunReachResult }
  | { type: "walked"; requestId: number; walk: SunReachWalk | null }
  | { type: "feasibility"; requestId: number; certificate: FeasibilityCertificate }
  | { type: "error"; requestId: number; error: string };

/** The node positions of a graph, as transferable parallel arrays. */
export function nodeArrays(graph: Extract<ReachGraph, { status: "ok" }>["graph"]) {
  const n = graph.nodes.size;
  const nodeIds = new Float64Array(n);
  const nodeLon = new Float64Array(n);
  const nodeLat = new Float64Array(n);
  let i = 0;
  for (const [id, node] of graph.nodes) {
    nodeIds[i] = id;
    nodeLon[i] = node.lon;
    nodeLat[i] = node.lat;
    i++;
  }
  return { nodeIds, nodeLon, nodeLat };
}

/** Rebuilds the id → position map the reach layer draws with. */
export function nodeMap(built: Extract<BuiltReachGraph, { status: "ok" }>): Map<number, { lat: number; lon: number }> {
  const map = new Map<number, { lat: number; lon: number }>();
  for (let i = 0; i < built.nodeIds.length; i++) {
    map.set(built.nodeIds[i], { lat: built.nodeLat[i], lon: built.nodeLon[i] });
  }
  return map;
}

/**
 * The worker's whole body, kept pure so it is testable without a Worker. One
 * graph is kept — the latest built; a search for any other id is an error, so
 * a search can never run against a graph the caller did not ask for.
 */
export function createSunBudgetHandler(build: typeof buildReachGraph = buildReachGraph) {
  let kept: { graphId: number; graph: Extract<ReachGraph, { status: "ok" }> } | null = null;
  // The last search on the kept graph, for replaying the walk behind a street.
  let lastRun: { run: SunReachRun; options: SunReachOptions } | null = null;
  let nextGraphId = 1;
  // Builds overlap (a second tap while the first fetches); only the latest may become kept.
  let latestBuild = 0;

  return async function handle(command: SunBudgetCommand): Promise<SunBudgetEvent> {
    const requestId = command?.requestId ?? -1;
    try {
      if (command?.protocol !== SUN_BUDGET_WORKER_PROTOCOL_VERSION || !Number.isInteger(command.requestId)) {
        throw new Error("invalid sun budget worker command");
      }
      if (command.type === "build") {
        const buildSeq = ++latestBuild;
        const graph = await build({
          center: command.center,
          timeBudgetSec: command.timeBudgetSec,
          horizonSec: command.horizonSec,
          departure: new Date(command.departureMs),
          travelMode: "walk",
        });
        if (graph.status !== "ok") return { type: "built", requestId, built: graph };
        if (buildSeq !== latestBuild) throw new Error("superseded by a newer build");
        const graphId = nextGraphId++;
        kept = { graphId, graph };
        lastRun = null;
        return {
          type: "built",
          requestId,
          built: { status: "ok", graphId, startPoint: graph.startPoint, edgeM: graph.edgeM, ...nodeArrays(graph.graph) },
        };
      }
      if (command.type === "feasibility") {
        const q = command.question;
        // The farthest a round trip goes is half the walking time out; the
        // shade must cover the whole outing, stop included (both inside timeMin).
        const built = await build({
          center: q.start,
          timeBudgetSec: (Math.max(0, q.timeMin - q.stayMin) * 60) / 2,
          horizonSec: q.timeMin * 60,
          departure: new Date(q.departure),
          travelMode: "walk",
        });
        // edgeM: the graph was cut at the data's edge (#380) — no "infeasible" proof there.
        const meta = built.status === "ok"
          ? { inputVersion: command.inputVersion, geometryVersion: built.generation, edgeM: built.edgeM }
          : { inputVersion: command.inputVersion };
        const certificate: FeasibilityCertificate =
          built.status === "ok"
            ? feasibilityCertificate(built.graph, built.startId, q, { timeAware: built.timeAware }, meta)
            : { status: "uncovered", question: q, inputVersion: command.inputVersion, modelVersion: FEASIBILITY_MODEL_VERSION, reason: built.reason };
        return { type: "feasibility", requestId, certificate };
      }
      if (!kept || kept.graphId !== command.graphId) throw new Error(`graph ${command.graphId} is not kept`);
      if (command.type === "walk") {
        const { fromId, toId, side } = command.edge;
        // Only the search behind the region on screen may answer: a slider step since then
        // ran a newer search whose walks belong to another region.
        const same =
          lastRun?.options.sunBudgetSec === command.budgets.sunBudgetSec &&
          lastRun.options.timeBudgetSec === command.budgets.timeBudgetSec &&
          lastRun.options.roundTrip?.dwellSec === command.budgets.roundTrip?.dwellSec;
        return { type: "walked", requestId, walk: same ? lastRun!.run.witness(fromId, toId, side) : null };
      }
      const { graph } = kept;
      const run = sunReachRun(graph.graph, graph.startId, { ...command.options, timeAware: graph.timeAware });
      lastRun = { run, options: command.options };
      return { type: "searched", requestId, result: run.result };
    } catch (e) {
      return { type: "error", requestId, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** Buffers an event can hand over instead of copying. */
export function eventTransferList(event: SunBudgetEvent): ArrayBuffer[] {
  if (event.type !== "built" || event.built.status !== "ok") return [];
  return [event.built.nodeIds.buffer, event.built.nodeLon.buffer, event.built.nodeLat.buffer] as ArrayBuffer[];
}

import { type DijkstraOptions, paretoRoutes, type RouteResult } from "./routing";
import { type PackedRoutingGraph, unpackRoutingGraph } from "./routingGraphCodec";
import { type SunReachOptions, type SunReachResult, sunReach } from "./sunReach";

/**
 * Versioned wire contract for `app/workers/routing.worker.ts` (L3c, #263).
 * The walking Pareto search and H3's Sun Budget reachability; A5b extends the
 * unions (agreed on #270).
 */
export const ROUTING_WORKER_PROTOCOL_VERSION = "umbra-routing-worker-v1";

export type ParetoCommand = {
  type: "pareto";
  protocol: typeof ROUTING_WORKER_PROTOCOL_VERSION;
  requestId: number;
  graph: PackedRoutingGraph;
  startId: number;
  endId: number;
  options: DijkstraOptions;
};

export type ReachCommand = {
  type: "reach";
  protocol: typeof ROUTING_WORKER_PROTOCOL_VERSION;
  requestId: number;
  graph: PackedRoutingGraph;
  startId: number;
  options: SunReachOptions;
};

export type RoutingWorkerCommand = ParetoCommand | ReachCommand;

export type RoutingWorkerEvent =
  | { type: "pareto"; requestId: number; routes: RouteResult[] }
  | { type: "reach"; requestId: number; result: SunReachResult }
  | { type: "error"; requestId: number; error: string };

export function assertRoutingWorkerCommand(command: RoutingWorkerCommand): void {
  if (command?.protocol !== ROUTING_WORKER_PROTOCOL_VERSION || !Number.isInteger(command.requestId))
    throw new Error("invalid routing worker command");
}

/** The worker's whole body, kept pure so it is testable without a Worker. */
export function handleRoutingCommand(command: RoutingWorkerCommand): RoutingWorkerEvent {
  const requestId = command?.requestId ?? -1;
  try {
    assertRoutingWorkerCommand(command);
    const graph = unpackRoutingGraph(command.graph);
    if (command.type === "reach") return { type: "reach", requestId, result: sunReach(graph, command.startId, command.options) };
    return { type: "pareto", requestId, routes: paretoRoutes(graph, command.startId, command.endId, command.options) };
  } catch (e) {
    return { type: "error", requestId, error: e instanceof Error ? e.message : String(e) };
  }
}

import { type DijkstraOptions, paretoRoutes, type RouteResult } from "./routing";
import { type PackedRoutingGraph, unpackRoutingGraph } from "./routingGraphCodec";

/**
 * Versioned wire contract for `app/workers/routing.worker.ts` (L3c, #263).
 * One command today — the walking Pareto search; A5b and H3 extend the unions
 * (agreed on #270).
 */
export const ROUTING_WORKER_PROTOCOL_VERSION = "umbra-routing-worker-v1";

export type RoutingWorkerCommand = {
  type: "pareto";
  protocol: typeof ROUTING_WORKER_PROTOCOL_VERSION;
  requestId: number;
  graph: PackedRoutingGraph;
  startId: number;
  endId: number;
  options: DijkstraOptions;
};

export type RoutingWorkerEvent =
  | { type: "pareto"; requestId: number; routes: RouteResult[] }
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
    return { type: "pareto", requestId, routes: paretoRoutes(graph, command.startId, command.endId, command.options) };
  } catch (e) {
    return { type: "error", requestId, error: e instanceof Error ? e.message : String(e) };
  }
}

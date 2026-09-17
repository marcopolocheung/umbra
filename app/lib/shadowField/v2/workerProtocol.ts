import type { NumericEdge, NumericEdgeResult, NumericPointResult, NumericReceiver, QueryOptions } from "./service";
import type { SolarPosition } from "./solar";

/** Versioned, batch-only wire contract for the inactive numeric worker. */
export const NUMERIC_WORKER_PROTOCOL_VERSION = "nyc-numeric-worker-v1";

export type NumericWorkerCommand =
  | { type: "queryPoints"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; receivers: NumericReceiver[]; sun: SolarPosition; options?: Omit<QueryOptions, "signal" | "generation"> }
  | { type: "queryEdges"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; edges: NumericEdge[]; sun: SolarPosition; options?: Omit<QueryOptions, "signal" | "generation"> }
  | { type: "queryTimes"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; receivers: NumericReceiver[]; suns: SolarPosition[]; options?: Omit<QueryOptions, "signal" | "generation"> }
  | { type: "cancel"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string };

export type NumericWorkerEvent =
  | { type: "points"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; results: NumericPointResult[] }
  | { type: "edges"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; results: NumericEdgeResult[] }
  | { type: "times"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; results: NumericPointResult[][] }
  | { type: "cancelled" | "error"; protocol: typeof NUMERIC_WORKER_PROTOCOL_VERSION; requestId: string; generation: string; error?: string };

export function assertNumericWorkerCommand(command: NumericWorkerCommand): void {
  if (command.protocol !== NUMERIC_WORKER_PROTOCOL_VERSION || !command.requestId || !command.generation)
    throw new Error("invalid numeric worker command");
}

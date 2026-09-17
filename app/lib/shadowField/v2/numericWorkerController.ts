import type { NumericFieldService } from "./service";
import { assertNumericWorkerCommand, NUMERIC_WORKER_PROTOCOL_VERSION, type NumericWorkerCommand, type NumericWorkerEvent } from "./workerProtocol";

/** Pure host used by a browser Worker and deterministic unit tests. */
export class NumericWorkerController {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly service: NumericFieldService, private readonly emit: (event: NumericWorkerEvent) => void) {}
  handle(command: NumericWorkerCommand): void {
    try { assertNumericWorkerCommand(command); } catch (error) { this.emit({ type: "error", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, error: error instanceof Error ? error.message : String(error) }); return; }
    if (command.type === "cancel") { this.active.get(command.requestId)?.abort(); this.emit({ type: "cancelled", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation }); return; }
    const abort = new AbortController(); this.active.set(command.requestId, abort);
    const options = { ...command.options, generation: command.generation, signal: abort.signal };
    const finish = () => this.active.delete(command.requestId);
    if (command.type === "queryPoints") void this.service.queryPoints(command.receivers, command.sun, options).then((results) => this.emit({ type: "points", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, results }), (error) => this.emit({ type: "error", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, error: error instanceof Error ? error.message : String(error) })).finally(finish);
    if (command.type === "queryEdges") void this.service.queryEdges(command.edges, command.sun, options).then((results) => this.emit({ type: "edges", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, results }), (error) => this.emit({ type: "error", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, error: error instanceof Error ? error.message : String(error) })).finally(finish);
    if (command.type === "queryTimes") void this.service.queryTimes(command.receivers, command.suns, options).then((results) => this.emit({ type: "times", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, results }), (error) => this.emit({ type: "error", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: command.requestId, generation: command.generation, error: error instanceof Error ? error.message : String(error) })).finally(finish);
  }
}

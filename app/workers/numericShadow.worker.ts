import { NumericWorkerController } from "../lib/shadowField/v2/numericWorkerController";
import type { NumericFieldService } from "../lib/shadowField/v2/service";
import type { NumericWorkerCommand, NumericWorkerEvent } from "../lib/shadowField/v2/workerProtocol";

/**
 * PR4's worker entrypoint is opt-in: a later feature-gated bootstrap supplies
 * a configured service/page loader. Nothing imports or instantiates it in the
 * shipping map or routing paths.
 */
export function installNumericShadowWorker(service: NumericFieldService): NumericWorkerController {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const controller = new NumericWorkerController(service, (event: NumericWorkerEvent) => scope.postMessage(event));
  scope.onmessage = (event: MessageEvent<NumericWorkerCommand>) => controller.handle(event.data);
  return controller;
}

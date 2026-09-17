/// <reference lib="webworker" />
import { RemoteTileController } from "./RemoteTileController";
import type { DebugWorkerCommand, DebugWorkerEvent } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

// Browser-worker adapter only. The controller owns the testable policy.
const controller = new RemoteTileController({
  emit(event: DebugWorkerEvent, transfer?: Transferable[]) {
    self.postMessage(event, transfer ?? []);
  },
});

self.onmessage = (event: MessageEvent<DebugWorkerCommand>) => controller.handle(event.data);

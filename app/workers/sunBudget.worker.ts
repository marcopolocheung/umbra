/// <reference lib="webworker" />
import {
  createSunBudgetHandler,
  eventTransferList,
  type SunBudgetCommand,
} from "../lib/reach/sunBudgetWorkerProtocol";

declare const self: DedicatedWorkerGlobalScope;

// #377: Sun Budget's graph build and searches, off the main thread. Policy lives in sunBudgetClient.ts.
const handle = createSunBudgetHandler();
self.onmessage = async (event: MessageEvent<SunBudgetCommand>) => {
  const answer = await handle(event.data);
  self.postMessage(answer, eventTransferList(answer));
};

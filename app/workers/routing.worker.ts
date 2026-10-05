/// <reference lib="webworker" />
import { handleRoutingCommand, type RoutingWorkerCommand } from "../lib/routingWorkerProtocol";

declare const self: DedicatedWorkerGlobalScope;

// L3c: the walking search off the main thread. Policy lives in routingWorkerClient.ts.
self.onmessage = (event: MessageEvent<RoutingWorkerCommand>) => self.postMessage(handleRoutingCommand(event.data));

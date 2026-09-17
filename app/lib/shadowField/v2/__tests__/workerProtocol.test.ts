import { describe, expect, it } from "vitest";
import { assertNumericWorkerCommand, NUMERIC_WORKER_PROTOCOL_VERSION } from "../workerProtocol";

describe("numeric worker protocol", () => {
  it("pins request and generation identity", () => {
    expect(() => assertNumericWorkerCommand({ type: "cancel", protocol: NUMERIC_WORKER_PROTOCOL_VERSION, requestId: "r", generation: "g" })).not.toThrow();
    expect(() => assertNumericWorkerCommand({ type: "cancel", protocol: "wrong" as typeof NUMERIC_WORKER_PROTOCOL_VERSION, requestId: "r", generation: "g" })).toThrow(/invalid/);
  });
});

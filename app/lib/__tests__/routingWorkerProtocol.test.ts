import { describe, expect, it } from "vitest";
import { paretoRoutes } from "../routing";
import { packRoutingGraph } from "../routingGraphCodec";
import {
  assertRoutingWorkerCommand,
  handleRoutingCommand,
  ROUTING_WORKER_PROTOCOL_VERSION,
  type ParetoCommand,
} from "../routingWorkerProtocol";
import { sunReach } from "../sunReach";
import { randomGraph } from "./paretoCases.fixture";

const command = (overrides: Partial<ParetoCommand> = {}): ParetoCommand => ({
  type: "pareto",
  protocol: ROUTING_WORKER_PROTOCOL_VERSION,
  requestId: 3,
  graph: packRoutingGraph(randomGraph(5, 6, 6, 4)),
  startId: 0,
  endId: 35,
  options: { crossingPenaltyM: 15, timeAware: { bucketMs: 60_000, bucketCount: 4 } },
  ...overrides,
});

describe("routing worker protocol", () => {
  it("rejects a wrong version or a missing request id", () => {
    expect(() => assertRoutingWorkerCommand(command())).not.toThrow();
    expect(() => assertRoutingWorkerCommand(command({ protocol: "v0" as never }))).toThrow();
    expect(() => assertRoutingWorkerCommand(command({ requestId: undefined as never }))).toThrow();
  });

  it("answers with the routes a direct call returns", () => {
    const c = command();
    const expected = paretoRoutes(randomGraph(5, 6, 6, 4), c.startId, c.endId, c.options);
    expect(expected.length).toBeGreaterThan(0);
    expect(handleRoutingCommand(c)).toStrictEqual({ type: "pareto", requestId: 3, routes: expected });
  });

  it("answers a reach command with the region a direct call returns", () => {
    const options = { sunBudgetSec: 60, timeBudgetSec: 200, timeAware: { bucketMs: 60_000, bucketCount: 4 } };
    const event = handleRoutingCommand({
      type: "reach",
      protocol: ROUTING_WORKER_PROTOCOL_VERSION,
      requestId: 4,
      graph: packRoutingGraph(randomGraph(5, 6, 6, 4)),
      startId: 0,
      options,
    });
    const expected = sunReach(randomGraph(5, 6, 6, 4), 0, options);
    expect(expected.reachable.length).toBeGreaterThan(0);
    expect(event.type).toBe("reach");
    if (event.type !== "reach") return;
    expect(event.requestId).toBe(4);
    expect(event.result.reachable).toStrictEqual(expected.reachable);
    expect(event.result.outcome).toBe(expected.outcome);
  });

  it("turns a failure into an error event for the same request", () => {
    const event = handleRoutingCommand(command({ graph: null as never }));
    expect(event).toMatchObject({ type: "error", requestId: 3 });
    expect(handleRoutingCommand(command({ protocol: "v0" as never }))).toMatchObject({ type: "error", requestId: 3 });
  });
});

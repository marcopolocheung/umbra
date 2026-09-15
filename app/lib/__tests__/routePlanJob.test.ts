import { describe, expect, it, vi } from "vitest";
import { RoutePlanJobCoordinator, type RoutePlanRequest } from "../routePlanJob";

const plan = {
  from: [-74, 40.7] as [number, number],
  to: [-73.98, 40.73] as [number, number],
  via: [[-73.99, 40.71]] as [number, number][],
  fromLabel: "Start",
  toLabel: "End",
};

function request(version: number, key = `route:${version}`): RoutePlanRequest {
  return {
    requestId: `request-${version}`,
    inputVersion: version,
    planRevision: version,
    actionId: `action-${version}`,
    retry: 0,
    idempotencyKey: key,
    plan,
  };
}

const completed = {
  status: "completed" as const,
  metrics: [{ label: "Most shadowed", distanceM: 1200, shadowCoverage: 0.75 }],
  shadowProvenance: null,
};

describe("RoutePlanJobCoordinator", () => {
  it("returns the completed pipeline metrics and shadow provenance, not a started acknowledgement", async () => {
    const result = await new RoutePlanJobCoordinator().submit(request(1), async () => completed);

    expect(result).toMatchObject({
      requestId: "request-1",
      inputVersion: 1,
      planRevision: 1,
      actionId: "action-1",
      retry: 0,
      idempotencyKey: "route:1",
      status: "completed",
      metrics: [{ distanceM: 1200, shadowCoverage: 0.75 }],
    });
    expect(result).not.toHaveProperty("note", expect.stringContaining("started"));
  });

  it("keeps unroutable multi-stop legs in a partial terminal result", async () => {
    const result = await new RoutePlanJobCoordinator().submit(request(1), async () => ({
      status: "partial",
      metrics: [{ label: "Shortest (partial)", distanceM: 500, shadowCoverage: 0.6 }],
      shadowProvenance: null,
      unroutableLegs: [{ completedLegs: 1, failedLeg: 2, totalLegs: 3 }],
    }));

    expect(result).toMatchObject({
      status: "partial",
      unroutableLegs: [{ completedLegs: 1, failedLeg: 2, totalLegs: 3 }],
    });
  });

  it("preserves no-plan-found and provider errors as distinct terminal states", async () => {
    const noPlan = await new RoutePlanJobCoordinator().submit(request(1), async () => ({
      status: "no_plan_found",
      message: "No connected walkable path.",
    }));
    const providerError = await new RoutePlanJobCoordinator().submit(request(1), async () => {
      throw new Error("Routing provider unavailable");
    });

    expect(noPlan).toMatchObject({
      status: "no_plan_found",
      message: "No connected walkable path.",
    });
    expect(providerError).toMatchObject({
      status: "error",
      message: "Routing provider unavailable",
    });
  });

  it("makes explicit cancellation terminal", async () => {
    const coordinator = new RoutePlanJobCoordinator();
    const result = coordinator.submit(request(1), async (_request, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return completed;
    });

    expect(coordinator.cancel("request-1")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled", reason: "cancelled" });
  });

  it("does not allow a stale completion to overwrite a newer plan", async () => {
    const coordinator = new RoutePlanJobCoordinator();
    let completeOld!: () => void;
    const old = coordinator.submit(request(1), async () => {
      await new Promise<void>((resolve) => {
        completeOld = resolve;
      });
      return completed;
    });
    const newer = coordinator.submit(request(2), async () => ({
      ...completed,
      metrics: [{ label: "Newest", distanceM: 800, shadowCoverage: 0.8 }],
    }));
    completeOld();

    await expect(old).resolves.toMatchObject({ status: "cancelled", reason: "superseded" });
    await expect(newer).resolves.toMatchObject({ status: "completed", inputVersion: 2 });
  });

  it("deduplicates a repeated idempotency key before it can mutate twice", async () => {
    const coordinator = new RoutePlanJobCoordinator();
    const run = vi.fn(async () => completed);
    const action = request(1, "same-intent");
    const first = coordinator.submit(action, run);
    const duplicate = coordinator.submit(action, run);

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("allows a later action with the same route intent", async () => {
    const coordinator = new RoutePlanJobCoordinator();
    const run = vi.fn(async () => completed);
    await coordinator.submit(request(1, "intent:coordinates"), run);
    await coordinator.submit({ ...request(2, "intent:coordinates"), actionId: "action-2" }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels an active job when the application plan revision advances", async () => {
    const coordinator = new RoutePlanJobCoordinator();
    let finish!: () => void;
    const active = coordinator.submit(request(1), async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return completed;
    });
    coordinator.advancePlanRevision(2);
    finish();
    await expect(active).resolves.toMatchObject({ status: "cancelled", reason: "superseded" });
  });

  it("fails closed when a runner returns a malformed completed result", async () => {
    const result = await new RoutePlanJobCoordinator().submit(request(1), async () => ({
      status: "completed", metrics: [], shadowProvenance: null,
    } as any));
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("invalid terminal result") });
  });
});

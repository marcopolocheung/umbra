/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReachGraph } from "../../lib/navigationData/reachGraph";
import type { RoutingGraph } from "../../lib/routing";
import type { SunReachEdge, SunReachResult } from "../../lib/sunReach";
import { useSunBudget } from "../useSunBudget";

afterEach(cleanup);

const departure = new Date("2026-07-01T16:00:00Z");
const graph: RoutingGraph = { nodes: new Map([[1, { id: 1, lat: 40.75, lon: -73.99 }]]), adj: new Map() };
const ok = async (): Promise<ReachGraph> => ({
  status: "ok",
  graph,
  startId: 1,
  timeAware: { bucketMs: 900_000, bucketCount: 2 },
});
const edge = (fromId: number, toId: number): SunReachEdge => ({ fromId, toId, side: "left", distanceM: 50 });
const result = (reachable: SunReachEdge[], undecided: SunReachEdge[] = []): SunReachResult => ({
  outcome: undecided.length ? "approximate" : "exact",
  reachable: reachable.map((e) => ({ ...e, sunSec: 1, arrivalSec: 1 })),
  undecided,
  stats: { labels: 0, evicted: 0, ms: 0 },
});
const ids = (edges: SunReachEdge[] | undefined) => (edges ?? []).map((e) => `${e.fromId}>${e.toId}`).sort();

describe("useSunBudget", () => {
  it("goes picking → loading → ready, searching the built graph at the chosen budgets", async () => {
    const search = vi.fn(async (_g: RoutingGraph, _s: number, _o: { sunBudgetSec: number; timeBudgetSec: number }) =>
      result([edge(1, 2)]),
    );
    const { result: hook } = renderHook(() => useSunBudget(departure, "walk", ok, search));
    expect(hook.current.status).toBe("off");
    act(() => hook.current.enter());
    expect(hook.current.status).toBe("picking");
    act(() => hook.current.setStart([-73.99, 40.75]));
    expect(hook.current.status).toBe("loading");
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(ids(hook.current.region?.proven)).toEqual(["1>2"]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][2]).toMatchObject({ sunBudgetSec: 480, timeBudgetSec: 1200 });
  });

  it("never drops a proven street when the sun budget widens and the new result is approximate", async () => {
    const search = vi.fn(async (_g: RoutingGraph, _s: number, o: { sunBudgetSec: number }) =>
      o.sunBudgetSec === 480 ? result([edge(1, 2), edge(2, 3)]) : result([edge(2, 3), edge(3, 4)], [edge(1, 2)]),
    );
    const { result: hook } = renderHook(() => useSunBudget(departure, "walk", ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3"]));
    act(() => hook.current.setSunMin(10));
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3", "3>4"]));
    expect(hook.current.region?.undecided).toEqual([]);
    expect(hook.current.outcome).toBe("approximate");
  });

  it("starts over at a new start: no street proven from the old one survives", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(result([edge(1, 2)]))
      .mockResolvedValueOnce(result([edge(7, 8)]));
    const build = vi.fn(ok);
    const { result: hook } = renderHook(() => useSunBudget(departure, "walk", build, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2"]));
    act(() => hook.current.setStart([-73.98, 40.76]));
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["7>8"]));
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("says uncovered outside the shade table and never searches", async () => {
    const search = vi.fn();
    const uncovered = async (): Promise<ReachGraph> => ({ status: "uncovered", reason: "outside the shade table" });
    const { result: hook } = renderHook(() => useSunBudget(departure, "walk", uncovered, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-87.6, 41.9]);
    });
    await waitFor(() => expect(hook.current.status).toBe("uncovered"));
    expect(search).not.toHaveBeenCalled();
    expect(hook.current.region).toBeNull();
  });
});

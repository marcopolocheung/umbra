/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReachGraph } from "../../lib/navigationData/reachGraph";
import type { RoutingGraph } from "../../lib/routing";
import type { SunReachEdge, SunReachOptions, SunReachResult } from "../../lib/sunReach";
import { useSunBudget } from "../useSunBudget";

afterEach(cleanup);

const departure = new Date("2026-07-01T16:00:00Z");
/** Each build returns a distinct graph object, as the real builder does. */
const ok = async (args: { center: [number, number] }): Promise<ReachGraph> => ({
  status: "ok",
  graph: { nodes: new Map(), adj: new Map() } as RoutingGraph,
  startId: 1,
  startPoint: args.center,
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
type Search = (g: RoutingGraph, s: number, o: SunReachOptions, x?: { signal?: AbortSignal }) => Promise<SunReachResult>;

describe("useSunBudget", () => {
  it("goes picking → loading → ready, always searching at walking pace", async () => {
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    expect(hook.current.status).toBe("off");
    act(() => hook.current.enter());
    expect(hook.current.status).toBe("picking");
    act(() => hook.current.setStart([-73.99, 40.75]));
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(ids(hook.current.region?.proven)).toEqual(["1>2"]);
    expect(search.mock.calls[0][2]).toMatchObject({ sunBudgetSec: 480, timeBudgetSec: 1200, travelMode: "walk" });
    expect(hook.current.shown).toEqual({ sunMin: 8, walkMin: 20 });
  });

  it("never drops a proven street when the sun budget widens and the new result is approximate", async () => {
    const search = vi.fn<Search>(async (_g, _s, o) =>
      o.sunBudgetSec === 480 ? result([edge(1, 2), edge(2, 3)]) : result([edge(2, 3), edge(3, 4)], [edge(1, 2)]),
    );
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3"]));
    act(() => hook.current.setSunMin(10));
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3", "3>4"]));
    expect(hook.current.region?.undecided).toEqual([]);
  });

  it("never shows the old start's result once the start has moved, even if it lands late", async () => {
    // The old start's search is still running when the user taps a new start.
    let releaseOld!: (r: SunReachResult) => void;
    const search = vi.fn<Search>((g) =>
      g === firstGraph ? new Promise<SunReachResult>((resolve) => { releaseOld = resolve; }) : Promise.resolve(result([edge(20, 21)])),
    );
    let firstGraph: RoutingGraph | null = null;
    const build = vi.fn(async (args: { center: [number, number] }) => {
      const built = await ok(args);
      if (built.status === "ok" && !firstGraph) firstGraph = built.graph;
      return built;
    });
    const { result: hook } = renderHook(() => useSunBudget(departure, false, build, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    act(() => hook.current.setStart([-73.98, 40.76]));
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["20>21"]));
    // The old reply arrives after the move: it must change nothing.
    await act(async () => releaseOld(result([edge(1, 2)])));
    expect(ids(hook.current.region?.proven)).toEqual(["20>21"]);
    // And widening the budget searches the new start, never serving the stale one.
    act(() => hook.current.setSunMin(10));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(ids(hook.current.region?.proven)).toEqual(["20>21"]);
  });

  it("does not build or search while the sun is down", async () => {
    const search = vi.fn<Search>();
    const build = vi.fn(ok);
    const { result: hook } = renderHook(() => useSunBudget(departure, true, build, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    expect(hook.current.status).toBe("sun-down");
    await new Promise((r) => setTimeout(r, 300));
    expect(build).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(hook.current.region).toBeNull();
  });

  it("says error, not 'finding', when the search fails", async () => {
    const search = vi.fn<Search>(async () => {
      throw new Error("worker died");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("error"));
  });

  it("says uncovered outside the shade table and never searches", async () => {
    const search = vi.fn<Search>();
    const uncovered = async (): Promise<ReachGraph> => ({ status: "uncovered", reason: "outside the shade table" });
    const { result: hook } = renderHook(() => useSunBudget(departure, false, uncovered, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-87.6, 41.9]);
    });
    await waitFor(() => expect(hook.current.status).toBe("uncovered"));
    expect(search).not.toHaveBeenCalled();
  });
});

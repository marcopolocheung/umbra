/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltReachGraph } from "../../lib/reach/sunBudgetWorkerProtocol";
import type { SunReachEdge, SunReachOptions, SunReachResult, SunReachWalk } from "../../lib/sunReach";
import { useSunBudget } from "../useSunBudget";

afterEach(cleanup);

const departure = new Date("2026-07-01T16:00:00Z");
/** Each build is a new kept graph with its own id, as the worker's are. */
let nextGraphId = 1;
const ok = async (args: { center: [number, number] }): Promise<BuiltReachGraph> => ({
  status: "ok",
  graphId: nextGraphId++,
  startPoint: args.center,
  edgeM: null,
  nodeIds: new Float64Array(),
  nodeLon: new Float64Array(),
  nodeLat: new Float64Array(),
});
const edge = (fromId: number, toId: number): SunReachEdge => ({ fromId, toId, side: "left", distanceM: 50 });
const result = (reachable: SunReachEdge[], undecided: SunReachEdge[] = []): SunReachResult => ({
  outcome: undecided.length ? "approximate" : "exact",
  reachable: reachable.map((e) => ({ ...e, sunSec: 1, arrivalSec: 1 })),
  undecided,
  stats: { labels: 0, evicted: 0, ms: 0 },
});
const ids = (edges: SunReachEdge[] | undefined) => (edges ?? []).map((e) => `${e.fromId}>${e.toId}`).sort();
type Search = (graphId: number, o: Omit<SunReachOptions, "timeAware">, x?: { signal?: AbortSignal }) => Promise<SunReachResult>;

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
    expect(search.mock.calls[0][1]).toMatchObject({ sunBudgetSec: 480, timeBudgetSec: 1200, travelMode: "walk" });
    expect(hook.current.shown).toEqual({ sunMin: 8, walkMin: 20, stayMin: null });
  });

  it("searches a round trip with its stop added to the walking time (H5c)", async () => {
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
      hook.current.setStayMin(10);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(search.mock.calls.at(-1)![1]).toEqual({ sunBudgetSec: 480, timeBudgetSec: 1800, travelMode: "walk", roundTrip: { dwellSec: 600 } });
    expect(hook.current.shown).toEqual({ sunMin: 8, walkMin: 20, stayMin: 10 });
  });

  it("never paints a one-way street into a round trip's region, or back (H5c)", async () => {
    // One way proves 1>2 and 2>3; the round trip at a wider sun budget only 1>2.
    const search = vi.fn<Search>(async (_id, o) => (o.roundTrip ? result([edge(1, 2)]) : result([edge(1, 2), edge(2, 3)])));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3"]));
    act(() => {
      hook.current.setStayMin(0);
      hook.current.setSunMin(10);
    });
    await waitFor(() => expect(hook.current.shown?.stayMin).toBe(0));
    expect(ids(hook.current.region?.proven)).toEqual(["1>2"]);
    act(() => hook.current.setStayMin(null));
    await waitFor(() => expect(hook.current.shown?.stayMin).toBeNull());
    expect(ids(hook.current.region?.proven)).toEqual(["1>2", "2>3"]);
  });

  it("never drops a proven street when the sun budget widens and the new result is approximate", async () => {
    const search = vi.fn<Search>(async (_id, o) =>
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
    let firstGraphId: number | null = null;
    const search = vi.fn<Search>((graphId) =>
      graphId === firstGraphId
        ? new Promise<SunReachResult>((resolve) => { releaseOld = resolve; })
        : Promise.resolve(result([edge(20, 21)])),
    );
    const build = vi.fn(async (args: { center: [number, number] }) => {
      const built = await ok(args);
      if (built.status === "ok" && firstGraphId === null) firstGraphId = built.graphId;
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
    // One rebuild first (the graph may have been lost), then the error.
    await waitFor(() => expect(hook.current.status).toBe("error"), { timeout: 3000 });
  });

  it("rebuilds once when the worker has lost the graph, then succeeds", async () => {
    // The first search finds its graph gone (the worker restarted); the rebuild's works.
    let calls = 0;
    const search = vi.fn<Search>(async () => {
      if (calls++ === 0) throw new Error("graph 1 is not kept");
      return result([edge(1, 2)]);
    });
    const build = vi.fn(ok);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result: hook } = renderHook(() => useSunBudget(departure, false, build, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(build).toHaveBeenCalledTimes(2);
    expect(ids(hook.current.region?.proven)).toEqual(["1>2"]);
  });

  it("keeps the same fit when the same start's graph is rebuilt (#378)", async () => {
    let calls = 0;
    const search = vi.fn<Search>(async () => {
      if (calls++ === 0) throw new Error("graph 1 is not kept");
      return result([edge(1, 2)]);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    const first = hook.current.fitKey;
    act(() => hook.current.setSunMin(9));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(hook.current.fitKey).toBe(first);
  });

  it("asks for one map fit per start, never per slider step (#378)", async () => {
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search));
    expect(hook.current.fitKey).toBeNull();
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.fitKey).not.toBeNull());
    const first = hook.current.fitKey;
    act(() => hook.current.setSunMin(12));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(hook.current.fitKey).toBe(first);
    act(() => hook.current.setStart([-73.98, 40.76]));
    await waitFor(() => expect(hook.current.fitKey).not.toBe(first));
  });

  it("calls a region clipped only when the shown walk reaches the data's edge (#380)", async () => {
    // The edge is 1.2 km away: a 10-min walk (~0.92 km with margin) can't reach it, a 20-min one can.
    const edgeBuild = async (args: { center: [number, number] }): Promise<BuiltReachGraph> => ({
      ...((await ok(args)) as Extract<BuiltReachGraph, { status: "ok" }>),
      edgeM: 1200,
    });
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, edgeBuild, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(hook.current.clipped).toBe(true);
    expect(hook.current.outcome).toBe("approximate");
    act(() => hook.current.setWalkMin(10));
    await waitFor(() => expect(hook.current.shown?.walkMin).toBe(10));
    expect(hook.current.clipped).toBe(false);
    expect(hook.current.outcome).toBe("exact");
  });

  it("shows the least-sun walk behind a tapped street, and forgets it when the region changes (#379)", async () => {
    const search = vi.fn<Search>(async () => result([edge(1, 2), edge(2, 1), edge(5, 6)]));
    const walk = (sunSec: number): SunReachWalk => ({ nodeIds: [9, 1, 2], sides: ["left", "left"], waits: [], sunSec, arrivalSec: 120 });
    const walkFor = vi.fn(async (_g: number, _b: unknown, e: { fromId: number }) => (e.fromId === 1 ? walk(90) : walk(40)));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search, walkFor));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    act(() => hook.current.showWalk({ lo: 1, hi: 2 }));
    await waitFor(() => expect(hook.current.walk).not.toBeNull());
    // Both directions of street 1–2 were proven; the shadier walk wins.
    expect(walkFor).toHaveBeenCalledTimes(2);
    expect(walkFor.mock.calls[0][1]).toEqual({ sunBudgetSec: 480, timeBudgetSec: 1200 });
    expect(hook.current.walk).toEqual(walk(40));
    act(() => hook.current.setSunMin(10));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.current.walk).toBeNull());
  });

  it("ignores a walk that answers after the region it was asked on has changed (#379)", async () => {
    // The walk reply is slow; the user moves the slider before it lands.
    let release!: (w: SunReachWalk) => void;
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const walkFor = vi.fn(() => new Promise<SunReachWalk>((resolve) => { release = resolve; }));
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search, walkFor));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    act(() => hook.current.showWalk({ lo: 1, hi: 2 }));
    act(() => hook.current.setSunMin(10));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await act(async () => release({ nodeIds: [9, 1, 2], sides: ["left", "left"], waits: [], sunSec: 5, arrivalSec: 60 }));
    expect(hook.current.walk).toBeNull();
  });

  it("recovers the walk after a slider round trip by re-running that budget once (#379)", async () => {
    // 8 → 12 → 8: the shown result comes from the cache, the worker's last run is 12.
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    let workerBudget = 0;
    search.mockImplementation(async (_id, o) => {
      workerBudget = o.sunBudgetSec;
      return result([edge(1, 2)]);
    });
    const walkFor = vi.fn(async (_g: number, b: { sunBudgetSec: number }) =>
      b.sunBudgetSec === workerBudget ? ({ nodeIds: [9, 1, 2], sides: ["left", "left"], waits: [], sunSec: 30, arrivalSec: 90 } as SunReachWalk) : null,
    );
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search, walkFor));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    act(() => hook.current.setSunMin(12));
    await waitFor(() => expect(hook.current.shown?.sunMin).toBe(12));
    act(() => hook.current.setSunMin(8));
    await waitFor(() => expect(hook.current.shown?.sunMin).toBe(8));
    act(() => hook.current.showWalk({ lo: 1, hi: 2 }));
    await waitFor(() => expect(hook.current.walk).not.toBeNull());
    expect(hook.current.walk).toMatchObject({ sunSec: 30 });
  });

  it("says 'none' when the search can't replay the tapped street", async () => {
    const search = vi.fn<Search>(async () => result([edge(1, 2)]));
    const walkFor = vi.fn(async () => null);
    const { result: hook } = renderHook(() => useSunBudget(departure, false, ok, search, walkFor));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-73.99, 40.75]);
    });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    act(() => hook.current.showWalk({ lo: 1, hi: 2 }));
    await waitFor(() => expect(hook.current.walk).toBe("none"));
  });

  it("says uncovered outside the shade table and never searches", async () => {
    const search = vi.fn<Search>();
    const uncovered = async (): Promise<BuiltReachGraph> => ({ status: "uncovered", reason: "outside the shade table" });
    const { result: hook } = renderHook(() => useSunBudget(departure, false, uncovered, search));
    act(() => {
      hook.current.enter();
      hook.current.setStart([-87.6, 41.9]);
    });
    await waitFor(() => expect(hook.current.status).toBe("uncovered"));
    expect(search).not.toHaveBeenCalled();
  });
});

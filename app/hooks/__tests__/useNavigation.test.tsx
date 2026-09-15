/* @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteOption } from "../../lib/routing";
import type { SavedRoute } from "../../lib/savedRoutes";
import { downloadBlob } from "../../lib/exportRoute";
import { geocodeReverse } from "../../lib/nominatim";
import { fetchRoutingGraph } from "../../lib/overpass";
import {
  sampleBuildingMaskBothSidewalks,
} from "../../lib/shadowSampling";
import { useNavigation } from "../useNavigation";

vi.mock("../../lib/nominatim", () => ({
  geocodeReverse: vi.fn(),
}));

vi.mock("../../lib/overpass", async () => {
  const actual = await vi.importActual<typeof import("../../lib/overpass")>(
    "../../lib/overpass",
  );
  return { ...actual, fetchRoutingGraph: vi.fn(), fetchStationEntrances: vi.fn() };
});

/**
 * The shadow field, swappable per test. `vi.hoisted` because `vi.mock`'s factory runs
 * when `useNavigation` is first imported, before this file's own consts initialise.
 */
const shadowStub = vi.hoisted(() => ({
  coverage: { source: "tiles" as string, confidence: 0.8 },
  /** Per-edge answers, in the order `sampleEdges` was handed them. */
  edgeShadow: [] as Array<{ left: number; right: number; source: string; confidence: number }>,
  readyError: null as Error | null,
  readyGate: null as Promise<void> | null,
  readyCalls: [] as Array<{
    kind: "broad" | "edges";
    options?: { signal?: AbortSignal; deadlineAt?: number };
  }>,
  sampledBatchSizes: [] as number[],
}));

vi.mock("../../lib/shadowField/ShadowField", async () => {
  const actual = await vi.importActual<typeof import("../../lib/shadowField/ShadowField")>(
    "../../lib/shadowField/ShadowField",
  );
  return {
    ...actual,
    createGeometryShadowField: () => ({
      shadowAt: () => ({ shadow: 0, source: "none", confidence: 0 }),
      sweep: () => [],
      coverage: () => shadowStub.coverage,
      sampleEdges: (edges: unknown[]) => {
        shadowStub.sampledBatchSizes.push(edges.length);
        return edges.map((_, i) => shadowStub.edgeShadow[i] ?? shadowStub.edgeShadow[0]);
      },
      ready: async (_bbox: unknown, options?: { signal?: AbortSignal; deadlineAt?: number }) => {
        shadowStub.readyCalls.push({ kind: "broad", options });
        if (shadowStub.readyGate) {
          await Promise.race([
            shadowStub.readyGate,
            new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        }
        if (shadowStub.readyError) throw shadowStub.readyError;
      },
      readyEdges: async (_edges: unknown, options?: { signal?: AbortSignal; deadlineAt?: number }) => {
        shadowStub.readyCalls.push({ kind: "edges", options });
        if (shadowStub.readyGate) {
          await Promise.race([
            shadowStub.readyGate,
            new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
        }
        if (shadowStub.readyError) throw shadowStub.readyError;
      },
      coverageEdges: () => shadowStub.coverage,
    }),
  };
});

vi.mock("../../lib/shadowSampling", async () => {
  const actual = await vi.importActual<typeof import("../../lib/shadowSampling")>(
    "../../lib/shadowSampling",
  );
  return {
    ...actual,
    sampleBuildingMaskBothSidewalks: vi.fn(actual.sampleBuildingMaskBothSidewalks),
  };
});

vi.mock("../../lib/exportRoute", async () => {
  const actual = await vi.importActual<typeof import("../../lib/exportRoute")>(
    "../../lib/exportRoute",
  );
  return {
    ...actual,
    downloadBlob: vi.fn(),
  };
});

function line(coordinates: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
}

function route(label = "Shortest", shadowCoverage = 0.4): RouteOption {
  return {
    label,
    geojson: line([
      [103.8, 1.3],
      [103.81, 1.31],
    ]),
    distanceM: 1000,
    shadowCoverage,
    longestContinuousShadowM: 120,
    longestContinuousSunM: 40,
    shadowTransitions: 2,
    detourRatio: 1,
    turnCount: 3,
  };
}

function savedRoute(routeOption: RouteOption): SavedRoute {
  return {
    id: "saved-1",
    name: routeOption.label,
    folderId: null,
    routeOption,
    waypointA: [103.8, 1.3],
    waypointB: [103.9, 1.35],
    waypointALabel: "Start",
    waypointBLabel: "End",
    additionalWaypoints: [[103.85, 1.32]],
    timeOfDayMinutes: 9 * 60 + 30,
    dateIso: "2026-08-16",
    createdAt: 1,
  };
}

function renderUseNavigation() {
  return renderHook(() =>
    useNavigation({
      mapRef: { current: null },
      dateRef: { current: new Date("2026-08-16T12:00:00Z") },
      setDate: vi.fn(),
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(geocodeReverse).mockResolvedValue("Reverse geocode label");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useNavigation", () => {
  it("places waypoint A from a pending map click and advances to waypoint B", async () => {
    const { result } = renderUseNavigation();

    act(() => result.current.setPendingSlot("A"));
    act(() => result.current.handleMapClick({ lng: 103.8, lat: 1.3 }));

    expect(result.current.waypointA).toEqual([103.8, 1.3]);
    expect(result.current.waypointALabel).toBe("1.300, 103.800");
    expect(result.current.pendingSlot).toBe("B");

    await waitFor(() => {
      expect(result.current.waypointALabel).toBe("Reverse geocode label");
    });
  });

  it("loads a saved transit route and derives walk-rendered route geometry", () => {
    const transitRoute = route("Via Transit", 0.25);
    transitRoute.legs = [
      { type: "walk", geojson: line([[103.8, 1.3], [103.81, 1.31]]) },
      {
        type: "transit",
        geojson: line([[103.81, 1.31], [103.88, 1.34]]),
        travelTimeSec: 600,
      },
      { type: "walk", geojson: line([[103.88, 1.34], [103.9, 1.35]]) },
    ];
    transitRoute.trainDrawData = {
      polylines: [],
      stops: [],
      transfers: [],
    };

    const { result } = renderUseNavigation();

    act(() => result.current.handleRouteModeChange("transit"));
    act(() => result.current.handleLoadRoute(savedRoute(transitRoute)));

    expect(result.current.navRoutes).toEqual([transitRoute]);
    expect(result.current.filteredRoutes).toEqual([transitRoute]);
    expect(result.current.selectedNavRoute).toEqual({
      type: "FeatureCollection",
      features: [transitRoute.legs[0].geojson, transitRoute.legs[2].geojson],
    });
    expect(result.current.navTrainDrawData).toBe(transitRoute.trainDrawData);
    expect(result.current.additionalWaypoints).toEqual([[103.85, 1.32]]);
    expect(result.current.canTransit).toBe(true);

    act(() => result.current.handleRouteModeChange("walk"));

    expect(result.current.navRoutes).toEqual([]);
    expect(result.current.filteredRoutes).toEqual([]);
  });

  it("warns instead of exporting an incomplete partial route", () => {
    const partialRoute = route("Partial", 0.6);
    partialRoute.partial = { completedLegs: 1, failedLeg: 2, totalLegs: 3 };
    const { result } = renderUseNavigation();

    act(() => result.current.handleLoadRoute(savedRoute(partialRoute)));
    act(() => result.current.handleExportRoute(0, "geojson"));

    expect(downloadBlob).not.toHaveBeenCalled();
    expect(result.current.navWarning).toBe(
      "Could not finish leg 2 of 3; showing 1 completed leg.",
    );
  });

  it("clears route and sketch state when navigation is reset", () => {
    const { result } = renderUseNavigation();

    act(() => result.current.handleLoadRoute(savedRoute(route())));
    act(() => result.current.handleAddAdditionalWaypoint([103.82, 1.31]));
    act(() => result.current.handleDrawModeToggle());
    act(() => result.current.handleSketchPointClick([103.83, 1.32]));

    expect(result.current.navRoutes).toHaveLength(0);
    expect(result.current.additionalWaypoints).toEqual([[103.85, 1.32], [103.82, 1.31]]);
    expect(result.current.drawMode).toBe(true);
    expect(result.current.sketchPoints).toHaveLength(1);

    act(() => result.current.handleClear());

    expect(result.current.waypointA).toBeNull();
    expect(result.current.waypointB).toBeNull();
    expect(result.current.additionalWaypoints).toEqual([]);
    expect(result.current.navRoutes).toEqual([]);
    expect(result.current.drawMode).toBe(false);
    expect(result.current.sketchPoints).toEqual([]);
    expect(result.current.selectedNavRoute).toBeNull();
  });
});

describe("terminal agent route jobs", () => {
  beforeEach(() => resetShadowStub());

  it("awaits a completed multi-stop pipeline result with metrics and provenance", async () => {
    vi.mocked(fetchRoutingGraph).mockResolvedValue(threeNodeGraph() as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    const request = result.current.createRoutePlanRequest({
      from: [103.8, 1.3], to: [103.801, 1.301], via: [[103.8005, 1.3005]], fromLabel: "Start", toLabel: "End",
    });
    let terminal: Awaited<ReturnType<typeof result.current.submitRoutePlan>>;
    await act(async () => { terminal = await result.current.submitRoutePlan(request); });

    expect(terminal!).toMatchObject({
      status: "completed", requestId: request.requestId, inputVersion: request.inputVersion,
      planRevision: request.planRevision, actionId: request.actionId, retry: request.retry,
      metrics: [expect.objectContaining({ distanceM: expect.any(Number) })],
    });
    expect(result.current.additionalWaypoints).toEqual([[103.8005, 1.3005]]);
    expect(result.current.navRoutes).not.toEqual([]);
  });

  it("rejects a request after the application route plan has been edited", async () => {
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    let request!: ReturnType<typeof result.current.createRoutePlanRequest>;
    act(() => {
      request = result.current.createRoutePlanRequest({
        from: [103.8, 1.3], to: [103.801, 1.301], via: [], fromLabel: "Start", toLabel: "End",
      });
    });
    act(() => result.current.handleSetWaypointA([103.802, 1.302], "Edited start"));
    let terminal!: Awaited<ReturnType<typeof result.current.submitRoutePlan>>;
    await act(async () => { terminal = await result.current.submitRoutePlan(request); });

    expect(terminal).toMatchObject({ status: "cancelled", reason: "superseded", planRevision: request.planRevision });
    expect(result.current.navRoutes).toEqual([]);
  });

  it("makes explicit route-job cancellation terminal at the navigation boundary", async () => {
    let releaseGraph!: (graph: ReturnType<typeof threeNodeGraph>) => void;
    vi.mocked(fetchRoutingGraph).mockImplementationOnce(() => new Promise((resolve) => { releaseGraph = resolve; }) as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    let request!: ReturnType<typeof result.current.createRoutePlanRequest>;
    let terminal!: ReturnType<typeof result.current.submitRoutePlan>;
    act(() => {
      request = result.current.createRoutePlanRequest({ from: [103.8, 1.3], to: [103.801, 1.301], via: [], fromLabel: "Start", toLabel: "End" });
      terminal = result.current.submitRoutePlan(request);
    });
    await waitFor(() => expect(fetchRoutingGraph).toHaveBeenCalledTimes(1));
    expect(result.current.cancelRoutePlan(request.requestId)).toBe(true);
    releaseGraph(threeNodeGraph());

    await expect(terminal).resolves.toMatchObject({ status: "cancelled", reason: "cancelled" });
  });

  it("deduplicates only a concurrent submission of the same navigation action", async () => {
    let releaseGraph!: (graph: ReturnType<typeof threeNodeGraph>) => void;
    vi.mocked(fetchRoutingGraph).mockImplementationOnce(() => new Promise((resolve) => { releaseGraph = resolve; }) as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    let request!: ReturnType<typeof result.current.createRoutePlanRequest>;
    let first!: ReturnType<typeof result.current.submitRoutePlan>;
    let duplicate!: ReturnType<typeof result.current.submitRoutePlan>;
    act(() => {
      request = result.current.createRoutePlanRequest({ from: [103.8, 1.3], to: [103.801, 1.301], via: [], fromLabel: "Start", toLabel: "End" });
      first = result.current.submitRoutePlan(request);
      duplicate = result.current.submitRoutePlan(request);
    });
    expect(duplicate).toBe(first);
    await waitFor(() => expect(fetchRoutingGraph).toHaveBeenCalledTimes(1));
    expect(result.current.cancelRoutePlan(request.requestId)).toBe(true);
    releaseGraph(threeNodeGraph());
    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    expect(fetchRoutingGraph).toHaveBeenCalledTimes(1);
  });

  it("clears a completed action lease so an identical route recomputes against current map state", async () => {
    let releaseFirstGraph!: (graph: ReturnType<typeof threeNodeGraph>) => void;
    vi.mocked(fetchRoutingGraph)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstGraph = resolve; }) as never)
      .mockResolvedValueOnce(threeNodeGraph() as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    const plan = { from: [103.8, 1.3] as [number, number], to: [103.801, 1.301] as [number, number], via: [], fromLabel: "Start", toLabel: "End" };
    let firstRequest!: ReturnType<typeof result.current.createRoutePlanRequest>;
    let firstTerminal!: ReturnType<typeof result.current.submitRoutePlan>;
    act(() => {
      firstRequest = result.current.createRoutePlanRequest(plan);
      firstTerminal = result.current.submitRoutePlan(firstRequest);
    });
    await waitFor(() => expect(fetchRoutingGraph).toHaveBeenCalledTimes(1));
    act(() => result.current.handleClear());
    releaseFirstGraph(threeNodeGraph());
    await expect(firstTerminal).resolves.toMatchObject({ status: "cancelled", reason: "superseded" });

    let secondRequest!: ReturnType<typeof result.current.createRoutePlanRequest>;
    let secondTerminal!: Awaited<ReturnType<typeof result.current.submitRoutePlan>>;
    act(() => { secondRequest = result.current.createRoutePlanRequest(plan); });
    await act(async () => { secondTerminal = await result.current.submitRoutePlan(secondRequest); });

    expect(secondRequest.actionId).not.toBe(firstRequest.actionId);
    expect(secondRequest.idempotencyKey).not.toBe(firstRequest.idempotencyKey);
    expect(secondTerminal).toMatchObject({ status: "completed", planRevision: secondRequest.planRevision });
    expect(fetchRoutingGraph).toHaveBeenCalledTimes(2);
  });

  it("reports an unroutable leg as partial instead of dropping it", async () => {
    const disconnected = threeNodeGraph();
    disconnected.nodes.set(4, { id: 4, lat: 1.31, lon: 103.81 });
    disconnected.nodes.set(5, { id: 5, lat: 1.3105, lon: 103.8105 });
    disconnected.adj.set(4, [{ toId: 5, distanceM: 75 }]);
    disconnected.adj.set(5, [{ toId: 4, distanceM: 75 }]);
    vi.mocked(fetchRoutingGraph).mockResolvedValue(disconnected as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    const request = result.current.createRoutePlanRequest({
      from: [103.8, 1.3], to: [103.81, 1.31], via: [[103.8005, 1.3005]], fromLabel: "Start", toLabel: "End",
    });
    let terminal: Awaited<ReturnType<typeof result.current.submitRoutePlan>>;
    await act(async () => { terminal = await result.current.submitRoutePlan(request); });

    expect(terminal!).toMatchObject({
      status: "partial",
      unroutableLegs: [expect.objectContaining({ failedLeg: 2, totalLegs: 2 })],
    });
    expect(result.current.navRoutes[0]?.partial).toMatchObject({ failedLeg: 2, totalLegs: 2 });
  });

  it("returns no_plan_found when no connected route exists", async () => {
    const disconnected = threeNodeGraph();
    disconnected.nodes.set(4, { id: 4, lat: 1.31, lon: 103.81 });
    disconnected.nodes.set(5, { id: 5, lat: 1.3105, lon: 103.8105 });
    disconnected.adj.set(4, [{ toId: 5, distanceM: 75 }]);
    disconnected.adj.set(5, [{ toId: 4, distanceM: 75 }]);
    vi.mocked(fetchRoutingGraph).mockResolvedValue(disconnected as never);
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }) });
    const { result } = renderHook(() => useNavigation({
      mapRef: { current: map as never }, dateRef: { current: new Date("2026-08-16T04:00:00Z") }, setDate: vi.fn(),
    }));
    const request = result.current.createRoutePlanRequest({
      from: [103.8, 1.3], to: [103.81, 1.31], via: [], fromLabel: "Start", toLabel: "End",
    });
    let terminal: Awaited<ReturnType<typeof result.current.submitRoutePlan>>;
    await act(async () => { terminal = await result.current.submitRoutePlan(request); });

    expect(terminal!).toMatchObject({ status: "no_plan_found" });
  });
});

// ─── Flat shadow readback (#154) ───────────────────────────────────────────────

/**
 * The shadow sampler classifies blue-dominant pixels as shadow and the shadow layer
 * paints buildings with that same field, so the canvas has to be read at pitch 0
 * or an occluded sidewalk scores shadowed. These drive `calculateRoute` far enough
 * to reach the readback and assert what the camera was doing when it happened.
 */

type FakeBounds = { west: number; south: number; east: number; north: number };

interface FakeMapOptions {
  pitch: number;
  /** Bounds by pitch — a tilted camera sees a larger box than a flat one. */
  boundsAtPitch: (pitch: number) => FakeBounds;
  /** When false, `idle` never fires — as during timeline playback. */
  emitIdle?: boolean;
}

function fakeMap(opts: FakeMapOptions) {
  const log: string[] = [];
  let pitch = opts.pitch;
  const idleHandlers: Array<() => void> = [];

  const map = {
    getPitch: () => pitch,
    getZoom: () => 16,
    // Only camera moves that touch pitch are what these tests are about; the
    // waypoint helpers also `jumpTo` a centre and zoom, which is noise here.
    jumpTo: (camera: { pitch?: number }) => {
      if (camera.pitch === undefined) return;
      pitch = camera.pitch;
      log.push(`jumpTo(${camera.pitch})`);
    },
    easeTo: (camera: { pitch?: number }) => {
      if (camera.pitch === undefined) return;
      pitch = camera.pitch;
      log.push(`easeTo(${camera.pitch})`);
    },
    getBounds: () => {
      const b = opts.boundsAtPitch(pitch);
      return {
        getWest: () => b.west,
        getSouth: () => b.south,
        getEast: () => b.east,
        getNorth: () => b.north,
      };
    },
    fitBounds: () => log.push("fitBounds"),
    once: (event: string, cb: () => void) => {
      if (event !== "idle") return;
      if (opts.emitIdle === false) idleHandlers.push(cb);
      else setTimeout(cb, 0);
    },
    off: () => {},
    getCanvas: () => {
      log.push(`getCanvas@pitch${pitch}`);
      return { width: 8, height: 8 } as unknown as HTMLCanvasElement;
    },
    project: () => ({ x: 0, y: 0 }),
    querySourceFeatures: () => [],
  };

  return { map, log, idleHandlers, getPitch: () => pitch };
}

/** jsdom has no 2D context, and the readback needs one. */
function stubCanvas2d() {
  const proto = window.HTMLCanvasElement.prototype as unknown as {
    getContext: unknown;
  };
  const original = proto.getContext;
  proto.getContext = () => ({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
  });
  return () => {
    proto.getContext = original;
  };
}

/** Two nodes joined by one edge — enough to reach and exercise the readback. */
function twoNodeGraph() {
  return {
    nodes: new Map([
      [1, { id: 1, lat: 1.3, lon: 103.8 }],
      [2, { id: 2, lat: 1.301, lon: 103.801 }],
    ]),
    adj: new Map([
      [1, [{ toId: 2, distanceM: 150 }]],
      [2, [{ toId: 1, distanceM: 150 }]],
    ]),
  };
}

async function runRouteWith(map: unknown) {
  const { result } = renderHook(() =>
    useNavigation({
      mapRef: { current: map as never },
      shadowLayerRef: {
        current: {
          readBuildingShadowMask: () => {
            (map as { getCanvas(): unknown }).getCanvas();
            return {
              data: new Uint8Array(64),
              width: 8,
              height: 8,
              pixelRatioX: 1,
              pixelRatioY: 1,
            };
          },
        } as never,
      },
      dateRef: { current: new Date("2026-08-16T04:00:00Z") },
      setDate: vi.fn(),
    }),
  );

  act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
  act(() => result.current.handleSetWaypointB([103.801, 1.301], "End"));

  await act(async () => {
    result.current.handleCalculateRoute();
  });
  await waitFor(() => expect(result.current.isCalculating).toBe(false), {
    timeout: 4000,
  });
  return result;
}

/** The field answers confidently from tiles unless a test says otherwise. */
function resetShadowStub() {
  shadowStub.coverage = { source: "tiles", confidence: 0.8 };
  shadowStub.edgeShadow = [{ left: 1, right: 1, source: "tiles", confidence: 0.8 }];
  shadowStub.readyError = null;
  shadowStub.readyGate = null;
  shadowStub.readyCalls = [];
  shadowStub.sampledBatchSizes = [];
  vi.mocked(sampleBuildingMaskBothSidewalks).mockClear();
}

/** Three nodes in a line — two undirected edges, so "only that edge" is testable. */
function threeNodeGraph() {
  return {
    nodes: new Map([
      [1, { id: 1, lat: 1.3, lon: 103.8 }],
      [2, { id: 2, lat: 1.3005, lon: 103.8005 }],
      [3, { id: 3, lat: 1.301, lon: 103.801 }],
    ]),
    adj: new Map([
      [1, [{ toId: 2, distanceM: 75 }]],
      [2, [{ toId: 1, distanceM: 75 }, { toId: 3, distanceM: 75 }]],
      [3, [{ toId: 2, distanceM: 75 }]],
    ]),
  };
}

describe("flat shadow readback (#154)", () => {
  let restoreCanvas: () => void;

  beforeEach(() => {
    restoreCanvas = stubCanvas2d();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(twoNodeGraph() as never);
    resetShadowStub();
    // These tests are about the canvas path, so keep the field unable to answer.
    shadowStub.coverage = { source: "none", confidence: 0 };
    shadowStub.edgeShadow = [{ left: 0, right: 0, source: "none", confidence: 0 }];
  });

  afterEach(() => restoreCanvas());

  // A generous box, in view at every pitch, so `fitBounds` is not what is under test.
  const wideBounds = () => ({ west: 100, south: -1, east: 107, north: 5 });

  it("reads the canvas flat and gives the tilt back", async () => {
    const { map, log } = fakeMap({ pitch: 55, boundsAtPitch: wideBounds });

    await runRouteWith(map);

    const flattened = log.indexOf("jumpTo(0)");
    const read = log.findIndex((entry) => entry.startsWith("getCanvas@"));
    expect(flattened).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(flattened);
    expect(log[read]).toBe("getCanvas@pitch0");
    expect(log.slice(read)).toContain("easeTo(55)");
  });

  it("leaves an already-flat camera alone", async () => {
    const { map, log } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    await runRouteWith(map);

    expect(log.filter((entry) => entry.startsWith("jumpTo"))).toEqual([]);
    expect(log.filter((entry) => entry.startsWith("easeTo"))).toEqual([]);
    expect(log).toContain("getCanvas@pitch0");
  });

  it("re-tests the route bbox against the flat camera, not the tilted one", async () => {
    // Tilted the map sees the whole region; flat it sees almost nothing. The old
    // code asked the tilted camera, skipped `fitBounds`, and then sampled a canvas
    // that did not contain the route.
    const { map, log } = fakeMap({
      pitch: 55,
      boundsAtPitch: (pitch) =>
        pitch > 0
          ? { west: 100, south: -1, east: 107, north: 5 }
          : { west: 103.7999, south: 1.2999, east: 103.8001, north: 1.3001 },
    });

    await runRouteWith(map);

    // `fitMapToRoute` also fits at the end, so the claim has to be that a fit
    // happened *before* the readback — otherwise this passes for the wrong reason.
    const read = log.findIndex((entry) => entry.startsWith("getCanvas@"));
    const fitBeforeRead = log.slice(0, read).indexOf("fitBounds");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(fitBeforeRead).toBeGreaterThan(log.indexOf("jumpTo(0)"));
  });

  it("leaves the camera alone entirely when the graph fetch fails", async () => {
    // A4b moved the flatten after the graph fetch, so a fetch that never returns a
    // graph no longer disturbs the camera at all. That is strictly stronger than
    // #154's guarantee — there is no tilt to give back because none was taken.
    vi.mocked(fetchRoutingGraph).mockRejectedValue(new Error("Overpass is down"));
    const { map, log } = fakeMap({ pitch: 60, boundsAtPitch: wideBounds });

    await runRouteWith(map);

    expect(log).not.toContain("jumpTo(0)");
    expect(map.getPitch()).toBe(60);
  });

  it("reads the canvas anyway when idle never arrives", async () => {
    // The timeline's play mode repaints every 50 ms, so `idle` never fires.
    const { map, log } = fakeMap({
      pitch: 45,
      boundsAtPitch: wideBounds,
      emitIdle: false,
    });

    await runRouteWith(map);

    expect(log).toContain("getCanvas@pitch0");
    expect(log).toContain("easeTo(45)");
  });
});


describe("routing reads the shadow field (A4b)", () => {
  let restoreCanvas: () => void;

  beforeEach(() => {
    restoreCanvas = stubCanvas2d();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(twoNodeGraph() as never);
    resetShadowStub();
  });

  afterEach(() => restoreCanvas());

  const wideBounds = () => ({ west: 100, south: -1, east: 107, north: 5 });

  // A box far too small to contain the route, so the canvas path is obliged to fit
  // the camera onto it before reading. That is what makes the next test's claim mean
  // something: with geometry available, that fit must not happen.
  const narrowBounds = () => ({ west: 103.7999, south: 1.2999, east: 103.8001, north: 1.3001 });

  it("never touches the canvas or the camera when geometry covers the route", async () => {
    const { map, log } = fakeMap({ pitch: 0, boundsAtPitch: narrowBounds });

    const result = await runRouteWith(map);

    expect(log.some((entry) => entry.startsWith("getCanvas@"))).toBe(false);
    expect(vi.mocked(sampleBuildingMaskBothSidewalks)).not.toHaveBeenCalled();
    // The only fit is `fitMapToRoute` showing the finished route.
    expect(log.filter((entry) => entry === "fitBounds")).toHaveLength(1);
    expect(result.current.navRoutes.length).toBeGreaterThan(0);
  });

  it("does fit and read when geometry cannot answer, so the last test discriminates", async () => {
    shadowStub.coverage = { source: "none", confidence: 0 };
    shadowStub.edgeShadow = [{ left: 0, right: 0, source: "none", confidence: 0 }];
    const { map, log } = fakeMap({ pitch: 0, boundsAtPitch: narrowBounds });

    await runRouteWith(map);

    expect(log.some((entry) => entry.startsWith("getCanvas@"))).toBe(true);
    expect(log.filter((entry) => entry === "fitBounds")).toHaveLength(2);
  });

  it("routes on the field's own left/right values", async () => {
    shadowStub.edgeShadow = [{ left: 1, right: 1, source: "tiles", confidence: 0.8 }];
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    const result = await runRouteWith(map);

    // Fully shadowed sidewalks on the only edge there is, so the route inherits it.
    expect(result.current.navRoutes[0].shadowCoverage).toBe(1);
    expect(result.current.navRoutes[0].shadowSource?.dominant).toBe("tiles");
  });

  it("falls back to pixels for a weak edge and only that edge", async () => {
    vi.mocked(fetchRoutingGraph).mockResolvedValue(threeNodeGraph() as never);
    shadowStub.coverage = { source: "tiles", confidence: 0.2 }; // so a canvas exists
    shadowStub.edgeShadow = [
      { left: 1, right: 1, source: "tiles", confidence: 0.8 },
      { left: 0, right: 0, source: "tiles", confidence: 0.2 },
    ];
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    const result = await runRouteWith(map);

    expect(vi.mocked(sampleBuildingMaskBothSidewalks)).toHaveBeenCalledTimes(1);
    expect(result.current.navRoutes[0].shadowSource?.bySource.canvas).toBeGreaterThan(0);
    expect(result.current.navRoutes[0].shadowSource?.bySource.tiles).toBeGreaterThan(0);
  });

  it("still routes, from the map view, when no geometry resolves at all", async () => {
    shadowStub.coverage = { source: "none", confidence: 0 };
    shadowStub.edgeShadow = [{ left: 0, right: 0, source: "none", confidence: 0 }];
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    const result = await runRouteWith(map);

    expect(result.current.navRoutes.length).toBeGreaterThan(0);
    expect(result.current.navRoutes[0].shadowSource?.dominant).toBe("canvas");
  });

  it("hands the whole edge set to the field in one batch", async () => {
    vi.mocked(fetchRoutingGraph).mockResolvedValue(threeNodeGraph() as never);
    shadowStub.edgeShadow = [{ left: 0, right: 0, source: "tiles", confidence: 0.8 }];
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    await runRouteWith(map);

    // Slicing the batch would rebuild the field's internal per-cell shadow indices.
    expect(shadowStub.sampledBatchSizes).toEqual([2]);
  });

  it("routes anyway when the geometry preload fails", async () => {
    // Overpass rate-limits constantly; that is a reason to fall back, not to fail.
    shadowStub.readyError = new Error("429 Too Many Requests");
    shadowStub.coverage = { source: "none", confidence: 0 };
    shadowStub.edgeShadow = [{ left: 0, right: 0, source: "none", confidence: 0 }];
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    const result = await runRouteWith(map);

    expect(result.current.navError).toBeNull();
    expect(result.current.navRoutes.length).toBeGreaterThan(0);
  });

  it("passes one route signal and absolute deadline to both readiness phases", async () => {
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    await runRouteWith(map);

    expect(shadowStub.readyCalls.map((call) => call.kind)).toEqual([
      "broad",
      "edges",
    ]);
    const [broad, edges] = shadowStub.readyCalls;
    expect(broad.options?.signal).toBe(edges.options?.signal);
    expect(broad.options?.deadlineAt).toBe(edges.options?.deadlineAt);
    expect(broad.options?.deadlineAt).toBeGreaterThan(Date.now());
  });

  it("aborts readiness on graph failure without hiding the graph error", async () => {
    shadowStub.readyGate = new Promise<void>(() => {});
    vi.mocked(fetchRoutingGraph).mockRejectedValue(new Error("Overpass is down"));
    const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });

    const result = await runRouteWith(map);

    expect(shadowStub.readyCalls).toHaveLength(1);
    expect(shadowStub.readyCalls[0].options?.signal?.aborted).toBe(true);
    expect(result.current.navError).toBe("Overpass is down");
  });

  it("writes nothing when cancelled during the geometry preload", async () => {
    let openGate: () => void = () => {};
    shadowStub.readyGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { map, log } = fakeMap({ pitch: 60, boundsAtPitch: wideBounds });

    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.801, 1.301], "End"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });

    await waitFor(() => expect(shadowStub.readyCalls.length).toBeGreaterThan(0));

    act(() => result.current.handleClearWaypointA());
    expect(
      shadowStub.readyCalls.every((call) => call.options?.signal?.aborted),
    ).toBe(true);
    await act(async () => openGate());

    expect(result.current.navRoutes).toEqual([]);
    // Nothing was flattened, so the finally has no tilt to give back.
    expect(log).not.toContain("jumpTo(0)");
    expect(map.getPitch()).toBe(60);
  });
});

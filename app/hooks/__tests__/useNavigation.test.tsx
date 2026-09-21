/* @vitest-environment jsdom */
import { token } from "../../lib/css-tokens";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteOption } from "../../lib/routing";
import { haversineMeters } from "../../lib/routing";
import type { SavedRoute } from "../../lib/savedRoutes";
import { downloadBlob } from "../../lib/exportRoute";
import { geocodeReverse } from "../../lib/nominatim";
import {
  fetchRoutingGraph,
  fetchStationEntrances,
  fetchStationEntranceBoxes,
} from "../../lib/overpass";
import { fetchBestTrainGraph } from "../../lib/transit/trainGraphSource";
import { clearNavigationCache } from "../../lib/navigationData/remoteNavigation";
import { fetchBestRoutingGraph } from "../../lib/navigationData/routingGraphSource";
import { bboxAroundEdges, QUERY_PAD_M } from "../../lib/shadowField/ShadowField";
import { MIN_TRANSIT_DISTANCE_M } from "../../lib/trainGraph";
import {
  sampleBuildingMaskBothSidewalks,
} from "../../lib/shadowSampling";
import { useNavigation } from "../useNavigation";
import { isShadowV2DebugEnabled } from "../../lib/shadowV2Debug/RemoteTileService";

vi.mock("../../lib/nominatim", () => ({
  geocodeReverse: vi.fn(),
}));

vi.mock("../../lib/transit/trainGraphSource", () => ({
  fetchBestTrainGraph: vi.fn(),
}));

vi.mock("../../lib/overpass", async () => {
  const actual = await vi.importActual<typeof import("../../lib/overpass")>(
    "../../lib/overpass",
  );
  return {
    ...actual,
    fetchRoutingGraph: vi.fn(),
    fetchStationEntrances: vi.fn(),
    fetchStationEntranceBoxes: vi.fn(),
  };
});
vi.mock("../../lib/navigationData/routingGraphSource", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/navigationData/routingGraphSource")
  >("../../lib/navigationData/routingGraphSource");
  return {
    ...actual,
    fetchBestRoutingGraph: vi.fn(actual.fetchBestRoutingGraph),
  };
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
    /** The bbox of a `ready` preload, recorded so tests can pin exact areas. */
    bbox?: unknown;
    options?: { signal?: AbortSignal; deadlineAt?: number };
  }>,
  sampledBatchSizes: [] as number[],
}));

afterEach(() => vi.unstubAllEnvs());

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
        shadowStub.readyCalls.push({ kind: "broad", bbox: _bbox, options });
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

describe("flat shadow readback (issue 154)", () => {
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

  it("keeps renderer-owned readback and route scoring identical with debug on or off", async () => {
    // The diagnostic is a MapLibre custom layer, never an IShadowLayer. This
    // checks the actual routing seam: both runs consume only the renderer-owned
    // readBuildingShadowMask and must produce the same scored route.
    const score = async (flag: "true" | "false") => {
      vi.stubEnv("VITE_SHADOW_V2_DEBUG", flag);
      expect(isShadowV2DebugEnabled(flag)).toBe(flag === "true");
      resetShadowStub();
      shadowStub.coverage = { source: "none", confidence: 0 };
      shadowStub.edgeShadow = [{ left: 0.25, right: 0.75, source: "none", confidence: 0 }];
      const { map } = fakeMap({ pitch: 0, boundsAtPitch: wideBounds });
      const result = await runRouteWith(map);
      return result.current.navRoutes.map((route) => ({
        distanceM: route.distanceM, shadowCoverage: route.shadowCoverage,
        longestContinuousShadowM: route.longestContinuousShadowM, shadowSource: route.shadowSource,
      }));
    };
    const off = await score("false");
    const on = await score("true");
    expect(on).toEqual(off);
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
    // The pipeline's own batch is the first call; later calls (if any) are the
    // post-landing conditions refresh (routeExposureRefresh), which re-samples
    // the chosen path's own edges — never a second pipeline batch.
    expect(shadowStub.sampledBatchSizes[0]).toBe(2);
    for (const size of shadowStub.sampledBatchSizes.slice(1)) expect(size).toBeLessThan(2);
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


// ─── #395: which array an index from the panel refers to ────────────────────

/**
 * Four nodes in a line, ~1.1 km end to end — far enough apart that the pipeline
 * looks for a transit option at all (it skips under 500 m).
 */
function transitCorridorGraph() {
  const node = (id: number, lon: number) => [id, { id, lat: 1.3, lon }] as const;
  const hop = (toId: number, distanceM: number) => ({ toId, distanceM });
  return {
    nodes: new Map([node(1, 103.8), node(2, 103.803), node(3, 103.807), node(4, 103.81)]),
    adj: new Map([
      [1, [hop(2, 334)]],
      [2, [hop(1, 334), hop(3, 445)]],
      [3, [hop(2, 445), hop(4, 334)]],
      [4, [hop(3, 334)]],
    ]),
  };
}

/** Three stations sitting on that corridor, on one line. */
function corridorTrainGraph() {
  const station = (id: string, name: string, lon: number) => ({ id, name, lat: 1.3, lon, lines: ["T"] });
  const rail = (to: string) => ({ to, weightSec: 60, type: "rail" as const, line: "T" });
  return {
    stations: new Map([
      ["subway:1", station("subway:1", "Alpha", 103.803)],
      ["subway:2", station("subway:2", "Beta", 103.805)],
      ["subway:3", station("subway:3", "Gamma", 103.807)],
    ]),
    adj: new Map([
      ["subway:1", [rail("subway:2")]],
      ["subway:2", [rail("subway:1"), rail("subway:3")]],
      ["subway:3", [rail("subway:2")]],
    ]),
    lineColors: new Map([["T", token("color-route")]]),
    lineNames: new Map([["T", "Test Line"]]),
    lineModes: new Map([["T", "subway" as const]]),
  };
}

describe("a route index from the panel resolves against the list the panel shows (issue 395)", () => {
  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({ entrances: [], failed: false } as never);
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
  });

  async function calculateInTransitMode() {
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64),
              width: 8,
              height: 8,
              pixelRatioX: 1,
              pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });
    return result;
  }

  it("draws the transit route the card describes, not a walk route", async () => {
    const result = await calculateInTransitMode();

    // The state that hid this bug: both kinds live in `navRoutes`, and the
    // transit one is NOT at `selectedRouteIndex`.
    expect(result.current.navRoutes.length).toBeGreaterThan(1);
    expect(result.current.filteredRoutes).toHaveLength(1);
    expect(result.current.selectedRouteIndex).toBe(0);
    expect(result.current.navRoutes.indexOf(result.current.filteredRoutes[0])).toBeGreaterThan(0);

    const transitRoute = result.current.filteredRoutes[0];
    // Named by mode since 3C: subway and bus are offered as separate cards.
    expect(transitRoute.label).toBe("Via Subway");
    // Resolved against `navRoutes`, all three of these come back for a walk
    // route: null draw data, null entrances, and the wrong geometry.
    expect(result.current.navTrainDrawData).toBe(transitRoute.trainDrawData);
    expect(result.current.navTrainDrawData).not.toBeNull();
    expect(result.current.navMrtEntrances).toBe(transitRoute.mrtEntrances);
    expect(result.current.selectedNavRoute).toEqual({
      type: "FeatureCollection",
      features: transitRoute.legs
        ?.filter((l) => l.type === "walk")
        .map((l) => l.geojson),
    });
  });

  it("exports the transit route the card describes", async () => {
    const result = await calculateInTransitMode();
    const transitRoute = result.current.filteredRoutes[0];

    act(() => result.current.handleExportRoute(0, "geojson"));

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(String(filename).toLowerCase()).toContain("subway");
    // Named by mode since 3C: subway and bus are offered as separate cards.
    expect(transitRoute.label).toBe("Via Subway");
  });
});


describe("transit is withheld under MIN_TRANSIT_DISTANCE_M and considered over it", () => {
  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({ entrances: [], failed: false } as never);
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
  });

  /** A point due east of the corridor's start, `metres` away by `haversineMeters`. */
  const eastOfStart = (metres: number): [number, number] => [
    103.8 + (metres / ((6371000 * Math.PI) / 180)) / Math.cos((1.3 * Math.PI) / 180),
    1.3,
  ];

  async function calculateTransitTo(end: [number, number]) {
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64),
              width: 8,
              height: 8,
              pixelRatioX: 1,
              pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB(end, "End"));
    const offered = result.current.canTransit;
    // Asked for anyway, so the pipeline's own gate is tested and not just the picker's.
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });
    return offered;
  }

  it("neither offers nor computes transit just under the threshold", async () => {
    const offered = await calculateTransitTo(eastOfStart(MIN_TRANSIT_DISTANCE_M - 25));
    expect(offered).toBe(false);
    expect(fetchBestTrainGraph).not.toHaveBeenCalled();
  });

  it("offers and computes transit just over it", async () => {
    const offered = await calculateTransitTo(eastOfStart(MIN_TRANSIT_DISTANCE_M + 25));
    expect(offered).toBe(true);
    expect(fetchBestTrainGraph).toHaveBeenCalledTimes(1);
  });
});

describe("entrances are fetched for the chosen stations, not the whole route (issue 401)", () => {
  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({ entrances: [], failed: false } as never);
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
  });

  it("asks for two station-sized boxes in one call, after the route is chosen", async () => {
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    // One request, not one per station.
    expect(fetchStationEntranceBoxes).toHaveBeenCalledTimes(1);
    const [boxes] = vi.mocked(fetchStationEntranceBoxes).mock.calls[0] as [
      { south: number; west: number; north: number; east: number }[],
    ];
    expect(boxes).toHaveLength(2);

    // Each box hugs a station. The route itself spans 0.01 degrees and the old
    // query padded that by 0.015 on every side; anything near that size here
    // would mean the whole-route box came back.
    for (const box of boxes) {
      expect(box.north - box.south).toBeLessThan(0.01);
      expect(box.east - box.west).toBeLessThan(0.01);
    }
    // Centred on the entry and exit stations of the corridor, not the waypoints.
    const centres = boxes.map((b) => (b.east + b.west) / 2).sort((x, y) => x - y);
    expect(centres[0]).toBeCloseTo(103.803, 3);
    expect(centres[1]).toBeCloseTo(103.807, 3);

    // The old route-wide call is gone entirely.
    expect(fetchStationEntrances).not.toHaveBeenCalled();
  });
});


describe("the boarding door is one a rider can enter by", () => {
  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
  });

  it("never boards through an exit-only door, however well placed", async () => {
    // Both doors belong to Alpha (103.803). The exit-only one sits between the
    // start and the platform, so it is the shortest way in on distance alone.
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [
        { id: 1, lat: 1.3, lon: 103.8025, kind: "entrance", exitOnly: true },
        { id: 2, lat: 1.3, lon: 103.8034, kind: "entrance" },
      ],
      failed: false,
    } as never);
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    const transitRoute = result.current.filteredRoutes[0];
    expect(transitRoute.label).toBe("Via Subway");
    expect(transitRoute.mrtEntrances?.[0]).toEqual([103.8034, 1.3]);
  });
});

describe("a station's published doors replace the fetched ones (issue 430)", () => {
  // Alpha (103.803) is the entry station on this corridor and Gamma (103.807)
  // the exit; the route runs 103.8 → 103.81.
  function trainGraphWithDoors(doors: Record<string, { lat: number; lon: number }[]>) {
    const graph = corridorTrainGraph();
    for (const [id, entrances] of Object.entries(doors)) {
      graph.stations.set(id, { ...graph.stations.get(id)!, entrances } as never);
    }
    return graph;
  }

  async function calculateWith(trainGraph: ReturnType<typeof corridorTrainGraph>) {
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(trainGraph as never);
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });
    const transitRoute = result.current.filteredRoutes[0];
    expect(transitRoute.label).toBe("Via Subway");
    return transitRoute;
  }

  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({ entrances: [], failed: false } as never);
  });

  it("asks Overpass for nothing when both stations publish their doors", async () => {
    const route = await calculateWith(
      trainGraphWithDoors({
        "subway:1": [{ lat: 1.3, lon: 103.8034 }],
        "subway:3": [{ lat: 1.3, lon: 103.8072 }],
      }),
    );
    expect(fetchStationEntranceBoxes).not.toHaveBeenCalled();
    expect(route.mrtEntrances).toEqual([
      [103.8034, 1.3],
      [103.8072, 1.3],
    ]);
  });

  it("never exits through a nearer door that is not the station's own", async () => {
    // Grand Central: the fetch finds a door right by the destination and the
    // nearest-station matcher gives it to Gamma, as it gave the terminal's
    // doors to the 7. Gamma's published list does not include it.
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [{ id: 9, lat: 1.3, lon: 103.8095, kind: "entrance" }],
      failed: false,
    } as never);
    const route = await calculateWith(
      trainGraphWithDoors({ "subway:3": [{ lat: 1.3, lon: 103.8072 }] }),
    );
    // Only Alpha, which publishes nothing, is still fetched for.
    expect(fetchStationEntranceBoxes).toHaveBeenCalledTimes(1);
    const [boxes] = vi.mocked(fetchStationEntranceBoxes).mock.calls[0] as [
      { south: number; west: number; north: number; east: number }[],
    ];
    expect(boxes).toHaveLength(1);
    expect((boxes[0].west + boxes[0].east) / 2).toBeCloseTo(103.803, 3);
    expect(route.mrtEntrances?.[1]).toEqual([103.8072, 1.3]);
  });

  it("uses the station point where OSM maps no door, without fetching", async () => {
    const route = await calculateWith(trainGraphWithDoors({ "subway:1": [], "subway:3": [] }));
    expect(fetchStationEntranceBoxes).not.toHaveBeenCalled();
    expect(route.mrtEntrances).toEqual([
      [103.803, 1.3],
      [103.807, 1.3],
    ]);
  });
});

// ─── #400: a dropped transit option ─────────────────────────────────────────

/**
 * The corridor, plus an island node sitting exactly on the entry station. OSM
 * pedestrian graphs are full of these — station interiors and service stubs that
 * connect to nothing — and the station centroid snaps straight onto one.
 */
function corridorGraphWithStationIsland() {
  const node = (id: number, lon: number) => [id, { id, lat: 1.3, lon }] as const;
  const hop = (toId: number, distanceM: number) => ({ toId, distanceM });
  return {
    nodes: new Map([
      node(1, 103.8),
      // Nudged off the station so the island below is strictly the nearest node
      // — otherwise the tie resolves to this one and the bug never fires.
      node(2, 103.8035),
      node(3, 103.807),
      node(4, 103.81),
      // Sits exactly on the entry station, and connects to nothing.
      node(99, 103.803),
    ]),
    adj: new Map([
      [1, [hop(2, 390)]],
      [2, [hop(1, 390), hop(3, 390)]],
      [3, [hop(2, 390), hop(4, 334)]],
      [4, [hop(3, 334)]],
      [99, []],
    ]),
  };
}

describe("a transit option is not lost to an unreachable snap (issue 400)", () => {
  beforeEach(() => {
    resetShadowStub();
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
    // No entrances at all, so the station centroid is the board point — the
    // production case when Overpass is rate-limited.
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [],
      failed: false,
    } as never);
  });

  async function routeOverIslandGraph() {
    vi.mocked(fetchRoutingGraph).mockResolvedValue(corridorGraphWithStationIsland() as never);
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });
    return result;
  }

  it("still offers transit when the closest node to the station is an island", async () => {
    const result = await routeOverIslandGraph();

    // Snapping to the nearest node lands on 99, the walk leg fails, and the
    // option is discarded — which is what this asserts has stopped happening.
    expect(result.current.filteredRoutes).toHaveLength(1);
    expect(result.current.filteredRoutes[0].label).toBe("Via Subway");
    // The subway offer carries no warning of its own; the bus mode explains
    // itself separately (Stage H) — its only stop shares the island, so no
    // bus stop is reachable on foot.
    expect(result.current.navWarning).toBe(
      "No bus stop within walking distance can be reached on foot, so Via Bus is not offered.",
    );
  });

  it("does not cry wolf when the entrance fetch failed but transit still works", async () => {
    // `failed: true` means the entrance list is cache-only — not that anything
    // went wrong for the user. The centroid fallback routes fine, so a warning
    // here would be noise on every rate-limited fetch.
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [],
      failed: true,
    } as never);

    const result = await routeOverIslandGraph();

    expect(result.current.filteredRoutes[0]?.label).toBe("Via Subway");
    // The entrance failure itself still cries no wolf; the warning that is
    // present names the bus mode's own outcome, not the entrance fetch.
    expect(result.current.navWarning).toBe(
      "No bus stop within walking distance can be reached on foot, so Via Bus is not offered.",
    );
  });
});


// ─── Static-backed transit access/egress (Session 5) ─────────────────────────

/**
 * Configured-NYC proof that subway access/egress walks route over the static,
 * shadow-enriched street graph: Overpass streets are armed to fail, the
 * published entry station (with doors) stands outside the route-stop bbox, and
 * the Via Subway card must still appear with a bounded access walk.
 */
const NAV5_BASE = "https://navigation.test";
const NAV5_GENERATION = "nyc-2026-09-19-abcdef123456";
const NAV5_SUPPORT = { south: 1.29, west: 103.77, north: 1.31, east: 103.83 };

interface Nav5Node {
  id: number;
  lat: number;
  lon: number;
  isIntersection: boolean;
}

interface Nav5Edge {
  id: string;
  from: number;
  to: number;
  tags: Record<string, string>;
}

function nav5ShardBody(
  geometryBounds: { south: number; west: number; north: number; east: number },
  nodes: Nav5Node[],
  edges: Nav5Edge[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: NAV5_GENERATION,
    kind: "streets",
    geometryBounds,
    supportBounds: geometryBounds,
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      distanceM: haversineMeters(
        [byId.get(edge.from)!.lon, byId.get(edge.from)!.lat],
        [byId.get(edge.to)!.lon, byId.get(edge.to)!.lat],
      ),
    })),
  };
}

async function nav5Sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Self-consistent pointer/manifest/shards with real digests (never Overpass). */
async function publishNav5() {
  const encoder = new TextEncoder();
  const bodies = new Map<string, Uint8Array>();
  const streetShards = [];
  // The station cell ends at lon 103.7845; the walk bbox below starts at
  // 103.785 — boarding happens strictly outside the route-stop bbox.
  const cells: Array<{ key: string; body: ReturnType<typeof nav5ShardBody> }> = [
    {
      key: "streets/cell-station.json",
      body: nav5ShardBody(
        { south: 1.295, west: 103.772, north: 1.305, east: 103.7845 },
        [
          { id: 11, lat: 1.3, lon: 103.782, isIntersection: false },
          { id: 12, lat: 1.3005, lon: 103.7825, isIntersection: false },
          { id: 13, lat: 1.3, lon: 103.7845, isIntersection: true },
        ],
        [
          { id: "s1-fwd", from: 11, to: 12, tags: { highway: "footway" } },
          { id: "s1-bwd", from: 12, to: 11, tags: { highway: "footway" } },
          { id: "s2-fwd", from: 12, to: 13, tags: { highway: "footway" } },
          { id: "s2-bwd", from: 13, to: 12, tags: { highway: "footway" } },
        ],
      ),
    },
    {
      key: "streets/cell-corridor.json",
      body: nav5ShardBody(
        { south: 1.295, west: 103.7845, north: 1.305, east: 103.806 },
        [
          // Ghost endpoint across the seam, owned by the station cell.
          { id: 13, lat: 1.3, lon: 103.7845, isIntersection: true },
          { id: 21, lat: 1.3, lon: 103.786, isIntersection: false },
          { id: 22, lat: 1.3, lon: 103.795, isIntersection: false },
          { id: 23, lat: 1.3, lon: 103.8, isIntersection: false },
          // Ghost endpoint on the far-east seam, owned by that cell.
          { id: 31, lat: 1.3, lon: 103.806, isIntersection: true },
        ],
        [
          { id: "c1-fwd", from: 13, to: 21, tags: { highway: "residential" } },
          { id: "c1-bwd", from: 21, to: 13, tags: { highway: "residential" } },
          { id: "c2-fwd", from: 21, to: 22, tags: { highway: "residential" } },
          { id: "c2-bwd", from: 22, to: 21, tags: { highway: "residential" } },
          { id: "c3-fwd", from: 22, to: 23, tags: { highway: "residential" } },
          { id: "c3-bwd", from: 23, to: 22, tags: { highway: "residential" } },
          { id: "c4-fwd", from: 23, to: 31, tags: { highway: "residential" } },
          { id: "c4-bwd", from: 31, to: 23, tags: { highway: "residential" } },
        ],
      ),
    },
    {
      // The destination access zone owns this whole cell: the padded route
      // bbox below ends at 103.8, so only `zoneAround(B, 2000)` overlaps it.
      key: "streets/cell-fareast.json",
      body: nav5ShardBody(
        { south: 1.295, west: 103.806, north: 1.305, east: 103.826 },
        [
          { id: 31, lat: 1.3, lon: 103.806, isIntersection: true },
          { id: 32, lat: 1.3, lon: 103.81, isIntersection: false },
          { id: 33, lat: 1.3, lon: 103.8125, isIntersection: false },
        ],
        [
          { id: "e1-fwd", from: 31, to: 32, tags: { highway: "residential" } },
          { id: "e1-bwd", from: 32, to: 31, tags: { highway: "residential" } },
          { id: "e2-fwd", from: 32, to: 33, tags: { highway: "residential" } },
          { id: "e2-bwd", from: 33, to: 32, tags: { highway: "residential" } },
        ],
      ),
    },
  ];
  for (const cell of cells) {
    const bytes = encoder.encode(JSON.stringify(cell.body));
    bodies.set(cell.key, bytes);
    streetShards.push({
      key: cell.key,
      bytes: bytes.byteLength,
      sha256: await nav5Sha256(bytes),
      geometryBounds: cell.body.geometryBounds,
      supportBounds: cell.body.supportBounds,
      nodes: cell.body.nodes.length,
      edges: cell.body.edges.length,
    });
  }
  const manifestObj = {
    version: 1,
    dataset: "nyc-navigation",
    generation: NAV5_GENERATION,
    createdAt: "2026-09-19T12:00:00.000Z",
    supportBounds: NAV5_SUPPORT,
    recipe: "test-fixture-v1",
    sources: [
      {
        id: "test",
        release: "test",
        url: "https://example.invalid/source",
        bytes: 1000,
        timestamp: "2026-09-18T12:00:00Z",
        sha256: "1".repeat(64),
      },
    ],
    noticesPath: `navigation/nyc/${NAV5_GENERATION}/notices.json`,
    noticesSha256: "2".repeat(64),
    streetShards,
    // The manifest contract requires a non-empty building list; the street
    // source never requests it.
    buildingShards: [
      {
        key: "buildings/cell-a.json",
        bytes: 128,
        sha256: "3".repeat(64),
        geometryBounds: { south: 1.295, west: 103.786, north: 1.305, east: 103.806 },
        supportBounds: { south: 1.295, west: 103.786, north: 1.305, east: 103.806 },
        buildings: 0,
        rings: 0,
        missingHeights: 0,
        maxHeightM: 0,
      },
    ],
    budgets: { streetShardBytes: 5_000_000, buildingShardBytes: 5_000_000, totalBytes: 10_000_000 },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifestObj));
  return {
    pointer: {
      version: 1,
      dataset: "nyc-navigation",
      generation: NAV5_GENERATION,
      manifestPath: `navigation/nyc/${NAV5_GENERATION}/manifest.json`,
      manifestSha256: await nav5Sha256(manifestBytes),
    },
    manifestBytes,
    bodies,
  };
}

/** Serves published navigation bytes through the global fetch, recording URLs. */
function stubNav5Fetch(published: Awaited<ReturnType<typeof publishNav5>>, calls: string[]) {
  return (async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    const bytes = (body: Uint8Array) => {
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => copy.buffer,
      };
    };
    if (href.endsWith("/current.json"))
      return bytes(new TextEncoder().encode(JSON.stringify(published.pointer)));
    if (href.endsWith("/manifest.json")) return bytes(published.manifestBytes);
    const key = href.split(`/navigation/nyc/${NAV5_GENERATION}/`)[1];
    const body = key ? published.bodies.get(key) : undefined;
    if (!body)
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return bytes(body);
  }) as unknown as typeof fetch;
}

/** Entry station outside the walk bbox with published doors; ride to the exit. */
function offCorridorTrainGraph() {
  const rail = (to: string) => ({ to, weightSec: 60, type: "rail" as const, line: "T" });
  return {
    stations: new Map([
      [
        "subway:E",
        {
          id: "subway:E",
          name: "West End",
          lat: 1.3,
          lon: 103.782,
          lines: ["T"],
          entrances: [{ lat: 1.3005, lon: 103.7825 }],
        },
      ],
      ["subway:M", { id: "subway:M", name: "Mid", lat: 1.3, lon: 103.791, lines: ["T"] }],
      [
        "subway:X",
        {
          id: "subway:X",
          name: "East End",
          lat: 1.3,
          lon: 103.799,
          lines: ["T"],
          entrances: [],
        },
      ],
    ]),
    adj: new Map([
      ["subway:E", [rail("subway:M")]],
      ["subway:M", [rail("subway:E"), rail("subway:X")]],
      ["subway:X", [rail("subway:M")]],
    ]),
    lineColors: new Map([["T", token("color-route")]]),
    lineNames: new Map([["T", "Test Line"]]),
    lineModes: new Map([["T", "subway" as const]]),
  };
}

function fareastTrainGraph() {
  const rail = (to: string) => ({ to, weightSec: 60, type: "rail" as const, line: "T" });
  return {
    stations: new Map([
      [
        "subway:E",
        {
          id: "subway:E",
          name: "West End",
          lat: 1.3,
          lon: 103.782,
          lines: ["T"],
          entrances: [{ lat: 1.3005, lon: 103.7825 }],
        },
      ],
      // Not a chosen endpoint: publishing an empty door list just keeps the
      // centroid as the board point if the search ever picks it.
      [
        "subway:M",
        { id: "subway:M", name: "Mid", lat: 1.3, lon: 103.795, lines: ["T"], entrances: [] },
      ],
      [
        "subway:F",
        {
          id: "subway:F",
          name: "Far East",
          lat: 1.3,
          lon: 103.807,
          lines: ["T"],
          entrances: [{ lat: 1.3005, lon: 103.8095 }],
        },
      ],
    ]),
    adj: new Map([
      ["subway:E", [rail("subway:M")]],
      ["subway:M", [rail("subway:E"), rail("subway:F")]],
      ["subway:F", [rail("subway:M")]],
    ]),
    lineColors: new Map([["T", token("color-route")]]),
    lineNames: new Map([["T", "Test Line"]]),
    lineModes: new Map([["T", "subway" as const]]),
  };
}

/** Old-generation stations publishing no doors — the legacy fetch path. */
function legacyEntrancesTrainGraph() {
  const station = (id: string, name: string, lon: number) => ({
    id,
    name,
    lat: 1.3,
    lon,
    lines: ["T"],
  });
  const rail = (to: string) => ({ to, weightSec: 60, type: "rail" as const, line: "T" });
  return {
    stations: new Map([
      ["subway:E", station("subway:E", "West End", 103.782)],
      ["subway:M", station("subway:M", "Mid", 103.791)],
      ["subway:X", station("subway:X", "East End", 103.799)],
    ]),
    adj: new Map([
      ["subway:E", [rail("subway:M")]],
      ["subway:M", [rail("subway:E"), rail("subway:X")]],
      ["subway:X", [rail("subway:M")]],
    ]),
    lineColors: new Map([["T", token("color-route")]]),
    lineNames: new Map([["T", "Test Line"]]),
    lineModes: new Map([["T", "subway" as const]]),
  };
}

describe("transit access walks use the static street graph when configured", () => {
  let navCalls: string[] = [];

  beforeEach(async () => {
    resetShadowStub();
    clearNavigationCache();
    vi.stubEnv("VITE_NAVIGATION_BASE", NAV5_BASE);
    navCalls = [];
    vi.stubGlobal("fetch", stubNav5Fetch(await publishNav5(), navCalls));
    // Tripwire: any Overpass street fetch rejects instead of succeeding
    // quietly through the fallback.
    vi.mocked(fetchRoutingGraph).mockRejectedValue(new Error("proxy down"));
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(offCorridorTrainGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [],
      failed: false,
    } as never);
  });

  afterEach(() => {
    clearNavigationCache();
    vi.unstubAllGlobals();
  });

  it("offers Via Subway with a bounded static access walk and no Overpass streets", async () => {
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    // ~1.1 km apart, so the pipeline looks for a transit option at all.
    act(() => result.current.handleSetWaypointA([103.79, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.8, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    // Both walks routed over verified static shards: no street fallback fired.
    expect(fetchRoutingGraph).not.toHaveBeenCalled();
    // The access zone pulled the station cell, which the route-stop bbox
    // ([103.785, 103.805]) cannot intersect on its own.
    expect(navCalls.some((url) => url.includes("cell-station.json"))).toBe(true);
    // Published doors stay authoritative: no legacy entrance fetch.
    expect(fetchStationEntranceBoxes).not.toHaveBeenCalled();

    const subway = result.current.filteredRoutes.find((route) => route.label === "Via Subway");
    expect(subway).toBeDefined();
    expect(subway?.legs?.map((leg) => leg.type)).toEqual(["walk", "transit", "walk"]);
    // A bounded access walk to the published door (~0.9 km of static
    // streets), not an unbounded snap to the corridor edge.
    const walkA = subway?.legs?.[0];
    expect(walkA?.distanceM).toBeGreaterThan(0);
    expect(walkA?.distanceM ?? Infinity).toBeLessThan(1500);
    // The board point is the published door, outside the route-stop bbox.
    expect(subway?.mrtEntrances?.[0]).toEqual([103.7825, 1.3005]);
    // The ride itself still comes from the TrainGraph implementation.
    expect(subway?.legs?.[1].stops).toEqual(["West End", "Mid", "East End"]);
  });
  it("alights over the destination access zone when the exit station stands outside the route bbox", async () => {
    // The exit station is east of the far seam (103.806), past the padded
    // route bbox. Only `zoneAround(B, 2000)` intersects its cell, so walkB
    // proves the B-side zone. A stands further west and B further east than
    // the other tests so the far-east station is the honest best exit (Mid
    // would cost a 1.1 km egress walk) and the ~2.9 km direct walk keeps the
    // offer clear of the walking-dominance gate — the offer itself is what
    // carries walkB's assertions here.
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(fareastTrainGraph() as never);
    vi.mocked(fetchRoutingGraph).mockClear();
    vi.mocked(fetchStationEntranceBoxes).mockClear();
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.7815, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.809, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    const subway = result.current.filteredRoutes.find((route) => route.label === "Via Subway");
    expect(subway).toBeDefined();
    expect(subway?.legs?.map((leg) => leg.type)).toEqual(["walk", "transit", "walk"]);
    // Both walks stay on verified static shards; no Overpass streets fired.
    expect(fetchRoutingGraph).not.toHaveBeenCalled();
    // The B-side zone is the only selector that can pull the far-east cell.
    expect(navCalls.some((url) => url.includes("cell-fareast.json"))).toBe(true);
    // Published doors stay authoritative on both sides: no legacy fetch.
    expect(fetchStationEntranceBoxes).not.toHaveBeenCalled();
    expect(subway?.mrtEntrances).toEqual([
      [103.7825, 1.3005],
      [103.8095, 1.3005],
    ]);
    // Bounded walks: the boarding door inside the A zone, the alighting door
    // on the far-east cell the B zone owns.
    const walkA = subway?.legs?.[0];
    expect(walkA?.distanceM).toBeGreaterThan(0);
    expect(walkA?.distanceM ?? Infinity).toBeLessThan(1500);
    const walkB = subway?.legs?.[2];
    expect(walkB?.distanceM).toBeGreaterThan(0);
    expect(walkB?.distanceM ?? Infinity).toBeLessThan(2500);
    // The ride itself still comes from the TrainGraph implementation.
    expect(subway?.legs?.[1].stops).toEqual(["West End", "Mid", "Far East"]);
  });

  it("still falls back to the legacy entrance boxes for old-generation stations on the static graph", async () => {
    // Neither endpoint publishes doors (pre-door-generation records), so the
    // legacy Overpass entrance fallback must still run — over the same static,
    // shadow-enriched streets walkA/walkB use.
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(legacyEntrancesTrainGraph() as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [
        { id: 401, lat: 1.3005, lon: 103.7825, kind: "entrance" },
        { id: 402, lat: 1.3005, lon: 103.7995, kind: "entrance" },
      ],
      failed: false,
    } as never);
    vi.mocked(fetchRoutingGraph).mockClear();
    vi.mocked(fetchStationEntranceBoxes).mockClear();
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64), width: 8, height: 8, pixelRatioX: 1, pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    act(() => result.current.handleSetWaypointA([103.79, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.8, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    // One legacy call, two station-sized boxes centred on the chosen stations.
    expect(fetchStationEntranceBoxes).toHaveBeenCalledTimes(1);
    const [boxes] = vi.mocked(fetchStationEntranceBoxes).mock.calls[0] as [
      { south: number; west: number; north: number; east: number }[],
    ];
    expect(boxes).toHaveLength(2);
    const centres = boxes.map((box) => (box.west + box.east) / 2).sort((x, y) => x - y);
    expect(centres[0]).toBeCloseTo(103.782, 5);
    expect(centres[1]).toBeCloseTo(103.799, 5);

    const subway = result.current.filteredRoutes.find((route) => route.label === "Via Subway");
    expect(subway).toBeDefined();
    // The fetched door wins for boarding; streets stayed static throughout.
    expect(subway?.mrtEntrances?.[0]).toEqual([103.7825, 1.3005]);
    expect(fetchRoutingGraph).not.toHaveBeenCalled();
    expect(navCalls.some((url) => url.includes("cell-station.json"))).toBe(true);
    expect(subway?.legs?.[1].stops).toEqual(["West End", "Mid", "East End"]);
  });




});
// ─── Static-off trips must keep the exact pre-zone readiness area ─────────────

describe("long trips without a static snapshot keep the exact route-bbox area", () => {
  beforeEach(() => {
    resetShadowStub();
    clearNavigationCache();
    // `VITE_NAVIGATION_BASE` is deliberately absent (the file-level afterEach
    // unstubs every env), so `acquireNavigationSnapshot` returns null: streets
    // come from Overpass and the ±2 km access zones cannot help anything. The
    // readiness area and the graph request must stay the pre-zone shapes
    // rather than widening for a dataset that is not bound.
    vi.mocked(fetchRoutingGraph).mockResolvedValue(transitCorridorGraph() as never);
    vi.mocked(fetchBestTrainGraph).mockResolvedValue(corridorTrainGraph() as never);
    vi.mocked(fetchStationEntrances).mockResolvedValue([] as never);
    vi.mocked(fetchStationEntranceBoxes).mockResolvedValue({
      entrances: [],
      failed: false,
    } as never);
  });

  afterEach(() => {
    clearNavigationCache();
  });

  it("preloads the route bbox and hands the graph fetch no access zones", async () => {
    const { map } = fakeMap({
      pitch: 0,
      boundsAtPitch: () => ({ west: 100, south: -1, east: 107, north: 5 }),
    });
    const { result } = renderHook(() =>
      useNavigation({
        mapRef: { current: map as never },
        shadowLayerRef: {
          current: {
            readBuildingShadowMask: () => ({
              data: new Uint8Array(64),
              width: 8,
              height: 8,
              pixelRatioX: 1,
              pixelRatioY: 1,
            }),
          } as never,
        },
        dateRef: { current: new Date("2026-08-16T04:00:00Z") },
        setDate: vi.fn(),
      }),
    );
    vi.mocked(fetchBestRoutingGraph).mockClear();
    act(() => result.current.handleSetWaypointA([103.8, 1.3], "Start"));
    act(() => result.current.handleSetWaypointB([103.81, 1.3], "End"));
    act(() => result.current.handleRouteModeChange("transit"));
    await act(async () => {
      result.current.handleCalculateRoute();
    });
    await waitFor(() => expect(result.current.isCalculating).toBe(false), { timeout: 4000 });

    // The Overpass-backed transit trip still lands, walk legs included.
    expect(result.current.navError).toBeNull();
    expect(result.current.filteredRoutes[0]?.label).toBe("Via Subway");

    // Every graph request in this calculation carries no transit access zones.
    const graphCalls = vi.mocked(fetchBestRoutingGraph).mock.calls;
    expect(graphCalls.length).toBeGreaterThan(0);
    for (const call of graphCalls) {
      const options = call[5] as { accessZones?: unknown[] } | undefined;
      expect(options?.accessZones ?? []).toEqual([]);
    }

    // The field preloads exactly the route bbox the Overpass graph can return
    // (padded as `sampleEdges` pads), not that bbox plus the ±2 km zones.
    // Mirror the hook's own padding arithmetic so the expected double matches.
    const padding = Math.max(
      0.005,
      Math.min(0.008, (haversineMeters([103.8, 1.3], [103.81, 1.3]) / 111000) * 0.3),
    );
    const [broad] = shadowStub.readyCalls;
    expect(broad?.kind).toBe("broad");
    expect(broad?.bbox).toEqual(
      bboxAroundEdges(
        [{ from: [103.8 - padding, 1.3 - padding], to: [103.81 + padding, 1.3 + padding] }],
        QUERY_PAD_M,
      ),
    );
  });
});

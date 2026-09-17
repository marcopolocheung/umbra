import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type maplibregl from "maplibre-gl";
import { boxAround, fetchRoutingGraph, fetchStationEntranceBoxes } from "../lib/overpass";
import {
  dijkstra,
  paretoRoutes,
  graphToGeoJSON,
  haversineMeters,
  SpatialGrid,
  connectRouteEndpoints,
  clearVirtualNodes,
  snapRouteStopsToReachableEdges,
  parallelSidewalkEdges,
  reachableFrom,
  snapToReachable,
} from "../lib/routing";
import type {
  GraphEdge,
  LatLng,
  RouteLeg,
  RouteOption,
  RoutingGraph,
  SketchPoint,
} from "../lib/routing";
import { recordRoutingRun, computeDerivedKpis } from "../lib/metrics";
import { snapOutsideBuilding } from "../lib/building-snap";
import type { MapBuildingQuery } from "../lib/building-snap";
import {
  findBestTrainRoute,
  matchEntranceToTrainStation,
  TRAIN_SUN_EXPOSURE,
  buildTrainDrawData,
  ENTRANCE_MATCH_MAX_M,
} from "../lib/trainGraph";
import { fetchBestTrainGraph } from "../lib/transit/trainGraphSource";
import { utcOffsetMinAt } from "../lib/timezone";
import { ensureZoneLookup, zoneAt } from "../lib/tzLookup";
import {
  sampleBuildingMaskBothSidewalks,
  computeSolarIntensity,
  pickClosestEntrance,
} from "../lib/shadowSampling";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import {
  LOW_CONFIDENCE,
  QUERY_PAD_M,
  bboxAroundEdges,
  createGeometryShadowField,
  edgeSampleCount,
} from "../lib/shadowField/ShadowField";
import type { ShadowField, ShadowSource } from "../lib/shadowField/ShadowField";
import {
  createOverpassCanopyProvider,
  createOverpassPrismProvider,
  createRasterCanopyProvider,
  createTilePrismProvider,
} from "../lib/shadowField/providers";
import { summarizeShadowSource } from "../lib/shadowProvenance";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import { partialRouteNotice, type PartialRouteInfo } from "../lib/partialRoute";
import { travelTimeSeconds } from "../lib/travelMode";
import type { TravelModeId } from "../lib/travelMode";
import type { StopEntry } from "../lib/trip/types";
import { routeBounds } from "../lib/routeBounds";
import {
  RoutePlanJobCoordinator,
  type RoutePlan,
  type RoutePlanOutcome,
  type RoutePlanRequest,
  type RoutePlanTerminalResult,
} from "../lib/routePlanJob";
import {
  CANVAS_CONFIDENCE,
  ROUTE_READINESS_BUDGET_MS,
  prefersReducedMotion,
  routePlanFingerprint,
  routingEdgeBatch,
  waitForMapIdle,
} from "../lib/navigationHelpers";

/** An opaque map-owned route identity for a C4 terminal result. */
export interface RouteReceiptMapObject {
  id: string;
  kind: "route";
  requestId: string;
  actionId: string;
  planRevision: number;
}

/**
 * The event-time seam between the navigation sub-hooks, owned by the
 * `useNavigation` facade.
 *
 * `useTrip` is constructed before `useRouting` (routing reads trip state), but
 * trip handlers cancel in-flight calculations and clear calculated routes, and
 * `useRouting` clears sketch state when a normal route lands while `useSketch`
 * is constructed after it. Neither direction can take the other as a
 * construction arg, so both read the other side lazily through this object,
 * which the facade assigns every render before any event can fire. All reads
 * are event-time; anything needed at render time (effect dependencies) travels
 * as an explicit arg instead.
 */
export interface NavSeam {
  cancelInFlightCalculation: () => void;
  setNavRoutes: React.Dispatch<React.SetStateAction<RouteOption[]>>;
  setSelectedRouteIndex: React.Dispatch<React.SetStateAction<number>>;
  setNavError: React.Dispatch<React.SetStateAction<string | null>>;
  setSketchPoints: React.Dispatch<React.SetStateAction<SketchPoint[]>>;
  setNavWarning: React.Dispatch<React.SetStateAction<string | null>>;
  setSimplifiedWaypoints: React.Dispatch<React.SetStateAction<LatLng[] | null>>;
  /**
   * The routes the panel is actually showing, which is what every index coming
   * back from the UI refers to. Deliberately not `navRoutes`: in transit mode
   * the two arrays differ, and resolving a card's index against the unfiltered
   * list silently picks a different route (#395).
   */
  visibleRoutes: RouteOption[];
}

/**
 * Whether a route belongs to the walk list or the transit list. The panel shows
 * one list at a time, so this is also what makes a card's index meaningful.
 */
export function isTransitRoute(route: RouteOption): boolean {
  return !!route.legs?.find((l: RouteLeg) => l.type === "transit");
}

export function routesForMode(
  routes: RouteOption[],
  mode: "walk" | "transit",
): RouteOption[] {
  return routes.filter((r) => (mode === "transit") === isTransitRoute(r));
}

/**
 * Everything `useRouting` reads from outside its own state. Trip pieces arrive
 * explicitly (values for the plan-revision effect, refs and setters for the
 * pipeline); sketch-owned setters arrive via the seam because `useSketch` is
 * constructed after this hook.
 */
export interface UseRoutingArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  shadowLayerRef?: React.MutableRefObject<IShadowLayer | null>;
  dateRef: React.MutableRefObject<Date>;
  travelModeRef: React.MutableRefObject<TravelModeId>;
  routeMode: "walk" | "transit";
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  additionalWaypoints: [number, number][];
  waypointARef: React.MutableRefObject<[number, number] | null>;
  waypointBRef: React.MutableRefObject<[number, number] | null>;
  /** Dwell per stop, positional — dwell edits advance the plan revision (C5). */
  dwellSignature: string;
  /**
   * Single-op whole-trip replacement for agent plans (id-preserving). Returns
   * the dwell signature of the trip it commits, which is not always all zeros
   * — `replaceStops` keeps the dwell of a stop whose coordinates did not move.
   */
  replaceAllStops: (entries: StopEntry[]) => string;
  seam: React.MutableRefObject<NavSeam>;
}

/**
 * The route-calculation pipeline, extracted from `useNavigation` (G6a).
 *
 * Owns calculated routes, the in-flight calculation (generation counter, abort
 * controller, camera flatten/restore), the geometry shadow field, and the C4/C5
 * agent plumbing (plan revisions, route-plan jobs, receipt map objects).
 */
export function useRouting({
  mapRef,
  shadowLayerRef,
  dateRef,
  travelModeRef,
  routeMode,
  waypointA,
  waypointB,
  additionalWaypoints,
  waypointARef,
  waypointBRef,
  dwellSignature,
  replaceAllStops,
  seam,
}: UseRoutingArgs) {
  const [navRoutes, setNavRoutes] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isCalculating, setIsCalculating] = useState(false);
  const [routeProgress, setRouteProgress] = useState<RouteCalculationProgress | null>(null);
  const [routePreview, setRoutePreview] = useState<GeoJSON.Feature<GeoJSON.LineString> | null>(
    null,
  );
  const [navError, setNavError] = useState<string | null>(null);
  const [routeSolarIntensity, setRouteSolarIntensity] = useState<number | null>(null);

  // Refs for stale-closure avoidance
  // `calculateRoute` keeps a stable identity by reading volatile values through
  // refs rather than deps; the mode is one of those, and it decides which list
  // the finished route is framed against.
  const routeModeRef = useRef(routeMode);
  routeModeRef.current = routeMode;
  const calcGenRef = useRef(0);
  const calcAbortRef = useRef<AbortController | null>(null);
  const agentRouteJobsRef = useRef(new RoutePlanJobCoordinator());
  const routePlanInputVersionRef = useRef(0);
  const routePlanRevisionRef = useRef(0);
  const routePlanActionSeqRef = useRef(0);
  const routeReceiptObjectRef = useRef<RouteReceiptMapObject | null>(null);
  const pendingAgentPlanFingerprintRef = useRef<string | null>(null);
  /** The pitch to hand back to the user once a flat shadow readback is done. */
  const pitchRestoreRef = useRef<number | null>(null);

  /**
   * Shadow from building geometry, tiles first and Overpass behind for reach, with
   * canopy blended on top — OSM's tagged crowns (A7) and the Meta/WRI height raster
   * (A8d), whichever is darker at a point.
   *
   * Lazily built rather than `useRef(createGeometryShadowField(...))`, whose argument
   * would be re-evaluated on every render and thrown away. `maplibregl.Map` satisfies
   * `TileMapLike` structurally, so the provider reads the live map through a getter
   * without any of it being plumbed through props.
   *
   * The canopy lists are separate, not more entries in the first: buildings resolve
   * first-one-wins and canopy is additive on top of whichever of them answered. The
   * raster gets a third list of its own because it answers a height field rather than
   * prisms — see `canopyRasterField.ts` for why a raster is marched, not tessellated.
   */
  const shadowFieldRef = useRef<ShadowField | null>(null);
  if (!shadowFieldRef.current) {
    shadowFieldRef.current = createGeometryShadowField(
      [createTilePrismProvider(() => mapRef.current), createOverpassPrismProvider()],
      [createOverpassCanopyProvider()],
      [createRasterCanopyProvider()],
    );
  }

  const routePlanTime = dateRef.current.getTime();
  const advanceRoutePlanRevision = useCallback(() => {
    // A different plan may draw different geometry. Its predecessor must no
    // longer be focusable or presentable as the current route.
    routeReceiptObjectRef.current = null;
    const revision = ++routePlanRevisionRef.current;
    agentRouteJobsRef.current.advancePlanRevision(revision);
    return revision;
  }, []);

  // Any real route-defining edit, including the selected shadow time and
  // per-stop dwell, invalidates a job based on the older plan.
  useEffect(() => {
    const fingerprint = routePlanFingerprint(waypointA, waypointB, additionalWaypoints, dwellSignature);
    if (pendingAgentPlanFingerprintRef.current === fingerprint) {
      pendingAgentPlanFingerprintRef.current = null;
      return;
    }
    advanceRoutePlanRevision();
  }, [waypointA, waypointB, additionalWaypoints, dwellSignature, routePlanTime, advanceRoutePlanRevision]);

  /**
   * Flatten the camera before a shadow readback. Returns whether it moved, because a
   * camera that moved has to settle before the canvas is read.
   *
   * `isBlueDominantShadowPixel` calls any blue-dominant pixel shadowed, and the shadow
   * layer now paints the buildings with that same field — a shadowed wall (`#6f7f99`)
   * and a shadowed roof (`#8797b2`) both satisfy the predicate. So a tilted readback
   * puts building surfaces under the sample points and scores an occluded sidewalk
   * as shadowed (#154). Pass E already skips drawing buildings at pitch 0 *because* it
   * assumes this readback is flat (`LocalShadowAdapter.ts`, "always at pitch 0");
   * this is what makes that true. Bearing needs no such handling — `map.project`
   * is correct under rotation, and only pitch produces occlusion.
   *
   * A second calculation starting while the first is still flat must not record 0
   * as the pitch to go back to, so an already-pending restore is left alone.
   */
  const flattenForShadowReadback = useCallback((map: maplibregl.Map): boolean => {
    if (map.getPitch() === 0) return false;
    if (pitchRestoreRef.current === null) pitchRestoreRef.current = map.getPitch();
    map.jumpTo({ pitch: 0 });
    return true;
  }, []);

  /** Hand the user's tilt back. Safe to call when nothing was flattened. */
  const restorePitchAfterShadowReadback = useCallback((map: maplibregl.Map | null) => {
    const pitch = pitchRestoreRef.current;
    if (pitch === null || !map) return;
    pitchRestoreRef.current = null;
    // Tilting is the one camera move that can provoke motion sickness.
    if (prefersReducedMotion()) map.jumpTo({ pitch });
    else map.easeTo({ pitch, duration: 400 });
  }, []);

  const cancelInFlightCalculation = useCallback(() => {
    calcGenRef.current++;
    calcAbortRef.current?.abort();
    // The abandoned calculation's `finally` sees a bumped generation and leaves the
    // camera alone, so cancelling is what gives the tilt back.
    restorePitchAfterShadowReadback(mapRef.current);
    setIsCalculating(false);
    setRouteProgress(null);
    setRoutePreview(null);
  }, [mapRef, restorePitchAfterShadowReadback]);

  const fitMapToRoute = useCallback(
    (route: RouteOption) => {
      const map = mapRef.current;
      const bounds = routeBounds(route);
      if (!map || !bounds) return;

      map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 800 });
    },
    [mapRef],
  );

  const calculateRoute = useCallback(
    async (plan?: RoutePlan, externalSignal?: AbortSignal): Promise<RoutePlanOutcome> => {
      const rawA = plan?.from ?? waypointARef.current;
      const rawB = plan?.to ?? waypointBRef.current;
      if (!rawA || !rawB) {
        return { status: "no_plan_found", message: "Choose a start and destination first." };
      }
      const map = mapRef.current;
      if (!map) {
        setNavError("Map not ready");
        return { status: "error", message: "Map not ready" };
      }

      // Agent jobs pass their complete input directly. State updates keep the UI in
      // sync, but calculation no longer waits for React to commit them.
      if (plan) {
        replaceAllStops([
          { coord: plan.from, label: plan.fromLabel },
          ...plan.via.map((coord) => ({ coord })),
          { coord: plan.to, label: plan.toLabel },
        ]);
      }

      const a = snapOutsideBuilding(rawA, map as unknown as MapBuildingQuery);
      const b = snapOutsideBuilding(rawB, map as unknown as MapBuildingQuery);
      if (process.env.NODE_ENV !== "production") {
        if (a[0] !== rawA[0] || a[1] !== rawA[1])
          console.log(`[routing] waypoint A snapped out of building: [${rawA}] → [${a}]`);
        if (b[0] !== rawB[0] || b[1] !== rawB[1])
          console.log(`[routing] waypoint B snapped out of building: [${rawB}] → [${b}]`);
      }

      const myGen = ++calcGenRef.current;
      calcAbortRef.current?.abort();
      const calculationController = new AbortController();
      calcAbortRef.current = calculationController;
      const calcSignal = calculationController.signal;
      const cancelFromOutside = () => calculationController.abort();
      externalSignal?.addEventListener("abort", cancelFromOutside, { once: true });
      const cancelled = (): RoutePlanOutcome => ({
        status: "cancelled",
        reason: externalSignal?.aborted ? "cancelled" : "superseded",
      });
      const updateProgress = (progress: RouteCalculationProgress) => {
        if (calcGenRef.current === myGen && !calcSignal.aborted) {
          setRouteProgress(progress);
        }
      };
      const updatePreview = (coords: [number, number][]) => {
        if (calcGenRef.current !== myGen || calcSignal.aborted || coords.length < 2) return;
        setRoutePreview({
          type: "Feature",
          properties: { preview: true },
          geometry: { type: "LineString", coordinates: [...coords] },
        });
      };
      const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

      setIsCalculating(true);
      updateProgress({ message: "Preparing route area" });
      setRoutePreview(null);
      setNavError(null);

      await yieldToBrowser();

      const t0 = performance.now();
      let graphFetchMs = 0;
      const canvasReadMs = 0;
      let dedicatedMaskReadMs = 0;
      let shadowSampleMs = 0;
      let dijkstraMs = 0;
      let readinessAbort: AbortController | null = null;

      try {
        const straightLineDistM = haversineMeters(a, b);
        const basePadding = Math.max(0.005, Math.min(0.008, (straightLineDistM / 111000) * 0.3));
        const padding = basePadding;
        let routeStops: [number, number][] = [
          a,
          ...(plan?.via ?? additionalWaypoints).map((wp) =>
            snapOutsideBuilding(wp, map as unknown as MapBuildingQuery),
          ),
          b,
        ];
        const allLats = routeStops.map((w) => w[1]);
        const allLngs = routeStops.map((w) => w[0]);
        const south = Math.min(...allLats) - padding;
        const north = Math.max(...allLats) + padding;
        const west = Math.min(...allLngs) - padding;
        const east = Math.max(...allLngs) + padding;

        const tFetch = performance.now();
        updateProgress({ message: "Fetching walk network" });

        // The area the field must be able to speak for: every node the graph fetch can
        // return, padded exactly as `sampleEdges` will pad internally. Loading one area
        // and resolving another makes a provider decline geometry it actually holds.
        const shadowBbox = bboxAroundEdges(
          [{ from: [west, south], to: [east, north] }],
          QUERY_PAD_M,
        )!;
        const field = shadowFieldRef.current!;

        readinessAbort = new AbortController();
        const readinessSignal = AbortSignal.any([calcSignal, readinessAbort.signal]);
        const readyOptions = {
          signal: readinessSignal,
          deadlineAt: Date.now() + ROUTE_READINESS_BUDGET_MS,
        };

        const broadPreload = field.ready(shadowBbox, readyOptions).catch(() => {});
        let graph: RoutingGraph;
        try {
          graph = await fetchRoutingGraph(south, west, north, east, calcSignal);
        } catch (error) {
          readinessAbort.abort();
          throw error;
        }
        // Enumerate as soon as the graph arrives. These exact cells, rather than the
        // graph's large enclosing rectangle, are what sampling and confidence use.
        const edgeBatch = routingEdgeBatch(graph);
        const edgeRefs = edgeBatch.refs;
        const edgeKeys = edgeBatch.keys;
        const edgeDistances = edgeBatch.distances;
        const directedEdgeCount = edgeBatch.directedCount;
        await Promise.all([
          broadPreload,
          field.readyEdges?.(edgeRefs, readyOptions).catch(() => {}),
        ]);
        graphFetchMs = performance.now() - tFetch;
        if (myGen !== calcGenRef.current || calcSignal.aborted) return cancelled();

        // Does the field cover this route? Asking before touching the camera is the
        // whole point of A4b: when geometry can answer, the mid-calculation `fitBounds`
        // jump and the full-canvas readback are both pure cost. The camera work stays
        // exactly as PR #160 left it on the path that still needs pixels.
        const coverage =
          field.coverageEdges?.(edgeRefs, dateRef.current) ??
          field.coverage(shadowBbox, dateRef.current);
        const needsCanvas = coverage.confidence < LOW_CONFIDENCE;

        let buildingMask: ReturnType<IShadowLayer["readBuildingShadowMask"]> = null;

        if (needsCanvas) {
          // Flatten before reading the bounds: a tilted camera sees further, so the
          // in-view test has to be asked of the camera the canvas will be read from.
          const flattened = flattenForShadowReadback(map);
          const currentBounds = map.getBounds();
          const bboxInView =
            currentBounds.getWest() <= west &&
            currentBounds.getEast() >= east &&
            currentBounds.getSouth() <= south &&
            currentBounds.getNorth() >= north;

          if (!bboxInView) {
            map.fitBounds(
              [
                [west, south],
                [east, north],
              ] as [[number, number], [number, number]],
              { padding: 50, duration: 0 },
            );
          }
          if (!bboxInView || flattened) await waitForMapIdle(map);
          if (myGen !== calcGenRef.current) return cancelled();

          const tCanvas = performance.now();
          updateProgress({ message: "Reading shadow layer" });
          buildingMask = shadowLayerRef?.current?.readBuildingShadowMask() ?? null;
          dedicatedMaskReadMs = performance.now() - tCanvas;
        }

        // Project lng/lat → CSS pixels with MapLibre's transform so shadow sampling
        // stays correct under any camera orientation. A hand-rolled web-mercator
        // formula is only valid at bearing 0 / pitch 0; the moment the user rotates
        // or tilts the map it samples the wrong pixels and the shadow % is garbage.
        const projectToScreen = (lng: number, lat: number): [number, number] => {
          const p = map.project([lng, lat]);
          return [p.x, p.y];
        };

        clearVirtualNodes(graph);

        if (myGen !== calcGenRef.current) return cancelled();
        await yieldToBrowser();
        if (myGen !== calcGenRef.current) return cancelled();

        const tShadow = performance.now();
        const edgeShadowCache = new Map<
          string,
          { left: number; right: number; source: ShadowSource; confidence: number }
        >();

        // One canonical (low id → high id) `EdgeRef` per undirected street segment,
        // with parallel arrays for its cache key and length. The field takes the whole
        // batch at once: it partitions internally into 2 km sun cells and builds one
        // region-filtered shadow index per cell, so slicing this up here would only
        // rebuild those indices and re-triangulate every prism whose shadow straddles
        // a slice boundary.
        updateProgress({
          message: "Sampling street shadow",
          current: 0,
          total: edgeRefs.length,
        });
        const fieldShadow = edgeRefs.length > 0 ? field.sampleEdges(edgeRefs, dateRef.current) : [];
        if (myGen !== calcGenRef.current) return cancelled();

        // Per edge: trust the geometry, or fall back to pixels for that edge alone.
        // When the canvas was never read — the field covered the route — a weak edge
        // keeps the field's answer and its real confidence, and the route says so
        // rather than pretending to a certainty nothing measured.
        let canvasFallbackEdges = 0;
        const buildingProviders: Array<"tiles" | "overpass" | "dedicated-mask" | "none"> = [];
        const canopyProviders: Array<"osm" | "raster" | "both" | "none"> = [];
        for (let i = 0; i < edgeRefs.length; i++) {
          const sample = fieldShadow[i];
          if (sample.confidence >= LOW_CONFIDENCE || !buildingMask) {
            edgeShadowCache.set(edgeKeys[i], {
              left: sample.left,
              right: sample.right,
              source: sample.source,
              confidence: sample.confidence,
            });
            buildingProviders.push(sample.buildingSource ?? "none");
            const osmCanopy = sample.canopySources?.osm ?? false;
            const rasterCanopy = sample.canopySources?.raster ?? false;
            canopyProviders.push(
              osmCanopy && rasterCanopy
                ? "both"
                : osmCanopy
                  ? "osm"
                  : rasterCanopy
                    ? "raster"
                    : "none",
            );
          } else {
            const pixels = sampleBuildingMaskBothSidewalks(
              projectToScreen,
              buildingMask,
              edgeRefs[i].from,
              edgeRefs[i].to,
              edgeSampleCount(edgeDistances[i]),
            );
            edgeShadowCache.set(edgeKeys[i], {
              ...pixels,
              source: "canvas",
              confidence: CANVAS_CONFIDENCE,
            });
            canvasFallbackEdges++;
            buildingProviders.push("dedicated-mask");
            canopyProviders.push("none");
          }
          const done = i + 1;
          if (done === edgeRefs.length || done % 100 === 0) {
            updateProgress({
              message: "Sampling street shadow",
              current: done,
              total: edgeRefs.length,
            });
            await yieldToBrowser();
            if (myGen !== calcGenRef.current) return cancelled();
          }
        }
        shadowSampleMs = performance.now() - tShadow;

        const shareOf = <T>(values: T[], value: T) =>
          edgeRefs.length === 0
            ? 0
            : values.filter((entry) => entry === value).length / edgeRefs.length;

        const tDijkstra = performance.now();
        updateProgress({ message: "Building shadow-aware graph" });
        const routingAdj = new Map<number, GraphEdge[]>();
        const ensureRA = (id: number) => {
          if (!routingAdj.has(id)) routingAdj.set(id, []);
        };

        for (const [fromId, edges] of graph.adj) {
          if (fromId < 0) continue;
          ensureRA(fromId);
          for (const edge of edges) {
            if (edge.toId < 0) continue;
            if (!graph.nodes.has(edge.toId)) continue;
            const lo = Math.min(fromId, edge.toId);
            const hi = Math.max(fromId, edge.toId);
            const { left, right } = edgeShadowCache.get(`${lo},${hi}`) ?? { left: 0, right: 0 };
            routingAdj.get(fromId)!.push(...parallelSidewalkEdges(fromId, edge, left, right));
          }
        }
        const routingGraph: RoutingGraph = { nodes: graph.nodes, adj: routingAdj };
        const spatialGrid = new SpatialGrid(routingGraph.nodes);

        /**
         * Length of the segment between two consecutive nodes on a chosen path.
         *
         * Both sidewalk edges of a segment carry the same `distanceM`, so the first
         * match is the answer. Checking the reverse direction covers the virtual snap
         * edges, which are wired one way into their host segment.
         */
        const edgeDistanceFor = (from: number, to: number): number => {
          const forward = routingAdj.get(from)?.find((e) => e.toId === to);
          if (forward) return forward.distanceM;
          return routingAdj.get(to)?.find((e) => e.toId === from)?.distanceM ?? 0;
        };

        updateProgress({ message: "Snapping stops to walkable streets" });
        const MAX_SNAP_DIST_M = 100;
        const snapStops = (stops: [number, number][]) =>
          snapRouteStopsToReachableEdges(stops, routingGraph, {
            maxSnapDistanceM: MAX_SNAP_DIST_M,
            // Snap onto edges the selected mode can actually leave: a bike stop
            // snapped to a bicycle=no edge strands the search on a virtual node
            // with no legal exit.
            travelMode: travelModeRef.current,
            describeStop: (index, total) => {
              if (index === 0) return "the start point";
              if (index === total - 1) return "the destination";
              return `stop ${index + 1}`;
            },
          });
        let snappedStops: ReturnType<typeof snapRouteStopsToReachableEdges>;
        let forcedPartial: PartialRouteInfo | null = null;
        try {
          snappedStops = snapStops(routeStops);
        } catch (fullRouteError) {
          // Keep a connected prefix when a later multi-stop leg cannot be reached.
          const originalStops = routeStops;
          let prefixResult: ReturnType<typeof snapRouteStopsToReachableEdges> | null = null;
          for (let prefixLength = originalStops.length - 1; prefixLength >= 2; prefixLength--) {
            clearVirtualNodes(routingGraph);
            try {
              prefixResult = snapStops(originalStops.slice(0, prefixLength));
              routeStops = originalStops.slice(0, prefixLength);
              forcedPartial = {
                completedLegs: prefixLength - 1,
                failedLeg: prefixLength,
                totalLegs: originalStops.length - 1,
              };
              break;
            } catch {
              // Try a shorter prefix; its completed legs are still valuable.
            }
          }
          if (!prefixResult) throw fullRouteError;
          snappedStops = prefixResult;
        }
        const effectiveStartId = snappedStops.ids[0];
        const effectiveEndId = snappedStops.ids[snappedStops.ids.length - 1];
        if (process.env.NODE_ENV !== "production") {
          snappedStops.ids.forEach((id, i) => {
            const sn = routingGraph.nodes.get(id);
            if (!sn) return;
            console.log(
              `[routing] stop ${i + 1} [${routeStops[i]}] snapped to connected road at ` +
                `[${sn.lon},${sn.lat}] (${haversineMeters(routeStops[i], [sn.lon, sn.lat]).toFixed(1)} m)`,
            );
          });
        }

        const midLat = (a[1] + b[1]) / 2;
        const midLng = (a[0] + b[0]) / 2;
        const solarIntensity = computeSolarIntensity(dateRef.current, midLat, midLng);
        const CROSSING_PENALTY_M = 15;
        const travelMode = travelModeRef.current;
        const opts = { crossingPenaltyM: CROSSING_PENALTY_M, solarIntensity, straightLineDistM, travelMode };
        // Station access is pedestrian even on a bike journey (mixed-mode is E6).
        const walkOpts = { ...opts, travelMode: "walk" as TravelModeId };

        let options: RouteOption[];

        if ((plan?.via ?? additionalWaypoints).length === 0) {
          updateProgress({ message: "Finding route choices" });
          const paretoResults = paretoRoutes(routingGraph, effectiveStartId, effectiveEndId, opts);
          dijkstraMs = performance.now() - tDijkstra;

          // Results are ordered [shortest, balanced, most shadowed] with duplicate
          // paths removed — when only 2 remain, the second is always the shadowed
          // end of the Pareto front, not "Balanced".
          const ROUTE_LABELS =
            paretoResults.length === 2
              ? ["Shortest", "Most shadowed"]
              : ["Shortest", "Balanced", "Most shadowed"];
          options = paretoResults.map((result, i) => ({
            label: ROUTE_LABELS[i] ?? "Route",
            geojson: connectRouteEndpoints(graphToGeoJSON(result.nodeIds, routingGraph), a, b),
            sides: result.sides,
            distanceM: result.distanceM,
            shadowCoverage: result.shadowCoverage,
            longestContinuousShadowM: result.longestContinuousShadowM,
            longestContinuousSunM: result.longestContinuousSunM,
            shadowTransitions: result.shadowTransitions,
            detourRatio: result.detourRatio,
            turnCount: result.turnCount,
            shadowSource: summarizeShadowSource(result.nodeIds, edgeShadowCache, edgeDistanceFor),
            travelMode,
            totalTimeSec: travelTimeSeconds(result.distanceM, travelMode),
            surfaceMetresM: result.surfaceMetresM,
          }));
        } else {
          const nodeChain = snappedStops.ids;

          const MULTI_LABELS = ["Shortest", "Balanced", "Most shadowed"] as const;
          const STRENGTHS = [0, 0.5, 1.0];
          const totalRouteLegs = STRENGTHS.length * (nodeChain.length - 1);
          let completedRouteLegs = 0;
          options = [];
          updateProgress({
            message: "Calculating route legs",
            current: completedRouteLegs,
            total: totalRouteLegs,
          });

          for (let si = 0; si < STRENGTHS.length; si++) {
            const strength = STRENGTHS[si];
            let totalDist = 0;
            let totalShadowDist = 0;
            const allCoords: [number, number][] = [];
            // `segResult` is scoped to the leg loop, but provenance is a property of the
            // whole route — so the node ids have to outlive the leg that produced them.
            const allNodeIds: number[] = [];
            const legs: RouteLeg[] = [];
            const surfaceMetresM: Record<string, number> = {};
            let failed = false;
            let failedLeg: number | null = null;

            for (let seg = 0; seg < nodeChain.length - 1; seg++) {
              const segResult = dijkstra(
                routingGraph,
                nodeChain[seg],
                nodeChain[seg + 1],
                strength,
                opts,
              );
              completedRouteLegs++;
              updateProgress({
                message: "Calculating route legs",
                current: completedRouteLegs,
                total: totalRouteLegs,
              });
              await yieldToBrowser();
              if (myGen !== calcGenRef.current) return cancelled();
              if (!segResult) {
                failed = true;
                failedLeg = seg + 1;
                break;
              }
              const segGeojson = connectRouteEndpoints(
                graphToGeoJSON(segResult.nodeIds, routingGraph),
                routeStops[seg],
                routeStops[seg + 1],
              );
              const legCoords = segGeojson.geometry.coordinates as [number, number][];
              const stitchedCoords = allCoords.length > 0 ? legCoords.slice(1) : legCoords;
              allCoords.push(...stitchedCoords);
              allNodeIds.push(
                ...(allNodeIds.length > 0 ? segResult.nodeIds.slice(1) : segResult.nodeIds),
              );
              legs.push({
                type: "walk",
                geojson: segGeojson,
                distanceM: segResult.distanceM,
                shadowCoverage: segResult.shadowCoverage,
              });
              totalDist += segResult.distanceM;
              totalShadowDist += segResult.distanceM * segResult.shadowCoverage;
              for (const [surface, metres] of Object.entries(segResult.surfaceMetresM)) {
                surfaceMetresM[surface] = (surfaceMetresM[surface] ?? 0) + metres;
              }
              if (si === 0) updatePreview(allCoords);
            }

            if (failed) {
              if (failedLeg != null && allCoords.length >= 2 && totalDist > 0) {
                const shadowCov = totalShadowDist / totalDist;
                options.push({
                  label: `${MULTI_LABELS[si] ?? "Route"} (partial)`,
                  geojson: {
                    type: "Feature",
                    properties: {},
                    geometry: { type: "LineString", coordinates: allCoords },
                  },
                  distanceM: totalDist,
                  shadowCoverage: shadowCov,
                  longestContinuousShadowM: 0,
                  longestContinuousSunM: 0,
                  shadowTransitions: 0,
                  detourRatio: 1.0,
                  turnCount: 0,
                  legs,
                  shadowSource: summarizeShadowSource(allNodeIds, edgeShadowCache, edgeDistanceFor),
                  travelMode,
                  totalTimeSec: travelTimeSeconds(totalDist, travelMode),
                  surfaceMetresM: { ...surfaceMetresM },
                  partial: {
                    completedLegs: failedLeg - 1,
                    failedLeg,
                    totalLegs: nodeChain.length - 1,
                  },
                });
              }
              continue;
            }
            if (allCoords.length < 2) continue;

            const shadowCov = totalDist > 0 ? totalShadowDist / totalDist : 0;
            options.push({
              label: forcedPartial
                ? `${MULTI_LABELS[si] ?? "Route"} (partial)`
                : (MULTI_LABELS[si] ?? "Route"),
              geojson: connectRouteEndpoints(
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: allCoords },
                },
                a,
                routeStops[routeStops.length - 1],
              ),
              distanceM: totalDist,
              shadowCoverage: shadowCov,
              longestContinuousShadowM: 0,
              longestContinuousSunM: 0,
              shadowTransitions: 0,
              detourRatio: 1.0,
              turnCount: 0,
              legs,
              shadowSource: summarizeShadowSource(allNodeIds, edgeShadowCache, edgeDistanceFor),
              travelMode,
              totalTimeSec: travelTimeSeconds(totalDist, travelMode),
              surfaceMetresM: { ...surfaceMetresM },
              partial: forcedPartial ?? undefined,
            });
          }

          dijkstraMs = performance.now() - tDijkstra;

          options = options.filter(
            (o, i, arr) => arr.findIndex((x) => Math.abs(x.distanceM - o.distanceM) < 1) === i,
          );
        }

        if (options.length === 0)
          throw new Error(
            "No walkable path found between the selected points. Try points on connected streets.",
          );

        // Train transit routing
        if (straightLineDistM <= 500) {
          if (import.meta.env.DEV)
            console.log(
              "[transit] Skipped: straight-line distance",
              straightLineDistM.toFixed(0),
              "m <= 500 m",
            );
        }
        // Set when a transit route was found and then discarded, so the user is
        // told transit was considered rather than silently shown walking only.
        let transitNotice: string | null = null;
        if (!forcedPartial && straightLineDistM > 500) {
          try {
            updateProgress({ message: "Checking transit option" });
            const trainPadding = Math.max(padding, 0.015);
            const trainSouth = Math.min(a[1], b[1]) - trainPadding;
            const trainNorth = Math.max(a[1], b[1]) + trainPadding;
            const trainWest = Math.min(a[0], b[0]) - trainPadding;
            const trainEast = Math.max(a[0], b[0]) + trainPadding;

            if (import.meta.env.DEV)
              console.log("[transit] Fetching train graph for bbox:", {
                trainSouth,
                trainWest,
                trainNorth,
                trainEast,
              });
            const trainGraph = await fetchBestTrainGraph(
              trainSouth,
              trainWest,
              trainNorth,
              trainEast,
              calcSignal,
            );
            if (import.meta.env.DEV)
              console.log(
                "[transit] trainGraph:",
                trainGraph
                  ? `${trainGraph.stations.size} stations, ${trainGraph.lineColors.size} lines`
                  : "null",
              );

            if (trainGraph && trainGraph.stations.size >= 2) {
              // Which hour's headway gets read is a question about where the
              // rider boards, not about the browser they planned it in — the
              // published table is a New York timetable either way. `zoneAt` is
              // synchronous but empty until its boundary set loads, and this is
              // an async pipeline, so it can simply be waited for; an unresolved
              // lookup leaves the wait unpriced rather than reading hour 0 in UTC.
              await ensureZoneLookup();
              const boardZone = zoneAt(a[1], a[0]);
              const departure = boardZone
                ? {
                    at: dateRef.current,
                    utcOffsetMin: utcOffsetMinAt(boardZone, dateRef.current),
                  }
                : {};
              if (import.meta.env.DEV)
                console.log("[transit] boarding zone:", boardZone ?? "unresolved — wait unpriced");

              const bestTrain = findBestTrainRoute(a, b, trainGraph, 1500, 5, departure);
              if (import.meta.env.DEV)
                console.log(
                  "[transit] bestTrain:",
                  bestTrain
                    ? `entry=${bestTrain.entryStation.name}, exit=${bestTrain.exitStation.name}, ${bestTrain.path.stationIds.length} stations, ${bestTrain.path.segments.length} segments`
                    : "null",
                );

              if (bestTrain) {
                const WALK_SHADOW_STRENGTH = 0.5;

                // Entrances are fetched here, and not before, because only now
                // is it known which two stations matter. Asking Overpass for the
                // whole route's bbox meant a box the size of the trip plus
                // ~3.3 km in each direction, for doors within 400 m of two
                // points.
                const entranceBoxes = [bestTrain.entryStation, bestTrain.exitStation].map(
                  (station) => boxAround(station.lat, station.lon, ENTRANCE_MATCH_MAX_M),
                );
                const entranceResult = await fetchStationEntranceBoxes(entranceBoxes, calcSignal);
                const { entrances } = entranceResult;
                if (import.meta.env.DEV)
                  console.log(
                    "[transit] entrances:",
                    entrances.length,
                    "in 2 station boxes",
                    entranceResult.failed ? "(fetch FAILED — list is cache only)" : "",
                  );

                // Matched against **every** station, not just the two endpoints,
                // even though only their boxes were fetched. A door inside the
                // entry station's box may really belong to a neighbour 200 m
                // away; offering the full set is what lets the matcher give it
                // to that neighbour instead of misattributing it here.
                const stationEntrances = new Map<
                  string,
                  { lat: number; lon: number; kind?: "entrance" | "station" }[]
                >();
                for (const entrance of entrances) {
                  const stationId = matchEntranceToTrainStation(entrance, trainGraph.stations);
                  if (stationId != null) {
                    if (!stationEntrances.has(stationId)) stationEntrances.set(stationId, []);
                    stationEntrances
                      .get(stationId)!
                      .push({ lat: entrance.lat, lon: entrance.lon, kind: entrance.kind });
                  }
                }

                const boardCandidates = stationEntrances.get(bestTrain.entryStation.id) ?? [
                  { ...bestTrain.entryStation, kind: "station" },
                ];
                const boardEntrance = pickClosestEntrance(a, boardCandidates, haversineMeters);

                const alightCandidates = stationEntrances.get(bestTrain.exitStation.id) ?? [
                  { ...bestTrain.exitStation, kind: "station" },
                ];
                const alightEntrance = pickClosestEntrance(b, alightCandidates, haversineMeters);

                // Snap to somewhere the walker can actually reach. A station
                // centroid, and sometimes a real entrance, sits on a fragment of
                // the pedestrian graph that connects to nothing — station
                // interiors and service stubs are their own islands. Nearest-node
                // snapping lands there, the walk leg fails, and the whole transit
                // option is dropped for a reason nobody can see.
                //
                // The walking route from A to B already succeeded, so both ends
                // share one component; computing it from the start covers the
                // alight snap too. `walkOpts` pins travel mode to walk, and walk
                // prohibits no edge, so this set is exactly what dijkstra can
                // traverse.
                const walkableFromStart = reachableFrom(routingGraph, effectiveStartId);
                const boardNodeId = snapToReachable(
                  [boardEntrance.lon, boardEntrance.lat],
                  routingGraph,
                  walkableFromStart,
                  spatialGrid,
                );
                const walkA = dijkstra(
                  routingGraph,
                  effectiveStartId,
                  boardNodeId,
                  WALK_SHADOW_STRENGTH,
                  walkOpts,
                );
                if (import.meta.env.DEV)
                  console.log(
                    "[transit] walkA:",
                    walkA ? `${walkA.distanceM.toFixed(0)}m` : "null",
                    "boardNodeId:",
                    boardNodeId,
                  );

                const alightNodeId = snapToReachable(
                  [alightEntrance.lon, alightEntrance.lat],
                  routingGraph,
                  walkableFromStart,
                  spatialGrid,
                );
                const walkB = dijkstra(
                  routingGraph,
                  alightNodeId,
                  effectiveEndId,
                  WALK_SHADOW_STRENGTH,
                  walkOpts,
                );
                if (import.meta.env.DEV)
                  console.log(
                    "[transit] walkB:",
                    walkB ? `${walkB.distanceM.toFixed(0)}m` : "null",
                    "alightNodeId:",
                    alightNodeId,
                  );

                if (!walkA || !walkB) {
                  if (import.meta.env.DEV)
                    console.warn(
                      "[transit] Walk leg failed:",
                      !walkA ? "walkA=null" : "",
                      !walkB ? "walkB=null" : "",
                    );
                  transitNotice = entranceResult.failed
                    ? `No walking route to ${bestTrain.entryStation.name}. Station entrance data could not be loaded — try again in a moment.`
                    : `Transit via ${bestTrain.entryStation.name} was found but no walking route reaches it, so it is not offered here.`;
                }
                if (walkA && walkB) {
                  const walkAGeoJSON = graphToGeoJSON(walkA.nodeIds, routingGraph);
                  const walkBGeoJSON = graphToGeoJSON(walkB.nodeIds, routingGraph);

                  const transitCoords: [number, number][] = bestTrain.path.stationIds.map((id) => {
                    const s = trainGraph.stations.get(id)!;
                    return [s.lon, s.lat];
                  });
                  const transitGeoJSON: GeoJSON.Feature<GeoJSON.LineString> = {
                    type: "Feature",
                    properties: {},
                    geometry: { type: "LineString", coordinates: transitCoords },
                  };

                  const stopNames = bestTrain.path.stationIds.map(
                    (id) => trainGraph.stations.get(id)?.name ?? `Station ${id}`,
                  );

                  const primaryLine = bestTrain.path.lines[0] ?? "";
                  const lineColor = trainGraph.lineColors.get(primaryLine) ?? "#0070BD";
                  const lineName = trainGraph.lineNames.get(primaryLine) ?? primaryLine;
                  const lineMode = trainGraph.lineModes.get(primaryLine) ?? "subway";
                  const sunExposure = TRAIN_SUN_EXPOSURE[lineMode];

                  // Riding, changing lines, and standing on the platform. The
                  // wait is carried separately as well so the card can say how
                  // much of the quoted time it is.
                  const transitTimeSec = bestTrain.path.totalSec;

                  const legs: RouteLeg[] = [
                    {
                      type: "walk",
                      geojson: walkAGeoJSON,
                      distanceM: walkA.distanceM,
                      shadowCoverage: walkA.shadowCoverage,
                    },
                    {
                      type: "transit",
                      geojson: transitGeoJSON,
                      travelTimeSec: transitTimeSec,
                      waitSec: bestTrain.path.waitSec,
                      line: primaryLine,
                      lineColor,
                      lineName,
                      sunExposure,
                      stops: stopNames,
                    },
                    {
                      type: "walk",
                      geojson: walkBGeoJSON,
                      distanceM: walkB.distanceM,
                      shadowCoverage: walkB.shadowCoverage,
                    },
                  ];

                  const totalWalkDistM = walkA.distanceM + walkB.distanceM;
                  const totalTimeSec = travelTimeSeconds(totalWalkDistM, "walk") + transitTimeSec;
                  const shadowCov =
                    totalWalkDistM > 0
                      ? (walkA.distanceM * walkA.shadowCoverage +
                          walkB.distanceM * walkB.shadowCoverage) /
                        totalWalkDistM
                      : 0;

                  const combinedGeoJSON: GeoJSON.Feature<GeoJSON.LineString> = {
                    type: "Feature",
                    properties: {},
                    geometry: {
                      type: "LineString",
                      coordinates: [
                        ...walkAGeoJSON.geometry.coordinates,
                        ...walkBGeoJSON.geometry.coordinates,
                      ],
                    },
                  };

                  const drawData = buildTrainDrawData(
                    bestTrain.path.segments,
                    trainGraph.lineColors,
                  );

                  options.push({
                    label: "Via Transit",
                    geojson: combinedGeoJSON,
                    distanceM: totalWalkDistM,
                    shadowCoverage: shadowCov,
                    longestContinuousShadowM: 0,
                    longestContinuousSunM: 0,
                    shadowTransitions: 0,
                    detourRatio: 1.0,
                    turnCount: 0,
                    legs,
                    totalTimeSec,
                    mrtEntrances: [
                      [boardEntrance.lon, boardEntrance.lat] as [number, number],
                      [alightEntrance.lon, alightEntrance.lat] as [number, number],
                    ],
                    trainDrawData: drawData,
                  });
                }
              }
            }
          } catch (e) {
            console.error("[routing] Train routing failed:", e);
          }
        }

        const routeSnapshots = options.map((o) => ({
          label: o.label,
          distanceM: o.distanceM,
          shadowCoverage: o.shadowCoverage,
        }));
        const { shadowCoverageGainPp, pathLengthDeltaPct } = computeDerivedKpis(routeSnapshots);
        recordRoutingRun({
          timestamp: Date.now(),
          phases: {
            graphFetch: graphFetchMs,
            canvasRead: canvasReadMs,
            dedicatedMaskRead: dedicatedMaskReadMs,
            shadowSample: shadowSampleMs,
            dijkstra: dijkstraMs,
            total: performance.now() - t0,
          },
          graphNodeCount: graph.nodes.size,
          graphDirectedEdges: directedEdgeCount,
          shadowFallbackShare: edgeRefs.length > 0 ? canvasFallbackEdges / edgeRefs.length : 0,
          buildingProviderShares: {
            tiles: shareOf(buildingProviders, "tiles"),
            overpass: shareOf(buildingProviders, "overpass"),
            "dedicated-mask": shareOf(buildingProviders, "dedicated-mask"),
            none: shareOf(buildingProviders, "none"),
          },
          canopySourceShares: {
            osm: shareOf(canopyProviders, "osm"),
            raster: shareOf(canopyProviders, "raster"),
            both: shareOf(canopyProviders, "both"),
            none: shareOf(canopyProviders, "none"),
          },
          fallbackReason: needsCanvas
            ? buildingMask
              ? "low-confidence"
              : "mask-unavailable"
            : null,
          routes: routeSnapshots,
          routeComputeMs: performance.now() - t0,
          shadowCoverageGainPp,
          pathLengthDeltaPct,
        });

        if (calcGenRef.current !== myGen) return cancelled();
        updateProgress({ message: "Finalizing route options" });
        const partialWarning = options.find((o) => o.partial)?.partial;
        setNavRoutes(options);
        setSelectedRouteIndex(0);
        setRouteSolarIntensity(solarIntensity);
        setRoutePreview(null);
        seam.current.setSketchPoints([]);
        seam.current.setNavWarning(
          partialWarning ? partialRouteNotice(partialWarning) : transitNotice,
        );
        seam.current.setSimplifiedWaypoints(null);
        // The panel shows one mode's list, and selection resets to its first
        // entry — so frame that, not whichever option happens to be first
        // overall.
        fitMapToRoute(routesForMode(options, routeModeRef.current)[0] ?? options[0]);
        const metrics = options.map((option) => ({
          label: option.label,
          distanceM: option.distanceM,
          shadowCoverage: option.shadowCoverage,
          totalTimeSec: option.totalTimeSec,
        }));
        const unroutableLegs = options.flatMap((option) =>
          option.partial ? [option.partial] : [],
        );
        if (unroutableLegs.length > 0) {
          return {
            status: "partial",
            metrics,
            shadowProvenance: options[0]?.shadowSource ?? null,
            unroutableLegs,
          };
        }
        return {
          status: "completed",
          metrics,
          shadowProvenance: options[0]?.shadowSource ?? null,
        };
      } catch (e) {
        readinessAbort?.abort();
        if (e instanceof DOMException && e.name === "AbortError") return cancelled();
        if (calcSignal.aborted) return cancelled();
        const message = e instanceof Error ? e.message : "Routing failed";
        setNavError(message);
        if (/No walkable path found|connected walkable street/.test(message)) {
          return { status: "no_plan_found", message };
        }
        return { status: "error", message };
      } finally {
        externalSignal?.removeEventListener("abort", cancelFromOutside);
        if (calcGenRef.current === myGen) {
          // A superseded calculation leaves the camera flat on purpose — the one
          // that replaced it owns the restore, and still holds the original pitch.
          restorePitchAfterShadowReadback(mapRef.current);
          setIsCalculating(false);
          setRouteProgress(null);
          setRoutePreview(null);
        }
      }
    },
    [
      additionalWaypoints,
      mapRef,
      shadowLayerRef,
      dateRef,
      waypointARef,
      waypointBRef,
      travelModeRef,
      seam,
      fitMapToRoute,
      flattenForShadowReadback,
      restorePitchAfterShadowReadback,
      replaceAllStops,
    ],
  );

  const createRoutePlanRequest = useCallback(
    (plan: RoutePlan): RoutePlanRequest => {
      const planRevision = advanceRoutePlanRevision();
      // Fingerprint what the trip ACTUALLY commits, not what a C4 plan looks
      // like it should commit. A plan carries no dwell, but `replaceStops`
      // preserves the dwell of any stop whose coordinates did not move, so a
      // plan issued over a trip that already has dwell commits a non-zero
      // signature. Assuming zeros here would miss the skip below, bump the
      // revision twice, and supersede the agent's own job.
      const entries = [
        { coord: plan.from, label: plan.fromLabel },
        ...plan.via.map((coord) => ({ coord })),
        { coord: plan.to, label: plan.toLabel },
      ];
      const committedDwell = replaceAllStops(entries);
      pendingAgentPlanFingerprintRef.current = routePlanFingerprint(
        plan.from,
        plan.to,
        plan.via,
        committedDwell,
      );
      const actionId = `agent-route-action-${++routePlanActionSeqRef.current}`;
      const retry = 0;
      const request: RoutePlanRequest = {
        requestId: `agent-route-request-${routePlanActionSeqRef.current}`,
        inputVersion: ++routePlanInputVersionRef.current,
        planRevision,
        actionId,
        retry,
        idempotencyKey: `${actionId}:retry:${retry}`,
        plan,
      };
      return request;
    },
    [
      advanceRoutePlanRevision,
      replaceAllStops,
    ],
  );

  const submitRoutePlan = useCallback(
    (request: RoutePlanRequest): Promise<RoutePlanTerminalResult> => {
      const terminalPromise = agentRouteJobsRef.current.submit(request, (job, signal) =>
        calculateRoute(job.plan, signal),
      );
      // Observe completion without wrapping the coordinator's Promise: C4 callers
      // rely on concurrent submits of one action receiving the exact same lease.
      void terminalPromise.then((terminal) => {
        if (
          (terminal.status === "completed" || terminal.status === "partial") &&
          terminal.planRevision === routePlanRevisionRef.current
        ) {
          routeReceiptObjectRef.current = {
            id: `route:${terminal.requestId}:${terminal.actionId}:${terminal.planRevision}`,
            kind: "route",
            requestId: terminal.requestId,
            actionId: terminal.actionId,
            planRevision: terminal.planRevision,
          };
        }
      });
      return terminalPromise;
    },
    [calculateRoute],
  );

  const cancelRoutePlan = useCallback(
    (requestId: string) => agentRouteJobsRef.current.cancel(requestId),
    [],
  );
  // Read-only seam for C5 receipt verification. The routing owner remains the
  // sole writer of this revision and C5 never infers it from drawn geometry.
  const getCurrentPlanRevision = useCallback(() => routePlanRevisionRef.current, []);
  const getRouteReceiptMapObjects = useCallback(() => {
    const object = routeReceiptObjectRef.current;
    return object && object.planRevision === routePlanRevisionRef.current ? [object] : [];
  }, []);

  // Derived values
  const filteredRoutes = useMemo(
    () => routesForMode(navRoutes, routeMode),
    [navRoutes, routeMode],
  );

  // `selectedRouteIndex` indexes what the panel renders, so it must be resolved
  // against the same array — see `NavSeam.visibleRoutes`.
  const selectedRoute = filteredRoutes[selectedRouteIndex];
  const selectedNavRoute =
    routePreview ??
    (selectedRoute?.legs
      ? ({
          type: "FeatureCollection",
          features: selectedRoute.legs
            .filter((l: RouteLeg) => l.type === "walk")
            .map((l: RouteLeg) => l.geojson),
        } as GeoJSON.FeatureCollection)
      : (selectedRoute?.geojson ?? null));
  const navTrainDrawData = selectedRoute?.trainDrawData ?? null;
  const navMrtEntrances = selectedRoute?.mrtEntrances ?? null;

  return {
    navRoutes,
    selectedRouteIndex,
    isCalculating,
    routeProgress,
    routePreview,
    navError,
    routeSolarIntensity,
    calcGenRef,
    calcAbortRef,
    shadowFieldRef,
    advanceRoutePlanRevision,
    cancelInFlightCalculation,
    fitMapToRoute,
    flattenForShadowReadback,
    restorePitchAfterShadowReadback,
    calculateRoute,
    createRoutePlanRequest,
    submitRoutePlan,
    cancelRoutePlan,
    getCurrentPlanRevision,
    getRouteReceiptMapObjects,
    setNavRoutes,
    setSelectedRouteIndex,
    setNavError,
    setIsCalculating,
    setRouteProgress,
    setRoutePreview,
    setRouteSolarIntensity,
    selectedNavRoute,
    navTrainDrawData,
    navMrtEntrances,
    filteredRoutes,
    // The geometry shadow field, shared so a day sweep reuses this cache
    // rather than building a second one and re-fetching the same prisms.
    shadowField: shadowFieldRef.current,
  };
}

export type UseRoutingResult = ReturnType<typeof useRouting>;

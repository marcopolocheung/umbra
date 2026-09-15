import { useCallback, useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { fetchRoutingGraph } from "../lib/overpass";
import {
  bfsReachable,
  connectRouteEndpoints,
  dijkstra,
  findSketchGaps,
  graphToGeoJSON,
  simplifyPolyline,
  sketchBoundingBox,
  snapToEdge,
  snapToReachableEdge,
} from "../lib/routing";
import type {
  GraphEdge,
  LatLng,
  RouteOption,
  RoutingGraph,
  SketchPoint,
} from "../lib/routing";
import { sampleBuildingMaskBothSidewalks } from "../lib/shadowSampling";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import {
  LOW_CONFIDENCE,
  QUERY_PAD_M,
  bboxAroundEdges,
  edgeSampleCount,
} from "../lib/shadowField/ShadowField";
import type { EdgeRef, ShadowField } from "../lib/shadowField/ShadowField";
import { buildingCentroidAt, snapOutsideBuilding } from "../lib/building-snap";
import type { MapBuildingQuery } from "../lib/building-snap";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import {
  ROUTE_READINESS_BUDGET_MS,
  cloneRoutingGraph,
  removeVirtualNode,
  waitForMapIdle,
} from "../lib/navigationHelpers";

/**
 * Sketch / draw-route mode, extracted from `useNavigation` (G6a).
 *
 * Owns the sketch point list, draw mode, and the sketch route pipeline. The
 * route-calculation seam it shares with `useRouting` — the generation counter,
 * the abort controller, the geometry shadow field, the camera flatten/restore
 * pair, the plan-revision advance, and the route-result setters — arrives as
 * explicit args wired by the `useNavigation` facade, so starting a sketch
 * calculation still supersedes an in-flight normal one and vice versa.
 */
export interface UseSketchArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  shadowLayerRef?: React.MutableRefObject<IShadowLayer | null>;
  dateRef: React.MutableRefObject<Date>;
  calcGenRef: React.MutableRefObject<number>;
  calcAbortRef: React.MutableRefObject<AbortController | null>;
  shadowFieldRef: React.MutableRefObject<ShadowField | null>;
  fitMapToRoute: (route: RouteOption) => void;
  flattenForShadowReadback: (map: maplibregl.Map) => boolean;
  restorePitchAfterShadowReadback: (map: maplibregl.Map | null) => void;
  advanceRoutePlanRevision: () => number;
  setNavRoutes: React.Dispatch<React.SetStateAction<RouteOption[]>>;
  setSelectedRouteIndex: React.Dispatch<React.SetStateAction<number>>;
  setNavError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsCalculating: React.Dispatch<React.SetStateAction<boolean>>;
  setRouteProgress: React.Dispatch<React.SetStateAction<RouteCalculationProgress | null>>;
}

export function useSketch({
  mapRef,
  shadowLayerRef,
  dateRef,
  calcGenRef,
  calcAbortRef,
  shadowFieldRef,
  fitMapToRoute,
  flattenForShadowReadback,
  restorePitchAfterShadowReadback,
  advanceRoutePlanRevision,
  setNavRoutes,
  setSelectedRouteIndex,
  setNavError,
  setIsCalculating,
  setRouteProgress,
}: UseSketchArgs) {
  // Sketch drawing state
  const [sketchPoints, setSketchPoints] = useState<SketchPoint[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [navWarning, setNavWarning] = useState<string | null>(null);
  const [simplifiedWaypoints, setSimplifiedWaypoints] = useState<LatLng[] | null>(null);

  const drawModeRef = useRef(drawMode);
  const sketchPointsRef = useRef(sketchPoints);

  drawModeRef.current = drawMode;
  sketchPointsRef.current = sketchPoints;

  // Keyboard shortcuts for draw mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === "d" || e.key === "D") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setDrawMode((prev) => {
            if (prev) {
              setSketchPoints([]);
              setNavWarning(null);
              setSimplifiedWaypoints(null);
            }
            return !prev;
          });
        }
      } else if (e.key === "Escape" && drawModeRef.current) {
        e.preventDefault();
        setDrawMode(false);
        setSketchPoints([]);
        setNavWarning(null);
        setSimplifiedWaypoints(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleDrawModeToggle = useCallback(() => {
    setDrawMode((prev) => {
      setSketchPoints([]);
      setNavWarning(null);
      setSimplifiedWaypoints(null);
      return !prev;
    });
  }, []);

  const handleClearSketch = useCallback(() => {
    setSketchPoints([]);
    setNavWarning(null);
    setSimplifiedWaypoints(null);
  }, []);

  const handleSketchPointClick = useCallback(
    (coord: LatLng) => {
      setSketchPoints((prev) => [...prev, { coord, address: null }]);

      const map = mapRef.current;
      const centroid = map ? buildingCentroidAt(coord, map as unknown as MapBuildingQuery) : null;
      const target = centroid ?? coord;

      geocodeReverse(target[1], target[0]).then((label) => {
        if (!label) return;
        setSketchPoints((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const p = next[i];
            if (p.address == null && p.coord[0] === coord[0] && p.coord[1] === coord[1]) {
              next[i] = { coord: p.coord, address: label };
              break;
            }
          }
          return next;
        });
      });
    },
    [mapRef],
  );

  const handleSketchPointDrag = useCallback(
    (index: number, coord: LatLng) => {
      setSketchPoints((prev) => {
        const next = [...prev];
        if (index < 0 || index >= next.length) return prev;
        next[index] = { coord, address: null };
        return next;
      });

      const map = mapRef.current;
      const centroid = map ? buildingCentroidAt(coord, map as unknown as MapBuildingQuery) : null;
      const target = centroid ?? coord;

      geocodeReverse(target[1], target[0]).then((label) => {
        if (!label) return;
        setSketchPoints((prev) => {
          const next = [...prev];
          if (index >= next.length) return prev;
          const p = next[index];
          if (p.coord[0] === coord[0] && p.coord[1] === coord[1] && p.address == null) {
            next[index] = { coord, address: label };
          }
          return next;
        });
      });
    },
    [mapRef],
  );

  // -------------------------------------------------------------------------
  // Sketch routing helpers
  // -------------------------------------------------------------------------

  const snapSketchWaypoints = useCallback(
    (
      waypoints: LatLng[],
      graph: RoutingGraph,
      map: maplibregl.Map,
    ): { snappedIds: number[]; snappedCoords: LatLng[] } => {
      const coords = waypoints.map((wp) =>
        snapOutsideBuilding(wp, map as unknown as MapBuildingQuery),
      );

      const snappedIds: number[] = [];
      const MAX_RESNAP_DIST_M = 250;

      const firstId = snapToEdge(coords[0], graph, -1000);
      snappedIds.push(firstId);

      for (let i = 1; i < coords.length; i++) {
        const preferredComponent = bfsReachable(graph, snappedIds[i - 1]);

        const primaryVid = -1000 - i;
        let id = snapToEdge(coords[i], graph, primaryVid);

        if (!preferredComponent.has(id)) {
          if (id < 0) removeVirtualNode(graph, id);

          const fallbackVid = -2000 - i;
          const fallback = snapToReachableEdge(coords[i], graph, preferredComponent, fallbackVid);
          if (!fallback) {
            throw new Error(
              `No walkable streets connected to your sketch near point ${i + 1}. Try drawing closer to streets.`,
            );
          }
          if (fallback.distM > MAX_RESNAP_DIST_M) {
            throw new Error(
              `Point ${i + 1} is about ${Math.round(fallback.distM)} m from the nearest connected street. Try drawing closer to streets.`,
            );
          }
          id = fallback.id;
        }

        snappedIds.push(id);
      }

      return { snappedIds, snappedCoords: coords };
    },
    [],
  );

  const calculateSketchRoute = useCallback(async () => {
    const coords = sketchPoints.map((p) => p.coord);
    if (coords.length < 2) return;
    const map = mapRef.current;
    if (!map) {
      setNavError("Map not ready");
      return;
    }

    const myGen = ++calcGenRef.current;
    calcAbortRef.current?.abort();
    calcAbortRef.current = new AbortController();
    const calcSignal = calcAbortRef.current.signal;
    const updateProgress = (progress: RouteCalculationProgress) => {
      if (calcGenRef.current === myGen && !calcSignal.aborted) {
        setRouteProgress(progress);
      }
    };
    let readinessAbort: AbortController | null = null;

    setIsCalculating(true);
    updateProgress({ message: "Preparing sketch route" });
    setNavError(null);
    setNavWarning(null);

    await new Promise<void>((r) => setTimeout(r, 0));
    if (calcGenRef.current !== myGen || calcSignal.aborted) return;

    try {
      const simplified = simplifyPolyline(coords, 30);
      setSimplifiedWaypoints(simplified);

      const bbox = sketchBoundingBox(simplified, 0.005);
      updateProgress({ message: "Fetching walk network" });

      const shadowBbox = bboxAroundEdges(
        [{ from: [bbox.west, bbox.south], to: [bbox.east, bbox.north] }],
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
        graph = await fetchRoutingGraph(bbox.south, bbox.west, bbox.north, bbox.east, calcSignal);
      } catch (error) {
        readinessAbort.abort();
        throw error;
      }

      const sketchRefs: EdgeRef[] = [];
      const sketchEdges: GraphEdge[][] = [];
      const sketchDistances: number[] = [];
      const sketchSeen = new Map<string, number>();
      for (const [fromId, edges] of graph.adj) {
        const fromNode = graph.nodes.get(fromId);
        if (!fromNode) continue;
        for (const edge of edges) {
          const toNode = graph.nodes.get(edge.toId);
          if (!toNode) continue;
          const key = `${Math.min(fromId, edge.toId)},${Math.max(fromId, edge.toId)}`;
          const existing = sketchSeen.get(key);
          if (existing !== undefined) {
            sketchEdges[existing].push(edge);
            continue;
          }
          const loNode = fromId < edge.toId ? fromNode : toNode;
          const hiNode = fromId < edge.toId ? toNode : fromNode;
          sketchSeen.set(key, sketchRefs.length);
          sketchEdges.push([edge]);
          sketchDistances.push(edge.distanceM);
          sketchRefs.push({ from: [loNode.lon, loNode.lat], to: [hiNode.lon, hiNode.lat] });
        }
      }
      await Promise.all([
        broadPreload,
        field.readyEdges?.(sketchRefs, readyOptions).catch(() => {}),
      ]);
      if (calcGenRef.current !== myGen || calcSignal.aborted) return;

      const coverage =
        field.coverageEdges?.(sketchRefs, dateRef.current) ??
        field.coverage(shadowBbox, dateRef.current);
      const needsCanvas = coverage.confidence < LOW_CONFIDENCE;

      if (needsCanvas) {
        // Flatten before reading the bounds: a tilted camera sees further, so the
        // in-view test has to be asked of the camera the canvas will be read from.
        const flattened = flattenForShadowReadback(map);
        const currentBounds = map.getBounds();
        const bboxInView =
          currentBounds.getWest() <= bbox.west &&
          currentBounds.getEast() >= bbox.east &&
          currentBounds.getSouth() <= bbox.south &&
          currentBounds.getNorth() >= bbox.north;

        if (!bboxInView) {
          map.fitBounds(
            [
              [bbox.west, bbox.south],
              [bbox.east, bbox.north],
            ] as [[number, number], [number, number]],
            { padding: 50, duration: 0 },
          );
        }
        if (!bboxInView || flattened) await waitForMapIdle(map);
        if (calcGenRef.current !== myGen || calcSignal.aborted) return;
      }

      const gaps = findSketchGaps(simplified, graph);
      if (gaps.length > 0) {
        const pointNums = gaps.map((i) => i + 1).join(", ");
        setNavWarning(
          `Your sketch crosses an area with no walkable roads near point ${pointNums} — the route may deviate there.`,
        );
      }

      let buildingMask: ReturnType<IShadowLayer["readBuildingShadowMask"]> = null;
      if (needsCanvas) {
        updateProgress({ message: "Reading shadow layer" });
        buildingMask = shadowLayerRef?.current?.readBuildingShadowMask() ?? null;
      }

      // MapLibre transform — correct under rotation/tilt (see calculateRoute).
      const projectToScreen = (lng: number, lat: number): [number, number] => {
        const p = map.project([lng, lat]);
        return [p.x, p.y];
      };

      updateProgress({ message: "Sampling street shadow" });
      // Sketch routing has no per-sidewalk graph — it folds both sides into one
      // `shadowFactor` — so there is no provenance to surface here. The source still
      // has to be the same one `calculateRoute` uses: two definitions of shadow in one
      // app is worse than a sketch card without a label.
      const sketchShadow =
        sketchRefs.length > 0 ? field.sampleEdges(sketchRefs, dateRef.current) : [];
      for (let i = 0; i < sketchRefs.length; i++) {
        let { left, right } = sketchShadow[i];
        if (sketchShadow[i].confidence < LOW_CONFIDENCE && buildingMask) {
          ({ left, right } = sampleBuildingMaskBothSidewalks(
            projectToScreen,
            buildingMask,
            sketchRefs[i].from,
            sketchRefs[i].to,
            edgeSampleCount(sketchDistances[i]),
          ));
        }
        const shadowFactor = Math.max(left, right);
        for (const edge of sketchEdges[i]) edge.shadowFactor = shadowFactor;
      }

      updateProgress({ message: "Finding route choices" });
      const sketchGraph = cloneRoutingGraph(graph);
      const { snappedIds } = snapSketchWaypoints(simplified, sketchGraph, map);

      const variants = [
        { label: "Shortest", shadowStrength: 0.0 },
        { label: "Balanced", shadowStrength: 0.5 },
        { label: "Most shadowed", shadowStrength: 1.0 },
      ] as const;

      const seen = new Set<string>();
      const options: RouteOption[] = [];
      for (const v of variants) {
        const fullPath: number[] = [];
        let totalDist = 0;
        let totalShadowDist = 0;
        let failed = false;

        for (let i = 0; i < snappedIds.length - 1; i++) {
          const leg = dijkstra(sketchGraph, snappedIds[i], snappedIds[i + 1], v.shadowStrength);
          if (!leg) {
            failed = true;
            break;
          }
          if (i === 0) fullPath.push(...leg.nodeIds);
          else fullPath.push(...leg.nodeIds.slice(1));
          totalDist += leg.distanceM;
          totalShadowDist += leg.distanceM * leg.shadowCoverage;
        }

        if (failed || fullPath.length < 2 || totalDist <= 0) continue;
        const key = fullPath.join(",");
        if (seen.has(key)) continue;
        seen.add(key);

        const geojson = connectRouteEndpoints(
          graphToGeoJSON(fullPath, sketchGraph),
          simplified[0],
          simplified[simplified.length - 1],
        );
        const shadowCoverage = totalShadowDist / totalDist;
        options.push({
          label: v.label,
          geojson,
          distanceM: totalDist,
          shadowCoverage,
          longestContinuousShadowM: 0,
          longestContinuousSunM: 0,
          shadowTransitions: 0,
          detourRatio: 1.0,
          turnCount: 0,
        });
      }

      if (options.length === 0) {
        throw new Error("No walkable path found along your sketch. Try drawing closer to streets.");
      }

      if (calcGenRef.current !== myGen || calcSignal.aborted) return;
      setNavRoutes(options);
      setSelectedRouteIndex(0);
      fitMapToRoute(options[0]);
    } catch (e) {
      readinessAbort?.abort();
      if (calcGenRef.current !== myGen || calcSignal.aborted) return;
      setNavError(e instanceof Error ? e.message : "Route calculation failed");
    } finally {
      if (calcGenRef.current === myGen) {
        restorePitchAfterShadowReadback(mapRef.current);
        setIsCalculating(false);
        setRouteProgress(null);
      }
    }
  }, [
    sketchPoints,
    mapRef,
    shadowLayerRef,
    dateRef,
    calcGenRef,
    calcAbortRef,
    shadowFieldRef,
    snapSketchWaypoints,
    fitMapToRoute,
    flattenForShadowReadback,
    restorePitchAfterShadowReadback,
    setNavRoutes,
    setSelectedRouteIndex,
    setNavError,
    setIsCalculating,
    setRouteProgress,
  ]);

  const handleSketchFinish = useCallback(() => {
    advanceRoutePlanRevision();
    setDrawMode(false);
    calculateSketchRoute();
  }, [calculateSketchRoute, advanceRoutePlanRevision]);

  return {
    sketchPoints,
    drawMode,
    navWarning,
    simplifiedWaypoints,
    drawModeRef,
    sketchPointsRef,
    setDrawMode,
    setSketchPoints,
    setNavWarning,
    setSimplifiedWaypoints,
    handleDrawModeToggle,
    handleClearSketch,
    handleSketchPointClick,
    handleSketchPointDrag,
    handleSketchFinish,
    calculateSketchRoute,
  };
}

export type UseSketchResult = ReturnType<typeof useSketch>;

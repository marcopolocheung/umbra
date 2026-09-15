import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { fetchRoutingGraph, fetchStationEntrances } from "../lib/overpass";
import {
  snapToEdge,
  dijkstra,
  snapToGraph,
  paretoRoutes,
  graphToGeoJSON,
  haversineMeters,
  bfsReachable,
  snapToReachableEdge,
  SpatialGrid,
  simplifyPolyline,
  sketchBoundingBox,
  findSketchGaps,
  connectRouteEndpoints,
  clearVirtualNodes,
  snapRouteStopsToReachableEdges,
  parallelSidewalkEdges,
} from "../lib/routing";
import type {
  GraphEdge,
  RoutingGraph,
  RouteLeg,
  LatLng,
  SketchPoint,
  RouteOption,
} from "../lib/routing";
import { recordRoutingRun, computeDerivedKpis } from "../lib/metrics";
import { buildingCentroidAt, snapOutsideBuilding } from "../lib/building-snap";
import type { MapBuildingQuery } from "../lib/building-snap";
import { createRoute, getRoutes, getFolders, updateRoute, deleteRoute } from "../lib/savedRoutes";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { routeToGPX, routeToGeoJSON, downloadBlob } from "../lib/exportRoute";
import {
  fetchTrainGraph,
  findBestTrainRoute,
  matchEntranceToTrainStation,
  TRAIN_SUN_EXPOSURE,
  buildTrainDrawData,
} from "../lib/trainGraph";
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
import type { EdgeRef, ShadowField, ShadowSource } from "../lib/shadowField/ShadowField";
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
import { routeBounds } from "../lib/routeBounds";
import {
  RoutePlanJobCoordinator,
  type RoutePlan,
  type RoutePlanOutcome,
  type RoutePlanRequest,
  type RoutePlanTerminalResult,
} from "../lib/routePlanJob";

/** An opaque map-owned route identity for a C4 terminal result. */
export interface RouteReceiptMapObject {
  id: string;
  kind: "route";
  requestId: string;
  actionId: string;
  planRevision: number;
}

/**
 * How much to trust the pixel sampler when it answers instead of the field.
 *
 * A prior, not a measurement — deliberately below the tile prior (0.8), because the
 * canvas reads whatever the renderer painted at whatever zoom the camera happened to
 * be at. `SOURCE_BASE_CONFIDENCE` carries the same caveat for the geometric sources.
 * A3's agreement harness cannot justify a number here: it compares the field and the
 * sampler over *identical* prisms, so it measures their disagreement, not the
 * sampler's accuracy. That needs the corpus #121 was blocking.
 */
const CANVAS_CONFIDENCE = 0.6;

/** Tilting is the one camera move that can provoke motion sickness. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How long to let the camera settle before reading the canvas anyway. */
const CAMERA_SETTLE_TIMEOUT_MS = 1500;

/** One wall-clock budget shared by broad and exact-cell shadow readiness. */
const ROUTE_READINESS_BUDGET_MS = 2500;

/**
 * Wait for the map to settle before the readback — but not forever. The timeline's
 * play mode advances the date every 50 ms, and each advance repaints the shadow
 * layer, so `idle` never arrives while it runs. `preserveDrawingBuffer` (invariant
 * #3) means the canvas still holds the last drawn frame, so sampling a frame late
 * beats hanging the calculation.
 */
function waitForMapIdle(map: maplibregl.Map): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.off("idle", finish);
      resolve();
    };
    timer = setTimeout(finish, CAMERA_SETTLE_TIMEOUT_MS);
    map.once("idle", finish);
  });
}

function routingEdgeBatch(graph: RoutingGraph): {
  refs: EdgeRef[];
  keys: string[];
  distances: number[];
  directedCount: number;
} {
  const refs: EdgeRef[] = [];
  const keys: string[] = [];
  const distances: number[] = [];
  const seen = new Set<string>();
  let directedCount = 0;
  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue;
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;
    for (const edge of edges) {
      if (edge.toId < 0) continue;
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;
      directedCount++;
      const lo = Math.min(fromId, edge.toId);
      const hi = Math.max(fromId, edge.toId);
      const key = `${lo},${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const loNode = fromId < edge.toId ? fromNode : toNode;
      const hiNode = fromId < edge.toId ? toNode : fromNode;
      keys.push(key);
      distances.push(edge.distanceM);
      refs.push({ from: [loNode.lon, loNode.lat], to: [hiNode.lon, hiNode.lat] });
    }
  }
  return { refs, keys, distances, directedCount };
}

function routePlanFingerprint(
  from: [number, number] | null,
  to: [number, number] | null,
  via: [number, number][],
): string {
  return JSON.stringify({ from, to, via });
}

interface UseNavigationArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  shadowLayerRef?: React.MutableRefObject<IShadowLayer | null>;
  dateRef: React.MutableRefObject<Date>;
  setDate: React.Dispatch<React.SetStateAction<Date>>;
}

export function useNavigation({ mapRef, shadowLayerRef, dateRef, setDate }: UseNavigationArgs) {
  // Navigation state
  const [navMode, setNavMode] = useState(false);
  const [waypointA, setWaypointA] = useState<[number, number] | null>(null);
  const [waypointB, setWaypointB] = useState<[number, number] | null>(null);
  const [navRoutes, setNavRoutes] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isCalculating, setIsCalculating] = useState(false);
  const [routeProgress, setRouteProgress] = useState<RouteCalculationProgress | null>(null);
  const [routePreview, setRoutePreview] = useState<GeoJSON.Feature<GeoJSON.LineString> | null>(
    null,
  );
  const [navError, setNavError] = useState<string | null>(null);
  const [routeSolarIntensity, setRouteSolarIntensity] = useState<number | null>(null);
  const [waypointALabel, setWaypointALabel] = useState<string | null>(null);
  const [waypointBLabel, setWaypointBLabel] = useState<string | null>(null);
  const [pendingSlot, setPendingSlot] = useState<"A" | "B" | null>(null);
  const pendingSlotRef = useRef<"A" | "B" | null>(null);
  pendingSlotRef.current = pendingSlot;

  const [saveModalRouteIndex, setSaveModalRouteIndex] = useState<number | null>(null);
  const [additionalWaypoints, setAdditionalWaypoints] = useState<[number, number][]>([]);
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>(() => getRoutes());
  const [savedFolders, setSavedFolders] = useState<SavedFolder[]>(() => getFolders());

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  // Sketch drawing state
  const [sketchPoints, setSketchPoints] = useState<SketchPoint[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [navWarning, setNavWarning] = useState<string | null>(null);
  const [simplifiedWaypoints, setSimplifiedWaypoints] = useState<LatLng[] | null>(null);

  // Route mode and shadow preference
  const [routeMode, setRouteMode] = useState<"walk" | "transit">("walk");
  const [shadowPreference, setShadowPreference] = useState(0.5);

  // Active-travel mode for walk routing (E1). Transit access legs stay
  // pedestrian — mixed-mode journeys are E6.
  const [travelMode, setTravelMode] = useState<TravelModeId>("walk");
  const travelModeRef = useRef(travelMode);
  travelModeRef.current = travelMode;

  // Refs for stale-closure avoidance
  const waypointARef = useRef(waypointA);
  const waypointBRef = useRef(waypointB);
  const calcGenRef = useRef(0);
  const calcAbortRef = useRef<AbortController | null>(null);
  const agentRouteJobsRef = useRef(new RoutePlanJobCoordinator());
  const routePlanInputVersionRef = useRef(0);
  const routePlanRevisionRef = useRef(0);
  const routePlanActionSeqRef = useRef(0);
  const routeReceiptObjectRef = useRef<RouteReceiptMapObject | null>(null);
  const pendingAgentPlanFingerprintRef = useRef<string | null>(null);
  const waypointALabelRef = useRef(waypointALabel);
  const waypointBLabelRef = useRef(waypointBLabel);
  const drawModeRef = useRef(drawMode);
  const sketchPointsRef = useRef(sketchPoints);
  const dragSlotRef = useRef<"A" | "B" | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);
  const ghostElRef = useRef<HTMLDivElement | null>(null);
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

  waypointARef.current = waypointA;
  waypointBRef.current = waypointB;
  waypointALabelRef.current = waypointALabel;
  waypointBLabelRef.current = waypointBLabel;
  drawModeRef.current = drawMode;
  sketchPointsRef.current = sketchPoints;
  const routePlanTime = dateRef.current.getTime();
  const advanceRoutePlanRevision = useCallback(() => {
    // A different plan may draw different geometry. Its predecessor must no
    // longer be focusable or presentable as the current route.
    routeReceiptObjectRef.current = null;
    const revision = ++routePlanRevisionRef.current;
    agentRouteJobsRef.current.advancePlanRevision(revision);
    return revision;
  }, []);

  // Any real route-defining edit, including the selected shadow time,
  // invalidates a job based on the older plan.
  useEffect(() => {
    const fingerprint = routePlanFingerprint(waypointA, waypointB, additionalWaypoints);
    if (pendingAgentPlanFingerprintRef.current === fingerprint) {
      pendingAgentPlanFingerprintRef.current = null;
      return;
    }
    advanceRoutePlanRevision();
  }, [waypointA, waypointB, additionalWaypoints, routePlanTime, advanceRoutePlanRevision]);

  // Escape to cancel pending slot
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingSlot(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const handleMapClick = useCallback(
    (coord: { lng: number; lat: number }, originalEvent?: MouseEvent) => {
      if (originalEvent?.altKey && waypointARef.current && waypointBRef.current) {
        const lngLat: [number, number] = [coord.lng, coord.lat];
        cancelInFlightCalculation();
        setAdditionalWaypoints((prev) => [...prev, lngLat]);
        setNavRoutes([]);
        setSelectedRouteIndex(0);
        return;
      }
      const slot = pendingSlotRef.current;
      if (!slot) return;
      setNavError(null);
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      cancelInFlightCalculation();
      if (slot === "A") {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointALabel(lbl);
        });
        setPendingSlot(waypointBRef.current ? null : "B");
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointBLabel(lbl);
        });
        setPendingSlot(null);
      }
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleClear = useCallback(() => {
    cancelInFlightCalculation();
    setWaypointA(null);
    setWaypointB(null);
    setWaypointALabel(null);
    setWaypointBLabel(null);
    setAdditionalWaypoints([]);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    setNavError(null);
    setRoutePreview(null);
    setRouteSolarIntensity(null);
    setPendingSlot(null);
    setDrawMode(false);
    setSketchPoints([]);
    setNavWarning(null);
    setSimplifiedWaypoints(null);
    setRouteMode("walk");
    setShadowPreference(0.5);
    setTravelMode("walk");
  }, [cancelInFlightCalculation]);

  const handleOpenSaveModal = useCallback(
    (routeIndex: number) => {
      if (navRoutes[routeIndex]?.partial) return;
      setSaveModalRouteIndex(routeIndex);
    },
    [navRoutes],
  );

  const handleConfirmSave = useCallback(
    (name: string, folderId: string | null) => {
      if (saveModalRouteIndex === null) return;
      const route = navRoutes[saveModalRouteIndex];
      if (!route || !waypointA || !waypointB) return;
      const d = dateRef.current;
      const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      createRoute({
        name,
        folderId,
        routeOption: route,
        waypointA,
        waypointB,
        waypointALabel: waypointALabel ?? null,
        waypointBLabel: waypointBLabel ?? null,
        additionalWaypoints: additionalWaypoints,
        timeOfDayMinutes: Math.floor(d.getHours() * 60 + d.getMinutes()),
        dateIso,
      });
      setSavedRoutes(getRoutes());
      setSavedFolders(getFolders());
      setSaveModalRouteIndex(null);
    },
    [
      saveModalRouteIndex,
      navRoutes,
      waypointA,
      waypointB,
      waypointALabel,
      waypointBLabel,
      additionalWaypoints,
      dateRef,
    ],
  );

  const handleLoadRoute = useCallback(
    (saved: SavedRoute) => {
      cancelInFlightCalculation();
      setWaypointA(saved.waypointA);
      setWaypointB(saved.waypointB);
      setWaypointALabel(saved.waypointALabel);
      setWaypointBLabel(saved.waypointBLabel);
      setAdditionalWaypoints(saved.additionalWaypoints ?? []);
      setNavRoutes([saved.routeOption]);
      setSelectedRouteIndex(0);
      const d = new Date(saved.dateIso + "T00:00:00");
      d.setHours(Math.floor(saved.timeOfDayMinutes / 60), saved.timeOfDayMinutes % 60, 0, 0);
      setDate(d);
    },
    [cancelInFlightCalculation, setDate],
  );

  const handleExportRoute = useCallback(
    (routeIndex: number, format: "gpx" | "geojson") => {
      const route = navRoutes[routeIndex];
      if (!route) return;
      if (route.partial) {
        setNavWarning(partialRouteNotice(route.partial));
        return;
      }
      const name = route.label;
      if (format === "gpx") {
        downloadBlob(routeToGPX(route, name), `${name}.gpx`, "application/gpx+xml");
      } else {
        downloadBlob(routeToGeoJSON(route), `${name}.geojson`, "application/geo+json");
      }
    },
    [navRoutes],
  );

  const handleRemoveAdditionalWaypoint = useCallback(
    (index: number) => {
      cancelInFlightCalculation();
      setAdditionalWaypoints((prev) => prev.filter((_, i) => i !== index));
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleSetAdditionalWaypoints = useCallback(
    (waypoints: [number, number][]) => {
      cancelInFlightCalculation();
      setAdditionalWaypoints(waypoints);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleAddAdditionalWaypoint = useCallback(
    (coord: [number, number]) => {
      cancelInFlightCalculation();
      setAdditionalWaypoints((prev) => [...prev, coord]);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleDeleteSavedRoute = useCallback((id: string) => {
    deleteRoute(id);
    setSavedRoutes(getRoutes());
  }, []);

  const handleRenameSavedRoute = useCallback((id: string, name: string) => {
    updateRoute(id, { name });
    setSavedRoutes(getRoutes());
  }, []);

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) {
      setNavError("Geolocation is not supported by your browser.");
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setUserLocation(coords);
        setIsLocating(false);
        mapRef.current?.jumpTo({ center: coords, zoom: 15 });
      },
      () => {
        setNavError("Unable to get your location. Check browser permissions.");
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [mapRef]);

  const handleToggleNavMode = useCallback(() => {
    if (!navMode) {
      setNavMode(true);
      return;
    }
    cancelInFlightCalculation();
    setWaypointA(null);
    setWaypointB(null);
    setWaypointALabel(null);
    setWaypointBLabel(null);
    setAdditionalWaypoints([]);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    setNavError(null);
    setRouteSolarIntensity(null);
    setPendingSlot(null);
    setDrawMode(false);
    setSketchPoints([]);
    setNavWarning(null);
    setSimplifiedWaypoints(null);
    setRouteMode("walk");
    setShadowPreference(0.5);
    setNavMode(false);
  }, [cancelInFlightCalculation, navMode]);

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

  const handleRouteModeChange = useCallback(
    (mode: "walk" | "transit") => {
      cancelInFlightCalculation();
      setRouteMode(mode);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleTravelModeChange = useCallback(
    (mode: TravelModeId) => {
      cancelInFlightCalculation();
      setTravelMode(mode);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation],
  );

  const handleShadowPreferenceChange = useCallback((v: number) => {
    setShadowPreference(v);
    setNavRoutes((routes) => {
      if (routes.length === 0) return routes;
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < routes.length; i++) {
        const diff = Math.abs(routes[i].shadowCoverage - v);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      setSelectedRouteIndex(bestIdx);
      return routes;
    });
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

  const cloneRoutingGraph = useCallback((graph: RoutingGraph): RoutingGraph => {
    const nodes = new Map(graph.nodes);
    const adj = new Map<number, GraphEdge[]>();
    for (const [id, edges] of graph.adj) {
      adj.set(
        id,
        edges.map((e) => ({ toId: e.toId, distanceM: e.distanceM, shadowFactor: e.shadowFactor })),
      );
    }
    return { nodes, adj };
  }, []);

  const removeVirtualNode = useCallback((graph: RoutingGraph, vid: number) => {
    const vidEdges = graph.adj.get(vid);
    if (vidEdges) {
      for (const e of vidEdges) {
        const ownerEdges = graph.adj.get(e.toId);
        if (ownerEdges) {
          for (let i = ownerEdges.length - 1; i >= 0; i--) {
            if (ownerEdges[i].toId === vid) ownerEdges.splice(i, 1);
          }
        }
      }
    }
    graph.nodes.delete(vid);
    graph.adj.delete(vid);
  }, []);

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
    [removeVirtualNode],
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
    cloneRoutingGraph,
    snapSketchWaypoints,
    fitMapToRoute,
    flattenForShadowReadback,
    restorePitchAfterShadowReadback,
  ]);

  const handleSketchFinish = useCallback(() => {
    advanceRoutePlanRevision();
    setDrawMode(false);
    calculateSketchRoute();
  }, [calculateSketchRoute, advanceRoutePlanRevision]);

  const handleSetWaypointA = useCallback(
    (coord: [number, number], label: string) => {
      cancelInFlightCalculation();
      setWaypointA(coord);
      setWaypointALabel(label);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
      const map = mapRef.current;
      if (map) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [cancelInFlightCalculation, mapRef],
  );

  const handleSetWaypointB = useCallback(
    (coord: [number, number], label: string) => {
      cancelInFlightCalculation();
      setWaypointB(coord);
      setWaypointBLabel(label);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
      const map = mapRef.current;
      if (map) map.jumpTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
    },
    [cancelInFlightCalculation, mapRef],
  );

  const handleUseLocationAsA = useCallback(
    (coord: [number, number]) => {
      handleSetWaypointA(coord, "Your location");
    },
    [handleSetWaypointA],
  );

  const handleUseLocationAsB = useCallback(
    (coord: [number, number]) => {
      handleSetWaypointB(coord, "Your location");
    },
    [handleSetWaypointB],
  );

  const handleSwapWaypoints = useCallback(() => {
    const a = waypointARef.current;
    const b = waypointBRef.current;
    const aLabel = waypointALabelRef.current;
    const bLabel = waypointBLabelRef.current;
    cancelInFlightCalculation();
    setWaypointA(b);
    setWaypointB(a);
    setWaypointALabel(bLabel);
    setWaypointBLabel(aLabel);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, [cancelInFlightCalculation]);

  const handleClearWaypointA = useCallback(() => {
    cancelInFlightCalculation();
    setWaypointA(null);
    setWaypointALabel(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, [cancelInFlightCalculation]);

  const handleClearWaypointB = useCallback(() => {
    cancelInFlightCalculation();
    setWaypointB(null);
    setWaypointBLabel(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, [cancelInFlightCalculation]);

  const handleMarkerDragEnd = useCallback(
    (slot: "A" | "B", coord: { lng: number; lat: number }) => {
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      cancelInFlightCalculation();
      setNavRoutes([]);
      setSelectedRouteIndex(0);
      if (slot === "A") {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointALabel(lbl);
        });
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) setWaypointBLabel(lbl);
        });
      }
    },
    [cancelInFlightCalculation],
  );

  const handlePinDragStart = useCallback(
    (slot: "A" | "B") => {
      dragSlotRef.current = slot;
      dragActiveRef.current = false;
      dragStartPos.current = null;

      const color = slot === "A" ? "#22c55e" : "#ef4444";

      function onMove(e: PointerEvent) {
        const { clientX: x, clientY: y } = e;

        if (!dragStartPos.current) {
          dragStartPos.current = { x, y };
          return;
        }

        const dx = x - dragStartPos.current.x;
        const dy = y - dragStartPos.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!dragActiveRef.current && dist > 6) {
          dragActiveRef.current = true;
          document.body.style.userSelect = "none";

          const ghost = document.createElement("div");
          ghost.style.cssText = [
            "position:fixed",
            "pointer-events:none",
            "z-index:9999",
            "transform:translate(-50%, -100%)",
            "transition:none",
          ].join(";");
          ghost.innerHTML = `<svg width="24" height="28" viewBox="0 0 12 14" fill="${color}" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))"><path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`;
          ghost.style.left = x + "px";
          ghost.style.top = y + "px";
          document.body.appendChild(ghost);
          ghostElRef.current = ghost;
        }

        if (dragActiveRef.current && ghostElRef.current) {
          ghostElRef.current.style.left = x + "px";
          ghostElRef.current.style.top = y + "px";
        }
      }

      function onUp(e: PointerEvent) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";

        if (ghostElRef.current) {
          ghostElRef.current.remove();
          ghostElRef.current = null;
        }

        if (!dragActiveRef.current) return;
        dragActiveRef.current = false;

        const currentSlot = dragSlotRef.current;
        if (!currentSlot) return;

        const map = mapRef.current;
        if (!map) return;

        const mapEl = map.getContainer();
        const rect = mapEl.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const relY = e.clientY - rect.top;

        if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) return;

        const lngLat = map.unproject([relX, relY]);
        handleMarkerDragEnd(currentSlot, { lng: lngLat.lng, lat: lngLat.lat });
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [handleMarkerDragEnd, mapRef],
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
        setAdditionalWaypoints(plan.via);
        setWaypointA(plan.from);
        setWaypointB(plan.to);
        setWaypointALabel(plan.fromLabel);
        setWaypointBLabel(plan.toLabel);
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
            const [trainGraph, entrances] = await Promise.all([
              fetchTrainGraph(trainSouth, trainWest, trainNorth, trainEast, calcSignal),
              fetchStationEntrances(trainSouth, trainWest, trainNorth, trainEast, calcSignal),
            ]);
            if (import.meta.env.DEV)
              console.log(
                "[transit] trainGraph:",
                trainGraph
                  ? `${trainGraph.stations.size} stations, ${trainGraph.lineColors.size} lines`
                  : "null",
              );
            if (import.meta.env.DEV) console.log("[transit] entrances:", entrances.length);

            if (trainGraph && trainGraph.stations.size >= 2) {
              const stationEntrances = new Map<
                number,
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
              for (const [id, station] of trainGraph.stations) {
                if (!stationEntrances.has(id)) {
                  stationEntrances.set(id, [
                    { lat: station.lat, lon: station.lon, kind: "station" },
                  ]);
                }
              }

              const bestTrain = findBestTrainRoute(a, b, trainGraph);
              if (import.meta.env.DEV)
                console.log(
                  "[transit] bestTrain:",
                  bestTrain
                    ? `entry=${bestTrain.entryStation.name}, exit=${bestTrain.exitStation.name}, ${bestTrain.path.stationIds.length} stations, ${bestTrain.path.segments.length} segments`
                    : "null",
                );

              if (bestTrain) {
                const WALK_SHADOW_STRENGTH = 0.5;

                const boardCandidates = stationEntrances.get(bestTrain.entryStation.id) ?? [
                  { ...bestTrain.entryStation, kind: "station" },
                ];
                const boardEntrance = pickClosestEntrance(a, boardCandidates, haversineMeters);

                const alightCandidates = stationEntrances.get(bestTrain.exitStation.id) ?? [
                  { ...bestTrain.exitStation, kind: "station" },
                ];
                const alightEntrance = pickClosestEntrance(b, alightCandidates, haversineMeters);

                const boardNodeId = snapToGraph(
                  [boardEntrance.lon, boardEntrance.lat],
                  routingGraph,
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

                const alightNodeId = snapToGraph(
                  [alightEntrance.lon, alightEntrance.lat],
                  routingGraph,
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

                  const TRAIN_SPEED_MS = (30 * 1000) / 3600;
                  const transitTimeSec = bestTrain.path.totalDistM / TRAIN_SPEED_MS;

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
        setSketchPoints([]);
        setNavWarning(partialWarning ? partialRouteNotice(partialWarning) : null);
        setSimplifiedWaypoints(null);
        fitMapToRoute(options[0]);
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
      fitMapToRoute,
      flattenForShadowReadback,
      restorePitchAfterShadowReadback,
    ],
  );

  const createRoutePlanRequest = useCallback(
    (plan: RoutePlan): RoutePlanRequest => {
      const planRevision = advanceRoutePlanRevision();
      pendingAgentPlanFingerprintRef.current = routePlanFingerprint(plan.from, plan.to, plan.via);
      setAdditionalWaypoints(plan.via);
      setWaypointA(plan.from);
      setWaypointB(plan.to);
      setWaypointALabel(plan.fromLabel);
      setWaypointBLabel(plan.toLabel);
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
    [advanceRoutePlanRevision],
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

  const handleCalculateRoute = useCallback(() => {
    // A direct user calculation is a new map application, even when the
    // coordinates happen to be identical to a previous agent action.
    advanceRoutePlanRevision();
    const useSketch = drawModeRef.current && sketchPointsRef.current.length >= 2;
    if (useSketch) {
      setDrawMode(false);
      calculateSketchRoute();
    } else {
      calculateRoute();
    }
  }, [calculateRoute, calculateSketchRoute, advanceRoutePlanRevision]);

  // Derived values
  const selectedRoute = navRoutes[selectedRouteIndex];
  const selectedNavRoute =
    routePreview ??
    (selectedRoute?.legs
      ? ({
          type: "FeatureCollection",
          features: selectedRoute.legs
            .filter((l: RouteLeg) => l.type === "walk")
            .map((l: RouteLeg) => l.geojson),
        } as GeoJSON.FeatureCollection)
      : (navRoutes[selectedRouteIndex]?.geojson ?? null));
  const navTrainDrawData = selectedRoute?.trainDrawData ?? null;
  const navMrtEntrances = selectedRoute?.mrtEntrances ?? null;

  const filteredRoutes = useMemo(() => {
    if (routeMode === "walk") {
      return navRoutes.filter((r) => !r.legs?.find((l: RouteLeg) => l.type === "transit"));
    }
    return navRoutes.filter((r) => !!r.legs?.find((l: RouteLeg) => l.type === "transit"));
  }, [navRoutes, routeMode]);

  const canTransit = !!(waypointA && waypointB && haversineMeters(waypointA, waypointB) > 500);

  return {
    // State
    navMode,
    waypointA,
    waypointB,
    navRoutes,
    selectedRouteIndex,
    isCalculating,
    routeProgress,
    navError,
    routeSolarIntensity,
    waypointALabel,
    waypointBLabel,
    pendingSlot,
    saveModalRouteIndex,
    additionalWaypoints,
    savedRoutes,
    savedFolders,
    userLocation,
    isLocating,
    sketchPoints,
    drawMode,
    navWarning,
    simplifiedWaypoints,
    routeMode,
    shadowPreference,
    travelMode,

    // Setters
    setPendingSlot,
    setSelectedRouteIndex,
    setSaveModalRouteIndex,

    // Handlers
    handleMapClick,
    handleClear,
    handleOpenSaveModal,
    handleConfirmSave,
    handleLoadRoute,
    handleExportRoute,
    handleRemoveAdditionalWaypoint,
    handleSetAdditionalWaypoints,
    handleAddAdditionalWaypoint,
    handleDeleteSavedRoute,
    handleRenameSavedRoute,
    handleLocateMe,
    handleToggleNavMode,
    handleDrawModeToggle,
    handleClearSketch,
    handleRouteModeChange,
    handleTravelModeChange,
    handleShadowPreferenceChange,
    handleSketchPointClick,
    handleSketchPointDrag,
    handleSketchFinish,
    handleSetWaypointA,
    handleSetWaypointB,
    handleUseLocationAsA,
    handleUseLocationAsB,
    handleSwapWaypoints,
    handleClearWaypointA,
    handleClearWaypointB,
    handleMarkerDragEnd,
    handlePinDragStart,
    handleCalculateRoute,
    createRoutePlanRequest,
    submitRoutePlan,
    cancelRoutePlan,
    getCurrentPlanRevision,
    getRouteReceiptMapObjects,

    // Derived
    selectedNavRoute,
    navTrainDrawData,
    navMrtEntrances,
    filteredRoutes,
    canTransit,
    // The geometry shadow field, shared so a day sweep reuses this cache
    // rather than building a second one and re-fetching the same prisms.
    shadowField: shadowFieldRef.current,
  };
}

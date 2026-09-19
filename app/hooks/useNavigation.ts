import { useState, useRef, useCallback } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { haversineMeters } from "../lib/routing";
import { routeToGPX, routeToGeoJSON, downloadBlob } from "../lib/exportRoute";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import { partialRouteNotice } from "../lib/partialRoute";
import type { TravelModeId } from "../lib/travelMode";
import { useSketch } from "./useSketch";
import { useTrip } from "./useTrip";
import { useRouting } from "./useRouting";
import type { NavSeam, RouteReceiptMapObject } from "./useRouting";

/** An opaque map-owned route identity for a C4 terminal result. */
export type { RouteReceiptMapObject };

interface UseNavigationArgs {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  shadowLayerRef?: React.MutableRefObject<IShadowLayer | null>;
  dateRef: React.MutableRefObject<Date>;
  setDate: React.Dispatch<React.SetStateAction<Date>>;
}

export function useNavigation({ mapRef, shadowLayerRef, dateRef, setDate }: UseNavigationArgs) {
  // Navigation state
  const [navMode, setNavMode] = useState(false);

  // Route mode and shadow preference
  const [routeMode, setRouteMode] = useState<"walk" | "transit">("walk");
  const [shadowPreference, setShadowPreference] = useState(0.5);

  // Rain objective: walk/bike routes are priced on rain shelter instead of sun.
  // The intensity is an ordinal 0–10 setting (no mm/h claim anywhere); it scales
  // reported exposure only — route choice does not depend on it.
  const [rainMode, setRainMode] = useState(false);
  const [rainIntensity, setRainIntensity] = useState(5);

  // Active-travel mode for walk routing (E1). Transit access legs stay
  // pedestrian — mixed-mode journeys are E6.
  const [travelMode, setTravelMode] = useState<TravelModeId>("walk");
  const travelModeRef = useRef(travelMode);
  travelModeRef.current = travelMode;

  // Event-time seam for the sub-hooks (see NavSeam in useRouting). Assigned
  // every render once routing and sketch have run, before any event can fire.
  const seamRef = useRef<NavSeam>(null!);

  // Trip state (waypoints, via stops, location, saved routes). Constructed
  // first: routing reads trip state, while trip handlers read routing back
  // lazily through the seam.
  const {
    trip,
    dwellSignature,
    dwellMinutes,
    replaceAllStops,
    clearTrip,
    relabelWaypoint,
    waypointA,
    waypointB,
    waypointALabel,
    waypointBLabel,
    pendingSlot,
    saveModalRouteIndex,
    additionalWaypoints,
    savedRoutes,
    savedFolders,
    userLocation,
    isLocating,
    waypointARef,
    waypointBRef,
    pendingSlotRef,
    setPendingSlot,
    setSaveModalRouteIndex,
    handleOpenSaveModal,
    handleConfirmSave,
    handleLoadRoute,
    handleRemoveAdditionalWaypoint,
    handleSetAdditionalWaypoints,
    handleAddAdditionalWaypoint,
    handleDeleteSavedRoute,
    handleRenameSavedRoute,
    handleLocateMe,
    handleSetWaypointA,
    handleSetWaypointB,
    handleUseLocationAsA,
    handleUseLocationAsB,
    handleSwapWaypoints,
    handleClearWaypointA,
    handleClearWaypointB,
    handleMarkerDragEnd,
    handlePinDragStart,
  } = useTrip({
    mapRef,
    dateRef,
    setDate,
    travelMode,
    seam: seamRef,
  });

  // The route-calculation pipeline. Constructed second: it reads trip state
  // above and feeds the sketch pipeline below.
  const {
    navRoutes,
    selectedRouteIndex,
    isCalculating,
    routeProgress,
    navError,
    routeSolarIntensity,
    calcGenRef,
    calcAbortRef,
    shadowFieldRef,
    bindStaticSnapshot,
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
  } = useRouting({
    mapRef,
    shadowLayerRef,
    dateRef,
    travelModeRef,
    routeMode,
    rainMode,
    waypointA,
    waypointB,
    additionalWaypoints,
    waypointARef,
    waypointBRef,
    dwellSignature,
    replaceAllStops,
    seam: seamRef,
  });

  // Sketch / draw-route mode (state + pipeline), fed by the routing outputs
  // above. Both pipelines share the calc-generation refs, the shadow field,
  // the camera pair and the route-result setters, so a sketch calculation
  // still supersedes an in-flight normal one and vice versa.
  const {
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
  } = useSketch({
    mapRef,
    shadowLayerRef,
    dateRef,
    calcGenRef,
    calcAbortRef,
    shadowFieldRef,
    bindStaticSnapshot,
    fitMapToRoute,
    flattenForShadowReadback,
    restorePitchAfterShadowReadback,
    advanceRoutePlanRevision,
    setNavRoutes,
    setSelectedRouteIndex,
    setNavError,
    setIsCalculating,
    setRouteProgress,
  });

  // Publish this render's routing and sketch outputs to the event-time seam.
  // Runs during render, so it is always assigned before any event can fire.
  seamRef.current = {
    cancelInFlightCalculation,
    setNavRoutes,
    setSelectedRouteIndex,
    setNavError,
    setSketchPoints,
    setNavWarning,
    setSimplifiedWaypoints,
    visibleRoutes: filteredRoutes,
  };

  const handleMapClick = useCallback(
    (coord: { lng: number; lat: number }, originalEvent?: MouseEvent) => {
      if (originalEvent?.altKey && waypointARef.current && waypointBRef.current) {
        const lngLat: [number, number] = [coord.lng, coord.lat];
        handleAddAdditionalWaypoint(lngLat);
        return;
      }
      const slot = pendingSlotRef.current;
      if (!slot) return;
      setNavError(null);
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      if (slot === "A") {
        // A map tap places the pin silently: no camera jump (the user is
        // already looking at the point) and the relabel must not clear routes.
        handleSetWaypointA(lngLat, coordLabel, { jump: false });
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) relabelWaypoint("A", lbl);
        });
        setPendingSlot(waypointBRef.current ? null : "B");
      } else {
        handleSetWaypointB(lngLat, coordLabel, { jump: false });
        geocodeReverse(coord.lat, coord.lng).then((lbl) => {
          if (lbl) relabelWaypoint("B", lbl);
        });
        setPendingSlot(null);
      }
    },
    [
      waypointARef,
      waypointBRef,
      pendingSlotRef,
      handleSetWaypointA,
      handleSetWaypointB,
      relabelWaypoint,
      handleAddAdditionalWaypoint,
      setPendingSlot,
      setNavError,
    ],
  );

  const handleClear = useCallback(() => {
    cancelInFlightCalculation();
    clearTrip();
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
    setRainMode(false);
    setRainIntensity(5);
    setTravelMode("walk");
  }, [
    cancelInFlightCalculation,
    clearTrip,
    setPendingSlot,
    setDrawMode,
    setSketchPoints,
    setNavWarning,
    setSimplifiedWaypoints,
    setNavError,
    setNavRoutes,
    setSelectedRouteIndex,
    setRoutePreview,
    setRouteSolarIntensity,
  ]);

  const handleExportRoute = useCallback(
    (routeIndex: number, format: "gpx" | "geojson") => {
      // The index comes from a card in the panel, which renders the filtered list.
      const route = filteredRoutes[routeIndex];
      if (!route) return;
      if (route.partial) {
        setNavWarning(partialRouteNotice(route.partial));
        return;
      }
      const name = route.label;
      // Only name the stops when the exported route actually came from them.
      // A sketch route is a freehand line the trip had no part in, and the
      // trip survives entering draw mode — attaching its stops would ship a
      // file claiming a track visits places it never goes near.
      const routeTrip = sketchPoints.length > 0 ? undefined : trip;
      if (format === "gpx") {
        downloadBlob(routeToGPX(route, name, routeTrip), `${name}.gpx`, "application/gpx+xml");
      } else {
        downloadBlob(routeToGeoJSON(route, routeTrip), `${name}.geojson`, "application/geo+json");
      }
    },
    [filteredRoutes, setNavWarning, trip, sketchPoints],
  );

  const handleToggleNavMode = useCallback(() => {
    if (!navMode) {
      setNavMode(true);
      return;
    }
    cancelInFlightCalculation();
    clearTrip();
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
    setRainMode(false);
    setRainIntensity(5);
    setNavMode(false);
  }, [
    cancelInFlightCalculation,
    navMode,
    clearTrip,
    setPendingSlot,
    setDrawMode,
    setSketchPoints,
    setNavWarning,
    setSimplifiedWaypoints,
    setNavError,
    setNavRoutes,
    setSelectedRouteIndex,
    setRouteSolarIntensity,
  ]);

  const handleRouteModeChange = useCallback(
    (mode: "walk" | "transit") => {
      cancelInFlightCalculation();
      setRouteMode(mode);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation, setNavRoutes, setSelectedRouteIndex],
  );

  const handleTravelModeChange = useCallback(
    (mode: TravelModeId) => {
      cancelInFlightCalculation();
      setTravelMode(mode);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation, setNavRoutes, setSelectedRouteIndex],
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
  }, [setNavRoutes, setSelectedRouteIndex]);

  // Objective switch is a route-defining change: in-flight work is obsolete and
  // the existing cards are answers to a different question.
  const handleRainModeChange = useCallback(
    (mode: boolean) => {
      cancelInFlightCalculation();
      setRainMode(mode);
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    [cancelInFlightCalculation, setNavRoutes, setSelectedRouteIndex],
  );

  // Intensity rescales reported wet time without changing which route won.
  const handleRainIntensityChange = useCallback((v: number) => {
    setRainIntensity(Math.max(0, Math.min(10, Math.round(v))));
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
  }, [
    calculateRoute,
    calculateSketchRoute,
    advanceRoutePlanRevision,
    drawModeRef,
    sketchPointsRef,
    setDrawMode,
  ]);

  const canTransit = !!(waypointA && waypointB && haversineMeters(waypointA, waypointB) > 500);

  return {
    // State
    navMode,
    trip,
    waypointA,
    waypointB,
    dwellMinutes,
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
    rainMode,
    rainIntensity,
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
    handleRainModeChange,
    handleRainIntensityChange,
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

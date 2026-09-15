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
    setWaypointA,
    setWaypointB,
    setWaypointALabel,
    setWaypointBLabel,
    setPendingSlot,
    setSaveModalRouteIndex,
    setAdditionalWaypoints,
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
    waypointA,
    waypointB,
    additionalWaypoints,
    waypointARef,
    waypointBRef,
    setWaypointA,
    setWaypointB,
    setWaypointALabel,
    setWaypointBLabel,
    setAdditionalWaypoints,
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
    navRoutes,
  };

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
    [
      cancelInFlightCalculation,
      waypointARef,
      waypointBRef,
      pendingSlotRef,
      setWaypointA,
      setWaypointALabel,
      setWaypointB,
      setWaypointBLabel,
      setPendingSlot,
      setAdditionalWaypoints,
      setNavError,
      setNavRoutes,
      setSelectedRouteIndex,
    ],
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
  }, [
    cancelInFlightCalculation,
    setWaypointA,
    setWaypointB,
    setWaypointALabel,
    setWaypointBLabel,
    setAdditionalWaypoints,
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
    [navRoutes, setNavWarning],
  );

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
  }, [
    cancelInFlightCalculation,
    navMode,
    setWaypointA,
    setWaypointB,
    setWaypointALabel,
    setWaypointBLabel,
    setAdditionalWaypoints,
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

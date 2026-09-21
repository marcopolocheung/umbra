import { useState, useRef, useCallback, useMemo } from "react";
import type maplibregl from "maplibre-gl";
import { geocodeReverse } from "../lib/nominatim";
import { haversineMeters } from "../lib/routing";
import { MIN_TRANSIT_DISTANCE_M } from "../lib/trainGraph";
import { routeToGPX, routeToGeoJSON, downloadBlob } from "../lib/exportRoute";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import { partialRouteNotice } from "../lib/partialRoute";
import type { TravelModeId } from "../lib/travelMode";
import { resolveExposureContext, type ExposureSettings, type ManualWind, type WindSource } from "../lib/exposure";
import type { SavedRoute } from "../lib/savedRoutes";
import { fetchWeatherForecast, nearestForecastWind } from "../services/weather";
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
  date?: Date;
}

export function useNavigation({ mapRef, shadowLayerRef, dateRef, setDate, date }: UseNavigationArgs) {
  // Navigation state
  const [navMode, setNavMode] = useState(false);

  // Route mode and shadow preference
  const [routeMode, setRouteMode] = useState<"walk" | "transit">("walk");
  const [shadowPreference, setShadowPreference] = useState(0.5);

  // Rain objective: walk/bike routes are priced on rain shelter instead of sun.
  // Keep the legacy intensity value in the facade for old consumers, but it is
  // no longer rendered or used in routing; exposure is reported unscaled.
  const [rainMode, setRainMode] = useState(false);
  const [windSource, setWindSource] = useState<WindSource>("forecast");
  const [manualWind, setManualWind] = useState<ManualWind>({ directionDeg: 0, speedMps: 0 });
  const [rainIntensity, setRainIntensity] = useState(5);
  const manualWindInitRef = useRef(0);
  const exposureSettings = useMemo<ExposureSettings>(() => ({
    objective: rainMode ? "rain" : "sun",
    windSource,
    manualWind,
  }), [rainMode, windSource, manualWind]);

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
    handleLoadRoute: loadSavedRoute,
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
    routeWind,
    routeExposureContext,
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
    setRouteExposureContext,
    setRouteWind,
    selectedNavRoute,
    navTrainDrawData,
    navMrtEntrances,
    filteredRoutes,
  } = useRouting({
    mapRef,
    shadowLayerRef,
    dateRef,
    date,
    travelModeRef,
    routeMode,
    rainMode,
    exposureSettings,
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
    exposureSettings,
    setRouteExposureContext,
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
    setRouteExposureContext(null);
    setRouteWind(null);
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
    setRouteExposureContext,
    setRouteWind,
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
    setRouteExposureContext(null);
    setRouteWind(null);
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
    setRouteExposureContext,
    setRouteWind,
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
        const protection = routes[i].objective === "rain"
          ? routes[i].exposure?.shelteredDistancePct ?? routes[i].dryCoverage ?? 0
          : routes[i].shadowCoverage;
        const diff = Math.abs(protection - v);
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
      setRouteExposureContext(null);
      setRouteWind(null);
    },
    [cancelInFlightCalculation, setNavRoutes, setSelectedRouteIndex, setRouteExposureContext, setRouteWind],
  );

  const handleWindSourceChange = useCallback((source: WindSource) => {
    if (source === "manual") {
      const token = ++manualWindInitRef.current;
      const pricedWind = routeWind?.dirDeg != null && routeWind.windMs != null
        ? { directionDeg: routeWind.dirDeg, speedMps: routeWind.windMs }
        : routeExposureContext?.windProvenance === "forecast" &&
            routeExposureContext.windDirectionDeg != null && routeExposureContext.windSpeedMps != null
          ? { directionDeg: routeExposureContext.windDirectionDeg, speedMps: routeExposureContext.windSpeedMps }
          : null;
      setManualWind(pricedWind ?? { directionDeg: 0, speedMps: 0 });

      // Before the first route is found, the forecast is still available from
      // the shared weather cache. Seed the manual controls from the trip anchor
      // (or the map centre) instead of making users retype a wind that is already
      // known. A later keystroke invalidates this asynchronous initializer.
      if (!pricedWind) {
        const anchor = waypointA && waypointB
          ? { lat: (waypointA[1] + waypointB[1]) / 2, lng: (waypointA[0] + waypointB[0]) / 2 }
          : mapRef.current?.getCenter();
        if (anchor) {
          void fetchWeatherForecast(anchor.lat, anchor.lng)
            .then((hours) => {
              if (manualWindInitRef.current !== token) return;
              const wind = nearestForecastWind(hours, dateRef.current);
              if (wind) setManualWind({ directionDeg: wind.directionDeg, speedMps: wind.speedMps });
            })
            .catch(() => {});
        }
      }
    } else {
      manualWindInitRef.current++;
    }
    setWindSource(source);
    cancelInFlightCalculation();
  }, [cancelInFlightCalculation, dateRef, mapRef, routeExposureContext, routeWind, waypointA, waypointB]);

  const handleManualWindChange = useCallback((wind: Partial<ManualWind>) => {
    manualWindInitRef.current++;
    setManualWind((previous) => ({
      directionDeg: Number.isFinite(wind.directionDeg) ? ((wind.directionDeg! % 360) + 360) % 360 : previous.directionDeg,
      speedMps: Number.isFinite(wind.speedMps) ? Math.max(0, wind.speedMps!) : previous.speedMps,
    }));
  }, []);

  const handleLoadRoute = useCallback((saved: SavedRoute) => {
    loadSavedRoute(saved);
    const objective = saved.exposureSettings?.objective ?? (saved.legacyRainResult ? "rain" : "sun");
    const settings: ExposureSettings = {
      objective,
      windSource: saved.exposureSettings?.windSource ?? "forecast",
      manualWind: saved.exposureSettings?.manualWind ?? { directionDeg: 0, speedMps: 0 },
    };
    setRainMode(objective === "rain");
    // Legacy rain records have no trustworthy source or wind. Reopen them in
    // forecast mode so the refresh can resolve current conditions; new manual
    // records restore their exact override.
    if (objective === "rain") {
      setWindSource(settings.windSource);
      if (saved.exposureSettings?.manualWind) setManualWind(settings.manualWind);
    }
    const savedContext = saved.routeOption.evaluatedContext;
    if (savedContext) {
      setRouteExposureContext(savedContext);
      setRouteWind(
        savedContext.objective === "rain"
          ? { dirDeg: savedContext.windDirectionDeg, windMs: savedContext.windSpeedMps }
          : null,
      );
    } else if (objective === "rain") {
      // Legacy rain records have no trustworthy original context. Seed an
      // explicitly vertical context so the refresh job can resolve forecast
      // wind once it has the saved route's fixed reference point.
      const coordinates = saved.routeOption.geojson.geometry.coordinates as Array<[number, number]>;
      const start = saved.waypointA ?? coordinates[0] ?? [0, 0];
      const end = saved.waypointB ?? coordinates[coordinates.length - 1] ?? start;
      const context = resolveExposureContext(settings, {
        time: dateRef.current,
        tripStops: [start, end],
        revision: `saved:${saved.id}`,
      });
      setRouteExposureContext(context);
      setRouteWind({ dirDeg: context.windDirectionDeg, windMs: context.windSpeedMps });
    } else {
      setRouteExposureContext(null);
      setRouteWind(null);
    }
  }, [dateRef, loadSavedRoute, setRouteExposureContext, setRouteWind]);

  // Legacy no-op compatibility handler. Rain exposure is always unscaled.
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

  const canTransit = !!(waypointA && waypointB && haversineMeters(waypointA, waypointB) > MIN_TRANSIT_DISTANCE_M);

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
    routeWind,
    routeExposureContext,
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
    windSource,
    manualWind,
    exposureSettings,
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
    handleWindSourceChange,
    handleManualWindChange,
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
    bindStaticSnapshot,

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

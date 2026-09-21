import "./lib/storageMigration";
import { useState, useRef, useEffect, useCallback, lazy, Suspense } from "react";
import TimelineSlider from "./components/TimelineSlider";
import AccumulationPanel from "./components/AccumulationPanel";
import SaveRouteModal from "./components/SaveRouteModal";
import SettingsPanel from "./components/SettingsPanel";
import DateInput from "./components/DateInput";
import DaySlider from "./components/DaySlider";
import AppShell from "./components/AppShell";
import SideNav, { type SideNavTab } from "./components/SideNav";
import BottomSheet, { type SnapPoint } from "./components/BottomSheet";
import SearchBar from "./components/SearchBar";
import FloatingMapControls from "./components/FloatingMapControls";
import FloatingRouteCards from "./components/FloatingRouteCards";
import HourlyExposureStrip from "./components/HourlyExposureStrip";
import QuickActions from "./components/QuickActions";
import DirectionsPanel from "./components/DirectionsPanel";
import NavigationStatusPanel from "./components/NavigationStatusPanel";
import ArrivalPanel from "./components/ArrivalPanel";
import PlaceDetail from "./components/PlaceDetail";
import AssistantPanel from "./components/AssistantPanel";

import type { IShadowLayer } from "./lib/shadow/IShadowLayer";
import {
  toMapLocal,
  fromMapLocal,
  fromMapLocalInZone,
  longitudeToUtcOffsetMin,
  utcOffsetMinAt,
} from "./lib/timezone";
import { ensureZoneLookup, zoneAt } from "./lib/tzLookup";
import { parseShareState, shareUrlFromState } from "./lib/shareState";
import { useShadowTime, formatTime12h, parseTime, dateToDayOfYear } from "./hooks/useShadowTime";
import { useShadowFieldPrewarm } from "./hooks/useShadowFieldPrewarm";
import { useNavigation } from "./hooks/useNavigation";
import { useHourlyExposure } from "./hooks/useHourlyExposure";
import { useAppState } from "./hooks/useAppState";
import { useWeatherHour } from "./hooks/useWeatherHour";
import { directionForWindReport, windFromLabel } from "./lib/rain/direction";
import {
  clearRainMapData,
  ensureRainMapLayer,
  RAIN_GRID_COLS,
  RAIN_GRID_ROWS,
  setRainMapData,
} from "./lib/rain/rainMapLayer";
import type { BBox } from "./lib/shadowField/ShadowField";

import { useAgent } from "./hooks/useAgent";
import { assistantPinId, type AssistantPin } from "./lib/agent/tools";
import type { MapObject } from "./lib/agent/receipts";
import { fetchCloudCoverForecast } from "./services/weather";
import { loadShadowCurrent, shadowApiBase, type ShadowCurrent } from "./lib/shadowField/remoteCatalog";

const MapView = lazy(() => import("./components/MapView"));
const SHADOW_LEGEND_STORAGE_KEY = "umbra:shadowLegendDismissed";

function readShadowLegendDismissed(): boolean {
  try {
    return window.localStorage.getItem(SHADOW_LEGEND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function TimeInput({
  date,
  onChange,
  utcOffsetMin,
  zone,
}: {
  date: Date;
  onChange: (d: Date) => void;
  utcOffsetMin: number;
  zone: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldCommitRef = useRef(true);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit() {
    shouldCommitRef.current = true;
    setText(formatTime12h(date, utcOffsetMin));
    setEditing(true);
  }

  function commit(val: string) {
    if (!shouldCommitRef.current) {
      shouldCommitRef.current = true;
      return;
    }
    setEditing(false);
    const mins = parseTime(val);
    if (mins !== null) {
      // On a DST-transition day the offset in effect now is not the one in
      // effect at the time being typed; resolve in the zone where we have one.
      const next = zone
        ? fromMapLocalInZone(date, zone, Math.floor(mins / 60), mins % 60)
        : fromMapLocal(date, utcOffsetMin, Math.floor(mins / 60), mins % 60);
      onChange(next);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            shouldCommitRef.current = false;
            setEditing(false);
          }
        }}
        className="min-h-11 rounded px-2 py-1 text-xs border focus:outline-none w-24 text-center"
        style={{
          background: "var(--color-canvas)",
          color: "var(--color-ink)",
          borderColor: "var(--color-hairline)",
          fontFamily: "var(--font-sans)",
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      className="min-h-11 text-xs tabular-nums w-24 text-center rounded px-2 py-1 hover:bg-canvas transition-colors"
      style={{ color: "var(--color-ink-muted)", fontFamily: "var(--font-sans)" }}
      title="Click to type a time (e.g. 6:30 AM, 14:30)"
    >
      {formatTime12h(date, utcOffsetMin)}
    </button>
  );
}

function CloudCoverBadge({ pct }: { pct: number }) {
  const label =
    pct >= 80
      ? `Cloud cover ${pct}% - shadow routing matters less`
      : pct >= 55
        ? `Cloud cover ${pct}% - shadows may be muted`
        : `Cloud cover ${pct}% - building shadow still matters`;
  const strongClouds = pct >= 55;

  return (
    <div
      className="mx-3 mt-3 rounded-lg border px-3 py-1.5 text-center text-[11px] font-medium"
      style={{
        background: strongClouds
          ? "color-mix(in srgb, var(--color-ink) 10%, transparent)"
          : "var(--color-sun-soft)",
        borderColor: strongClouds
          ? "color-mix(in srgb, var(--color-ink) 24%, transparent)"
          : "color-mix(in srgb, var(--color-sun) 18%, transparent)",
        color: strongClouds ? "var(--color-ink-muted)" : "var(--color-sun-strong)",
      }}
    >
      {label}
    </div>
  );
}

function ShadowLegend({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="flex min-h-11 max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg"
      style={{
        background: "var(--color-raised)",
        borderColor: "var(--color-hairline)",
        color: "var(--color-ink)",
        fontFamily: "var(--font-sans)",
      }}
      role="status"
    >
      {/*
        Swatch mirrors LocalShadowAdapter's midday shadow: NOON_RGB is declared as
        --color-shadow-noon in the registry, composited here at the same 72% the adapter
        uses before calling its 0.7 paint alpha. If those change, change this — a legend
        that shows a colour the map never paints is worse than no legend. See CLAUDE.md
        invariant #5, which already couples shadow colour to the shadow predicate.
      */}
      <span
        className="h-4 w-4 shrink-0 rounded-sm border"
        style={{
          background: "color-mix(in srgb, var(--color-shadow-noon) 72%, transparent)",
          borderColor: "var(--color-hairline-strong)",
        }}
        aria-hidden="true"
      />
      <span className="leading-snug">Dark blue areas are shadowed at the selected time.</span>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-canvas"
        aria-label="Dismiss shadow legend"
        title="Dismiss"
      >
        <span className="material-symbols-outlined text-base" aria-hidden="true">
          close
        </span>
      </button>
    </div>
  );
}

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const shadow = useShadowTime();
  const {
    date,
    setDate,
    showSunLines,
    setShowSunLines,
    accumulation,
    setAccumulation,
    isPlaying,
    setIsPlaying,
    sliderMode,
    setSliderMode,
    mapCenter,
    mapZoom,
    mapPitch,
    mapUtcOffsetMin,
    mapZone,
    handleMapReady,
    handleSliderChange,
    handleDayOfYearChange,
    adjustYear,
    jumpTo,
    getCanvas,
    getBounds,
    mapRef,
    dateRef,
  } = shadow;

  const shadowLayerRef = useRef<IShadowLayer | null>(null);
  const nav = useNavigation({ mapRef, shadowLayerRef, dateRef, setDate });
  const {
    navMode,
    waypointA,
    waypointB,
    dwellMinutes,
    selectedRouteIndex,
    isCalculating,
    routeProgress,
    navError,
    routeSolarIntensity,
    routeWind,
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
    setPendingSlot,
    setSelectedRouteIndex,
    setSaveModalRouteIndex,
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
    selectedNavRoute,
    navTrainDrawData,
    navMrtEntrances,
    filteredRoutes,
    canTransit,
    shadowField,
  } = nav;

  // "When should I go?" for the selected route. One strip, rendered in whichever
  // of the two route surfaces the current breakpoint shows.
  const hourlyExposure = useHourlyExposure(
    filteredRoutes[selectedRouteIndex] ?? null,
    shadowField,
    date,
    mapUtcOffsetMin,
  );
  const exposureSlot = (
    <HourlyExposureStrip
      exposure={hourlyExposure}
      currentHour={toMapLocal(date, mapUtcOffsetMin).hours}
      onPickHour={setDate}
    />
  );

  const { phase, selectedPlace, dispatch } = useAppState();

  // Weather for the heat score, from D2's cache — the same response the cloud badge
  // already fetched for this location, matched to the hour the timeline is showing.
  const heatWeather = useWeatherHour(mapCenter, date);

  // The Sun/Rain toggle now also switches the canvas: rain aims the painter's ray
  // at the forecast wind (vertical when unknown) instead of the sun, and paints
  // wet-blue where that ray reaches. setEnabled keeps the same layer alive, so the
  // switch is a repaint, not a rebuild.
  useEffect(() => {
    const layer = shadowLayerRef.current;
    if (!layer) return;
    layer.setEnabled?.(true);
    layer.setHazard?.(rainMode ? "rain" : "sun");
  }, [rainMode]);
  useEffect(() => {
    const layer = shadowLayerRef.current;
    if (!rainMode || !layer) return;
    layer.setRainWind?.(heatWeather?.windDirDeg ?? null, heatWeather?.windMs ?? null);
  }, [rainMode, heatWeather]);

  // The rain *ground* picture as a basemap raster: the same shelter grid routing
  // pays for, preloaded the way routing preloads it, composited by the style
  // renderer so the map below is never destroyed by a custom pass.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const clear = () => clearRainMapData(map);
    if (!rainMode) {
      clear();
      return;
    }
    try {
      ensureRainMapLayer(map);
    } catch {
      // Style not settled yet; the next moveend pass reconciles.
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const repaint = async () => {
      const bounds = map.getBounds();
      const bbox: BBox = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
      try {
        await shadowField?.ready(bbox, { deadlineAt: Date.now() + 2500 });
      } catch {
        // Providers may refuse; the grid then honestly reports what it has.
      }
      if (cancelled || !shadowField) return;
      const direction = directionForWindReport(
        heatWeather?.windDirDeg ?? null,
        heatWeather?.windMs ?? null,
      );
      const grid = shadowField.sampleRainGrid(
        bbox,
        RAIN_GRID_COLS,
        RAIN_GRID_ROWS,
        direction,
        date,
      );
      setRainMapData(map, grid, bbox);
    };
    repaint();
    const onMoveEnd = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(repaint, 250);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      map.off("moveend", onMoveEnd);
    };
  }, [rainMode, heatWeather, shadowField, date, mapRef]);

  const [bottomSheetSnap, setBottomSheetSnap] = useState<SnapPoint>("collapsed");
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "error">("idle");
  const [cloudCoverPct, setCloudCoverPct] = useState<number | null>(null);
  const [shadowLayerReady, setShadowLayerReady] = useState(false);
  const [shadowLegendDismissed, setShadowLegendDismissed] = useState(readShadowLegendDismissed);
  const [remoteShadowCurrent, setRemoteShadowCurrent] = useState<ShadowCurrent | undefined>();
  const [remoteShadowError, setRemoteShadowError] = useState<string | null>(null);
  const didHydrateShareRef = useRef(false);

  // This is only a small active-generation health check. Browser tile loading
  // remains deliberately separate from the existing local shadow renderer.
  useEffect(() => {
    if (!shadowApiBase()) return;
    const controller = new AbortController();
    void loadShadowCurrent(controller.signal)
      .then((current) => {
        if (controller.signal.aborted) return;
        setRemoteShadowCurrent(current);
        setRemoteShadowError(null);
        if (current) console.info("[shadow-data] active NYC generation", current.generation);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRemoteShadowError(error instanceof Error ? error.message : "NYC shadow pointer request failed");
        }
      });
    return () => controller.abort();
  }, []);

  // Page-load field prewarm (latency session A2): move the shadow field's
  // materialization off the route path. Once the map and shadow layer settle,
  // the camera's bbox is made ready under the current NYC generation, so the
  // first route calculation's `field.ready` / `field.readyEdges` find it cached.
  useShadowFieldPrewarm({
    mapRef,
    generation: remoteShadowCurrent?.generation,
    shadowLayerReady,
    shadowField,
    bindStaticSnapshot,
  });

  // AI assistant (shadow-aware day-trip planner)
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPins, setAssistantPins] = useState<AssistantPin[]>([]);
  const [receiptMapObjects, setReceiptMapObjects] = useState<MapObject[]>([]);
  const agent = useAgent({
    mapRef,
    shadowLayerRef,
    dateRef,
    setDate,
    mapUtcOffsetMin,
    userLocation,
    setWaypointA: handleSetWaypointA,
    setWaypointB: handleSetWaypointB,
    setAdditionalWaypoints: handleSetAdditionalWaypoints,
    createRoutePlanRequest,
    submitRoutePlan,
    cancelRoutePlan,
    getCurrentPlanRevision,
    setPins: setAssistantPins,
    getMapObjects: () => [
      ...assistantPins.map((pin) => ({
        id: pin.objectId ?? assistantPinId(pin.lat, pin.lng),
        kind: "pin" as const,
        lat: pin.lat,
        lng: pin.lng,
        label: pin.label,
      })),
      ...getRouteReceiptMapObjects(),
      ...receiptMapObjects,
    ],
    registerMapObjects: (objects) =>
      setReceiptMapObjects((current) =>
        objects.length === 0
          ? []
          : [
              ...current.filter((existing) => !objects.some((object) => object.id === existing.id)),
              ...objects,
            ],
      ),
    // Map-object ownership stays in the application. Receipt verification only
    // carries an opaque id and cannot manipulate map state itself.
    focusMapObject: (objectId) => {
      const map = mapRef.current;
      if (!map) return;
      const object = [
        ...assistantPins.map((pin) => ({
          id: pin.objectId ?? assistantPinId(pin.lat, pin.lng),
          kind: "pin" as const,
          lat: pin.lat,
          lng: pin.lng,
        })),
        ...getRouteReceiptMapObjects(),
        ...receiptMapObjects,
      ].find((candidate) => candidate.id === objectId);
      if (object?.kind === "pin" || object?.kind === "shadow") {
        if (object.lat == null || object.lng == null) return;
        map.flyTo({
          center: [object.lng, object.lat],
          zoom: Math.max(map.getZoom(), 15),
          duration: 500,
        });
        return;
      }
      if (object?.kind === "route" && selectedNavRoute) {
        const feature =
          selectedNavRoute.type === "FeatureCollection"
            ? selectedNavRoute.features[0]
            : selectedNavRoute;
        if (feature?.geometry.type === "LineString") {
          const coordinates = feature.geometry.coordinates;
          if (coordinates.length) {
            const lngs = coordinates.map((point) => point[0]);
            const lats = coordinates.map((point) => point[1]);
            map.fitBounds(
              [
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)],
              ],
              { padding: 80, duration: 500 },
            );
          }
        }
      }
    },
  });

  // Sync activeTab with phase
  const [activeTab, setActiveTab] = useState<SideNavTab>("map");

  const handleTabChange = (tab: SideNavTab) => {
    setActiveTab(tab);
    if (tab === "directions") {
      dispatch({ type: "START_DIRECTIONS" });
    } else if (tab === "map") {
      if (phase === "DIRECTIONS" || phase === "NAVIGATING") {
        dispatch({ type: "BACK" });
      }
    }
  };

  const handleSidebarToggle = () => setSidebarOpen((o) => !o);

  const handleOpenDirections = () => {
    setSidebarOpen(true);
    handleTabChange("directions");
  };

  // Keep tab synced with phase changes
  useEffect(() => {
    if (phase === "DIRECTIONS" || phase === "NAVIGATING") {
      setActiveTab("directions");
    } else if (phase === "IDLE" || phase === "PLACE_DETAIL" || phase === "ARRIVAL") {
      setActiveTab("map");
    }
  }, [phase]);

  const handleSearchSelect = (p: {
    name: string;
    category?: string | null;
    address?: string | null;
    center: [number, number];
    zoom: number;
  }) => {
    jumpTo(p.center, p.zoom);
    setMenuOpen(true);
    dispatch({
      type: "SELECT_PLACE",
      place: {
        name: p.name,
        category: p.category ?? null,
        address: p.address ?? null,
        coord: p.center,
      },
    });
  };

  // Sync phase transitions with navigation hook
  useEffect(() => {
    if (phase === "DIRECTIONS" && !navMode) {
      handleToggleNavMode();
    } else if (phase !== "DIRECTIONS" && phase !== "NAVIGATING" && navMode) {
      handleToggleNavMode();
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (didHydrateShareRef.current || !mapRef.current || mapCenter == null) return;
    didHydrateShareRef.current = true;

    // Read the query synchronously, before anything is awaited. Setting the
    // ref above releases the URL-writing effect below, which immediately
    // replaces the address bar with the app's current state — so by the time an
    // await resolves, `window.location.search` is no longer the shared link.
    const search = window.location.search;

    // The zone lookup is a lazily-fetched chunk, so at first paint it is not
    // there yet and `zoneAt` would answer null for every link. Waiting costs a
    // tick at startup; it resolves even when the fetch fails, in which case the
    // longitude estimate below stands in.
    void ensureZoneLookup().then(() => {
      if (!mapRef.current || mapCenter == null) return;

      // A share link stores a wall clock, so the offset is its decoder key — and it
      // has to be the offset at the *shared* coordinates, not wherever this map
      // happens to sit. `firstPass` exists only to read that centre out.
      const firstPass = parseShareState(search, mapUtcOffsetMin);
      const sharedZone = firstPass.center
        ? zoneAt(firstPass.center[1], firstPass.center[0]) // parseShareState gives [lng, lat]
        : null;
      const offset = sharedZone
        ? utcOffsetMinAt(sharedZone, firstPass.date ?? new Date())
        : firstPass.center
          ? longitudeToUtcOffsetMin(firstPass.center[0])
          : mapUtcOffsetMin;
      const shared = parseShareState(search, offset);
      const hasRouteState = !!(
        shared.waypointA ||
        shared.waypointB ||
        shared.additionalWaypoints.length > 0
      );

      if (shared.date) setDate(shared.date);
      // `dwell` is positional over the stops that are actually present, in
      // [a, ...via, b] order — so the destination's index depends on whether
      // a start was in the link at all. Assuming a start would drop B's dwell
      // from a destination-only link.
      const dwellAt = (i: number) => shared.dwell[i] ?? 0;
      const aOffset = shared.waypointA ? 1 : 0;
      if (shared.waypointA)
        handleSetWaypointA(shared.waypointA, "Shared start", { dwellMinutes: dwellAt(0) });
      if (shared.waypointB)
        handleSetWaypointB(shared.waypointB, "Shared destination", {
          dwellMinutes: dwellAt(aOffset + shared.additionalWaypoints.length),
        });
      if (shared.additionalWaypoints.length > 0) {
        handleSetAdditionalWaypoints(
          shared.additionalWaypoints,
          shared.additionalWaypoints.map((_, i) => dwellAt(aOffset + i)),
        );
      }
      if (shared.travelMode !== "walk") handleTravelModeChange(shared.travelMode);
      if (shared.center || shared.zoom != null) {
        const center = shared.center ?? ([mapCenter[1], mapCenter[0]] as [number, number]);
        mapRef.current.jumpTo({ center, zoom: shared.zoom ?? mapRef.current.getZoom() });
      }
      if (hasRouteState) {
        setMenuOpen(true);
        setSidebarOpen(true);
        dispatch({ type: "START_DIRECTIONS" });
      }
    });
  }, [
    dispatch,
    handleSetAdditionalWaypoints,
    handleSetWaypointA,
    handleSetWaypointB,
    handleTravelModeChange,
    mapCenter,
    mapRef,
    mapUtcOffsetMin,
    setDate,
  ]);

  useEffect(() => {
    if (!didHydrateShareRef.current || !mapCenter) return;
    const url = shareUrlFromState({
      mapCenter,
      mapZoom,
      date,
      utcOffsetMin: mapUtcOffsetMin,
      waypointA,
      waypointB,
      additionalWaypoints,
      dwellMinutes,
      travelMode,
    });
    window.history.replaceState(null, "", url);
  }, [additionalWaypoints, date, dwellMinutes, mapCenter, mapUtcOffsetMin, mapZoom, travelMode, waypointA, waypointB]);

  const handleShareLink = useCallback(async () => {
    const url = shareUrlFromState({
      mapCenter,
      mapZoom,
      date,
      utcOffsetMin: mapUtcOffsetMin,
      waypointA,
      waypointB,
      additionalWaypoints,
      dwellMinutes,
      travelMode,
    });
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
    } catch {
      setShareStatus("error");
    }
    window.setTimeout(() => setShareStatus("idle"), 1800);
  }, [additionalWaypoints, date, dwellMinutes, mapCenter, mapUtcOffsetMin, mapZoom, travelMode, waypointA, waypointB]);

  const handleDismissShadowLegend = useCallback(() => {
    setShadowLegendDismissed(true);
    try {
      window.localStorage.setItem(SHADOW_LEGEND_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures; dismissal still applies for this session.
    }
  }, []);

  // Drive bottom sheet snap from phase on mobile
  useEffect(() => {
    if (!menuOpen) return;
    if (phase === "DIRECTIONS") {
      setBottomSheetSnap("mid");
    } else if (phase === "PLACE_DETAIL") {
      setBottomSheetSnap("mid");
    } else if (phase === "IDLE") {
      setBottomSheetSnap("collapsed");
    }
  }, [phase, menuOpen]);

  const weatherLatKey = mapCenter ? mapCenter[0].toFixed(2) : null;
  const weatherLngKey = mapCenter ? mapCenter[1].toFixed(2) : null;
  const weatherHourMs = Math.round(date.getTime() / 3600000) * 3600000;

  useEffect(() => {
    if (!weatherLatKey || !weatherLngKey) {
      setCloudCoverPct(null);
      return;
    }

    const ctrl = new AbortController();

    fetchCloudCoverForecast(
      Number(weatherLatKey),
      Number(weatherLngKey),
      new Date(weatherHourMs),
      ctrl.signal,
    )
      .then((forecast) => setCloudCoverPct(forecast?.cloudCoverPct ?? null))
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setCloudCoverPct(null);
        }
      });

    return () => ctrl.abort();
  }, [weatherHourMs, weatherLatKey, weatherLngKey]);

  const { hours: _localH, minutes: _localM, year: _localYear } = toMapLocal(date, mapUtcOffsetMin);
  const mapLocalMins = _localH * 60 + _localM;

  // -- Timeline controls (floating card style) --
  const timelineControls = !accumulation.enabled ? (
    <div
      className="rounded-t-2xl md:rounded-2xl overflow-hidden"
      style={{
        background: "var(--color-raised)",
        boxShadow: "var(--shadow-level-2)",
      }}
    >
      {/* Floating tooltip */}
      <div
        className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none z-20"
        style={{ bottom: "calc(100% + 6px)" }}
      >
        <div
          className="text-[11px] font-bold px-2.5 py-0.5 rounded-md tabular-nums shadow-md whitespace-nowrap"
          style={{ background: "var(--color-danger)", color: "var(--color-on-danger)", fontFamily: "var(--font-sans)" }}
        >
          {sliderMode === "time"
            ? formatTime12h(date, mapUtcOffsetMin)
            : new Date(date.getTime() + mapUtcOffsetMin * 60000).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}
        </div>
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "5px solid var(--color-danger)",
          }}
        />
      </div>

      {/* Ruler */}
      {cloudCoverPct != null && <CloudCoverBadge pct={cloudCoverPct} />}

      {sliderMode === "time" ? (
        <TimelineSlider
          minutes={mapLocalMins}
          onChange={handleSliderChange}
          date={date}
          latDeg={mapCenter?.[0]}
          lngDeg={mapCenter?.[1]}
          utcOffsetMin={mapUtcOffsetMin}
        />
      ) : (
        <DaySlider
          dayOfYear={dateToDayOfYear(date, mapUtcOffsetMin)}
          year={_localYear}
          onChange={handleDayOfYearChange}
        />
      )}

      {/* Controls row */}
      <div className="flex items-center justify-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={() => setIsPlaying((p) => !p)}
          className="flex items-center justify-center w-11 h-11 rounded-lg hover:bg-canvas transition-colors"
          style={{ color: "var(--color-ink-muted)" }}
          title={isPlaying ? "Pause" : "Play"}
        >
          <span
            className="material-symbols-outlined text-xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            {isPlaying ? "pause" : "play_arrow"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setSliderMode((m) => (m === "time" ? "day" : "time"))}
          className="flex min-h-11 items-center gap-1.5 px-3 rounded-lg hover:bg-canvas transition-colors border"
          style={{ borderColor: "var(--color-hairline)" }}
          title={sliderMode === "time" ? "Switch to day of year" : "Switch to time of day"}
        >
          <span
            className="material-symbols-outlined text-base"
            style={{
              color: sliderMode === "time" ? "var(--color-ink)" : "var(--color-ink-muted)",
              fontVariationSettings: "'FILL' 1",
            }}
          >
            schedule
          </span>
          <span className="text-[9px]" style={{ color: "var(--color-hairline)" }}>
            /
          </span>
          <span
            className="material-symbols-outlined text-base"
            style={{
              color: sliderMode === "day" ? "var(--color-ink)" : "var(--color-ink-muted)",
              fontVariationSettings: "'FILL' 1",
            }}
          >
            calendar_month
          </span>
        </button>

        {sliderMode === "time" ? (
          <>
            <DateInput
              date={date}
              onChange={setDate}
              utcOffsetMin={mapUtcOffsetMin}
              zone={mapZone}
            />
            <TimeInput
              date={date}
              onChange={setDate}
              utcOffsetMin={mapUtcOffsetMin}
              zone={mapZone}
            />
          </>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => adjustYear(-1)}
              className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-canvas transition-colors"
              style={{ color: "var(--color-ink-muted)" }}
              aria-label="Previous year"
            >
              <span className="material-symbols-outlined text-base">chevron_left</span>
            </button>
            <span
              className="text-sm tabular-nums w-12 text-center font-medium"
              style={{ color: "var(--color-ink)", fontFamily: "var(--font-sans)" }}
            >
              {_localYear}
            </span>
            <button
              type="button"
              onClick={() => adjustYear(+1)}
              className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-canvas transition-colors"
              style={{ color: "var(--color-ink-muted)" }}
              aria-label="Next year"
            >
              <span className="material-symbols-outlined text-base">chevron_right</span>
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null;

  // -- Bottom-of-panel controls --
  const bottomPanelControls = (
    <div className="flex flex-col gap-2">
      <div
        className="rounded-xl border p-2 flex flex-col gap-2"
        style={{ background: "white", borderColor: "var(--color-hairline)" }}
      >
        <AccumulationPanel
          accumulation={accumulation}
          onChange={setAccumulation}
          getCanvas={getCanvas as () => HTMLCanvasElement | undefined}
          getBounds={
            getBounds as () =>
              | { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number }
              | undefined
          }
        />
        <SettingsPanel showSunLines={showSunLines} onShowSunLinesChange={setShowSunLines} />
        <a
          href="/about"
          className="text-[11px] hover:underline"
          style={{ color: "var(--color-ink-muted)" }}
        >
          About Umbra
        </a>
        <div className="h-px" style={{ background: "var(--color-hairline)" }} />
        <div
          className="text-[10px] tabular-nums select-none"
          style={{ color: "var(--color-ink-muted)", opacity: 0.6 }}
        >
          zoom {mapZoom.toFixed(1)}
        </div>
        {remoteShadowCurrent && (
          <div
            className="text-[10px] select-none"
            style={{ color: "var(--color-ink-muted)" }}
          >
            NYC shade data ready ({remoteShadowCurrent.tileCount.toLocaleString()} tiles)
          </div>
        )}
        {remoteShadowError && (
          <div className="text-[10px]" role="status" style={{ color: "var(--color-danger)" }}>
            NYC shade data unavailable: {remoteShadowError}
          </div>
        )}
      </div>
    </div>
  );

  // -- Phase-aware sidebar content --
  const sidebarContent = (() => {
    switch (phase) {
      case "PLACE_DETAIL":
        return selectedPlace ? (
          <PlaceDetail
            place={selectedPlace}
            onDirections={() => dispatch({ type: "START_DIRECTIONS" })}
            onBack={() => dispatch({ type: "BACK" })}
          />
        ) : (
          <QuickActions
            onNavigate={() => dispatch({ type: "START_DIRECTIONS" })}
            onDrawRoute={handleDrawModeToggle}
            drawMode={drawMode}
          />
        );

      case "DIRECTIONS":
        return (
          <DirectionsPanel
            waypointA={waypointA}
            waypointB={waypointB}
            waypointALabel={waypointALabel}
            waypointBLabel={waypointBLabel}
            onSetWaypointA={handleSetWaypointA}
            onSetWaypointB={handleSetWaypointB}
            onSwapWaypoints={handleSwapWaypoints}
            onClearWaypointA={handleClearWaypointA}
            onClearWaypointB={handleClearWaypointB}
            onClear={handleClear}
            onCalculate={handleCalculateRoute}
            isCalculating={isCalculating}
            routeProgress={routeProgress}
            routes={filteredRoutes}
            exposureSlot={exposureSlot}
            selectedRouteIndex={selectedRouteIndex}
            onSelectRoute={setSelectedRouteIndex}
            error={navError}
            solarIntensity={routeSolarIntensity}
            pendingSlot={pendingSlot}
            onSetPendingSlot={setPendingSlot}
            onSaveRoute={handleOpenSaveModal}
            savedRoutes={savedRoutes}
            savedFolders={savedFolders}
            onLoadRoute={handleLoadRoute}
            onDeleteSavedRoute={handleDeleteSavedRoute}
            onRenameSavedRoute={handleRenameSavedRoute}
            additionalWaypoints={additionalWaypoints}
            onAddAdditionalWaypoint={handleAddAdditionalWaypoint}
            onRemoveAdditionalWaypoint={handleRemoveAdditionalWaypoint}
            onExportRoute={handleExportRoute}
            onPinDragStart={handlePinDragStart}
            drawMode={drawMode}
            onDrawModeToggle={handleDrawModeToggle}
            onClearSketch={handleClearSketch}
            sketchPointCount={sketchPoints.length}
            warning={navWarning}
            onBack={() => dispatch({ type: "BACK" })}
            onStartNavigation={() => dispatch({ type: "START_NAVIGATION" })}
            hideRouteCards
            routeMode={routeMode}
            onRouteModeChange={handleRouteModeChange}
            canTransit={canTransit}
            travelMode={travelMode}
            onTravelModeChange={handleTravelModeChange}
            shadowPreference={shadowPreference}
            onShadowPreferenceChange={handleShadowPreferenceChange}
          />
        );

      case "NAVIGATING":
        return (
          <NavigationStatusPanel
            route={filteredRoutes[selectedRouteIndex] ?? null}
            waypointA={waypointA}
            waypointB={waypointB}
            waypointALabel={waypointALabel}
            waypointBLabel={waypointBLabel}
            onBack={() => dispatch({ type: "BACK" })}
            onArrive={() => dispatch({ type: "ARRIVE" })}
            onExit={() => dispatch({ type: "DISMISS" })}
          />
        );

      case "ARRIVAL":
        return (
          <ArrivalPanel
            route={filteredRoutes[selectedRouteIndex] ?? null}
            waypointB={waypointB}
            waypointBLabel={waypointBLabel}
            onPlanAnother={() => dispatch({ type: "START_DIRECTIONS" })}
            onDone={() => dispatch({ type: "DISMISS" })}
          />
        );

      default: // IDLE
        return (
          <QuickActions
            onNavigate={() => dispatch({ type: "START_DIRECTIONS" })}
            onDrawRoute={handleDrawModeToggle}
            drawMode={drawMode}
          />
        );
    }
  })();

  // Desktop sidebar: SideNav wrapping phase content + footer
  const desktopSidebar = (
    <SideNav activeTab={activeTab} onTabChange={handleTabChange}>
      <div className="flex flex-col min-h-full">
        <div className="flex-1">{sidebarContent}</div>
        <div className="mt-auto pt-3 border-t" style={{ borderColor: "var(--color-hairline)" }}>
          {bottomPanelControls}
        </div>
      </div>
    </SideNav>
  );

  // -- Map overlays --
  const mapOverlays = (
    <>
      {/* Mobile floating search — hidden while directions own the phone: the
          pill would otherwise sit half over the sheet's planning form, reading
          as if the search had slid open over the navigation card (U4). It
          returns the moment the trip ends or the user backs out. */}
      {phase !== "DIRECTIONS" && phase !== "NAVIGATING" && (
        <div
          className="absolute top-4 left-4 z-30 md:hidden"
          style={{ width: "min(560px, calc(100vw - 2rem))" }}
        >
          <SearchBar onSelect={handleSearchSelect} mapCenter={mapCenter} />
        </div>
      )}

      {/* Pending waypoint banner */}
      {pendingSlot && (
        <div
          className="absolute top-20 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex items-center gap-2 rounded-full px-4 py-1.5 text-sm select-none border"
          style={{
            background: "var(--color-raised)",
            borderColor: "var(--color-hairline-strong)",
            color: "var(--color-ink)",
          }}
        >
          <span
            className="w-2 h-2 rounded-full animate-pulse shrink-0"
            style={{ background: "var(--color-route-soft)" }}
          />
          Click map to place waypoint {pendingSlot}
          <span className="text-xs ml-1" style={{ color: "var(--color-ink-muted)" }}>
            — Esc to cancel
          </span>
        </div>
      )}

      {/* Floating route cards — desktop only, during DIRECTIONS phase */}
      {phase === "DIRECTIONS" && filteredRoutes.length > 0 && (
        <FloatingRouteCards
          routes={filteredRoutes}
          selectedRouteIndex={selectedRouteIndex}
          onSelectRoute={setSelectedRouteIndex}
          onSaveRoute={handleOpenSaveModal}
          onExportRoute={handleExportRoute}
          weather={heatWeather}
          solarIntensity={routeSolarIntensity}
          rainWind={routeWind}
          exposureSlot={exposureSlot}
          onStartNavigation={() => dispatch({ type: "START_NAVIGATION" })}
          rainMode={rainMode}
          rainIntensity={rainIntensity}
        />
      )}

      {/* Floating map controls — right side. Their bottom rides the same
          choreography as the timeline card below them (U4): timeline at
          0–~88px with no sheet, at 80–~168px over the collapsed band, under
          the sheet otherwise. */}
      <div
        className="absolute md:top-24 md:bottom-auto right-3 z-10"
        style={{ bottom: menuOpen && bottomSheetSnap === "collapsed" ? 176 : 96 }}
      >
        <FloatingMapControls
          mapRef={mapRef}
          pitch={mapPitch}
          onLocateMe={handleLocateMe}
          isLocating={isLocating}
          onShare={handleShareLink}
          shareStatus={shareStatus}
          rainMode={rainMode}
          onRainModeChange={handleRainModeChange}
          rainIntensity={rainIntensity}
          onRainIntensityChange={handleRainIntensityChange}
        />
      </div>

      {shadowLayerReady && !shadowLegendDismissed && !accumulation.enabled && (
        <div className="absolute left-4 top-20 z-20 md:left-6 md:top-20">
          <ShadowLegend onDismiss={handleDismissShadowLegend} />
        </div>
      )}

      {/* Rain map legend — only while the rain objective owns the map */}
      {rainMode && !accumulation.enabled && (
        <div
          className="absolute left-6 top-24 z-10 hidden md:flex flex-col gap-1 rounded-lg px-3 py-2 shadow-lg"
          style={{ background: "var(--color-raised)", borderColor: "var(--color-hairline)", border: "1px solid var(--color-hairline)" }}
        >
          <div className="text-[10px] uppercase tracking-widest font-bold" style={{ color: "var(--color-ink-muted)" }}>
            Rain shelter
          </div>
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "var(--color-route-mid)" }} />
            Direct rain reaches here
          </div>
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
            <span className="inline-block w-3 h-3 rounded-sm bg-transparent" style={{ border: "1px dashed var(--color-hairline-strong)" }} />
            Sheltered (overhang or canopy)
          </div>
        </div>
      )}

      {/* Rain wind pill — the wind the canvas is aimed at, hour by hour */}
      {rainMode && heatWeather?.windDirDeg != null && heatWeather.windMs != null && (
        <div
          className="hidden md:block absolute bottom-28 right-6 z-10 rounded-lg px-3 py-2 shadow-lg"
          style={{ background: "var(--color-raised)", border: "1px solid var(--color-hairline)" }}
        >
          <div className="text-[10px] uppercase tracking-widest font-bold" style={{ color: "var(--color-ink-muted)" }}>
            Wind this hour
          </div>
          <div className="text-xs" style={{ color: "var(--color-ink)" }}>
            {windFromLabel(heatWeather.windDirDeg)} {Math.round(heatWeather.windMs * 3.6)} km/h
            <span style={{ color: "var(--color-ink-muted)" }}>
              {" "}· shelter tilted {Math.round(directionForWindReport(heatWeather.windDirDeg, heatWeather.windMs).altitudeDeg)}°
            </span>
          </div>
        </div>
      )}

      {/* Desktop timeline — floating card at bottom */}
      {!accumulation.enabled && (
        <div className="hidden md:block absolute bottom-6 z-10" style={{ left: 24, right: 24 }}>
          <div className="relative">{timelineControls}</div>
        </div>
      )}

      {/* Mobile timeline — full width at the map's bottom edge. U4 removed a
          stray `relative` that lost to `.absolute` in Tailwind's output order,
          dropping the whole card *below* the map (offscreen at phone widths).
          While the sheet is settled at its collapsed snap, the timeline rides
          above the 80px band so the trip bar owns the thumb zone alone; at
          taller snaps the sheet covers it entirely, which is the honest state
          (the sheet owns the screen then). */}
      {!accumulation.enabled && (
        <div
          className="absolute bottom-0 left-0 right-0 z-10 md:hidden"
          style={{ bottom: menuOpen && bottomSheetSnap === "collapsed" ? 80 : 0 }}
        >
          {timelineControls}
        </div>
      )}

      {/* Mobile bottom sheet */}
      {menuOpen && (
        <BottomSheet snap={bottomSheetSnap} onSnapChange={setBottomSheetSnap}>
          {phase === "PLACE_DETAIL" && selectedPlace ? (
            <PlaceDetail
              place={selectedPlace}
              onDirections={() => dispatch({ type: "START_DIRECTIONS" })}
              onBack={() => dispatch({ type: "BACK" })}
            />
          ) : phase === "DIRECTIONS" ? (
            <DirectionsPanel
              waypointA={waypointA}
              waypointB={waypointB}
              waypointALabel={waypointALabel}
              waypointBLabel={waypointBLabel}
              onSetWaypointA={handleSetWaypointA}
              onSetWaypointB={handleSetWaypointB}
              onSwapWaypoints={handleSwapWaypoints}
              onClearWaypointA={handleClearWaypointA}
              onClearWaypointB={handleClearWaypointB}
              onClear={handleClear}
              onCalculate={handleCalculateRoute}
              isCalculating={isCalculating}
              routeProgress={routeProgress}
              routes={filteredRoutes}
              weather={heatWeather}
              rainWind={routeWind}
              selectedRouteIndex={selectedRouteIndex}
              onSelectRoute={setSelectedRouteIndex}
              error={navError}
              solarIntensity={routeSolarIntensity}
              pendingSlot={pendingSlot}
              onSetPendingSlot={setPendingSlot}
              onSaveRoute={handleOpenSaveModal}
              savedRoutes={savedRoutes}
              savedFolders={savedFolders}
              onLoadRoute={handleLoadRoute}
              onDeleteSavedRoute={handleDeleteSavedRoute}
              onRenameSavedRoute={handleRenameSavedRoute}
              additionalWaypoints={additionalWaypoints}
              onAddAdditionalWaypoint={handleAddAdditionalWaypoint}
              onRemoveAdditionalWaypoint={handleRemoveAdditionalWaypoint}
              onExportRoute={handleExportRoute}
              onPinDragStart={handlePinDragStart}
              drawMode={drawMode}
              onDrawModeToggle={handleDrawModeToggle}
              onClearSketch={handleClearSketch}
              sketchPointCount={sketchPoints.length}
              warning={navWarning}
              onBack={() => dispatch({ type: "BACK" })}
              onStartNavigation={() => dispatch({ type: "START_NAVIGATION" })}
              routeMode={routeMode}
              onRouteModeChange={handleRouteModeChange}
              canTransit={canTransit}
              travelMode={travelMode}
              onTravelModeChange={handleTravelModeChange}
              shadowPreference={shadowPreference}
              onShadowPreferenceChange={handleShadowPreferenceChange}
              rainMode={rainMode}
              onRainModeChange={handleRainModeChange}
              rainIntensity={rainIntensity}
              onRainIntensityChange={handleRainIntensityChange}
            />
          ) : phase === "NAVIGATING" ? (
            <NavigationStatusPanel
              route={filteredRoutes[selectedRouteIndex] ?? null}
              waypointA={waypointA}
              waypointB={waypointB}
              waypointALabel={waypointALabel}
              waypointBLabel={waypointBLabel}
              onBack={() => dispatch({ type: "BACK" })}
              onArrive={() => dispatch({ type: "ARRIVE" })}
              onExit={() => dispatch({ type: "DISMISS" })}
            />
          ) : phase === "ARRIVAL" ? (
            <ArrivalPanel
              route={filteredRoutes[selectedRouteIndex] ?? null}
              waypointB={waypointB}
              waypointBLabel={waypointBLabel}
              onPlanAnother={() => dispatch({ type: "START_DIRECTIONS" })}
              onDone={() => dispatch({ type: "DISMISS" })}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <QuickActions
                onNavigate={() => dispatch({ type: "START_DIRECTIONS" })}
                onDrawRoute={handleDrawModeToggle}
                drawMode={drawMode}
              />
              <div
                className="mt-2 rounded-xl border p-1.5 flex flex-col gap-1"
                style={{ background: "white", borderColor: "var(--color-hairline)" }}
              >
                <AccumulationPanel
                  accumulation={accumulation}
                  onChange={setAccumulation}
                  getCanvas={getCanvas as () => HTMLCanvasElement | undefined}
                  getBounds={
                    getBounds as () =>
                      | {
                          getWest(): number;
                          getEast(): number;
                          getNorth(): number;
                          getSouth(): number;
                        }
                      | undefined
                  }
                />
                <SettingsPanel showSunLines={showSunLines} onShowSunLinesChange={setShowSunLines} />
                <a
                  href="/about"
                  className="text-[10px] px-1.5 pt-0.5 pb-0.5 transition-colors hover:underline"
                  style={{ color: "var(--color-ink-muted)" }}
                >
                  About Umbra
                </a>
              </div>
            </div>
          )}
        </BottomSheet>
      )}

      {/* Save route modal */}
      {saveModalRouteIndex !== null && filteredRoutes[saveModalRouteIndex] && (
        <SaveRouteModal
          defaultName={filteredRoutes[saveModalRouteIndex].label}
          onSave={handleConfirmSave}
          onCancel={() => setSaveModalRouteIndex(null)}
        />
      )}
    </>
  );

  return (
    <>
      <AppShell
        mapRef={mapRef}
        sidebar={desktopSidebar}
        sidebarOpen={sidebarOpen}
        onSidebarToggle={handleSidebarToggle}
        map={
          <Suspense fallback={null}>
            <MapView
              date={date}
              accumulation={accumulation}
              onMapReady={handleMapReady}
              onShadowLayerReady={(layer) => {
                shadowLayerRef.current = layer;
                setShadowLayerReady(layer !== null);
              }}
              onMapClick={handleMapClick}
              navWaypoints={{ a: waypointA ?? undefined, b: waypointB ?? undefined }}
              navRoute={selectedNavRoute}
              showSunLines={showSunLines}
              mapClickActive={pendingSlot !== null}
              onMarkerDragEnd={handleMarkerDragEnd}
              navTrainDrawData={navTrainDrawData}
              navMrtEntrances={navMrtEntrances}
              additionalWaypoints={additionalWaypoints}
              userLocation={userLocation}
              assistantPins={assistantPins}
              drawMode={drawMode}
              sketchPoints={sketchPoints}
              onSketchPointClick={handleSketchPointClick}
              onSketchPointDrag={handleSketchPointDrag}
              onSketchFinish={handleSketchFinish}
              simplifiedWaypoints={simplifiedWaypoints}
            />
          </Suspense>
        }
        mapOverlays={mapOverlays}
      />

      {/* Desktop search bar — rendered outside AppShell so it layers above the sidebar */}
      <div className="hidden md:block fixed top-4 left-4 z-50" style={{ width: "376px" }}>
        <SearchBar
          onSelect={handleSearchSelect}
          mapCenter={mapCenter}
          onMenuToggle={handleSidebarToggle}
          onDirections={handleOpenDirections}
        />
      </div>

      {/* AI assistant: launcher FAB + chat panel */}
      {!assistantOpen && (
        <button
          type="button"
          onClick={() => setAssistantOpen(true)}
          className="fixed z-40 flex items-center justify-center rounded-full shadow-xl transition-transform hover:scale-105"
          style={{
            bottom: "6rem",
            right: "1rem",
            width: 52,
            height: 52,
            background: "var(--color-ink)",
            color: "var(--color-on-ink)",
          }}
          title="Ask the Umbra Assistant"
          aria-label="Open Umbra Assistant"
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
            assistant
          </span>
        </button>
      )}
      <AssistantPanel
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        messages={agent.messages}
        isThinking={agent.isThinking}
        onSend={agent.sendMessage}
        onReset={agent.reset}
        onFocusMapObject={agent.focusMapObject}
      />
    </>
  );
}

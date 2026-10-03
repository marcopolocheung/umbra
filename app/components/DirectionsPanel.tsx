import { Fragment, useEffect, useRef, useState } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import type { TravelModeId } from "../lib/travelMode";
import type { ManualWind, WindSource } from "../lib/exposure";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import { routeProgressCount, routeProgressPercent } from "../lib/routeProgress";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { routeAfterSunset, shortestRoute } from "../lib/routeTradeoff";
import RouteCard from "./RouteCard";
import SolarPill from "./SolarPill";
import type { ReactNode } from "react";
import SavedRoutesSection from "./SavedRoutesSection";
import DirectionsPlanning, { DirectionsObjective } from "./DirectionsPlanning";

/**
 * The collapsed trip bar: once options exist, the planning form folds into one
 * origin → destination row so the route stack starts inside the sheet's first
 * snap point instead of below ~600px of inputs. One tap (Edit) reopens the form.
 */
function TripSummaryBar({ from, to, onEdit }: { from: string; to: string; onEdit: () => void }) {
  return (
    <button
      type="button"
      data-directions-section="Trip"
      onClick={onEdit}
      aria-label={`Edit trip: ${from} to ${to}`}
      title="Edit trip"
      className="flex min-h-11 w-full items-center gap-2 rounded-sm border-2 px-3 py-2 transition-colors hover:bg-ground"
      style={{ background: "var(--color-ground)", borderColor: "var(--color-ink)" }}
    >
      <span className="material-symbols-outlined shrink-0 text-base text-ink-muted" aria-hidden="true">route</span>
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--color-ink)" }}>
        {from} <span className="text-ink-muted">→</span> {to}
      </span>
      <span className="material-symbols-outlined shrink-0 text-base text-route" aria-hidden="true">edit</span>
    </button>
  );
}

/**
 * The partial/failed-route notice, riding inside the card stack as a strip
 * note: ink-ruled on the ground, a caveat about the data, not solar data.
 */
function NoticePill({ text }: { text: string }) {
  return (
    <div
      className="border-l-4 px-2.5 py-1.5 text-[11px] font-medium"
      style={{ background: "var(--color-ground)", borderColor: "var(--color-ink)", color: "var(--color-ink)" }}
      role="status"
    >
      {text}
    </div>
  );
}

export interface DirectionsPanelProps {
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onSetWaypointA: (coord: [number, number], label: string) => void;
  onSetWaypointB: (coord: [number, number], label: string) => void;
  onSwapWaypoints: () => void;
  onClearWaypointA: () => void;
  onClearWaypointB: () => void;
  onClear: () => void;
  onCalculate: () => void;
  isCalculating: boolean;
  routeProgress?: RouteCalculationProgress | null;
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  error: string | null;
  solarIntensity?: number | null;
  pendingSlot: 'A' | 'B' | null;
  onSetPendingSlot: (slot: 'A' | 'B' | null) => void;
  onSaveRoute?: (routeIndex: number) => void;
  savedRoutes?: SavedRoute[];
  savedFolders?: SavedFolder[];
  onLoadRoute?: (route: SavedRoute) => void;
  onDeleteSavedRoute?: (id: string) => void;
  onRenameSavedRoute?: (id: string, name: string) => void;
  additionalWaypoints?: [number, number][];
  /** Labels positional with `additionalWaypoints`. */
  additionalWaypointLabels?: (string | null)[];
  onAddAdditionalWaypoint?: (coord: [number, number], label: string) => void;
  onRemoveAdditionalWaypoint?: (index: number) => void;
  onExportRoute?: (routeIndex: number, format: "gpx" | "geojson") => void;
  onPinDragStart?: (slot: 'A' | 'B') => void;
  drawMode?: boolean;
  onDrawModeToggle?: () => void;
  onClearSketch?: () => void;
  sketchPointCount?: number;
  warning?: string | null;
  onBack: () => void;
  onStartNavigation?: () => void;
  routePreviewGrip?: ReactNode;
  hideRouteCards?: boolean;
  /** The dose line and hourly exposure strip, rendered under the tradeoff line. */
  exposureSlot?: ReactNode;
  routeMode?: 'walk' | 'transit';
  onRouteModeChange?: (mode: 'walk' | 'transit') => void;
  canTransit?: boolean;
  /** Active-travel mode for walk routing (E1). Hidden unless routeMode is walk. */
  travelMode?: TravelModeId;
  onTravelModeChange?: (mode: TravelModeId) => void;
  shadowPreference?: number;
  onShadowPreferenceChange?: (v: number) => void;
  /** The forecast hour at the map's location, for the heat score. */
  weather: WeatherHour | null;
  selectedTime: Date;
  mapUtcOffsetMin: number;
  /** SunCalc position at the map centre; azimuth is a north-clockwise bearing. */
  solarPosition: { altitudeDeg: number; azimuthDeg: number } | null;
  sunset: Date | null;
  onOpenTimeline: () => void;
  /** Rain objective: cards present shelter figures; sun-derived lines hide. */
  rainMode?: boolean;
  onRainModeChange?: (mode: boolean) => void;
  /** Deprecated compatibility props; rain exposure is unscaled. */
  rainIntensity?: number;
  onRainIntensityChange?: (v: number) => void;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
  /** S2b: the learned shade preference behind the default card. */
  learnedPreference?: { detourM: number; picks: number; stated: boolean } | null;
  onResetLearnedPreference?: () => void;
  windSource?: WindSource;
  manualWind?: ManualWind;
  onWindSourceChange?: (source: WindSource) => void;
  onManualWindChange?: (wind: Partial<ManualWind>) => void;
}

export default function DirectionsPanel({
  waypointA, waypointB,
  waypointALabel, waypointBLabel,
  onSetWaypointA, onSetWaypointB,
  onSwapWaypoints, onClearWaypointA, onClearWaypointB,
  onClear: _onClear, onCalculate, isCalculating,
  routeProgress,
  routes, selectedRouteIndex, onSelectRoute,
  error, solarIntensity,
  pendingSlot, onSetPendingSlot,
  onSaveRoute,
  savedRoutes, savedFolders,
  onLoadRoute, onDeleteSavedRoute, onRenameSavedRoute,
  additionalWaypoints, additionalWaypointLabels, onAddAdditionalWaypoint, onRemoveAdditionalWaypoint,
  onExportRoute,
  onPinDragStart,
  drawMode = false, onDrawModeToggle, onClearSketch,
  sketchPointCount = 0,
  warning,
  onBack,
  onStartNavigation,
  routePreviewGrip,
  hideRouteCards = false,
  exposureSlot,
  routeMode = 'walk', onRouteModeChange,
  canTransit = true,
  travelMode = 'walk', onTravelModeChange,
  shadowPreference = 0.5, onShadowPreferenceChange,
  weather,
  selectedTime, mapUtcOffsetMin, solarPosition, sunset, onOpenTimeline,
  rainMode = false, onRainModeChange,
  rainIntensity: _rainIntensity = 5, onRainIntensityChange: _onRainIntensityChange,
  rainWind = null,
  learnedPreference = null,
  onResetLearnedPreference,
  windSource = "forecast",
  manualWind = { directionDeg: 0, speedMps: 0 },
  onWindSourceChange,
  onManualWindChange,
}: DirectionsPanelProps) {
  const baselineRoute = shortestRoute(routes);
  const completeBaselineRoute = shortestRoute(routes.filter((route) => !route.partial)) ?? baselineRoute;
  const selectedRoute = routes[selectedRouteIndex];
  const [editing, setEditing] = useState(false);
  const wasCalculating = useRef(false);
  useEffect(() => {
    if (wasCalculating.current && !isCalculating && routes.length > 0) setEditing(false);
    wasCalculating.current = isCalculating;
  }, [isCalculating, routes.length]);
  // Once options exist the planning form collapses to the trip bar — unless
  // the user reopened it, is mid-sketch, or is about to place a pin on the map.
  const showForm = routes.length === 0 || editing || drawMode || pendingSlot !== null || isCalculating;
  // Where a partial/failed notice rides inside the stack. Up to three options
  // it stays above the whole stack (after the pill); past three, serial
  // position puts the end slot in memory's favour, so it moves to just above
  // the weakest viable card instead of trailing it.
  const weakNoticeIndex = routes.length > 3 ? routes.length - 2 : 0;
  const progressPercent = routeProgress ? routeProgressPercent(routeProgress) : null;
  const progressCount = routeProgress ? routeProgressCount(routeProgress) : null;

  return (
    <div className="directions-panel flex flex-col gap-3 pb-3">
      {!showForm && (
        <TripSummaryBar from={waypointALabel ?? "Start"} to={waypointBLabel ?? "Destination"} onEdit={() => setEditing(true)} />
      )}
      {!showForm && onRainModeChange && <div className="directions-planning directions-collapsed-objective" data-objective={rainMode ? "rain" : "sun"}>
        <DirectionsObjective rainMode={rainMode} onRainModeChange={onRainModeChange} />
      </div>}
      {savedRoutes && savedRoutes.length > 0 && savedFolders && onLoadRoute && onDeleteSavedRoute && onRenameSavedRoute && (
        <div data-directions-section="Saved routes"><SavedRoutesSection routes={savedRoutes} folders={savedFolders} onLoad={onLoadRoute} onDelete={onDeleteSavedRoute} onRename={onRenameSavedRoute} /></div>
      )}
      {showForm && <DirectionsPlanning
        waypointA={waypointA} waypointB={waypointB} waypointALabel={waypointALabel} waypointBLabel={waypointBLabel}
        onSetWaypointA={onSetWaypointA} onSetWaypointB={onSetWaypointB} onSwapWaypoints={onSwapWaypoints}
        onClearWaypointA={onClearWaypointA} onClearWaypointB={onClearWaypointB}
        pendingSlot={pendingSlot} onSetPendingSlot={onSetPendingSlot} onPinDragStart={onPinDragStart}
        additionalWaypoints={additionalWaypoints} additionalWaypointLabels={additionalWaypointLabels} onAddAdditionalWaypoint={onAddAdditionalWaypoint}
        onRemoveAdditionalWaypoint={onRemoveAdditionalWaypoint} drawMode={drawMode}
        onDrawModeToggle={onDrawModeToggle} onClearSketch={onClearSketch} sketchPointCount={sketchPointCount}
        routeMode={routeMode} onRouteModeChange={onRouteModeChange} canTransit={canTransit}
        travelMode={travelMode} onTravelModeChange={onTravelModeChange}
        shadowPreference={shadowPreference} onShadowPreferenceChange={onShadowPreferenceChange}
        rainMode={rainMode} onRainModeChange={onRainModeChange}
        windSource={windSource} manualWind={manualWind} onWindSourceChange={onWindSourceChange}
        onManualWindChange={onManualWindChange} onCalculate={onCalculate} isCalculating={isCalculating}
        onBack={onBack}
        selectedTime={selectedTime} mapUtcOffsetMin={mapUtcOffsetMin} solarPosition={solarPosition}
        sunset={sunset} weather={weather} onOpenTimeline={onOpenTimeline}
      />}
      {isCalculating && routeProgress && (
        <div role="status" aria-live="polite" className="mx-3 border-2 px-3 py-2 text-[11px]" style={{ background: "var(--color-ground)", borderColor: "var(--color-rule)", color: "var(--color-ink-muted)" }}>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">{routeProgress.message}</span>
            {progressCount && <span className="shrink-0 tabular-nums">{progressCount}</span>}
          </div>
          {progressPercent != null && <div role="progressbar" aria-label={routeProgress.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressPercent)} className="mt-2 h-1.5 overflow-hidden" style={{ background: "color-mix(in srgb, var(--color-ink) 16%, transparent)" }}><div className="h-full transition-[width]" style={{ width: `${progressPercent}%`, background: "var(--color-route)" }} /></div>}
        </div>
      )}

      {/* Route cards — hidden on desktop when FloatingRouteCards is used. The
          selected card carries the conditions/dose detail block itself. The
          partial/failed notice rides above the weakest viable card once the
          stack passes three options (serial position): trailing the stack
          puts it at end-position, where memory favours the weakest option. */}
      {!hideRouteCards && routes.length > 0 && (
        <div
          data-directions-section="Routes"
          data-testid={routePreviewGrip ? "route-preview-docked" : undefined}
          className="flex flex-col gap-1.5 border-t pt-2"
          style={{ borderColor: "var(--color-rule)" }}
        >
          {routePreviewGrip}
          {!rainMode && solarIntensity != null && (
            <SolarPill intensity={solarIntensity} afterSunset={routeAfterSunset(selectedRoute ?? routes[0])} />
          )}
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Route options">
            {routes.map((r, i) => (
              <Fragment key={i}>
                {(i === weakNoticeIndex && warning) && <NoticePill text={warning} />}
                <RouteCard
                  route={r}
                  selected={i === selectedRouteIndex}
                  onSelect={() => onSelectRoute(i)}
                  onSave={onSaveRoute ? () => onSaveRoute(i) : undefined}
                  onExport={onExportRoute ? (fmt) => onExportRoute(i, fmt) : undefined}
                  recommended={r.label === "Balanced"}
                  baselineRoute={completeBaselineRoute ?? undefined}
                  rainMode={rainMode}
                  rainIntensity={_rainIntensity}
                  rainWind={rainWind}
                  weather={weather}
                  exposureSlot={i === selectedRouteIndex ? exposureSlot : undefined}
                  learnedPreference={i === selectedRouteIndex ? learnedPreference : undefined}
                  onResetLearnedPreference={onResetLearnedPreference}
                />
              </Fragment>
            ))}
          </div>

          {onStartNavigation && routes.length > 0 && !selectedRoute?.partial && (
            <div className="sticky bottom-0 z-10 -mx-3 px-3 py-2 md:static md:mx-0 md:px-0" style={{ background: "var(--color-panel)" }}>
              <button type="button" onClick={onStartNavigation} className="umbra-start-button">
                START NAVIGATING
              </button>
            </div>
          )}
        </div>
      )}

      {/* Warning with no route stack to ride in (and errors) stays at the
          panel's foot — there is no weaker card to anchor it to. */}
      {warning && routes.length === 0 && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "var(--color-ink-muted)", borderColor: "var(--color-rule)" }}>
          {warning}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "var(--color-danger)", borderColor: "var(--color-rule)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

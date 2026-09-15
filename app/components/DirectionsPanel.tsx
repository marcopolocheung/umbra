import { memo, useState } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import type { TravelModeId } from "../lib/travelMode";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import { routeProgressCount, routeProgressPercent } from "../lib/routeProgress";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { shortestRoute } from "../lib/routeTradeoff";
import WaypointInput from "./WaypointInput";
import RouteCard from "./RouteCard";
import RouteTradeoffSummary from "./RouteTradeoffSummary";
import type { ReactNode } from "react";
import SavedRoutesSection from "./SavedRoutesSection";

const SolarPill = memo(function SolarPill({ intensity }: { intensity: number }) {
  if (intensity < 0.15) {
    return (
      <div
        className="text-xs px-2.5 py-1 rounded-full self-start"
        style={{ background: "rgba(100,116,139,0.1)", color: "var(--md-on-surface-variant)" }}
      >
        Low sun — shadow routing minimal
      </div>
    );
  }
  if (intensity <= 0.6) {
    return (
      <div
        className="text-xs px-2.5 py-1 rounded-full self-start"
        style={{ background: "rgba(255,171,0,0.12)", color: "#92400e" }}
      >
        Moderate solar load
      </div>
    );
  }
  return (
    <div
      className="text-xs px-2.5 py-1 rounded-full self-start"
      style={{ background: "var(--md-primary-container)", color: "var(--md-on-primary-container)" }}
    >
      High solar load — shadow matters
    </div>
  );
});

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
  weather?: WeatherHour | null;
}

export default function DirectionsPanel({
  waypointA, waypointB,
  waypointALabel, waypointBLabel,
  onSetWaypointA, onSetWaypointB,
  onSwapWaypoints, onClearWaypointA, onClearWaypointB,
  onClear, onCalculate, isCalculating,
  routeProgress,
  routes, selectedRouteIndex, onSelectRoute,
  error, solarIntensity,
  pendingSlot, onSetPendingSlot,
  onSaveRoute,
  savedRoutes, savedFolders,
  onLoadRoute, onDeleteSavedRoute, onRenameSavedRoute,
  additionalWaypoints, onAddAdditionalWaypoint, onRemoveAdditionalWaypoint,
  onExportRoute,
  onPinDragStart,
  drawMode = false, onDrawModeToggle, onClearSketch,
  sketchPointCount = 0,
  warning,
  onBack,
  onStartNavigation,
  hideRouteCards = false,
  exposureSlot,
  routeMode = 'walk', onRouteModeChange,
  canTransit = true,
  travelMode = 'walk', onTravelModeChange,
  shadowPreference = 0.5, onShadowPreferenceChange,
  weather = null,
}: DirectionsPanelProps) {
  const shadowLabel = shadowPreference < 0.33 ? "Fastest" : shadowPreference > 0.66 ? "Most shadowed" : "Balanced";
  const baselineRoute = shortestRoute(routes);
  const completeBaselineRoute = shortestRoute(routes.filter((route) => !route.partial)) ?? baselineRoute;
  const selectedRoute = routes[selectedRouteIndex];
  const [addingStop, setAddingStop] = useState(false);
  const progressPercent = routeProgress ? routeProgressPercent(routeProgress) : null;
  const progressCount = routeProgress ? routeProgressCount(routeProgress) : null;

  function activateWaypointSlot(slot: 'A' | 'B') {
    if (slot === 'B' && drawMode) return;
    onSetPendingSlot(pendingSlot === slot ? null : slot);
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button type="button"
          onClick={onBack}
          className="flex items-center justify-center w-7 h-7 rounded-full transition-colors hover:bg-amber-50"
          style={{ background: "var(--md-surface-container-low)", color: "var(--md-on-surface-variant)" }}
          title="Back"
        >
          <span className="material-symbols-outlined text-base">arrow_back</span>
        </button>
        <h2 className="text-[13px] font-medium" style={{ color: "var(--md-on-surface)" }}>Directions</h2>
        {/* Walk / Transit tabs */}
        <div
          className="flex rounded-lg overflow-hidden border"
          style={{ borderColor: "var(--md-outline-variant)" }}
        >
          {(['walk', 'transit'] as const).map((mode) => (
            <button type="button"
              key={mode}
              onClick={() => onRouteModeChange?.(mode)}
              disabled={mode === 'transit' && !canTransit}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                routeMode === mode
                  ? 'text-amber-900 bg-amber-50'
                  : 'hover:bg-slate-50'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
              style={routeMode !== mode ? { color: "var(--md-on-surface-variant)" } : undefined}
              title={mode === 'transit' && !canTransit ? 'Too close for transit' : undefined}
            >
              {mode === 'walk' ? 'Walk' : 'Transit'}
            </button>
          ))}
        </div>
      </div>

      {/* Walk / Bike selector (E1) — only for walk routing; transit legs stay pedestrian */}
      {routeMode === 'walk' && onTravelModeChange && (
        <div
          className="flex rounded-lg overflow-hidden border self-start"
          style={{ borderColor: "var(--md-outline-variant)" }}
        >
          {(['walk', 'bike'] as const).map((mode) => (
            <button type="button"
              key={mode}
              onClick={() => onTravelModeChange(mode)}
              aria-pressed={travelMode === mode}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                travelMode === mode
                  ? 'text-amber-900 bg-amber-50'
                  : 'hover:bg-slate-50'
              }`}
              style={travelMode !== mode ? { color: "var(--md-on-surface-variant)" } : undefined}
              title={mode === 'bike' ? 'Avoids stairs and rough surfaces, prefers cycleways' : undefined}
            >
              {mode === 'walk' ? 'Walk' : 'Bike'}
            </button>
          ))}
        </div>
      )}

      {/* Saved routes */}
      {savedRoutes && savedRoutes.length > 0 && savedFolders && onLoadRoute && onDeleteSavedRoute && onRenameSavedRoute && (
        <SavedRoutesSection
          routes={savedRoutes}
          folders={savedFolders}
          onLoad={onLoadRoute}
          onDelete={onDeleteSavedRoute}
          onRename={onRenameSavedRoute}
        />
      )}

      {/* Waypoint inputs */}
      <div
        className="rounded-xl p-4 flex flex-col gap-2"
        style={{ background: "var(--md-surface-container-low)" }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <WaypointInput
              label={waypointALabel}
              placeholder="Start — type or click map"
              dotColor="green"
              onSet={onSetWaypointA}
              onClear={onClearWaypointA}
            />
          </div>
          <button
            type="button"
            aria-label="Place start waypoint on map"
            aria-pressed={pendingSlot === 'A'}
            onPointerDown={() => onPinDragStart?.('A')}
            onClick={() => activateWaypointSlot('A')}
            className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-amber-50"
            style={{ color: pendingSlot === 'A' ? "var(--md-primary)" : "var(--md-on-surface-variant)" }}
            title="Place start waypoint on map"
          >
            <span className="material-symbols-outlined text-base">add_location</span>
          </button>
        </div>

        {/* Swap button */}
        <div className="flex justify-center">
          <button type="button"
            onClick={onSwapWaypoints}
            className="text-slate-400 hover:text-amber-700 transition-colors p-1 hover:bg-amber-50 rounded-lg"
            title="Swap waypoints"
          >
            <span className="material-symbols-outlined text-lg">swap_vert</span>
          </button>
        </div>

        <div
          className="flex items-start gap-2 transition-opacity"
          style={drawMode ? { opacity: 0.4 } : undefined}
        >
          <div className="flex-1 min-w-0">
            <WaypointInput
              label={waypointBLabel}
              placeholder={drawMode ? "Tap map to sketch route" : "End — type or click map"}
              dotColor="red"
              onSet={onSetWaypointB}
              onClear={onClearWaypointB}
            />
          </div>
          <button
            type="button"
            aria-label="Place destination waypoint on map"
            aria-pressed={pendingSlot === 'B'}
            disabled={drawMode}
            onPointerDown={() => !drawMode && onPinDragStart?.('B')}
            onClick={() => activateWaypointSlot('B')}
            className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-amber-50 disabled:cursor-not-allowed"
            style={{ color: pendingSlot === 'B' ? "var(--md-primary)" : "var(--md-on-surface-variant)" }}
            title="Place destination waypoint on map"
          >
            <span className="material-symbols-outlined text-base">add_location</span>
          </button>
        </div>
      </div>

      {/* Additional waypoints */}
      {(additionalWaypoints ?? []).length > 0 || addingStop ? (
        <div className="pl-4 flex flex-col gap-1 text-[10px]" style={{ color: "var(--md-on-surface-variant)" }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ opacity: 0.6 }}>Stops between start and destination</span>
            {!addingStop && onAddAdditionalWaypoint && (
              <button type="button"
                onClick={() => setAddingStop(true)}
                className="text-[10px] font-medium hover:text-amber-700 transition-colors"
                style={{ color: "var(--md-primary)" }}
              >
                Add stop
              </button>
            )}
          </div>
          {(additionalWaypoints ?? []).map((wp, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full text-white text-[9px] flex items-center justify-center shrink-0" style={{ background: "var(--md-primary)" }}>{i + 1}</span>
              <span className="flex-1 tabular-nums truncate" style={{ color: "var(--md-on-surface)" }}>{wp[1].toFixed(5)}, {wp[0].toFixed(5)}</span>
              <button type="button"
                onClick={() => onRemoveAdditionalWaypoint?.(i)}
                className="text-slate-300 hover:text-red-500 transition-colors px-0.5"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
          ))}
          {addingStop && onAddAdditionalWaypoint && (
            <div className="mt-1 rounded-lg border px-2 py-1" style={{ borderColor: "var(--md-outline-variant)" }}>
              <WaypointInput
                label={null}
                placeholder="Stop — type an address or place"
                dotColor="amber"
                onSet={(coord, label) => {
                  onAddAdditionalWaypoint(coord, label);
                  setAddingStop(false);
                }}
                onClear={() => setAddingStop(false)}
              />
            </div>
          )}
        </div>
      ) : onAddAdditionalWaypoint ? (
        <button type="button"
          onClick={() => setAddingStop(true)}
          className="ml-4 self-start flex items-center gap-1 text-[11px] font-medium hover:text-amber-700 transition-colors"
          style={{ color: "var(--md-primary)" }}
        >
          <span className="material-symbols-outlined text-sm">add_location</span>
          Add stop
        </button>
      ) : null}

      {/* Route input — Search / Draw segmented control */}
      <div className="border-t pt-2" style={{ borderColor: "var(--md-outline-variant)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--md-on-surface-variant)" }}>Route input</span>
          <div
            className="flex rounded-lg overflow-hidden border"
            style={{ borderColor: "var(--md-outline-variant)" }}
          >
            <button type="button"
              onClick={() => drawMode && onDrawModeToggle?.()}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                !drawMode ? 'text-amber-900 bg-amber-50' : 'hover:bg-slate-50'
              }`}
              style={drawMode ? { color: "var(--md-on-surface-variant)" } : undefined}
            >
              Search
            </button>
            <button type="button"
              onClick={() => !drawMode && onDrawModeToggle?.()}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                drawMode ? 'text-amber-900 bg-amber-50' : 'hover:bg-slate-50'
              }`}
              style={!drawMode ? { color: "var(--md-on-surface-variant)" } : undefined}
            >
              Draw
            </button>
          </div>
        </div>
        {drawMode && (
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[11px]" style={{ color: "var(--md-on-surface-variant)" }}>
              {sketchPointCount > 0 ? (
                <span className="tabular-nums" style={{ color: "var(--md-primary)" }}>
                  {sketchPointCount} point{sketchPointCount !== 1 ? "s" : ""} drawn
                </span>
              ) : (
                "Tap map to sketch route"
              )}
            </p>
            {sketchPointCount > 0 && onClearSketch && (
              <button type="button"
                onClick={onClearSketch}
                className="text-[11px] transition-colors hover:text-amber-700"
                style={{ color: "var(--md-on-surface-variant)" }}
              >
                Clear sketch
              </button>
            )}
          </div>
        )}
      </div>

      {/* Shadow preference slider */}
      <div className="border-t pt-2" style={{ borderColor: "var(--md-outline-variant)" }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px]" style={{ color: "var(--md-on-surface-variant)" }}>Shadow preference</span>
          <span className="text-[11px] font-medium" style={{ color: "var(--md-on-surface)" }}>{shadowLabel}</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={shadowPreference}
          onChange={(e) => onShadowPreferenceChange?.(parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-700"
          style={{ background: "var(--md-surface-container-low)" }}
        />
        <div className="flex justify-between mt-1">
          <span className="text-[10px]" style={{ color: "var(--md-on-surface-variant)" }}>Fastest</span>
          <span className="text-[10px]" style={{ color: "var(--md-on-surface-variant)" }}>Most shadowed</span>
        </div>
      </div>

      {/* Calculate button */}
      <div className="flex gap-2 shrink-0">
        <button type="button"
          onClick={onCalculate}
          disabled={drawMode ? sketchPointCount < 2 || isCalculating : !waypointA || !waypointB || isCalculating}
          className="flex-1 px-2 py-2 rounded-lg text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
          style={{ background: "var(--md-primary)", color: "var(--md-on-primary)" }}
        >
          {isCalculating && (
            <svg aria-hidden="true" focusable="false" className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          )}
          {isCalculating ? 'Calculating...' : 'Find Shadowed Route'}
        </button>
      </div>
      {isCalculating && routeProgress && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border px-3 py-2 text-[11px]"
          style={{
            background: "var(--md-surface-container-low)",
            borderColor: "var(--md-outline-variant)",
            color: "var(--md-on-surface-variant)",
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="truncate">{routeProgress.message}</span>
            {progressCount && <span className="shrink-0 tabular-nums">{progressCount}</span>}
          </div>
          {progressPercent != null && (
            <div
              role="progressbar"
              aria-label={routeProgress.message}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPercent)}
              className="mt-2 h-1.5 overflow-hidden rounded-full"
              style={{ background: "rgba(100,116,139,0.16)" }}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${progressPercent}%`, background: "var(--md-primary)" }}
              />
            </div>
          )}
        </div>
      )}

      {/* Route cards — hidden on desktop when FloatingRouteCards is used */}
      {!hideRouteCards && routes.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: "var(--md-outline-variant)" }}>
          {solarIntensity != null && <SolarPill intensity={solarIntensity} />}
          <RouteTradeoffSummary
            route={selectedRoute}
            baselineRoute={completeBaselineRoute ?? undefined}
            weather={weather}
          />
          {exposureSlot}
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Route options">
            {routes.map((r, i) => (
              <RouteCard
                key={i}
                route={r}
                selected={i === selectedRouteIndex}
                onSelect={() => onSelectRoute(i)}
                onSave={onSaveRoute ? () => onSaveRoute(i) : undefined}
                onExport={onExportRoute ? (fmt) => onExportRoute(i, fmt) : undefined}
                recommended={r.label === "Balanced"}
              />
            ))}
          </div>

          {onStartNavigation && routes.length > 0 && !selectedRoute?.partial && (
            <button type="button"
              onClick={onStartNavigation}
              className="mt-2 w-full px-3 py-2.5 rounded-lg text-sm font-bold transition-colors"
              style={{ background: "#22c55e", color: "white" }}
            >
              START NAVIGATING
            </button>
          )}
        </div>
      )}

      {/* Warning */}
      {warning && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "#a16207", borderColor: "var(--md-outline-variant)" }}>
          {warning}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "var(--md-error)", borderColor: "var(--md-outline-variant)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

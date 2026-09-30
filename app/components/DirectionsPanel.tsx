import { Fragment, useState } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import type { TravelModeId } from "../lib/travelMode";
import type { ManualWind, WindSource } from "../lib/exposure";
import { TRAVEL_MODE_POLICIES } from "../lib/travelMode";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import { routeProgressCount, routeProgressPercent } from "../lib/routeProgress";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { shortestRoute } from "../lib/routeTradeoff";
import { MIN_TRANSIT_DISTANCE_M } from "../lib/trainGraph";
import WaypointInput from "./WaypointInput";
import RouteCard from "./RouteCard";
import SolarPill from "./SolarPill";
import type { ReactNode } from "react";
import SavedRoutesSection from "./SavedRoutesSection";
import Segmented from "./ui/Segmented";

/**
 * The collapsed trip bar: once options exist, the planning form folds into one
 * origin → destination row so the route stack starts inside the sheet's first
 * snap point instead of below ~600px of inputs. One tap (Edit) reopens the form.
 */
function TripSummaryBar({ from, to, onEdit }: { from: string; to: string; onEdit: () => void }) {
  return (
    <button
      type="button"
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
  /** Rain objective: cards present shelter figures; sun-derived lines hide. */
  rainMode?: boolean;
  onRainModeChange?: (mode: boolean) => void;
  /** Deprecated compatibility props; rain exposure is unscaled. */
  rainIntensity?: number;
  onRainIntensityChange?: (v: number) => void;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
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
  rainMode = false, onRainModeChange,
  rainIntensity: _rainIntensity = 5, onRainIntensityChange: _onRainIntensityChange,
  rainWind = null,
  windSource = "forecast",
  manualWind = { directionDeg: 0, speedMps: 0 },
  onWindSourceChange,
  onManualWindChange,
}: DirectionsPanelProps) {
  const preferenceLabel = shadowPreference < 0.33
    ? "Fastest"
    : shadowPreference > 0.66
      ? (rainMode ? "Most sheltered" : "Most shadowed")
      : "Balanced";
  const baselineRoute = shortestRoute(routes);
  const completeBaselineRoute = shortestRoute(routes.filter((route) => !route.partial)) ?? baselineRoute;
  const selectedRoute = routes[selectedRouteIndex];
  const [addingStop, setAddingStop] = useState(false);
  const [editing, setEditing] = useState(false);
  // Once options exist the planning form collapses to the trip bar — unless
  // the user reopened it, is mid-sketch, or is about to place a pin on the map.
  const showForm = routes.length === 0 || editing || drawMode || pendingSlot !== null;
  // Where a partial/failed notice rides inside the stack. Up to three options
  // it stays above the whole stack (after the pill); past three, serial
  // position puts the end slot in memory's favour, so it moves to just above
  // the weakest viable card instead of trailing it.
  const weakNoticeIndex = routes.length > 3 ? routes.length - 2 : 0;
  const progressPercent = routeProgress ? routeProgressPercent(routeProgress) : null;
  const progressCount = routeProgress ? routeProgressCount(routeProgress) : null;

  function activateWaypointSlot(slot: 'A' | 'B') {
    if (slot === 'B' && drawMode) return;
    onSetPendingSlot(pendingSlot === slot ? null : slot);
  }

  return (
    <div className={`flex flex-col gap-3 px-3 pb-3 ${showForm ? "pt-3" : "pt-0"}`}>
      {/* Collapsed trip bar leads the panel (U4): with options on screen the
          sheet's collapsed band is exactly one trip bar tall, so the bar —
          the band's whole job — must be the panel's first child, flush to the
          band's top. Reopening the form restores the normal order. */}
      {!showForm && (
        <TripSummaryBar
          from={waypointALabel ?? "Start"}
          to={waypointBLabel ?? "Destination"}
          onEdit={() => setEditing(true)}
        />
      )}
      {/* Header: back, the panel's stamped label, and Walk / Transit. Every
          control is a ≥44px target; Transit's disabled reason is on screen,
          not only in a tooltip touch never shows (issue 126). */}
      <div className="flex items-center justify-between gap-2">
        <button type="button"
          onClick={onBack}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border-2 transition-colors hover:bg-ground"
          style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
          title="Back"
          aria-label="Back"
        >
          <span className="material-symbols-outlined text-base" aria-hidden="true">arrow_back</span>
        </button>
        <h2 className="umbra-kicker" style={{ color: "var(--color-ink)" }}>Directions</h2>
        <Segmented
          label="Route mode"
          value={routeMode}
          onChange={(mode) => onRouteModeChange?.(mode)}
          options={[
            { value: "walk", label: "Walk" },
            { value: "transit", label: "Transit", disabled: !canTransit, title: canTransit ? undefined : `Transit needs a start and destination over ${MIN_TRANSIT_DISTANCE_M} m apart` },
          ]}
        />
      </div>
      {!canTransit && (
        <p className="-mt-1 text-right text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
          {waypointA && waypointB
            ? `Transit needs ends over ${MIN_TRANSIT_DISTANCE_M} m apart`
            : "Transit needs a start and a destination"}
        </p>
      )}

      {/* Saved routes — reachable without reopening the planning form. Its
          divider (inside SavedRoutesSection) is rule-strong: saved trips
          and this trip's planning controls are different kinds of content, and
          spacing alone doesn't group them (law of proximity, U4). */}
      {savedRoutes && savedRoutes.length > 0 && savedFolders && onLoadRoute && onDeleteSavedRoute && onRenameSavedRoute && (
        <SavedRoutesSection
          routes={savedRoutes}
          folders={savedFolders}
          onLoad={onLoadRoute}
          onDelete={onDeleteSavedRoute}
          onRename={onRenameSavedRoute}
        />
      )}

      {/* Rain objective — walk pricing only; transit cards keep their sun model.
          Lives outside the planning form so the objective stays flippable after
          the form collapses to the trip bar (the map-column toggle is desktop-only). */}
      {onRainModeChange && (
        <Segmented
          label="Route objective"
          data-testid="rain-mode-selector"
          className="self-start"
          value={rainMode ? "rain" : "sun"}
          onChange={(objective) => onRainModeChange(objective === "rain")}
          options={[
            { value: "sun", label: "Sun", title: "Route by sun exposure" },
            { value: "rain", label: "Rain", title: "Route using rain shelter" },
          ]}
        />
      )}

      {/* Planning form — collapses to the trip bar once options exist, so the
          route stack starts inside the sheet's first snap point. */}
      {showForm ? (
        <>
      {rainMode && onWindSourceChange && (
        <div className="flex flex-col gap-2 self-start rounded-sm border-2 p-2 text-[11px]" style={{ borderColor: "var(--color-rule)" }}>
          <div className="font-semibold" style={{ color: "var(--color-ink)" }}>Rain conditions</div>
          <Segmented
            label="Wind source"
            value={windSource}
            onChange={(source) => onWindSourceChange(source)}
            options={[
              { value: "forecast", label: "Forecast wind" },
              { value: "manual", label: "Manual wind" },
            ]}
          />
          {windSource === "manual" && onManualWindChange && (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1">
                From °
                <input
                  type="number"
                  min={0}
                  max={360}
                  step={1}
                  value={manualWind.directionDeg}
                  onChange={(event) => onManualWindChange({ directionDeg: Number(event.target.value) })}
                  className="min-h-11 w-16 rounded-sm border-2 px-1"
                  aria-label="Wind from bearing in degrees"
                />
              </label>
              <label className="flex items-center gap-1">
                m/s
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={manualWind.speedMps}
                  onChange={(event) => onManualWindChange({ speedMps: Number(event.target.value) })}
                  className="min-h-11 w-16 rounded-sm border-2 px-1"
                  aria-label="Wind speed in metres per second"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {/* Active-travel selector (E1/E4) — only for walk routing; transit legs stay pedestrian */}
      {routeMode === 'walk' && onTravelModeChange && (
        <Segmented
          label="Travel mode"
          data-testid="travel-mode-selector"
          className="self-start"
          value={travelMode}
          onChange={(mode) => onTravelModeChange(mode)}
          options={(Object.keys(TRAVEL_MODE_POLICIES) as TravelModeId[]).map((mode) => ({
            value: mode,
            label: TRAVEL_MODE_POLICIES[mode].label,
            ariaLabel: mode === 'scoot' ? 'Scoot: kick scooter or skateboard, not electric' : undefined,
            title: mode === 'walk' ? undefined : mode === 'bike' ? 'Avoids stairs and rough surfaces, prefers cycleways' : 'Avoids steps and rough surfaces — for scooters and skateboards',
          }))}
        />
      )}

      {/* Waypoint inputs */}
      <div
        className="rounded-sm border-2 p-3 flex flex-col gap-1"
        style={{ background: "var(--color-ground)", borderColor: "var(--color-rule)" }}
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-panel"
            style={{ color: pendingSlot === 'A' ? "var(--color-route)" : "var(--color-ink-muted)" }}
            title="Place start waypoint on map"
          >
            <span className="material-symbols-outlined text-base">add_location</span>
          </button>
        </div>

        {/* Swap button */}
        <div className="flex justify-center">
          <button type="button"
            onClick={onSwapWaypoints}
            className="flex h-11 w-11 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-panel hover:text-ink"
            title="Swap waypoints"
            aria-label="Swap start and destination"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden="true">swap_vert</span>
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
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-panel disabled:cursor-not-allowed"
            style={{ color: pendingSlot === 'B' ? "var(--color-route)" : "var(--color-ink-muted)" }}
            title="Place destination waypoint on map"
          >
            <span className="material-symbols-outlined text-base">add_location</span>
          </button>
        </div>
      </div>

      {/* Additional waypoints */}
      {(additionalWaypoints ?? []).length > 0 || addingStop ? (
        <div className="pl-4 flex flex-col gap-1 text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ opacity: 0.6 }}>Stops between start and destination</span>
            {!addingStop && onAddAdditionalWaypoint && (
              <button type="button"
                onClick={() => setAddingStop(true)}
                className="min-h-11 px-2 text-[11px] font-medium hover:text-ink transition-colors"
                style={{ color: "var(--color-ink-muted)" }}
              >
                Add stop
              </button>
            )}
          </div>
          {(additionalWaypoints ?? []).map((wp, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full text-on-ink text-[11px] flex items-center justify-center shrink-0" style={{ background: "var(--color-ink)" }}>{i + 1}</span>
              <span className="flex-1 tabular-nums truncate" style={{ color: "var(--color-ink)" }}>{wp[1].toFixed(5)}, {wp[0].toFixed(5)}</span>
              <button type="button"
                onClick={() => onRemoveAdditionalWaypoint?.(i)}
                className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-muted hover:text-danger transition-colors"
                aria-label={`Remove stop ${i + 1}`}
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">close</span>
              </button>
            </div>
          ))}
          {addingStop && onAddAdditionalWaypoint && (
            <div className="mt-1 rounded-sm border-2 px-2 py-1" style={{ borderColor: "var(--color-rule)" }}>
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
          className="ml-2 min-h-11 self-start flex items-center gap-1 px-2 text-[11px] font-medium hover:text-ink transition-colors"
          style={{ color: "var(--color-ink-muted)" }}
        >
          <span className="material-symbols-outlined text-sm" aria-hidden="true">add_location</span>
          Add stop
        </button>
      ) : null}

      {/* Route input — Search / Draw segmented control */}
      <div className="border-t pt-2" style={{ borderColor: "var(--color-rule)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Route input</span>
          <Segmented
            label="Route input"
            value={drawMode ? "draw" : "search"}
            onChange={(input) => { if ((input === "draw") !== drawMode) onDrawModeToggle?.(); }}
            options={[
              { value: "search", label: "Search" },
              { value: "draw", label: "Draw" },
            ]}
          />
        </div>
        {drawMode && (
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
              {sketchPointCount > 0 ? (
                <span className="tabular-nums" style={{ color: "var(--color-route)" }}>
                  {sketchPointCount} point{sketchPointCount !== 1 ? "s" : ""} drawn
                </span>
              ) : (
                "Tap map to sketch route"
              )}
            </p>
            {sketchPointCount > 0 && onClearSketch && (
              <button type="button"
                onClick={onClearSketch}
                className="min-h-11 px-2 text-[11px] transition-colors hover:text-ink"
                style={{ color: "var(--color-ink-muted)" }}
              >
                Clear sketch
              </button>
            )}
          </div>
        )}
      </div>

      {/* Objective preference slider */}
      <div className="border-t pt-2" style={{ borderColor: "var(--color-rule)" }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>{rainMode ? "Shelter preference" : "Shadow preference"}</span>
          <span className="text-[11px] font-medium" style={{ color: "var(--color-ink)" }}>{preferenceLabel}</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={shadowPreference}
          onChange={(e) => onShadowPreferenceChange?.(parseFloat(e.target.value))}
          aria-label={rainMode ? "Shelter preference" : "Shadow preference"}
          aria-valuetext={preferenceLabel}
          className="h-11 w-full cursor-pointer accent-ink"
        />
        <div className="flex justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Fastest</span>
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>{rainMode ? "Most sheltered" : "Most shadowed"}</span>
        </div>
      </div>

      {/* Calculate button */}
      <div className="flex gap-2 shrink-0">
        <button type="button"
          onClick={() => { setEditing(false); onCalculate(); }}
          disabled={drawMode ? sketchPointCount < 2 || isCalculating : !waypointA || !waypointB || isCalculating}
          className="umbra-start-button gap-1 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isCalculating && (
            <svg aria-hidden="true" focusable="false" className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          )}
          {isCalculating ? 'Calculating...' : rainMode ? 'Find Sheltered Route' : 'Find Shadowed Route'}
        </button>
      </div>
        </>
      ) : null}
      {isCalculating && routeProgress && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-sm border-2 px-3 py-2 text-[11px]"
          style={{
            background: "var(--color-ground)",
            borderColor: "var(--color-rule)",
            color: "var(--color-ink-muted)",
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
              style={{ background: "color-mix(in srgb, var(--color-ink) 16%, transparent)" }}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${progressPercent}%`, background: "var(--color-route)" }}
              />
            </div>
          )}
        </div>
      )}

      {/* Route cards — hidden on desktop when FloatingRouteCards is used. The
          selected card carries the conditions/dose detail block itself. The
          partial/failed notice rides above the weakest viable card once the
          stack passes three options (serial position): trailing the stack
          puts it at end-position, where memory favours the weakest option. */}
      {!hideRouteCards && routes.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: "var(--color-rule)" }}>
          {!rainMode && solarIntensity != null && <SolarPill intensity={solarIntensity} />}
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
                />
              </Fragment>
            ))}
          </div>

          {onStartNavigation && routes.length > 0 && !selectedRoute?.partial && (
            <button type="button" onClick={onStartNavigation} className="umbra-start-button mt-2">
              START NAVIGATING
            </button>
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

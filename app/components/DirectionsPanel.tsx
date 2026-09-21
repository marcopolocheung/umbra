import { Fragment, useState } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import type { TravelModeId } from "../lib/travelMode";
import { TRAVEL_MODE_POLICIES } from "../lib/travelMode";
import type { RouteCalculationProgress } from "../lib/routeProgress";
import { routeProgressCount, routeProgressPercent } from "../lib/routeProgress";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { shortestRoute } from "../lib/routeTradeoff";
import WaypointInput from "./WaypointInput";
import RouteCard from "./RouteCard";
import SolarPill from "./SolarPill";
import type { ReactNode } from "react";
import SavedRoutesSection from "./SavedRoutesSection";

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
      className="flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 transition-colors hover:bg-canvas"
      style={{ background: "var(--color-canvas)", borderColor: "var(--color-hairline)" }}
    >
      <span className="material-symbols-outlined shrink-0 text-base text-ink-muted" aria-hidden="true">route</span>
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--color-ink)" }}>
        {from} <span className="text-ink-faint">→</span> {to}
      </span>
      <span className="material-symbols-outlined shrink-0 text-base text-route" aria-hidden="true">edit</span>
    </button>
  );
}

/**
 * The partial/failed-route notice, as a pill riding inside the card stack.
 * Sun-strong ink on sun-soft: a caveat about the data, not chrome.
 */
function NoticePill({ text }: { text: string }) {
  return (
    <div
      className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium"
      style={{ background: "var(--color-sun-soft)", color: "var(--color-sun-strong)" }}
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
  /** 0–10 intensity setting that scales wet-minute figures only. */
  rainIntensity?: number;
  onRainIntensityChange?: (v: number) => void;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
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
  rainMode = false, onRainModeChange,
  rainIntensity = 5, onRainIntensityChange,
  rainWind = null,
}: DirectionsPanelProps) {
  const shadowLabel = shadowPreference < 0.33 ? "Fastest" : shadowPreference > 0.66 ? "Most shadowed" : "Balanced";
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <button type="button"
          onClick={onBack}
          className="flex items-center justify-center w-7 h-7 rounded-full transition-colors hover:bg-canvas"
          style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
          title="Back"
        >
          <span className="material-symbols-outlined text-base">arrow_back</span>
        </button>
        <h2 className="text-[13px] font-medium" style={{ color: "var(--color-ink)" }}>Directions</h2>
        {/* Walk / Transit tabs — segmented controls carry 44px rows (U4): the
            buttons may stay narrow, but their height is a thumb target. */}
        <div
          className="flex rounded-lg overflow-hidden border"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          {(['walk', 'transit'] as const).map((mode) => (
            <button type="button"
              key={mode}
              onClick={() => onRouteModeChange?.(mode)}
              disabled={mode === 'transit' && !canTransit}
              aria-pressed={routeMode === mode}
              className={`flex min-h-11 items-center px-2.5 text-[11px] font-medium transition-colors ${
                routeMode === mode
                  ? 'text-ink bg-canvas'
                  : 'hover:bg-canvas'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
              style={routeMode !== mode ? { color: "var(--color-ink-muted)" } : undefined}
              title={mode === 'transit' && !canTransit ? 'Too close for transit' : undefined}
            >
              {mode === 'walk' ? 'Walk' : 'Transit'}
            </button>
          ))}
        </div>
      </div>

      {/* Saved routes — reachable without reopening the planning form. Its
          divider (inside SavedRoutesSection) is hairline-strong: saved trips
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

      {/* Planning form — collapses to the trip bar once options exist, so the
          route stack starts inside the sheet's first snap point. */}
      {showForm ? (
        <>
      {/* Rain objective — walk pricing only; transit cards keep their sun model */}
      {onRainModeChange && (
        <div
          className="flex rounded-lg overflow-hidden border self-start"
          style={{ borderColor: "var(--color-hairline)" }}
          data-testid="rain-mode-selector"
        >
          {([false, true] as const).map((rain) => (
            <button type="button"
              key={rain ? "rain" : "sun"}
              onClick={() => onRainModeChange(rain)}
              aria-pressed={rainMode === rain}
              className={`flex min-h-11 items-center px-2.5 text-[11px] font-medium transition-colors ${
                rainMode === rain ? 'text-route bg-route-soft' : 'hover:bg-canvas'
              }`}
              style={rainMode !== rain ? { color: "var(--color-ink-muted)" } : undefined}
              title={rain ? 'Route away from rain (experimental)' : 'Route by sun exposure'}
            >
              {rain ? 'Rain' : 'Sun'}
            </button>
          ))}
        </div>
      )}
      {rainMode && onRainIntensityChange && (
        <label className="flex items-center gap-2 self-start text-[10px]" style={{ color: "var(--color-ink-muted)" }}>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={rainIntensity}
            onChange={(e) => onRainIntensityChange(Number(e.target.value))}
            aria-label="Rain intensity 0 to 10"
            className="w-32"
          />
          <span>Rain {rainIntensity}/10</span>
        </label>
      )}

      {/* Active-travel selector (E1/E4) — only for walk routing; transit legs stay pedestrian */}
      {routeMode === 'walk' && onTravelModeChange && (
        <div
          className="flex rounded-lg overflow-hidden border self-start"
          style={{ borderColor: "var(--color-hairline)" }}
          data-testid="travel-mode-selector"
        >
          {(Object.keys(TRAVEL_MODE_POLICIES) as TravelModeId[]).map((mode) => (
            <button type="button"
              key={mode}
              onClick={() => onTravelModeChange(mode)}
              aria-pressed={travelMode === mode}
              aria-label={mode === 'scoot' ? 'Scoot: kick scooter or skateboard, not electric' : undefined}
              className={`flex min-h-11 items-center px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors ${
                travelMode === mode
                  ? 'text-ink bg-canvas'
                  : 'hover:bg-canvas'
              }`}
              style={travelMode !== mode ? { color: "var(--color-ink-muted)" } : undefined}
              title={mode === 'walk' ? undefined : mode === 'bike' ? 'Avoids stairs and rough surfaces, prefers cycleways' : 'Avoids steps and rough surfaces — for scooters and skateboards'}
            >
              {TRAVEL_MODE_POLICIES[mode].label}
            </button>
          ))}
        </div>
      )}

      {/* Waypoint inputs */}
      <div
        className="rounded-xl p-4 flex flex-col gap-2"
        style={{ background: "var(--color-canvas)" }}
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
            className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-canvas"
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
            className="text-ink-faint hover:text-ink transition-colors p-1 hover:bg-canvas rounded-lg"
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
            className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-canvas disabled:cursor-not-allowed"
            style={{ color: pendingSlot === 'B' ? "var(--color-route)" : "var(--color-ink-muted)" }}
            title="Place destination waypoint on map"
          >
            <span className="material-symbols-outlined text-base">add_location</span>
          </button>
        </div>
      </div>

      {/* Additional waypoints */}
      {(additionalWaypoints ?? []).length > 0 || addingStop ? (
        <div className="pl-4 flex flex-col gap-1 text-[10px]" style={{ color: "var(--color-ink-muted)" }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ opacity: 0.6 }}>Stops between start and destination</span>
            {!addingStop && onAddAdditionalWaypoint && (
              <button type="button"
                onClick={() => setAddingStop(true)}
                className="text-[10px] font-medium hover:text-ink transition-colors"
                style={{ color: "var(--color-ink-muted)" }}
              >
                Add stop
              </button>
            )}
          </div>
          {(additionalWaypoints ?? []).map((wp, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="w-4 h-4 rounded-full text-on-ink text-[9px] flex items-center justify-center shrink-0" style={{ background: "var(--color-ink)" }}>{i + 1}</span>
              <span className="flex-1 tabular-nums truncate" style={{ color: "var(--color-ink)" }}>{wp[1].toFixed(5)}, {wp[0].toFixed(5)}</span>
              <button type="button"
                onClick={() => onRemoveAdditionalWaypoint?.(i)}
                className="text-ink-faint hover:text-danger transition-colors px-0.5"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
          ))}
          {addingStop && onAddAdditionalWaypoint && (
            <div className="mt-1 rounded-lg border px-2 py-1" style={{ borderColor: "var(--color-hairline)" }}>
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
          className="ml-4 self-start flex items-center gap-1 text-[11px] font-medium hover:text-ink transition-colors"
          style={{ color: "var(--color-ink-muted)" }}
        >
          <span className="material-symbols-outlined text-sm">add_location</span>
          Add stop
        </button>
      ) : null}

      {/* Route input — Search / Draw segmented control */}
      <div className="border-t pt-2" style={{ borderColor: "var(--color-hairline)" }}>
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Route input</span>
          <div
            className="flex rounded-lg overflow-hidden border"
            style={{ borderColor: "var(--color-hairline)" }}
          >
            <button type="button"
              onClick={() => drawMode && onDrawModeToggle?.()}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                !drawMode ? 'text-ink bg-canvas' : 'hover:bg-canvas'
              }`}
              style={drawMode ? { color: "var(--color-ink-muted)" } : undefined}
            >
              Search
            </button>
            <button type="button"
              onClick={() => !drawMode && onDrawModeToggle?.()}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                drawMode ? 'text-ink bg-canvas' : 'hover:bg-canvas'
              }`}
              style={!drawMode ? { color: "var(--color-ink-muted)" } : undefined}
            >
              Draw
            </button>
          </div>
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
                className="text-[11px] transition-colors hover:text-ink"
                style={{ color: "var(--color-ink-muted)" }}
              >
                Clear sketch
              </button>
            )}
          </div>
        )}
      </div>

      {/* Shadow preference slider */}
      <div className="border-t pt-2" style={{ borderColor: "var(--color-hairline)" }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Shadow preference</span>
          <span className="text-[11px] font-medium" style={{ color: "var(--color-ink)" }}>{shadowLabel}</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={shadowPreference}
          onChange={(e) => onShadowPreferenceChange?.(parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-ink"
          style={{ background: "var(--color-canvas)" }}
        />
        <div className="flex justify-between mt-1">
          <span className="text-[10px]" style={{ color: "var(--color-ink-muted)" }}>Fastest</span>
          <span className="text-[10px]" style={{ color: "var(--color-ink-muted)" }}>Most shadowed</span>
        </div>
      </div>

      {/* Calculate button */}
      <div className="flex gap-2 shrink-0">
        <button type="button"
          onClick={() => { setEditing(false); onCalculate(); }}
          disabled={drawMode ? sketchPointCount < 2 || isCalculating : !waypointA || !waypointB || isCalculating}
          className="flex-1 px-2 py-2 rounded-lg text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
          style={{ background: "var(--color-route)", color: "var(--color-on-route)" }}
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
        </>
      ) : null}
      {isCalculating && routeProgress && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border px-3 py-2 text-[11px]"
          style={{
            background: "var(--color-canvas)",
            borderColor: "var(--color-hairline)",
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
        <div className="flex flex-col gap-1.5 border-t pt-2" style={{ borderColor: "var(--color-hairline)" }}>
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
                  rainIntensity={rainIntensity}
                  rainWind={rainWind}
                  weather={weather}
                  exposureSlot={i === selectedRouteIndex ? exposureSlot : undefined}
                />
              </Fragment>
            ))}
          </div>

          {onStartNavigation && routes.length > 0 && !selectedRoute?.partial && (
            <button type="button"
              onClick={onStartNavigation}
              className="mt-2 w-full min-h-11 px-3 py-2.5 rounded-lg text-sm font-bold transition-colors"
              style={{ background: "var(--color-shade)", color: "var(--color-on-shade)" }}
            >
              START NAVIGATING
            </button>
          )}
        </div>
      )}

      {/* Warning with no route stack to ride in (and errors) stays at the
          panel's foot — there is no weaker card to anchor it to. */}
      {warning && routes.length === 0 && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "var(--color-sun-strong)", borderColor: "var(--color-hairline)" }}>
          {warning}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-xs border-t pt-2 shrink-0" style={{ color: "var(--color-danger)", borderColor: "var(--color-hairline)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

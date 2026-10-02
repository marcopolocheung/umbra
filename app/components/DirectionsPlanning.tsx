import { useEffect, useId, useRef, useState } from "react";
import type { TravelModeId } from "../lib/travelMode";
import type { ManualWind, WindSource } from "../lib/exposure";
import type { WeatherHour } from "../lib/heat/types";
import { MIN_TRANSIT_DISTANCE_M } from "../lib/trainGraph";
import { formatTime12h } from "../hooks/useShadowTime";
import WaypointInput from "./WaypointInput";
import DirectionsConditions from "./DirectionsConditions";
import Segmented from "./ui/Segmented";
import "./directions.css";

export interface DirectionsPlanningProps {
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onSetWaypointA: (coord: [number, number], label: string) => void;
  onSetWaypointB: (coord: [number, number], label: string) => void;
  onSwapWaypoints: () => void;
  onClearWaypointA: () => void;
  onClearWaypointB: () => void;
  pendingSlot: "A" | "B" | null;
  onSetPendingSlot: (slot: "A" | "B" | null) => void;
  onPinDragStart?: (slot: "A" | "B") => void;
  additionalWaypoints?: [number, number][];
  onAddAdditionalWaypoint?: (coord: [number, number], label: string) => void;
  onRemoveAdditionalWaypoint?: (index: number) => void;
  drawMode: boolean;
  onDrawModeToggle?: () => void;
  onClearSketch?: () => void;
  sketchPointCount: number;
  routeMode: "walk" | "transit";
  onRouteModeChange?: (mode: "walk" | "transit") => void;
  canTransit: boolean;
  travelMode: TravelModeId;
  onTravelModeChange?: (mode: TravelModeId) => void;
  shadowPreference: number;
  onShadowPreferenceChange?: (value: number) => void;
  rainMode: boolean;
  onRainModeChange?: (rain: boolean) => void;
  windSource: WindSource;
  manualWind: ManualWind;
  onWindSourceChange?: (source: WindSource) => void;
  onManualWindChange?: (wind: Partial<ManualWind>) => void;
  onCalculate: () => void;
  isCalculating: boolean;
  onBack: () => void;
  selectedTime: Date;
  mapUtcOffsetMin: number;
  solarPosition: { altitudeDeg: number; azimuthDeg: number } | null;
  sunset: Date | null;
  weather: WeatherHour | null;
  onOpenTimeline: () => void;
}

const modes = [
  { id: "walk", label: "Walk", icon: "directions_walk" },
  { id: "bike", label: "Bike", icon: "directions_bike" },
  { id: "scoot", label: "Scoot", icon: "skateboarding" },
  { id: "transit", label: "Transit", icon: "train" },
] as const;

function StopPin({ pressed }: { pressed: boolean }) {
  return <span className="directions-stop-pin" aria-hidden="true" data-pressed={pressed}><i className="directions-stop-ring" /><i className="directions-stop-shadow" /></span>;
}

export function DirectionsObjective({ rainMode, onRainModeChange }: { rainMode: boolean; onRainModeChange?: (rain: boolean) => void }) {
  return <div className="directions-objective" data-directions-section="Dodge">
    <span className="directions-label">Dodge</span>
    <fieldset className="directions-tags"><legend className="sr-only">Dodge</legend>
      <button type="button" className="directions-tag" data-kind="sun" aria-pressed={!rainMode} onClick={() => onRainModeChange?.(false)}><span className="material-symbols-outlined" aria-hidden="true">sunny</span>Sun</button>
      <button type="button" className="directions-tag" data-kind="rain" aria-pressed={rainMode} onClick={() => onRainModeChange?.(true)}><span className="material-symbols-outlined" aria-hidden="true">rainy</span>Rain</button>
    </fieldset>
  </div>;
}

export default function DirectionsPlanning(props: DirectionsPlanningProps) {
  const {
    waypointA, waypointB, waypointALabel, waypointBLabel, onSetWaypointA, onSetWaypointB,
    onSwapWaypoints, onClearWaypointA, onClearWaypointB, pendingSlot, onSetPendingSlot,
    onPinDragStart, additionalWaypoints, onAddAdditionalWaypoint, onRemoveAdditionalWaypoint,
    drawMode, onDrawModeToggle, onClearSketch, sketchPointCount, routeMode, onRouteModeChange,
    canTransit, travelMode, onTravelModeChange, shadowPreference, onShadowPreferenceChange,
    rainMode, onRainModeChange, windSource, manualWind, onWindSourceChange, onManualWindChange,
    onCalculate, isCalculating, onBack,
    selectedTime, mapUtcOffsetMin, solarPosition, sunset, weather, onOpenTimeline,
  } = props;
  const [addingStop, setAddingStop] = useState(false);
  const [misting, setMisting] = useState(false);
  const [sketchSubmission, setSketchSubmission] = useState(false);
  const wasCalculating = useRef(false);
  const filterId = useId().replaceAll(":", "");
  const ready = sketchSubmission || (drawMode ? sketchPointCount >= 2 : Boolean(waypointA && waypointB));
  const filled = Boolean(waypointB) && !drawMode;
  const preferenceLabel = shadowPreference < 0.33 ? "Fastest" : shadowPreference > 0.66 ? "Most shade" : "Balanced";
  const selectedMode = routeMode === "transit" ? "transit" : travelMode;
  const transitOffReason = waypointA && waypointB
    ? `Transit needs ends over ${MIN_TRANSIT_DISTANCE_M} m apart in a straight line`
    : "Transit needs a start and a destination";

  useEffect(() => {
    if (wasCalculating.current && !isCalculating) setSketchSubmission(false);
    wasCalculating.current = isCalculating;
  }, [isCalculating]);

  useEffect(() => {
    if (!ready) { setMisting(false); return; }
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (motion?.matches) { setMisting(false); return; }
    const stopForReducedMotion = () => { if (motion?.matches) setMisting(false); };
    motion?.addEventListener("change", stopForReducedMotion);
    const start = window.setTimeout(() => setMisting(true), drawMode ? 0 : 950);
    const stop = window.setTimeout(() => setMisting(false), drawMode ? 1200 : 2150);
    return () => { window.clearTimeout(start); window.clearTimeout(stop); motion?.removeEventListener("change", stopForReducedMotion); };
  }, [ready, drawMode]);

  function toggleSlot(slot: "A" | "B") {
    if (slot === "B" && drawMode) return;
    onSetPendingSlot(pendingSlot === slot ? null : slot);
  }

  return <div className="directions-planning" data-objective={rainMode ? "rain" : "sun"} data-filled={filled} data-ready={ready} data-sketch={drawMode}>
    <svg key={ready ? "ready" : "idle"} width="0" height="0" className="directions-filter" aria-hidden="true">
      <filter id={filterId}><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="2"><animate attributeName="scale" values="18;0" begin={drawMode ? "0s" : "0.95s"} dur="1.2s" fill="freeze" /></feDisplacementMap>
      </filter>
    </svg>
    <div className="directions-head" data-directions-section="Start">
      <button type="button" className="directions-back" aria-label="Back to map" onClick={onBack}>
        <svg viewBox="0 0 28 20" aria-hidden="true"><path fill="currentColor" d="M1.5 10 L11.6 1.2 L13.6 3.2 L9.6 7.7 L21.8 7.3 L26.6 4.4 L25 10 L26.6 15.6 L21.8 12.7 L9.6 12.3 L13.6 16.8 L11.6 18.8 Z" /></svg>Back
      </button>
      <button key={selectedTime.getTime()} type="button" className="directions-stamp" aria-label={`Leaves at ${formatTime12h(selectedTime, mapUtcOffsetMin)}. Change time`} onClick={onOpenTimeline}><span className="material-symbols-outlined" aria-hidden="true">schedule</span>Leaves {formatTime12h(selectedTime, mapUtcOffsetMin)}</button>
    </div>
    <div className="directions-titles">
      <span className="directions-kicker">{rainMode ? "Plan a walk" : "Plan a walk on"}</span>
      <h2>{rainMode ? "under cover" : "the shady side"}</h2>
    </div>
    <DirectionsObjective rainMode={rainMode} onRainModeChange={onRainModeChange} />
    <div className="directions-trip" data-directions-section="Trip">
      <div className="directions-stop">
        <span className="directions-node directions-node-start" aria-hidden="true" />
        <WaypointInput label={waypointALabel} placeholder="Choose a start" dotColor="green" variant="strip" fieldLabel="From" onSet={onSetWaypointA} onClear={onClearWaypointA} />
        <button type="button" className="directions-pin-button" aria-label="Place start on map" aria-pressed={pendingSlot === "A"} onPointerDown={() => onPinDragStart?.("A")} onClick={() => toggleSlot("A")}><StopPin pressed={pendingSlot === "A"} /></button>
      </div>
      <div className="directions-mid">
        <button type="button" className="directions-swap" aria-label="Swap start and destination" onClick={onSwapWaypoints}><span className="material-symbols-outlined" aria-hidden="true">swap_vert</span></button>
        {onAddAdditionalWaypoint && <button type="button" className="directions-add" onClick={() => setAddingStop(true)}><span className="material-symbols-outlined" aria-hidden="true">add</span>Add a stop</button>}
      </div>
      <div className="directions-stop">
        <span className="directions-node directions-node-end" aria-hidden="true" />
        <WaypointInput label={waypointBLabel} placeholder={drawMode ? "Tap map to sketch route" : "Choose a destination"} dotColor="red" variant="strip" fieldLabel="To" onSet={onSetWaypointB} onClear={onClearWaypointB} />
        <button type="button" className="directions-pin-button" aria-label="Place destination on map" aria-pressed={pendingSlot === "B"} disabled={drawMode} onPointerDown={() => !drawMode && onPinDragStart?.("B")} onClick={() => toggleSlot("B")}><StopPin pressed={pendingSlot === "B"} /></button>
      </div>
      {((additionalWaypoints?.length ?? 0) > 0 || addingStop) && <div className="directions-extra-stops">
        {additionalWaypoints?.map((point, index) => <div key={`${point[0]}:${point[1]}:${index}`} className="directions-extra-stop"><span>Stop {index + 1}: {point[1].toFixed(5)}, {point[0].toFixed(5)}</span><button type="button" aria-label={`Remove stop ${index + 1}`} onClick={() => onRemoveAdditionalWaypoint?.(index)}>×</button></div>)}
        {addingStop && <WaypointInput label={null} placeholder="Stop — type an address or place" dotColor="amber" variant="strip" onSet={(coord, label) => { onAddAdditionalWaypoint?.(coord, label); setAddingStop(false); }} onClear={() => setAddingStop(false)} />}
      </div>}
    </div>
    <button type="button" className="directions-draw" aria-pressed={drawMode} onClick={onDrawModeToggle}><span className="material-symbols-outlined" aria-hidden="true">gesture</span>{drawMode ? "Use searched stops" : "Or draw the route on the map"}</button>
    {drawMode && <div className="directions-sketch-count"><span>{sketchPointCount} point{sketchPointCount === 1 ? "" : "s"} drawn</span>{sketchPointCount > 0 && onClearSketch && <button type="button" onClick={onClearSketch}>Clear sketch</button>}</div>}
    <div className="directions-modes" data-directions-section="Travel by">
      <span className="directions-label">Travel by</span>
      <fieldset className="directions-bullets"><legend className="sr-only">Travel by</legend>
        {modes.map((mode) => <button key={mode.id} type="button" className="directions-bullet" aria-label={mode.label} aria-pressed={selectedMode === mode.id} disabled={mode.id === "transit" && !canTransit} title={mode.id === "transit" && !canTransit ? transitOffReason : undefined} onClick={() => {
          if (mode.id === "transit") onRouteModeChange?.("transit");
          else { onRouteModeChange?.("walk"); onTravelModeChange?.(mode.id); }
        }}><span className="directions-bullet-icon"><span className="material-symbols-outlined" aria-hidden="true">{mode.icon}</span></span><span className="directions-bullet-name">{mode.label}</span></button>)}
      </fieldset>
      {!canTransit && <p className="directions-transit-reason">{transitOffReason}</p>}
    </div>
    <div className="directions-preference" data-directions-section="Shade or speed">
      <div className="directions-preference-head"><label className="directions-label" htmlFor={`${filterId}-preference`}>Shade or speed</label><output className="directions-preference-value" htmlFor={`${filterId}-preference`}>{preferenceLabel}</output></div>
      <input id={`${filterId}-preference`} type="range" min="0" max="1" step="0.01" value={shadowPreference} onChange={(event) => onShadowPreferenceChange?.(Number(event.target.value))} aria-valuetext={preferenceLabel} />
      <div className="directions-preference-ends"><span className="directions-label">Fastest</span><span className="directions-label">Most shade</span></div>
    </div>
    {rainMode && onWindSourceChange && <div className="directions-wind-settings">
      <Segmented label="Wind source" value={windSource} onChange={onWindSourceChange} options={[{ value: "forecast", label: "Forecast wind" }, { value: "manual", label: "Manual wind" }]} />
      {windSource === "manual" && onManualWindChange && <div><label>From ° <input type="number" min={0} max={360} value={manualWind.directionDeg} onChange={(event) => onManualWindChange({ directionDeg: Number(event.target.value) })} /></label><label>m/s <input type="number" min={0} step={0.1} value={manualWind.speedMps} onChange={(event) => onManualWindChange({ speedMps: Number(event.target.value) })} /></label></div>}
    </div>}
    <DirectionsConditions selectedTime={selectedTime} mapUtcOffsetMin={mapUtcOffsetMin} solarPosition={solarPosition} sunset={sunset} weather={weather} />
    {ready && <div className="directions-dock" data-directions-section="Find">
      <div className="directions-blur" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="directions-stage" style={misting ? { filter: `url(#${filterId})` } : undefined}>
        <span className="directions-puff" aria-hidden="true" />
        <div className="directions-cta-wrap"><button type="button" className="directions-cta" onClick={() => { if (drawMode) setSketchSubmission(true); onCalculate(); }} disabled={isCalculating} aria-busy={isCalculating}>
          {isCalculating ? "Calculating…" : rainMode ? "Find shelter" : "Find the shade"}<span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </button></div>
      </div>
    </div>}
  </div>;
}

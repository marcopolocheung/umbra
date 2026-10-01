import SunCalc from "suncalc";
import { fromMapLocal } from "./timezone";

/** Minutes between samples of the timeline's sun path. */
export const SUN_PATH_STEP_MIN = 10;

/**
 * The sun's altitude in degrees across the map-local day containing `date`: one
 * sample every `SUN_PATH_STEP_MIN` minutes from local midnight through the next
 * midnight inclusive (145 samples). This is the SunCalc model behind the theme's
 * 0° rule (`uiTheme.solarTheme`) and the shadow layer, so the timeline's sun
 * path, its night bands and the app theme agree about when the sun is up.
 */
export function sunAltitudeTrace(
  date: Date,
  latDeg: number,
  lngDeg: number,
  utcOffsetMin: number,
): number[] {
  const midnight = fromMapLocal(date, utcOffsetMin, 0, 0).getTime();
  const out: number[] = [];
  for (let m = 0; m <= 1440; m += SUN_PATH_STEP_MIN) {
    const { altitude } = SunCalc.getPosition(new Date(midnight + m * 60000), latDeg, lngDeg);
    out.push((altitude * 180) / Math.PI);
  }
  return out;
}

/** Altitude at a map-local minute, linearly interpolated between samples. */
export function altitudeAt(trace: number[], minutes: number): number {
  const i = Math.max(0, Math.min(trace.length - 1, minutes / SUN_PATH_STEP_MIN));
  const lo = Math.floor(i);
  const hi = Math.min(trace.length - 1, lo + 1);
  return trace[lo] + (trace[hi] - trace[lo]) * (i - lo);
}

/**
 * The stretches of the day with the sun at or below the horizon, as
 * [start, end] map-local minutes. Edges are interpolated zero crossings, so a
 * polar night is one span over the whole day and a polar day has none.
 */
export function nightSpans(trace: number[]): [number, number][] {
  const spans: [number, number][] = [];
  let start: number | null = trace[0] <= 0 ? 0 : null;
  for (let k = 1; k < trace.length; k++) {
    const a = trace[k - 1];
    const b = trace[k];
    if ((a > 0) === (b > 0)) continue;
    const crossing = (k - 1 + a / (a - b)) * SUN_PATH_STEP_MIN;
    if (b <= 0) start = crossing;
    else if (start !== null) {
      spans.push([start, crossing]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, (trace.length - 1) * SUN_PATH_STEP_MIN]);
  return spans;
}

/**
 * The direction raindrops arrive from, as the ray a shelter query walks backward.
 *
 * Rain hits the ground along a slanted path: wind drives the drop sideways while
 * terminal velocity pulls it down. Running that vector backward from a point gives
 * the direction geometry must occupy to keep the point dry — the exact role the sun
 * azimuth/altitude pair plays for shadow, which is what lets the rain sampler reuse
 * `shadowIndex` unchanged.
 *
 * Conventions, all of them deliberate:
 * - `fromDeg` is the meteorologically conventional **wind-from** bearing, the same
 *   angle Open-Meteo's `wind_direction_10m` reports. It is fed to the shadow index
 *   verbatim — the caster shift points *away* from it, i.e. downwind, so the lee
 *   (downwind) side of a wall reads sheltered and the windward side reads wet.
 * - `altitudeDeg` is the ray's elevation above the horizon: 90° is vertical rain.
 * - With zero wind the formula yields the vertical cap, not a discontinuity: the
 *   windless v0 field is the same sampler with `windMs = 0`.
 */

export interface RainDirection {
  /** Meteorological wind-from bearing in degrees. Fed through as the shadow azimuth. */
  fromDeg: number;
  /** Ray elevation in degrees, `atan(windMs / fallSpeed)` converted and clamped. */
  altitudeDeg: number;
  /** The wind speed this direction was derived from, m/s. 0 = vertical rain. */
  windMs: number;
}

/** Terminal fall speed used to tilt the ray, m/s. A documented approximation. */
export const RAIN_FALL_SPEED_MPS = 9;

/**
 * Below this ray elevation the geometry stops being trustworthy at street level:
 * the wind that steepens the ray also channels along the canyon the casters model
 * as solid walls, so very low elevations overreach (same reasoning as the sun's
 * `LOW_SUN_ALTITUDE_RAD` floor, and the confidence dock travellers on top).
 */
export const MIN_RAIN_ALTITUDE_DEG = 10;

/**
 * The near-vertical cap. Exactly 90° breaks the shadow index (`tan(90°)` → ∞).
 * 89.5° shifts a 20 m caster by ~17 cm — under every other error in the model.
 */
export const MAX_RAIN_ALTITUDE_DEG = 89.5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The windless direction: vertical rain, which is v0 of the rain field. */
export function verticalRainDirection(): RainDirection {
  return rainDirectionFromWind(0, 0);
}

/**
 * The reverse-rain-ray direction for a wind report.
 *
 * `windFromDeg` is the FROM bearing (meteorological convention); `windMs` is the
 * sustained speed at the reported height. The tilt is `atan(u / v_terminal)`, which
 * for the constant fall speed means ~27° at 4.5 m/s and ~45° at 9 m/s.
 */
export function rainDirectionFromWind(windFromDeg: number, windMs: number): RainDirection {
  const finiteMs = Number.isFinite(windMs) ? Math.max(0, windMs) : 0;
  // With no wind there is no bearing, and every caller must agree on that: the
  // canonical windless direction is `verticalRainDirection()`.
  const azimuth = finiteMs === 0
    ? 0
    : (((Number.isFinite(windFromDeg) ? windFromDeg : 0) % 360) + 360) % 360;
  // Elevation above the horizon: vertical rain is 90°, and wind tips the ray the
  // rest of the way toward horizontal. The clamps express the stopping points —
  // low (plausibly horizontal) rays overreach canyon physics, and exactly 90° is
  // the tangent singularity in the shadow index.
  const tiltDeg = (Math.atan(finiteMs / RAIN_FALL_SPEED_MPS) * 180) / Math.PI;
  const altitudeDeg = clamp(
    90 - tiltDeg,
    MIN_RAIN_ALTITUDE_DEG,
    MAX_RAIN_ALTITUDE_DEG,
  );
  return { fromDeg: azimuth, altitudeDeg, windMs: finiteMs };
}

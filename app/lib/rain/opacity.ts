/**
 * How much *rain* a prism blocks — a different physical question from how much
 * *light* it blocks, answered from the same crown.
 *
 * `canopy.ts` already derives a light opacity per crown from published beam
 * transmittance (~0.9 in leaf, ~0.3 out). Rain interception is a different process:
 * a leafed crown stops a large share of rainfall at first contact, then drips, and
 * its published throughfall/rainfall-interception values are broad; a bare crown
 * still deflects a little. The numbers below are **priors stated as ranges in
 * `docs/notes/rain-model.md`**, expressed as a single point here so the field can
 * march. Both are deliberately understated — promising dry is the dangerous error.
 *
 * `rainOpacityForLightOpacity` interpolates between the two using the prism's
 * existing light opacity as the proxy for "how much canopy is between sky and
 * walker". That lets the rain sampler reuse the exact canopy prisms the shadow
 * field already holds, seasonality included, rather than re-querying them.
 */

/** Prior canopy rain opacity in full leaf (range documented as 0.2–0.6). */
export const RAIN_OPACITY_LEAF_ON = 0.4;

/** Prior canopy rain opacity out of leaf (range documented as 0.0–0.2). */
export const RAIN_OPACITY_LEAF_OFF = 0.1;

/** Light opacity the canopy module gives a leafed crown (`1 − transmittance 0.1`). */
const LIGHT_OPACITY_LEAF_ON = 0.9;

/** Light opacity out of leaf (`1 − transmittance 0.7`). */
const LIGHT_OPACITY_LEAF_OFF = 0.3;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Rain opacity carried by a prism whose source light opacity is `light`.
 *
 * Buildings (`opacity` absent ⇒ 1 everywhere in the shadow pipeline) are opaque to
 * rain too, so they stay 1. A canopy passes through the ramp; anything the ramp
 * cannot place is clamped rather than guessed.
 */
export function rainOpacityForLightOpacity(light: number | undefined): number {
  if (light === undefined || Number.isNaN(light)) return 1;
  const span = LIGHT_OPACITY_LEAF_ON - LIGHT_OPACITY_LEAF_OFF;
  const t = span > 0
    ? clamp01((light - LIGHT_OPACITY_LEAF_OFF) / span)
    : 0;
  return RAIN_OPACITY_LEAF_OFF + t * (RAIN_OPACITY_LEAF_ON - RAIN_OPACITY_LEAF_OFF);
}

/**
 * Confidence dock applied to a rain answer whose geometry is building walls.
 *
 * The tilt that makes walls relevant also makes the wind change direction between
 * the height it was reported at and the canyon floor — a channeling effect the
 * casters cannot know about. 0.85 says "this answer still stands, but less surely".
 * Canopy-only answers do not pay it: crowns sit above the reclaimed wind layer.
 */
export const RAIN_TILT_WALL_DOCK = 0.85;

/** Docks building-backed rain answers when the ray comes in below this elevation. */
export const RAIN_TILT_DOCK_ALTITUDE_DEG = 70;

/**
 * The per-hazard policy decisions the shared painter passes delegate to.
 *
 * Sun and rain differ in *meaning*, not in machinery: the direction seam
 * (`hazardDirection`) already turns them into one azimuth/altitude/
 * below-horizon triple, exactly as `ShadowField.sampleRainEdges` feeds the
 * shadow index weather-derived rays. What still differed per hazard was which
 * painter passes apply and how a fragment reads the field they share. That is
 * this table, so a pass runs or skips by policy instead of by a hazard
 * ternary sprinkled through `render()`:
 *
 * - `drawsGround`: Pass A coverage fill + Pass D canvas composite. Sun only —
 *   rain's ground picture is the style-rendered wash (`rainMapLayer.ts`).
 * - `erasesRoofs`: Pass C, which erases a caster's own footprint on the
 *   axiom a roof is lit even inside a neighbour's shadow. Inverted for rain:
 *   the footprint is exactly the sheltered ground, so rain never erases.
 * - `surfaceInverts`: Pass E reads the ceiling field as shadow for sun and
 *   as exposure (wet = 1 − shadowed) for rain.
 */

export type HazardMode = "sun" | "rain";

export interface HazardDirection {
  azimuthRad: number;
  altitudeRad: number;
  /** Sun below the horizon (the night quad). Rain never goes below. */
  sunBelow: boolean;
}

export interface HazardProfile {
  readonly mode: HazardMode;
  /** Run Pass A and Pass D: the canvas owns the ground picture. */
  readonly drawsGround: boolean;
  /** Run Pass C roof self-shadow erasure after Pass B. */
  readonly erasesRoofs: boolean;
  /** Pass E paints exposure (wet) instead of shadow (shaded). */
  readonly surfaceInverts: boolean;
}

export const HAZARD_PROFILES: Record<HazardMode, HazardProfile> = {
  sun: {
    mode: "sun",
    drawsGround: true,
    erasesRoofs: true,
    surfaceInverts: false,
  },
  rain: {
    mode: "rain",
    drawsGround: false,
    erasesRoofs: false,
    surfaceInverts: true,
  },
};

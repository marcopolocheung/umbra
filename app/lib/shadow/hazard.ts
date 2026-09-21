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
 * Both objectives use the same coverage polarity: blue means the receiver is
 * protected. Rain changes only the incident ray. Ground coverage and the roof
 * exclusion pass therefore stay physically identical for both objectives.
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
}

export const HAZARD_PROFILES: Record<HazardMode, HazardProfile> = {
  sun: {
    mode: "sun",
    drawsGround: true,
    erasesRoofs: true,
  },
  rain: {
    mode: "rain",
    drawsGround: true,
    erasesRoofs: true,
  },
};

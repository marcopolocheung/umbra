import { describe, expect, it } from "vitest";
import {
  RAIN_OPACITY_LEAF_OFF,
  RAIN_OPACITY_LEAF_ON,
  rainOpacityForLightOpacity,
} from "../opacity";

describe("rainOpacityForLightOpacity", () => {
  it("keeps buildings opaque to rain", () => {
    // `opacity` absent marks buildings in the shadow pipeline; the rain rewrite
    // never sees them, but a stray opaque-handed caster must read as a canopy
    // note rather than crash. Light 1 saturates the leaf-on end of the ramp.
    expect(rainOpacityForLightOpacity(undefined)).toBe(1);
    expect(rainOpacityForLightOpacity(1)).toBeCloseTo(RAIN_OPACITY_LEAF_ON, 9);
  });

  it("maps a leafed crown's light opacity to the rain prior", () => {
    expect(rainOpacityForLightOpacity(0.9)).toBeCloseTo(RAIN_OPACITY_LEAF_ON, 9);
  });

  it("maps a bare crown to the leaf-off prior", () => {
    expect(rainOpacityForLightOpacity(0.3)).toBeCloseTo(RAIN_OPACITY_LEAF_OFF, 9);
  });

  it("is monotone through the ramp and clamped at both ends", () => {
    const mid = rainOpacityForLightOpacity(0.6);
    expect(mid).toBeGreaterThan(RAIN_OPACITY_LEAF_OFF);
    expect(mid).toBeLessThan(RAIN_OPACITY_LEAF_ON);
    expect(rainOpacityForLightOpacity(1.5)).toBeCloseTo(RAIN_OPACITY_LEAF_ON, 9);
    expect(rainOpacityForLightOpacity(0)).toBe(RAIN_OPACITY_LEAF_OFF);
  });
});

import { describe, expect, it } from "vitest";
import { RAIN_WET_ALPHA, RAIN_WET_RGB, rainCompositeColor } from "../rainComposite";

describe("rainCompositeColor", () => {
  it("paints the open street at full strength — the blank-canvas regression", () => {
    const [r, g, b, a] = rainCompositeColor(0);
    expect(a).toBeCloseTo(RAIN_WET_ALPHA, 9);
    expect(r).toBeCloseTo(RAIN_WET_RGB[0] * RAIN_WET_ALPHA, 9);
    expect(g).toBeCloseTo(RAIN_WET_RGB[1] * RAIN_WET_ALPHA, 9);
    expect(b).toBeCloseTo(RAIN_WET_RGB[2] * RAIN_WET_ALPHA, 9);
  });

  it("goes transparent under an opaque shelter", () => {
    const [r, g, b, a] = rainCompositeColor(1);
    expect(a).toBe(0);
    expect(r + g + b).toBe(0);
  });

  it("patches half-of-the-canopy priors through linearly", () => {
    // leaf-on 0.4 → exposed 0.6
    const [, , , a] = rainCompositeColor(0.4);
    expect(a).toBeCloseTo(RAIN_WET_ALPHA * 0.6, 9);
  });

  it("clamps out-of-range readings", () => {
    expect(rainCompositeColor(1.5)[3]).toBe(0);
    expect(rainCompositeColor(-0.5)[3]).toBeCloseTo(RAIN_WET_ALPHA, 9);
  });
});

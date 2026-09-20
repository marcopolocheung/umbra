import { describe, expect, it } from "vitest";
import {
  RAIN_WET_ALPHA,
  RAIN_WET_RGB,
  rainSurfaceColor,
} from "../rainComposite";

const DRY: [number, number, number] = [0.8, 0.8, 0.8];

describe("rainSurfaceColor", () => {
  it("fully exposed walls take the wet wash tint", () => {
    const [r, g, b] = rainSurfaceColor(DRY, RAIN_WET_RGB, 1, 0);
    expect(r).toBeCloseTo(RAIN_WET_RGB[0], 6);
    expect(g).toBeCloseTo(RAIN_WET_RGB[1], 6);
    expect(b).toBeCloseTo(RAIN_WET_RGB[2], 6);
  });

  it("fully sheltered walls stay dry stone, with gentle facing shading", () => {
    const front = rainSurfaceColor(DRY, RAIN_WET_RGB, 0, -1); // facing the rain ray
    const back = rainSurfaceColor(DRY, RAIN_WET_RGB, 0, 0.5);
    expect(front).toEqual([DRY[0], DRY[1], DRY[2]]);
    expect(back[0]).toBeLessThan(DRY[0]);
    expect(back[0]).toBeGreaterThan(0.6);
  });

  it("interpolates a canopy-like partial exposure", () => {
    const [r] = rainSurfaceColor(DRY, RAIN_WET_RGB, 0.4, 0);
    expect(r).toBeGreaterThan(RAIN_WET_RGB[0]);
    expect(r).toBeLessThan(DRY[0]);
  });

  it("keeps the wash constants the style layer tints with", () => {
    // `rainMapLayer.ts` paints the ground wash with these; drifting one copy
    // without the other made the wash and the 3D surfaces two blues (PR-per
    // history).
    expect(RAIN_WET_RGB).toEqual([0x25 / 255, 0x63 / 255, 0xeb / 255]);
    expect(RAIN_WET_ALPHA).toBeCloseTo(0.35, 9);
  });
});

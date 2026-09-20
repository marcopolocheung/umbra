import { describe, expect, it } from "vitest";
import { rainSurfaceColor } from "../rainComposite";

const DRY: [number, number, number] = [0.8, 0.8, 0.8];
const WET: [number, number, number] = [0.1, 0.3, 0.9];

describe("rainSurfaceColor", () => {
  it("fully exposed walls take the wet tint", () => {
    const [r, g, b] = rainSurfaceColor(DRY, WET, 1, 0);
    expect(r).toBeCloseTo(WET[0], 6);
    expect(g).toBeCloseTo(WET[1], 6);
    expect(b).toBeCloseTo(WET[2], 6);
  });

  it("fully sheltered walls stay dry stone, with gentle facing shading", () => {
    const front = rainSurfaceColor(DRY, WET, 0, -1); // facing the rain-view axis
    const back = rainSurfaceColor(DRY, WET, 0, 0.5);
    expect(front).toEqual([DRY[0], DRY[1], DRY[2]]);
    expect(back[0]).toBeLessThan(DRY[0]);
    expect(back[0]).toBeGreaterThan(0.6);
  });

  it("interpolates a canopy-like partial exposure", () => {
    const [r] = rainSurfaceColor(DRY, WET, 0.4, 0);
    expect(r).toBeGreaterThan(WET[0]);
    expect(r).toBeLessThan(DRY[0]);
  });
});

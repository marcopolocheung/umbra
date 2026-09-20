import { describe, expect, it } from "vitest";
import {
  createGeometryShadowField,
  staticPrismProvider,
} from "../../shadowField/ShadowField";
import type { BBox } from "../../shadowField/ShadowField";
import { rainDirectionFromWind } from "../direction";
import { RAIN_GRID_COLS, RAIN_GRID_ROWS, rainWashPixels } from "../rainMapLayer";

const COVERAGE: BBox = { west: -0.01, south: -0.01, east: 0.01, north: 0.01 };
const WHEN = new Date("2026-07-15T12:00:00Z");

describe("sampleRainGrid", () => {
  it("returns the sheltered share per cell as a 4×4 point average", () => {
    const field = createGeometryShadowField([
      staticPrismProvider(
        {
          prisms: [
            {
              ring: [[0.00005, -0.00005], [0.00009, -0.00005], [0.00009, 0.00005], [0.00005, 0.00005]],
              heightM: 10,
            },
          ],
          maxHeightM: 10,
        },
        COVERAGE,
        "overpass",
      ),
    ]);
    const bounds: BBox = { west: -0.00012, south: -0.00005, east: 0.00042, north: 0.00005 };
    const grid = field.sampleRainGrid(bounds, 2, 1, rainDirectionFromWind(90, 9), WHEN);
    expect(grid.source).toBe("overpass");
    // Left cell: the wall plus its 10 m west (lee) band covers exactly half the
    // cell's 4×4 sample points; the right cell lies east of the band's reach.
    expect(grid.values[0]).toBeCloseTo(0.5, 9);
    expect(grid.values[1]).toBe(0);
    expect(grid.values.length).toBe(2);
  });

  it("reports unknown when no geometry can answer", () => {
    const field = createGeometryShadowField([]);
    const grid = field.sampleRainGrid(COVERAGE, 4, 3, rainDirectionFromWind(0, 0), WHEN);
    expect(grid.source).toBe("none");
    expect(grid.confidence).toBe(0);
    expect(grid.values.every((v) => v === 0)).toBe(true);
  });
});

describe("rainWashPixels", () => {
  it("tints exposed share at the wash alpha and leaves shelter transparent", () => {
    const { data, width, height } = rainWashPixels({
      values: new Float32Array([0, 0.4, 1]),
      cols: 3,
      rows: 1,
      source: "canopy",
      confidence: 0.5,
    });
    expect(width).toBe(3);
    expect(height).toBe(1);
    // rgb = #2563eb everywhere; alpha = 0.35 × exposed.
    expect([data[0], data[1], data[2], data[3]]).toEqual([37, 99, 235, 89]);
    expect(data[7]).toBe(54); // 0.35 × 0.6
    expect([data[8], data[11]]).toEqual([37, 0]);
  });

  it("clamps out-of-range shelters to the exposed range", () => {
    const { data } = rainWashPixels({
      values: new Float32Array([1.5, -0.5]),
      cols: 2,
      rows: 1,
      source: "none",
      confidence: 0,
    });
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(89);
  });

  it("mirrors the layer's own grid constants", () => {
    // The export-visible wash shape follows the constants page.tsx samples with.
    expect(RAIN_GRID_COLS).toBeGreaterThan(64);
    expect(RAIN_GRID_ROWS).toBeGreaterThan(40);
  });
});

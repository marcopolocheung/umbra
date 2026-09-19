import { describe, expect, it } from "vitest";
import {
  createGeometryShadowField,
  staticPrismProvider,
} from "../../shadowField/ShadowField";
import type { BBox } from "../../shadowField/ShadowField";
import { rainDirectionFromWind } from "../direction";
import { RAIN_GRID_COLS, rainGridFeatureCollection } from "../rainMapLayer";

const COVERAGE: BBox = { west: -0.01, south: -0.01, east: 0.01, north: 0.01 };
const WHEN = new Date("2026-07-15T12:00:00Z");

describe("sampleRainGrid", () => {
  it("paints the lee band and leaves the windward street exposed", () => {
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
    // Left cell centre sits inside the wall's dry lee band, the right one is
    // windward and beyond its reach.
    expect(grid.source).toBe("overpass");
    expect(grid.values[0]).toBeGreaterThan(0.95);
    expect(grid.values[1]).toBe(0);
    expect(grid.values.length).toBe(2);
    // Row 0 = north strip, its centre sits in the lee band (see fixture maths).
  });

  it("reports unknown when no geometry can answer", () => {
    const field = createGeometryShadowField([]);
    const grid = field.sampleRainGrid(COVERAGE, 4, 3, rainDirectionFromWind(0, 0), WHEN);
    expect(grid.source).toBe("none");
    expect(grid.confidence).toBe(0);
    expect(grid.values.every((v) => v === 0)).toBe(true);
  });
});

describe("rainGridFeatureCollection", () => {
  it("emits one closed polygon per cell, row-major north first", () => {
    const values = new Float32Array([0.2, 0.8, 0.4, 0.9]);
    const bounds: BBox = { west: 10, south: 20, east: 12, north: 22 };
    const fc = rainGridFeatureCollection({ values, cols: 2, rows: 2, source: "canopy", confidence: 0.5 }, bounds);
    expect(fc.features).toHaveLength(4);
    expect(fc.features[0]!.properties?.shelter).toBeCloseTo(0.2, 5);
    // Row 0 is the north strip; each ring closes on itself.
    const ring = fc.features[0]!.geometry!.coordinates[0]!;
    expect(ring[2][1]).toBeCloseTo(22, 9); // NE corner's latitude (row 0 = north edge)
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Chattr pillar: the export-visible grid shape mirrors the layer's own constants.
    void RAIN_GRID_COLS;
  });
});

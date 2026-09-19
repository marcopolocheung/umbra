import { describe, expect, it } from "vitest";
import {
  createGeometryShadowField,
  staticCanopyProvider,
  staticPrismProvider,
  LOW_CONFIDENCE,
} from "../../shadowField/ShadowField";
import type { BBox, EdgeRef } from "../../shadowField/ShadowField";
import type { PrismSet } from "../../shadowField/geometry";
import { rainDirectionFromWind } from "../direction";

/** ~1.1° on a side — comfortably covers the 400 m query pad around the probes. */
const COVERAGE: BBox = { west: -0.01, south: -0.01, east: 0.01, north: 0.01 };

/** A short east–west edge whose left sidewalk rides ~4 m north of the origin. */
const CENTER_EDGE: EdgeRef = { from: [-0.00002, 0], to: [0.00002, 0] };

const LEAF_ON = new Date("2026-07-15T12:00:00Z");
const LEAF_OFF = new Date("2027-01-15T12:00:00Z");

function canopyOver(center: [number, number], radiusM: number, lightOpacity: number): PrismSet {
  const steps = 8;
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([
      center[0] + (Math.cos(a) * radiusM) / 111195,
      center[1] + (Math.sin(a) * radiusM) / 111195,
    ] as [number, number]);
  }
  return {
    prisms: [{ ring, heightM: 9, baseM: 3, opacity: lightOpacity }],
    maxHeightM: 9,
  };
}

describe("sampleRainEdges — vertical (v0) semantics", () => {
  it("a point inside a building footprint is dry, not merely beside a building", () => {
    const field = createGeometryShadowField([
      staticPrismProvider(
        {
          prisms: [
            {
              ring: [[-0.0005, -0.0005], [0.0005, -0.0005], [0.0005, 0.0005], [-0.0005, 0.0005]],
              heightM: 10,
            },
          ],
          maxHeightM: 10,
        },
        COVERAGE,
        "overpass"
      ),
    ]);
    const [sample] = field.sampleRainEdges([CENTER_EDGE], rainDirectionFromWind(0, 0), LEAF_ON);
    expect(sample.left).toBeCloseTo(1, 9);
    expect(sample.right).toBeCloseTo(1, 9);
    expect(sample.source).toBe("overpass");
    expect(sample.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
  });

  it("no geometry reads exposed with unknown confidence — absent is not dry", () => {
    const field = createGeometryShadowField([]);
    const [sample] = field.sampleRainEdges([CENTER_EDGE], rainDirectionFromWind(0, 0), LEAF_ON);
    expect(sample.left).toBe(0);
    expect(sample.right).toBe(0);
    expect(sample.source).toBe("none");
    expect(sample.confidence).toBe(0);
  });

  it("a leafed crown overhead gives the rain prior, a bare crown the leaf-off prior", () => {
    const crown = canopyOver([0, 0.000036], 6.7, 0.9);
    const field = createGeometryShadowField([], [staticCanopyProvider(crown, COVERAGE)], []);
    const on = field.sampleRainEdges([CENTER_EDGE], rainDirectionFromWind(0, 0), LEAF_ON)[0];
    expect(on.left).toBeCloseTo(0.4, 6);
    expect(on.right).toBe(0); // right sidewalk sits outside the small crown
    expect(on.source).toBe("canopy");
    expect(on.canopySources?.osm).toBe(true);

    const bare = createGeometryShadowField([], [staticCanopyProvider({ ...crown, prisms: [{ ...crown.prisms[0], opacity: 0.3 }] }, COVERAGE)], []);
    const off = bare.sampleRainEdges([CENTER_EDGE], rainDirectionFromWind(0, 0), LEAF_OFF)[0];
    expect(off.left).toBeCloseTo(0.1, 6);
  });
});

describe("sampleRainEdges — wind-tilted (v1) direction convention", () => {
  /** A wall 5.5–9.7 m east of the origin, 10 m tall, spanning the ±4 m sidewalks. */
  const wallEast: PrismSet = {
    prisms: [
      {
        ring: [[0.00005, -0.00005], [0.00009, -0.00005], [0.00009, 0.00005], [0.00005, 0.00005]],
        heightM: 10,
      },
    ],
    maxHeightM: 10,
  };

  it("shelters the lee (downwind) sidewalk: wind FROM the bearing → ray +180°", () => {
    const field = createGeometryShadowField([staticPrismProvider(wallEast, COVERAGE, "overpass")]);
    const direction = rainDirectionFromWind(90, 9); // from the east at 45° tilt
    expect(direction.altitudeDeg).toBeCloseTo(45, 6);
    const [lee] = field.sampleRainEdges([CENTER_EDGE], direction, LEAF_ON);
    // The lee points stay dry and the answer keeps usable confidence — the wall
    // dock is the only discount a 45° tilt buys.
    expect(lee.left).toBeCloseTo(1, 9);
    expect(lee.right).toBeCloseTo(1, 9);
    expect(lee.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    expect(lee.confidence).toBeLessThan(0.7); // docked, not full
  });

  it("leaves the windward sidewalk exposed past the wall's reach", () => {
    const field = createGeometryShadowField([staticPrismProvider(wallEast, COVERAGE, "overpass")]);
    const farWindward: EdgeRef = { from: [0.0004, -0.00001], to: [0.00042, -0.00001] };
    const [wet] = field.sampleRainEdges([farWindward], rainDirectionFromWind(90, 9), LEAF_ON);
    expect(wet.left).toBe(0);
    expect(wet.right).toBe(0);
    expect(wet.source).toBe("overpass");
  });
});

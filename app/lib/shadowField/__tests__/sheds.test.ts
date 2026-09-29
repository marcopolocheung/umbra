import { describe, expect, it } from "vitest";
import { type EdgeRef, sidewalkOffsets } from "../ShadowField";
import { metersPerDegree } from "../geometry";
import { shedPrismsFromPermits } from "../sheds";

const LAT = 40.7549;
const LNG = -73.984;
const { mPerLat, mPerLng } = metersPerDegree(LAT);

/** A point `east`/`north` metres from the scene origin. */
function at(east: number, north: number): [number, number] {
  return [LNG + east / mPerLng, LAT + north / mPerLat];
}

/** A 100 m east–west street through the origin. Its field "left" is north. */
const EAST_WEST: EdgeRef = { from: at(-50, 0), to: at(50, 0) };

function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The point on an edge's `side` sidewalk sample line at fraction `t` along it. */
function sidewalkPoint(edge: EdgeRef, side: "left" | "right", t: number): [number, number] {
  const offset = sidewalkOffsets(edge)[side];
  return [
    edge.from[0] + t * (edge.to[0] - edge.from[0]) + offset[0],
    edge.from[1] + t * (edge.to[1] - edge.from[1]) + offset[1],
  ];
}

describe("shedPrismsFromPermits", () => {
  it("covers the sidewalk on the side the permit leans to, not the other", () => {
    const north = shedPrismsFromPermits([{ lng: at(0, 1)[0], lat: at(0, 1)[1] }], [EAST_WEST]);
    const south = shedPrismsFromPermits([{ lng: at(0, -1)[0], lat: at(0, -1)[1] }], [EAST_WEST]);

    expect(north.placed).toBe(1);
    const northRing = north.set.prisms[0].ring;
    expect(pointInRing(sidewalkPoint(EAST_WEST, "left", 0.5), northRing)).toBe(true);
    expect(pointInRing(sidewalkPoint(EAST_WEST, "right", 0.5), northRing)).toBe(false);

    const southRing = south.set.prisms[0].ring;
    expect(pointInRing(sidewalkPoint(EAST_WEST, "right", 0.5), southRing)).toBe(true);
    expect(pointInRing(sidewalkPoint(EAST_WEST, "left", 0.5), southRing)).toBe(false);
  });

  it("follows a diagonal street", () => {
    const diagonal: EdgeRef = { from: at(-40, -40), to: at(40, 40) };
    // Left of a south-west → north-east edge is north-west.
    const permit = at(-0.7, 0.7);
    const { set } = shedPrismsFromPermits([{ lng: permit[0], lat: permit[1] }], [diagonal]);
    const ring = set.prisms[0].ring;
    expect(pointInRing(sidewalkPoint(diagonal, "left", 0.5), ring)).toBe(true);
    expect(pointInRing(sidewalkPoint(diagonal, "right", 0.5), ring)).toBe(false);
    // Only a frontage along the street, not the whole block.
    expect(pointInRing(sidewalkPoint(diagonal, "left", 0.05), ring)).toBe(false);
  });

  it("drops a permit too close to the centerline to have a side", () => {
    const result = shedPrismsFromPermits([{ lng: at(0, 0.1)[0], lat: at(0, 0.1)[1] }], [EAST_WEST]);
    expect(result.placed).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it("drops a permit too far from any edge to be snapped", () => {
    const result = shedPrismsFromPermits([{ lng: at(0, 20)[0], lat: at(0, 20)[1] }], [EAST_WEST]);
    expect(result.placed).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it("snaps to the nearest of several edges", () => {
    const parallel: EdgeRef = { from: at(-50, 12), to: at(50, 12) };
    // 3 m north of EAST_WEST, 9 m south of `parallel`.
    const permit = at(10, 3);
    const { set } = shedPrismsFromPermits(
      [{ lng: permit[0], lat: permit[1] }],
      [parallel, EAST_WEST],
    );
    const ring = set.prisms[0].ring;
    expect(pointInRing(sidewalkPoint(EAST_WEST, "left", 0.6), ring)).toBe(true);
  });

  it("builds an opaque sheet lifted off the ground", () => {
    const { set } = shedPrismsFromPermits([{ lng: at(0, 1)[0], lat: at(0, 1)[1] }], [EAST_WEST]);
    const [prism] = set.prisms;
    expect(prism.opacity).toBe(1);
    expect(prism.baseM).toBeGreaterThan(0);
    expect(set.maxHeightM).toBe(prism.heightM);
  });

  it("returns an empty set, not nothing, when there are no permits", () => {
    const result = shedPrismsFromPermits([], [EAST_WEST]);
    expect(result.set.prisms).toEqual([]);
  });
});

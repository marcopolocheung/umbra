import { describe, expect, it } from "vitest";
import {
  COIN_RADIUS,
  coast,
  coinOutline,
  distanceAt,
  lineBadgePlacements,
  pointAtDistance,
  rideLength,
  snapToPath,
} from "../lineBadges";

describe("lineBadgePlacements", () => {
  it("pins one badge per ride, not per station hop", () => {
    const badges = lineBadgePlacements([
      { line: "L", color: "#A7A9AC", coords: [[-73.99, 40.73], [-73.98, 40.73]] },
      { line: "L", color: "#A7A9AC", coords: [[-73.98, 40.73], [-73.97, 40.73]] },
      { line: "G", color: "#6CBE45", coords: [[-73.97, 40.73], [-73.97, 40.74]] },
    ]);
    expect(badges.map((b) => b.line)).toEqual(["L", "G"]);
    expect(badges[0].color).toBe("#A7A9AC");
  });

  it("starts a new badge when the same line is ridden again after a change", () => {
    const hop = (line: string, x: number) => ({ line, color: "#000000", coords: [[x, 40.7], [x + 0.01, 40.7]] as [number, number][] });
    expect(lineBadgePlacements([hop("A", 0), hop("C", 0.01), hop("A", 0.02)]).map((b) => b.line)).toEqual(["A", "C", "A"]);
  });

  it("skips empty geometry and joins a ride's hops into one track", () => {
    expect(lineBadgePlacements([{ line: "S", color: "#808183", coords: [] }])).toEqual([]);
    const [ride] = lineBadgePlacements([
      { line: "L", color: "#A7A9AC", coords: [[0, 0], [1, 0]] },
      { line: "L", color: "#A7A9AC", coords: [[1, 0], [2, 0]] },
    ]);
    expect(ride.coords).toEqual([[0, 0], [1, 0], [1, 0], [2, 0]]);
  });
});

describe("snapToPath", () => {
  const path: [number, number][] = [[0, 0], [100, 0], [100, 100]];

  it("finds the hop, and the point along it, nearest a dragged point", () => {
    expect(snapToPath(path, [40, 30])).toEqual({ index: 0, t: 0.4 });
    expect(snapToPath(path, [130, 60])).toEqual({ index: 1, t: 0.6 });
    // Past the end, it stops at the end: the swelling never leaves its ride.
    expect(snapToPath(path, [-50, -10])).toEqual({ index: 0, t: 0 });
  });

  it("copes with a degenerate path", () => {
    expect(snapToPath([], [1, 1])).toBeNull();
    expect(snapToPath([[5, 5]], [9, 9])).toEqual({ index: 0, t: 0 });
  });
});

describe("distance along a ride", () => {
  const km = 1000 / 111_195; // one kilometre of latitude
  const ride: [number, number][] = [[-73.98, 40.7], [-73.98, 40.7 + km], [-73.98, 40.7 + 3 * km]];

  it("measures, walks and inverts the track", () => {
    expect(rideLength(ride)).toBeCloseTo(3000, -1);
    expect(distanceAt(ride, 1, 0.5)).toBeCloseTo(2000, -1);
    expect(pointAtDistance(ride, 2000)[1]).toBeCloseTo(40.7 + 2 * km, 6);
    // Clamped: the badge cannot be placed off either end.
    expect(pointAtDistance(ride, -50)).toEqual(ride[0]);
    expect(pointAtDistance(ride, 99_999)).toEqual(ride[2]);
  });
});

describe("coast", () => {
  it("decays like the time slider and stops dead at the ends", () => {
    const step = coast(100, 1, 16, 1000);
    expect(step.v).toBeCloseTo(Math.exp(-0.009 * 16));
    expect(step.s).toBeGreaterThan(100);
    expect(coast(995, 1, 16, 1000)).toEqual({ s: 1000, v: 0, atEnd: true });
    expect(coast(5, -1, 16, 1000)).toEqual({ s: 0, v: 0, atEnd: true });
  });

  it("travels v0 / friction in all, so a glide can be aimed at a resting point", () => {
    let state = { s: 0, v: 0.9, atEnd: false };
    for (let i = 0; i < 400 && Math.abs(state.v) > 1e-6; i++) state = coast(state.s, state.v, 16, 1e6);
    expect(state.s).toBeCloseTo(0.9 / 0.009, -1);
  });
});

describe("coinOutline", () => {
  it("is the same hand-inked edge for one line and a different one for another", () => {
    expect(coinOutline("L")).toBe(coinOutline("L"));
    expect(coinOutline("L")).not.toBe(coinOutline("G"));
  });

  it("stays a coin: every point within a few percent of the radius", () => {
    const radii = coinOutline("A").slice(1, -1).split("L").map((p) => Math.hypot(...(p.split(",").map(Number) as [number, number])));
    expect(radii).toHaveLength(48);
    for (const r of radii) expect(Math.abs(r - COIN_RADIUS) / COIN_RADIUS).toBeLessThan(0.08);
  });
});

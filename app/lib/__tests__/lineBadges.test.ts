import { describe, expect, it } from "vitest";
import {
  BLOB_HALF_LENGTH,
  LINE_HALF_WIDTH,
  blobOutline,
  coast,
  distanceAt,
  foldAngle,
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

  it("sits halfway along the drawn track, on the line", () => {
    // An L-shaped ride: 1 km east, then 3 km north. Halfway (2 km) is 1 km up the second arm.
    const east = 1000 / (111_195 * Math.cos((40.73 * Math.PI) / 180));
    const north = 1000 / 111_195;
    const [badge] = lineBadgePlacements([
      { line: "A", color: "#0039A6", coords: [[-74, 40.73], [-74 + east, 40.73], [-74 + east, 40.73 + 3 * north]] },
    ]);
    expect(badge.at[0]).toBeCloseTo(-74 + east, 6);
    expect(badge.at[1]).toBeCloseTo(40.73 + north, 3);
  });

  it("starts a new badge when the same line is ridden again after a change", () => {
    const hop = (line: string, x: number) => ({ line, color: "#000000", coords: [[x, 40.7], [x + 0.01, 40.7]] as [number, number][] });
    expect(lineBadgePlacements([hop("A", 0), hop("C", 0.01), hop("A", 0.02)]).map((b) => b.line)).toEqual(["A", "C", "A"]);
  });

  it("skips empty geometry and places a single-point ride on its point", () => {
    expect(lineBadgePlacements([{ line: "S", color: "#808183", coords: [] }])).toEqual([]);
    expect(lineBadgePlacements([{ line: "S", color: "#808183", coords: [[-73.98, 40.75]] }])[0].at).toEqual([-73.98, 40.75]);
  });
});

describe("snapToPath", () => {
  const path: [number, number][] = [[0, 0], [100, 0], [100, 100]];

  it("pulls a dragged point onto the nearest stretch of the line", () => {
    expect(snapToPath(path, [40, 30])?.at).toEqual([40, 0]);
    expect(snapToPath(path, [130, 60])?.at).toEqual([100, 60]);
    // Past the end, it stops at the end: the badge never leaves its ride.
    expect(snapToPath(path, [-50, -10])?.at).toEqual([0, 0]);
  });

  it("gives the line's direction there, never upside down", () => {
    expect(snapToPath(path, [40, 30])?.angleDeg).toBe(0);
    expect(snapToPath(path, [130, 60])?.angleDeg).toBe(90);
    // Drawn right-to-left, the same line folds back to 0°, not 180°.
    expect(snapToPath([[100, 0], [0, 0]], [40, 5])?.angleDeg).toBe(0);
  });

  it("copes with a degenerate path", () => {
    expect(snapToPath([], [1, 1])).toBeNull();
    expect(snapToPath([[5, 5]], [9, 9])).toEqual({ at: [5, 5], angleDeg: 0, index: 0, t: 0 });
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

describe("foldAngle", () => {
  it.each([[0, 0], [90, 90], [135, -45], [-135, 45], [270, 90], [-90, 90]])("folds %s° to %s°", (deg, folded) => {
    expect(foldAngle(deg)).toBe(folded);
  });
});

describe("blobOutline", () => {
  it("is the same irregular shape for one line and a different one for another", () => {
    expect(blobOutline("L")).toBe(blobOutline("L"));
    expect(blobOutline("L")).not.toBe(blobOutline("G"));
  });

  it("tapers to exactly the drawn line's width at both ends, so it fuses with the line", () => {
    const pts = blobOutline("A").slice(1, -1).split("L").map((p) => p.split(",").map(Number));
    const ends = pts.filter(([x]) => Math.abs(x) === BLOB_HALF_LENGTH);
    expect(ends).toHaveLength(4);
    for (const [, y] of ends) expect(Math.abs(y)).toBeCloseTo(LINE_HALF_WIDTH, 1);
    // …and swells well past the line in the middle, room for the letter.
    const middle = pts.filter(([x]) => x === 0).map(([, y]) => Math.abs(y));
    for (const y of middle) expect(y).toBeGreaterThan(9);
  });
});

import { describe, expect, it } from "vitest";
import {
  COIN_RADIUS,
  coast,
  coinOutline,
  distanceAt,
  restingGap,
  rubberBand,
  springStep,
  stopDistances,
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

describe("stopDistances", () => {
  const km = 1000 / 111_195;
  const ride: [number, number][] = [[-73.98, 40.7], [-73.98, 40.7 + 2 * km]];

  it("places the ride's stops along it and leaves other rides' stops out", () => {
    const d = stopDistances(ride, [[-73.98, 40.7 + 2 * km], [-73.98, 40.7 + km], [-73.97, 40.7 + km]]);
    expect(d).toHaveLength(2);
    expect(d[0]).toBeCloseTo(1000, -1);
    expect(d[1]).toBeCloseTo(2000, -1);
  });
});

describe("restingGap", () => {
  const stops = [0, 400, 800];

  it("leaves a coin that hides no stop where it is", () => {
    expect(restingGap(200, stops, 800, 60)).toBeNull();
  });

  it("nudges a coin off a stop by the smallest clear step", () => {
    expect(restingGap(390, stops, 800, 60)).toBe(340);
    expect(restingGap(420, stops, 800, 60)).toBe(460);
    // At the board stop the only clear side is onward.
    expect(restingGap(10, stops, 800, 60)).toBe(60);
  });

  it("gives up on a ride too dense to hold the coin clear", () => {
    expect(restingGap(50, [0, 50, 100], 100, 60)).toBeNull();
  });
});

describe("rubberBand", () => {
  it("follows a small pull and stiffens toward the limit without reaching it", () => {
    expect(rubberBand(1, 12)).toBeCloseTo(1, 1);
    expect(rubberBand(12, 12)).toBeCloseTo(9.1, 1);
    expect(rubberBand(200, 12)).toBeLessThan(12);
    expect(rubberBand(200, 12)).toBeGreaterThan(11.9);
  });
});

describe("springStep", () => {
  it("wobbles a released coin back past the line and settles on it", () => {
    let state = { x: 10, v: 0 };
    let crossings = 0;
    for (let t = 0; t < 1200; t += 16) {
      const next = springStep(state.x, state.v, 16);
      if (Math.sign(next.x) !== Math.sign(state.x) && state.x !== 0) crossings++;
      state = next;
    }
    // Under-damped: it overshoots at least once, then comes to rest on the line.
    expect(crossings).toBeGreaterThanOrEqual(1);
    expect(Math.abs(state.x)).toBeLessThan(0.3);
  });

  it("survives a long frame without blowing up", () => {
    expect(Math.abs(springStep(10, 0, 500).x)).toBeLessThan(10);
  });
});

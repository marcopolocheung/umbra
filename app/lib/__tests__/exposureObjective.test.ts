/**
 * H2 — exposure duration as the objective.
 *
 * The committed Route-A/Route-B fixture from the brief, verbatim:
 *
 *   Route A: 1,000 m total,   800 m shadowed →  200 m exposed
 *   Route B: 1,500 m total, 1,000 m shadowed →  500 m exposed   ← "more shadowed", 2.5× the sun
 *
 * Under the old objective (maximize shadowed metres inside the 2.0× + 250 m
 * detour budget) B won the most-shadowed slot while carrying 2.5× A's absolute
 * sun — the demonstrable defect H2 exists to fix. Under the duration objective
 * (minimize sun seconds) A must win and B must leave the front entirely: A
 * dominates it on both criteria.
 *
 * All graphs are hand-crafted and deterministic. Run with: npm test
 */

import { describe, it, expect } from "vitest";
import { paretoRoutes, type RoutingGraph, type OsmNode, type GraphEdge } from "../routing";

const edge = (
  toId: number,
  distanceM: number,
  shadowFactor: number,
): GraphEdge => ({ toId, distanceM, shadowFactor });

/**
 * The brief's two routes as parallel branches:
 *
 *   1 --[500m @ .8]--> 2 --[500m @ .8]--> 4      (A: 1,000 m, 800 shadowed)
 *   1 --[750m @ 2/3]--> 3 --[750m @ 2/3]--> 4     (B: 1,500 m, 1,000 shadowed)
 */
function makeRouteABGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0, lon: 0 }],
    [2, { id: 2, lat: 0.00449, lon: 0 }],
    [3, { id: 3, lat: 0, lon: 0.00674 }],
    [4, { id: 4, lat: 0.00898, lon: 0.00898 }],
  ]);
  const adj: Map<number, GraphEdge[]> = new Map([
    [1, [edge(2, 500, 0.8), edge(3, 750, 2 / 3)]],
    [2, [edge(1, 500, 0.8), edge(4, 500, 0.8)]],
    [3, [edge(1, 750, 2 / 3), edge(4, 750, 2 / 3)]],
    [4, [edge(2, 500, 0.8), edge(3, 750, 2 / 3)]],
  ]);
  return { nodes, adj };
}

describe("paretoRoutes exposure-duration objective (H2)", () => {
  it("the Route-A/Route-B fixture: picks A, and B leaves the front", () => {
    const g = makeRouteABGraph();
    const routes = paretoRoutes(g, 1, 4, { straightLineDistM: 1000 });

    // Route A (via 2) is shorter AND carries less sun (200 m ≈ 143 s vs B's
    // 500 m ≈ 357 s), so B — "more shadowed" in metres, 2.5× the sun in
    // minutes — is strictly dominated and must not appear at all.
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.nodeIds).toEqual([1, 2, 4]);
    }

    // The winner reports exposure duration alongside coverage: A's 200 m of
    // sun at 1.4 m/s is ~143 s, and its coverage is 800/1000.
    const best = routes.reduce((a, b) =>
      (b.exposure?.exposedDurationSec ?? Infinity) < (a.exposure?.exposedDurationSec ?? Infinity) ? b : a);
    expect(best.shadowCoverage).toBeCloseTo(0.8);
    expect(best.exposure?.exposedDurationSec).toBeCloseTo(200 / 1.4, 1);
    expect(best.exposure?.shelteredDistanceM).toBeCloseTo(800);
  });

  it("maxContinuousExposureSec rejects the sunny crossing, not the shaded detour", () => {
    // A 400 m fully-sunlit crossing (≈ 286 s unbroken sun) against a 600 m
    // fully-shaded detour. Unconstrained, the crossing wins both criteria.
    // With the cap at 200 s, every surviving option must take the detour.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.00269, lon: 0.00269 }],
      [3, { id: 3, lat: 0.00539, lon: 0 }],
    ]);
    const adj: Map<number, GraphEdge[]> = new Map([
      [1, [edge(3, 400, 0), edge(2, 300, 1)]],
      [2, [edge(1, 300, 1), edge(3, 300, 1)]],
      [3, [edge(1, 400, 0), edge(2, 300, 1)]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const free = paretoRoutes(g, 1, 3, {});
    expect(free.some((r) => r.nodeIds.join() === "1,3")).toBe(true);

    const capped = paretoRoutes(g, 1, 3, { maxContinuousExposureSec: 200 });
    expect(capped.length).toBeGreaterThan(0);
    for (const r of capped) {
      expect(r.nodeIds).toEqual([1, 2, 3]);
    }
    // The cap is honest about what remains: the detour still reports its
    // (zero) exposure rather than pretending the crossing was free.
    expect(capped[0].exposure?.exposedDurationSec).toBeCloseTo(0, 5);
  });

  it("the cap survives dominance: a shade-broken streak must not be pruned by a sunnier rival", () => {
    // The direct route is one 112 m unbroken sun run (80 s) plus a 50 m sun
    // finish — 115.7 s unbroken, past the 100 s cap. The detour carries MORE
    // total sun (85 s) but its early shade breaks the run, so its finish
    // stays at 65.7 s. At node 3 the direct label beats the detour on
    // distance and total sun — a dominance rule blind to the streak prunes
    // the detour there, and the cap then kills the direct: the search returns
    // nothing. The streak is part of the label, so it is part of the
    // comparison.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.0007, lon: 0.0004 }],
      [5, { id: 5, lat: 0.0014, lon: 0.0004 }],
      [3, { id: 3, lat: 0.0014, lon: 0 }],
      [4, { id: 4, lat: 0.0018, lon: 0 }],
    ]);
    const sun = (toId: number, distanceM: number): GraphEdge => edge(toId, distanceM, 0);
    const shade = (toId: number, distanceM: number): GraphEdge => edge(toId, distanceM, 1);
    const adj: Map<number, GraphEdge[]> = new Map([
      [1, [sun(3, 112), sun(2, 77)]],
      [2, [sun(1, 77), shade(5, 10)]],
      [5, [shade(2, 10), sun(3, 42)]],
      [3, [sun(1, 112), sun(5, 42), sun(4, 50)]],
      [4, [sun(3, 50)]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const capped = paretoRoutes(g, 1, 4, { maxContinuousExposureSec: 100 });
    expect(capped.length).toBeGreaterThan(0);
    for (const r of capped) {
      expect(r.nodeIds).toEqual([1, 2, 5, 3, 4]);
    }
    // Uncapped, the direct route is better on both axes and rightly wins
    // every representative slot; only the cap makes the detour the answer.
    const free = paretoRoutes(g, 1, 4, {});
    expect(free.some((r) => r.nodeIds.join() === "1,3,4")).toBe(true);
    expect(free.some((r) => r.nodeIds.join() === "1,2,5,3,4")).toBe(false);
  });

  it("keeps rain's three representatives: the knee is the most-sheltered corner, not the shortest", () => {
    // Regression for the H2 knee flip: normalizing rain exposure as
    // "smaller is better" made the shortest route its own knee, and the
    // front collapsed to Shortest + Driest — the Balanced option vanished.
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0, lon: 0 }],
      [2, { id: 2, lat: 0.00449, lon: 0.008 }],
      [3, { id: 3, lat: 0, lon: 0.00989 }],
      [4, { id: 4, lat: 0.00449, lon: 0.01618 }],
    ]);
    const shelter = (toId: number, distanceM: number, factor: number): GraphEdge => ({
      toId, distanceM, shadowFactor: 0, shelterFactor: factor,
    });
    const adj: Map<number, GraphEdge[]> = new Map([
      [1, [shelter(2, 500, 0), shelter(3, 550, 0.5), shelter(4, 1800, 1)]],
      [2, [shelter(1, 500, 0), shelter(4, 500, 0)]],
      [3, [shelter(1, 550, 0.5), shelter(4, 550, 0.5)]],
      [4, [shelter(2, 500, 0), shelter(3, 550, 0.5), shelter(1, 1800, 1)]],
    ]);
    const g: RoutingGraph = { nodes, adj };

    const routes = paretoRoutes(g, 1, 4, { objective: "rain" });
    // The three-route front: 1,000 m bare, 1,100 m half-sheltered (the knee),
    // 1,800 m fully sheltered.
    expect(routes.length).toBe(3);
    expect(routes.map((r) => r.nodeIds)).toContainEqual([1, 2, 4]);
    expect(routes.map((r) => r.nodeIds)).toContainEqual([1, 3, 4]);
    expect(routes.map((r) => r.nodeIds)).toContainEqual([1, 4]);
  });
});

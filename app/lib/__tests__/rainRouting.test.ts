import { describe, expect, it } from "vitest";
import {
  dijkstra,
  paretoRoutes,
  parallelSidewalkEdges,
} from "../routing";
import type { GraphEdge, RoutingGraph } from "../routing";

function node(id: number, lng: number, lat: number) {
  // `routing.ts` reads `lon` for the remaining-distance heuristic.
  return { id, lon: lng, lat, isIntersection: false };
}

function graphOf(nodes: number[][], edges: Array<[number, number, number, { shadowFactor?: number; shelterFactor?: number }?]>) {
  const g: RoutingGraph = { nodes: new Map(), adj: new Map() };
  for (const [id, lng, lat] of nodes) g.nodes.set(id, node(id, lng, lat));
  for (const [a, b, d, f] of edges) {
    const mk = (to: number): GraphEdge => ({
      toId: to,
      distanceM: d,
      shadowFactor: f?.shadowFactor ?? 0,
      shelterFactor: f?.shelterFactor,
      surface: "paved",
      highway: "residential",
    });
    g.adj.set(a, [...(g.adj.get(a) ?? []), mk(b)]);
    g.adj.set(b, [...(g.adj.get(b) ?? []), mk(a)]);
  }
  return g;
}

/** A(0) ↔ B(1) direct wet, or A–X–B dry via X(2) — distances 56 vs 39+39. */
function dryDetourGraph(): RoutingGraph {
  return graphOf(
    [[1, 0, 0], [2, 0.0005, 0], [3, 0.00025, 0.00025]],
    [
      [1, 2, 56, { shelterFactor: 0 }],
      [1, 3, 39, { shelterFactor: 1 }],
      [3, 2, 39, { shelterFactor: 1 }],
    ],
  );
}

describe("parallelSidewalkEdges — rain mode", () => {
  const source: GraphEdge = {
    toId: 5,
    distanceM: 100,
    shadowFactor: 0.9,
    surface: "paved",
  };

  it("sun mode still replaces only shadowFactor and side", () => {
    const [left, right] = parallelSidewalkEdges(3, source, 0.2, 0.8);
    expect(left).toEqual({ ...source, shadowFactor: 0.2, side: "left" });
    expect(right).toEqual({ ...source, shadowFactor: 0.8, side: "right" });
    expect(left.shelterFactor).toBeUndefined();
  });

  it("rain mode writes shelterFactor and leaves shadowFactor alone", () => {
    const [left, right] = parallelSidewalkEdges(3, source, 0.2, 0.8, "rain");
    expect(left.shelterFactor).toBe(0.2);
    expect(right.shelterFactor).toBe(0.8);
    expect(left.side).toBe("left");
    expect(left.shadowFactor).toBe(source.shadowFactor);
    expect(left.surface).toBe("paved");
  });
});

describe("dijkstra — rain objective", () => {
  it("prices shelter: the dry detour wins when the corridor is worth a detour", () => {
    const route = dijkstra(dryDetourGraph(), 1, 2, 1, { objective: "rain", precipIntensity: 1 });
    expect(route).not.toBeNull();
    expect(route!.nodeIds).toEqual([1, 3, 2]); // via the dry X
    expect(route!.dryCoverage).toBeCloseTo(1, 9);
    expect(route!.longestContinuousWetM).toBe(0);
  });

  it("sun objective is unaffected: no shadow, so the shortest path wins", () => {
    const route = dijkstra(dryDetourGraph(), 1, 2, 1, {});
    expect(route!.nodeIds).toEqual([1, 2]);
    expect(route!.dryCoverage).toBeUndefined();
  });

  it("reports the longest unbroken wet stretch on a mixed route", () => {
    const g = graphOf(
      [[1, 0, 0], [2, 0.00025, 0], [3, 0.0005, 0], [4, 0.001, 0]],
      [
        [1, 2, 40, { shelterFactor: 1 }],
        [2, 3, 40, { shelterFactor: 1 }],
        [3, 4, 40, { shelterFactor: 0 }],
      ],
    );
    const route = dijkstra(g, 1, 4, 0, { objective: "rain" });
    expect(route!.dryCoverage).toBeCloseTo(80 / 120, 9);
    expect(route!.longestContinuousWetM).toBe(40);
    expect(route!.wetTransitions).toBe(1);
  });
});

describe("paretoRoutes — rain objective", () => {
  it("orders shortest before driest in a dry-corridor graph", () => {
    const results = paretoRoutes(dryDetourGraph(), 1, 2, { objective: "rain" });
    expect(results.length).toBe(2);
    expect(results[0].distanceM).toBe(56);
    expect(results[0].dryCoverage).toBe(0);
    expect(results[1].distanceM).toBe(78);
    expect(results[1].dryCoverage).toBeCloseTo(1, 9);
  });

  it("no shelter anywhere collapses the front to the shortest path", () => {
    const g = graphOf(
      [[1, 0, 0], [2, 0.0005, 0], [3, 0.00025, 0.00025]],
      [[1, 2, 56], [1, 3, 39], [3, 2, 39]],
    );
    const results = paretoRoutes(g, 1, 2, { objective: "rain" });
    expect(results.length).toBe(1);
    expect(results[0].dryCoverage).toBe(0);
  });

  it("never detours for shelter beyond the detour budget", () => {
    // A far-away perfectly dry wormhole must not eat the search's budget.
    const g = graphOf(
      [[1, 0, 0], [2, 0.001, 0], [3, 0.02, 0], [4, 0.021, 0]],
      [
        [1, 2, 100, { shelterFactor: 0 }],
        [1, 3, 2000, { shelterFactor: 1 }],
        [3, 4, 2000, { shelterFactor: 1 }],
        [2, 4, 2000, { shelterFactor: 0 }],
        [2, 4, 100, { shelterFactor: 0 }],
      ] as Array<[number, number, number, { shelterFactor: number }?]>,
    );
    const results = paretoRoutes(g, 1, 4, { objective: "rain" });
    const longest = Math.max(...results.map((r) => r.distanceM));
    expect(longest).toBeLessThan(500);
    expect(results.some((r) => r.nodeIds.includes(3))).toBe(false);
  });
});

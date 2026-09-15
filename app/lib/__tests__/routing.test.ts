/**
 * Unit tests for app/lib/routing.ts
 *
 * All tests use deterministic, hand-crafted graphs so results are reproducible
 * without any browser APIs, network access, or randomness.
 *
 * Graph notation used throughout:
 *   node id → [lng, lat] coordinates
 *   edges labelled with [distanceM, shadowFactor]
 *
 * Run with: npm test
 */

import { describe, it, expect } from "vitest";
import {
  haversineMeters,
  snapToGraph,
  snapToEdge,
  dijkstra,
  paretoRoutes,
  graphToGeoJSON,
  bfsReachable,
  snapToReachableEdge,
  snapRouteStopsToReachableEdges,
  connectRouteEndpoints,
  parallelSidewalkEdges,
  type RoutingGraph,
  type OsmNode,
  type GraphEdge,
} from "../routing";

// ── Graph factories ────────────────────────────────────────────────────────────

/**
 * Linear graph: 1 -- 2 -- 3
 *   1→2: 100 m, shadow=0
 *   2→3: 100 m, shadow=0.5
 */
function makeLinearGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.0, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: 100, shadowFactor: 0.0 }]],
    [2, [{ toId: 1, distanceM: 100, shadowFactor: 0.0 },
         { toId: 3, distanceM: 100, shadowFactor: 0.5 }]],
    [3, [{ toId: 2, distanceM: 100, shadowFactor: 0.5 }]],
  ]);
  return { nodes, adj };
}

/**
 * Two-path graph:
 *
 *   1 --[100m, shadow=0]--> 3          (sunny shortcut)
 *   1 --[100m, shadow=1]--> 2 --[100m, shadow=1]--> 3  (shadowed detour, 200m total)
 *
 * shadow=0 Dijkstra: 1→3 direct (cost 100) vs 1→2→3 (cost 200) → 1→3
 * shadow=1 Dijkstra: 1→3 cost=100*(1-0*0.7)=100 vs 1→2→3 cost=2*100*(1-0.7)=60 → 1→2→3
 */
function makeTwoPathGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 3, distanceM: 100, shadowFactor: 0.0 },
         { toId: 2, distanceM: 100, shadowFactor: 1.0 }]],
    [2, [{ toId: 1, distanceM: 100, shadowFactor: 1.0 },
         { toId: 3, distanceM: 100, shadowFactor: 1.0 }]],
    [3, [{ toId: 1, distanceM: 100, shadowFactor: 0.0 },
         { toId: 2, distanceM: 100, shadowFactor: 1.0 }]],
  ]);
  return { nodes, adj };
}

/**
 * Disconnected graph:
 *   1 -- 2    (connected pair)
 *   3          (isolated node)
 */
function makeDisconnectedGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.0, lon: 0.001 }],
    [3, { id: 3, lat: 1.0, lon: 1.000 }], // isolated
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: 100, shadowFactor: 0 }]],
    [2, [{ toId: 1, distanceM: 100, shadowFactor: 0 }]],
    [3, []],
  ]);
  return { nodes, adj };
}

/**
 * Snap test graph — four nodes in a rough square:
 *   1 (lon=0, lat=0) -- 2 (lon=0.01, lat=0)
 *   |                   |
 *   3 (lon=0, lat=0.01) - 4 (lon=0.01, lat=0.01)
 */
function makeSquareGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.00, lon: 0.00 }],
    [2, { id: 2, lat: 0.00, lon: 0.01 }],
    [3, { id: 3, lat: 0.01, lon: 0.00 }],
    [4, { id: 4, lat: 0.01, lon: 0.01 }],
  ]);
  const d = haversineMeters([0, 0], [0.01, 0]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: d, shadowFactor: 0 },
         { toId: 3, distanceM: d, shadowFactor: 0 }]],
    [2, [{ toId: 1, distanceM: d, shadowFactor: 0 },
         { toId: 4, distanceM: d, shadowFactor: 0 }]],
    [3, [{ toId: 1, distanceM: d, shadowFactor: 0 },
         { toId: 4, distanceM: d, shadowFactor: 0 }]],
    [4, [{ toId: 2, distanceM: d, shadowFactor: 0 },
         { toId: 3, distanceM: d, shadowFactor: 0 }]],
  ]);
  return { nodes, adj };
}

// ── Scenario 1: haversineMeters accuracy ──────────────────────────────────────

describe("haversineMeters", () => {
  it("1° longitude at equator ≈ 111 195 m (±50 m)", () => {
    const d = haversineMeters([0, 0], [1, 0]);
    expect(d).toBeGreaterThan(111_145);
    expect(d).toBeLessThan(111_245);
  });

  it("1° latitude ≈ 111 195 m (±50 m)", () => {
    const d = haversineMeters([0, 0], [0, 1]);
    expect(d).toBeGreaterThan(111_145);
    expect(d).toBeLessThan(111_245);
  });

  it("same point → 0 m", () => {
    expect(haversineMeters([13.4, 52.5], [13.4, 52.5])).toBe(0);
  });

  it("is symmetric", () => {
    const a: [number, number] = [2.3, 48.8];
    const b: [number, number] = [-73.9, 40.7];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 3);
  });
});

// ── Scenario 2: dijkstra — direct path, only one route ───────────────────────

describe("dijkstra — linear graph (single path)", () => {
  it("returns path 1→2→3", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual([1, 2, 3]);
  });

  it("distanceM equals sum of edge distances (200 m)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.distanceM).toBeCloseTo(200, 5);
  });

  it("shadowCoverage is weighted average (edge 2→3 has shadow=0.5, 100m each → 0.25)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    // 100m * 0.0 + 100m * 0.5 = 50 shadowed of 200 total → 0.25
    expect(result!.shadowCoverage).toBeCloseTo(0.25, 5);
  });

  it("path nodes are in start→end order (regression: must not be reversed)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    const ids = result!.nodeIds;
    expect(ids[0]).toBe(1); // must start at startId
    expect(ids[ids.length - 1]).toBe(3); // must end at endId
  });
});

// ── Scenario 3: dijkstra — shadow preference changes the chosen path ───────────

describe("dijkstra — two-path graph (shadow vs distance trade-off)", () => {
  it("shadow=0 picks the shortest (direct 1→3, 100 m)", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual([1, 3]);
    expect(result!.distanceM).toBeCloseTo(100, 5);
  });

  it("shadow=1 picks the most-shadowed detour (1→2→3, 200 m, 100% shadow)", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 1.0);
    expect(result).not.toBeNull();
    // Effective cost of 1→2→3: 2 * 100 * (1 - 0.7) = 60 < 100
    expect(result!.nodeIds).toEqual([1, 2, 3]);
    expect(result!.shadowCoverage).toBeCloseTo(1.0, 5);
  });

  it("shortest and most-shadowed produce different nodeId keys (no false dedup)", () => {
    const g1 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const g2 = makeTwoPathGraph();
    const mostShadowed = dijkstra(g2, 1, 3, 1.0)!;
    expect(shortest.nodeIds.join(",")).not.toBe(mostShadowed.nodeIds.join(","));
  });

  it("shadow coverage is 0 on the direct (sunny) edge", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadowCoverage).toBeCloseTo(0.0, 5);
  });
});

// ── Scenario 4: dijkstra — disconnected graph returns null ────────────────────

describe("dijkstra — disconnected graph", () => {
  it("returns null when destination is unreachable", () => {
    const g = makeDisconnectedGraph();
    expect(dijkstra(g, 1, 3, 0)).toBeNull();
  });

  it("returns a result when destination is reachable", () => {
    const g = makeDisconnectedGraph();
    expect(dijkstra(g, 1, 2, 0)).not.toBeNull();
  });
});

// ── Scenario 5: snapToGraph — nearest node selection ─────────────────────────

describe("snapToGraph", () => {
  it("returns the nearest node id", () => {
    const g = makeSquareGraph();
    // Node 1 is at (lon=0, lat=0). Coord at (lon=0.001, lat=0) is closest to 1.
    const nearest = snapToGraph([0.001, 0], g);
    expect(nearest).toBe(1);
  });

  it("returns node 4 when coord is in top-right quadrant", () => {
    const g = makeSquareGraph();
    const nearest = snapToGraph([0.009, 0.009], g);
    expect(nearest).toBe(4);
  });
});

// ── Scenario 6: snapToEdge — mid-edge virtual node insertion ─────────────────

describe("snapToEdge", () => {
  it("inserts a virtual node for a mid-edge coordinate", () => {
    // Simple 2-node graph: 1 at (lon=0,lat=0), 2 at (lon=0.01, lat=0)
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: haversineMeters([0, 0], [0.01, 0]), shadowFactor: 0.5 }]],
        [2, [{ toId: 1, distanceM: haversineMeters([0, 0], [0.01, 0]), shadowFactor: 0.5 }]],
      ]),
    };
    const midLon = 0.005;
    const virtualId = snapToEdge([midLon, 0], graph, -99);
    expect(virtualId).toBe(-99);
    expect(graph.nodes.has(-99)).toBe(true);
    // Virtual node should be wired to both endpoints
    const vEdges = graph.adj.get(-99)!;
    expect(vEdges.some((e) => e.toId === 1)).toBe(true);
    expect(vEdges.some((e) => e.toId === 2)).toBe(true);
  });

  it("returns the endpoint id when coord projects exactly onto an endpoint (t=0)", () => {
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 1000, shadowFactor: 0 }]],
        [2, [{ toId: 1, distanceM: 1000, shadowFactor: 0 }]],
      ]),
    };
    // Project exactly onto node 1
    const id = snapToEdge([0, 0], graph, -1);
    // t=0, so should return bestFromId directly without inserting virtual node
    expect(graph.nodes.has(-1)).toBe(false);
    expect(id).toBe(1);
  });

  it("inherits edge metadata from the split edge", () => {
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 1000, shadowFactor: 0.75, highway: "cycleway", surface: "gravel" }]],
        [2, [{ toId: 1, distanceM: 1000, shadowFactor: 0.75, highway: "cycleway", surface: "gravel" }]],
      ]),
    };
    snapToEdge([0.005, 0], graph, -1);
    const vEdges = graph.adj.get(-1)!;
    expect(vEdges.every((e) => e.shadowFactor === 0.75)).toBe(true);
    expect(vEdges.every((e) => e.highway === "cycleway")).toBe(true);
    expect(vEdges.every((e) => e.surface === "gravel")).toBe(true);
  });
});

// ── Scenario 7: graphToGeoJSON — correct coordinate order ────────────────────

describe("graphToGeoJSON", () => {
  it("produces a GeoJSON LineString with correct coordinates", () => {
    const g = makeLinearGraph();
    const feat = graphToGeoJSON([1, 2, 3], g);
    expect(feat.type).toBe("Feature");
    expect(feat.geometry.type).toBe("LineString");
    const coords = feat.geometry.coordinates;
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual([0.000, 0.0]);
    expect(coords[1]).toEqual([0.001, 0.0]);
    expect(coords[2]).toEqual([0.002, 0.0]);
  });

  it("silently skips unknown node ids", () => {
    const g = makeLinearGraph();
    const feat = graphToGeoJSON([1, 999, 3], g);
    expect(feat.geometry.coordinates).toHaveLength(2);
  });
});

// ── connectRouteEndpoints — route geometry reaches the requested points ───────

describe("connectRouteEndpoints", () => {
  const line = (coords: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  });

  it("prepends start and appends end when the route is snapped onto the road", () => {
    // Route runs along a road; the user's actual pins are off to the side.
    const start: [number, number] = [0.0, 0.0];
    const end: [number, number] = [0.003, 0.0];
    const snapped = line([[0.001, 0.0], [0.002, 0.0]]);
    const out = connectRouteEndpoints(snapped, start, end);
    const c = out.geometry.coordinates;
    expect(c[0]).toEqual(start); // visibly reaches the start pin
    expect(c[c.length - 1]).toEqual(end); // and the end pin
    expect(c).toHaveLength(4);
  });

  it("does not duplicate an endpoint that already coincides with the pin", () => {
    const start: [number, number] = [0.001, 0.0];
    const end: [number, number] = [0.002, 0.0];
    const snapped = line([[0.001, 0.0], [0.0015, 0.0], [0.002, 0.0]]);
    const out = connectRouteEndpoints(snapped, start, end);
    expect(out.geometry.coordinates).toHaveLength(3); // unchanged
  });

  it("handles an empty geometry by returning a direct start→end segment", () => {
    const out = connectRouteEndpoints(line([]), [0, 0], [1, 1]);
    expect(out.geometry.coordinates).toEqual([[0, 0], [1, 1]]);
  });
});

// ── Scenario 8: Regression guard — route ordering and deduplication ───────────

describe("route ordering regression guard", () => {
  it("Most Shadowed shadowCoverage ≥ Shortest shadowCoverage on two-path graph", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const mostShadowed = dijkstra(g2, 1, 3, 1.0)!;
    expect(mostShadowed.shadowCoverage).toBeGreaterThanOrEqual(shortest.shadowCoverage);
  });

  it("Most Shadowed distanceM ≥ Shortest distanceM (shadowed path is a detour here)", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const mostShadowed = dijkstra(g2, 1, 3, 1.0)!;
    expect(mostShadowed.distanceM).toBeGreaterThanOrEqual(shortest.distanceM);
  });

  it("nodeIds from different shadow strengths differ on the two-path graph", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const r0 = dijkstra(g1, 1, 3, 0)!;
    const r1 = dijkstra(g2, 1, 3, 1)!;
    expect(r0.nodeIds.join(",")).not.toBe(r1.nodeIds.join(","));
  });

  it("uniform shadow graph: shadow=0 and shadow=1 produce the same route (adaptive skip)", () => {
    // All edges have shadowFactor=0 → no shadow preference possible
    const g1 = makeLinearGraph();
    const g2 = makeLinearGraph();
    const r0 = dijkstra(g1, 1, 3, 0)!;
    const r1 = dijkstra(g2, 1, 3, 1)!;
    // Same path → dedup check would correctly skip balanced
    expect(r0.nodeIds.join(",")).toBe(r1.nodeIds.join(","));
  });
});

// ── Scenario 9: New RouteResult fields ───────────────────────────────────────

describe("dijkstra — longestContinuousShadowM and shadowTransitions", () => {
  it("linear graph: shadow=0.5 is not > SHADOW_THRESH (0.5), so 0 transitions and 0 streak", () => {
    const g = makeLinearGraph();
    // edge 1→2 shadow=0, edge 2→3 shadow=0.5
    // SHADOW_THRESH=0.5 with strict >: 0.5 > 0.5 = false → both edges sunny
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadowTransitions).toBe(0);
    expect(result!.longestContinuousShadowM).toBe(0);
    // both edges sunny and contiguous → the whole path is one exposed stretch
    expect(result!.longestContinuousSunM).toBeCloseTo(result!.distanceM, 5);
  });

  it("one sunny edge then one shadowed edge → 1 transition, streak = shadowed edge distance", () => {
    // Inline graph: 1→2 sunny, 2→3 shadowed (shadow=0.8 > 0.5 threshold)
    const g: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0.0, lon: 0.000 }],
        [2, { id: 2, lat: 0.0, lon: 0.001 }],
        [3, { id: 3, lat: 0.0, lon: 0.002 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 100, shadowFactor: 0.0 }]],
        [2, [{ toId: 1, distanceM: 100, shadowFactor: 0.0 },
             { toId: 3, distanceM: 100, shadowFactor: 0.8 }]],
        [3, [{ toId: 2, distanceM: 100, shadowFactor: 0.8 }]],
      ]),
    };
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadowTransitions).toBe(1);
    expect(result!.longestContinuousShadowM).toBeCloseTo(100, 5);
    expect(result!.longestContinuousSunM).toBeCloseTo(100, 5);
  });

  it("fully-shadowed path has 0 transitions and streak = total distance", () => {
    const g = makeTwoPathGraph();
    // Most-shadowed path: 1→2→3, both edges shadow=1.0
    const result = dijkstra(g, 1, 3, 1.0);
    expect(result!.shadowTransitions).toBe(0);
    expect(result!.longestContinuousShadowM).toBeCloseTo(200, 5);
    expect(result!.longestContinuousSunM).toBe(0);
  });

  it("fully-sunny path has 0 transitions and streak = 0", () => {
    const g = makeTwoPathGraph();
    // Shortest path: 1→3 direct, shadow=0
    const result = dijkstra(g, 1, 3, 0.0);
    expect(result!.shadowTransitions).toBe(0);
    expect(result!.longestContinuousShadowM).toBe(0);
    expect(result!.longestContinuousSunM).toBeCloseTo(result!.distanceM, 5);
  });

  it("sun streak measures the longest run, not the total sun", () => {
    // 1→2 sun 100 m, 2→3 shadow 100 m, 3→4 sun 200 m. Total sun is 300 m,
    // but the longest unbroken exposure is the 200 m run — the number that
    // distinguishes one crossing from several short gaps.
    const g: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0.0, lon: 0.000 }],
        [2, { id: 2, lat: 0.0, lon: 0.001 }],
        [3, { id: 3, lat: 0.0, lon: 0.002 }],
        [4, { id: 4, lat: 0.0, lon: 0.003 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 100, shadowFactor: 0.0 }]],
        [2, [{ toId: 1, distanceM: 100, shadowFactor: 0.0 },
             { toId: 3, distanceM: 100, shadowFactor: 1.0 }]],
        [3, [{ toId: 2, distanceM: 100, shadowFactor: 1.0 },
             { toId: 4, distanceM: 200, shadowFactor: 0.0 }]],
        [4, [{ toId: 3, distanceM: 200, shadowFactor: 0.0 }]],
      ]),
    };
    const result = dijkstra(g, 1, 4, 0)!;
    expect(result.longestContinuousSunM).toBeCloseTo(200, 5);
    expect(result.longestContinuousShadowM).toBeCloseTo(100, 5);
  });
});

describe("dijkstra — DijkstraOptions", () => {
  it("crossingPenaltyM=50 does not change shortest (no isIntersection flags set)", () => {
    const g = makeTwoPathGraph();
    const r = dijkstra(g, 1, 3, 0, { crossingPenaltyM: 50 });
    expect(r!.nodeIds).toEqual([1, 3]); // same shortest path; no nodes are marked
  });

  it("solarIntensity=0 collapses shadow routing to shortest", () => {
    const g0 = makeTwoPathGraph();
    const g1 = makeTwoPathGraph();
    const r0 = dijkstra(g0, 1, 3, 0,   { solarIntensity: 0 })!;
    const r1 = dijkstra(g1, 1, 3, 1.0, { solarIntensity: 0 })!;
    expect(r0.nodeIds.join(",")).toBe(r1.nodeIds.join(","));
    expect(r1.nodeIds).toEqual([1, 3]); // no shadow benefit → same as shortest
  });

  it("detourRatio > 1 when shadowed path is a detour", () => {
    const g = makeTwoPathGraph();
    // Direct edge 1→3 costs 100m; shadowed detour 1→2→3 costs 200m.
    // Using the direct edge distance (100m) as the straight-line baseline
    // gives detourRatio = 200 / 100 = 2.0 > 1.
    const r = dijkstra(g, 1, 3, 1.0, { straightLineDistM: 100 })!;
    expect(r.detourRatio).toBeGreaterThan(1.0);
  });

  it("detourRatio = 1.0 when straightLineDistM is 0 (default)", () => {
    const g = makeTwoPathGraph();
    const r = dijkstra(g, 1, 3, 1.0)!;
    expect(r.detourRatio).toBe(1.0);
  });
});

// ── Scenario 10: Parallel sidewalk edges ─────────────────────────────────────

describe("dijkstra — parallel sidewalk edges (same fromId→toId, different shadowFactor)", () => {
  function makeParallelEdgeGraph(): RoutingGraph {
    // 1 → 2: two parallel edges (shadowed sidewalk shadow=0.9, sunny sidewalk shadow=0.1)
    // 2 → 3: two parallel edges (both shadowed, shadow=0.8)
    return {
      nodes: new Map([
        [1, { id: 1, lat: 0.0, lon: 0.000 }],
        [2, { id: 2, lat: 0.0, lon: 0.001 }],
        [3, { id: 3, lat: 0.0, lon: 0.002 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 100, shadowFactor: 0.9 },
             { toId: 2, distanceM: 100, shadowFactor: 0.1 }]],
        [2, [{ toId: 1, distanceM: 100, shadowFactor: 0.9 },
             { toId: 1, distanceM: 100, shadowFactor: 0.1 },
             { toId: 3, distanceM: 100, shadowFactor: 0.8 },
             { toId: 3, distanceM: 100, shadowFactor: 0.8 }]],
        [3, [{ toId: 2, distanceM: 100, shadowFactor: 0.8 },
             { toId: 2, distanceM: 100, shadowFactor: 0.8 }]],
      ]),
    };
  }

  it("shadow=1 picks the more shadow sidewalk: shadowCoverage = 0.9 for edge 1→2", () => {
    const g = makeParallelEdgeGraph();
    const result = dijkstra(g, 1, 3, 1.0)!;
    expect(result).not.toBeNull();
    expect(result.nodeIds).toEqual([1, 2, 3]);
    // Edge 1→2: shadowed sidewalk (0.9) chosen; edge 2→3: both 0.8
    // shadowCoverage = (100*0.9 + 100*0.8) / 200 = 0.85
    expect(result.shadowCoverage).toBeCloseTo(0.85, 5);
  });

  it("shadow=0 picks the edge with lower cost (both edges same distanceM, so first found)", () => {
    const g = makeParallelEdgeGraph();
    const result = dijkstra(g, 1, 3, 0.0)!;
    expect(result).not.toBeNull();
    // shadow=0 → cost = distanceM regardless of shadow; both sidewalks identical cost
    expect(result.nodeIds).toEqual([1, 2, 3]);
    expect(result.distanceM).toBeCloseTo(200, 5);
  });

  it("stats reflect the actual edge chosen, not the first edge in the adj list", () => {
    const g = makeParallelEdgeGraph();
    const shadowed = dijkstra(g, 1, 3, 1.0)!;
    // The shadowed sidewalk (0.9) should be chosen for 1→2; not the sunny one (0.1)
    expect(shadowed.shadowCoverage).toBeGreaterThan(0.5);
  });
});

// ── Scenario 11: computeDerivedKpis ──────────────────────────────────────────

import { computeDerivedKpis } from "../metrics";

describe("computeDerivedKpis", () => {
  it("returns nulls when only one route", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadowCoverage: 0.1 },
    ]);
    expect(kpis.shadowCoverageGainPp).toBeNull();
    expect(kpis.pathLengthDeltaPct).toBeNull();
  });

  it("computes shadow gain correctly", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadowCoverage: 0.1 },
      { label: "Most shadowed", distanceM: 250, shadowCoverage: 0.6 },
    ]);
    // (0.6 - 0.1) * 100 = 50 pp
    expect(kpis.shadowCoverageGainPp).toBeCloseTo(50, 5);
  });

  it("computes path length delta correctly", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadowCoverage: 0.1 },
      { label: "Most shadowed", distanceM: 250, shadowCoverage: 0.6 },
    ]);
    // (250 - 200) / 200 * 100 = 25%
    expect(kpis.pathLengthDeltaPct).toBeCloseTo(25, 5);
  });

  it("negative delta when Most Shadowed is somehow shorter (edge case)", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 300, shadowCoverage: 0.0 },
      { label: "Most shadowed", distanceM: 200, shadowCoverage: 1.0 },
    ]);
    // (200 - 300) / 300 * 100 = -33.33%
    expect(kpis.pathLengthDeltaPct).toBeCloseTo(-33.33, 1);
  });
});

import type { RouteOption, TransitLeg } from "../routing";

describe("TransitLeg type (compile-time check)", () => {
  it("RouteOption without transitLeg compiles (pure-walk)", () => {
    const r: RouteOption = {
      label: "Shortest",
      geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      distanceM: 200, shadowCoverage: 0.3, longestContinuousShadowM: 100, longestContinuousSunM: 60,
      shadowTransitions: 1, detourRatio: 1.0, turnCount: 2,
    };
    expect(r.transitLeg).toBeUndefined();
  });

  it("RouteOption with transitLeg compiles", () => {
    const leg: TransitLeg = {
      boardStop:  { id: 1, lat: 48.1, lon: 11.5, name: "Central", mode: "subway" },
      alightStop: { id: 2, lat: 48.2, lon: 11.6, name: "North",   mode: "subway" },
      transitDistM: 1200, sunExposure: 0.0, walkToBoardM: 150, walkFromAlightM: 200,
    };
    const r: RouteOption = {
      label: "Via Transit",
      geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      distanceM: 1550, shadowCoverage: 0.1, longestContinuousShadowM: 0, longestContinuousSunM: 0,
      shadowTransitions: 0, detourRatio: 1.0, turnCount: 0,
      transitLeg: leg,
    };
    expect(r.transitLeg?.sunExposure).toBe(0.0);
  });
});

// ── Graph fixture: two fully disconnected components ──────────────────────────
//
//   Component A (east):  1 --[dAB]--> 2   nodes at lon=0.1 and lon=0.2
//   Component B (west):  3 --[dCD]--> 4   nodes at lon=0.0 and lon=0.01
//
// Used to test that bfsReachable / snapToReachableEdge respect component boundaries.

function makeSplitComponentGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.1 }],
    [2, { id: 2, lat: 0.0, lon: 0.2 }],
    [3, { id: 3, lat: 0.0, lon: 0.0 }],
    [4, { id: 4, lat: 0.0, lon: 0.01 }],
  ]);
  const dAB = haversineMeters([0.1, 0], [0.2, 0]);
  const dCD = haversineMeters([0.0, 0], [0.01, 0]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: dAB, shadowFactor: 0 }]],
    [2, [{ toId: 1, distanceM: dAB, shadowFactor: 0 }]],
    [3, [{ toId: 4, distanceM: dCD, shadowFactor: 0 }]],
    [4, [{ toId: 3, distanceM: dCD, shadowFactor: 0 }]],
  ]);
  return { nodes, adj };
}

// ── Tests: bfsReachable ────────────────────────────────────────────────────────

describe("bfsReachable", () => {
  it("returns all nodes when the graph is fully connected", () => {
    const graph = makeLinearGraph(); // 1-2-3 all connected
    const reachable = bfsReachable(graph, 1);
    expect(reachable).toEqual(new Set([1, 2, 3]));
  });

  it("returns only the component of the start node in a disconnected graph", () => {
    // makeDisconnectedGraph: 1-2 connected, 3 isolated
    const graph = makeDisconnectedGraph();
    const reachable = bfsReachable(graph, 1);
    expect(reachable.has(1)).toBe(true);
    expect(reachable.has(2)).toBe(true);
    expect(reachable.has(3)).toBe(false);
  });

  it("returns only the start node when it is isolated", () => {
    const graph = makeDisconnectedGraph(); // node 3 has no edges
    const reachable = bfsReachable(graph, 3);
    expect(reachable).toEqual(new Set([3]));
  });
});

// ── Tests: snapToReachableEdge ────────────────────────────────────────────────

describe("snapToReachableEdge", () => {
  it("snaps to the nearest reachable edge even when a closer unreachable edge exists", () => {
    // coord sits on edge 3-4 (unreachable component); reachable = {1,2}
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.005, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result).not.toBeNull();
    // Nearest point on the 1-2 edge to coord is endpoint 1 (t clips to 0)
    expect(result!.id).toBe(1);
  });

  it("returns null when no reachable edges exist", () => {
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.005, 0.0];
    const emptyReachable = new Set<number>();

    const result = snapToReachableEdge(coord, graph, emptyReachable, -1);

    expect(result).toBeNull();
  });

  it("returns a snap distance near zero when coord sits on a reachable edge", () => {
    // coord at the midpoint of edge 1-2 (both reachable)
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.15, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result).not.toBeNull();
    expect(result!.distM).toBeLessThan(1); // essentially on the edge
  });

  it("inserts a virtual node wired to the snapped edge endpoints", () => {
    // coord at midpoint of 1-2 — should create virtual node -1
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.15, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result!.id).toBe(-1); // virtual node inserted
    const vAdj = graph.adj.get(-1)!;
    const toIds = vAdj.map((e) => e.toId).sort((a, b) => a - b);
    expect(toIds).toEqual([1, 2]); // wired bidirectionally to 1 and 2
  });
});

// ── Tests: snapRouteStopsToReachableEdges ─────────────────────────────────────

function makeNearbyDisconnectedWaypointGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.0, lon: 0.020 }],
    [3, { id: 3, lat: 0.0002, lon: 0.009 }],
    [4, { id: 4, lat: 0.0002, lon: 0.011 }],
  ]);
  const mainDist = haversineMeters([0, 0], [0.02, 0]);
  const islandDist = haversineMeters([0.009, 0.0002], [0.011, 0.0002]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: mainDist, shadowFactor: 0.2 }]],
    [2, [{ toId: 1, distanceM: mainDist, shadowFactor: 0.2 }]],
    [3, [{ toId: 4, distanceM: islandDist, shadowFactor: 0.9 }]],
    [4, [{ toId: 3, distanceM: islandDist, shadowFactor: 0.9 }]],
  ]);
  return { nodes, adj };
}

describe("snapRouteStopsToReachableEdges", () => {
  it("repairs a via stop that is closest to a disconnected path fragment", () => {
    const graph = makeNearbyDisconnectedWaypointGraph();
    const stops: [number, number][] = [
      [0.001, 0],
      [0.010, 0.0002],
      [0.019, 0],
    ];

    const result = snapRouteStopsToReachableEdges(stops, graph, {
      maxSnapDistanceM: 50,
    });

    expect(result.ids).toHaveLength(3);
    expect(bfsReachable(graph, result.ids[0]).has(result.ids[1])).toBe(true);
    expect(bfsReachable(graph, result.ids[1]).has(result.ids[2])).toBe(true);
    expect(result.snapDistancesM[1]).toBeLessThan(50);
    expect(dijkstra(graph, result.ids[0], result.ids[1], 0)).not.toBeNull();
    expect(dijkstra(graph, result.ids[1], result.ids[2], 0)).not.toBeNull();
  });

  it("fails fast when a disconnected via stop is too far from the route component", () => {
    const graph = makeNearbyDisconnectedWaypointGraph();
    const stops: [number, number][] = [
      [0.001, 0],
      [0.010, 0.0002],
      [0.019, 0],
    ];

    expect(() =>
      snapRouteStopsToReachableEdges(stops, graph, { maxSnapDistanceM: 5 })
    ).toThrow(/stop 2 is \d+ m from the nearest connected walkable street/);
  });
});

// ── Tests: paretoRoutes ───────────────────────────────────────────────────────
//
// Graph coordinates are placed so haversine distances roughly match the stated
// edge distanceM values (0.001° ≈ 111 m at the equator) — paretoRoutes uses a
// straight-line heuristic, which must stay a lower bound on remaining distance.

/** Asserts a route never visits the same node twice (no loops / back-and-forth). */
function expectSimplePath(nodeIds: number[]) {
  expect(new Set(nodeIds).size).toBe(nodeIds.length);
}

/**
 * Shadowed dead-end spur:
 *   1 --[111m, shadow 0]-- 2 --[111m, shadow 0]-- 3
 *                         |
 *                       [55m, shadow 1.0]
 *                         |
 *                         5   (cul-de-sac)
 *
 * The only simple path 1→3 is [1,2,3]. Walking the spur (2→5→2) adds shadowed
 * meters at the cost of distance, so "pump" walks like [1,2,5,2,3] are
 * Pareto-optimal in (distance, shadow-meters) space — but useless as routes.
 */
function makeShadowSpurGraph(): RoutingGraph {
  const d = 111, s = 55;
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0,    lon: 0.000 }],
    [2, { id: 2, lat: 0.0,    lon: 0.001 }],
    [3, { id: 3, lat: 0.0,    lon: 0.002 }],
    [5, { id: 5, lat: 0.0005, lon: 0.001 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: d, shadowFactor: 0 }]],
    [2, [{ toId: 1, distanceM: d, shadowFactor: 0 },
         { toId: 3, distanceM: d, shadowFactor: 0 },
         { toId: 5, distanceM: s, shadowFactor: 1.0 }]],
    [3, [{ toId: 2, distanceM: d, shadowFactor: 0 }]],
    [5, [{ toId: 2, distanceM: s, shadowFactor: 1.0 }]],
  ]);
  return { nodes, adj };
}

/**
 * Shadowed triangle block hanging off the only path — loopable WITHOUT U-turns:
 *   1 --[111m, shadow 0]-- A --[111m, shadow 0]-- 3
 *   A — B — C — A: fully shadowed triangle (111 m + 111 m + ~166 m)
 *
 * [1, A, B, C, A, 3] never immediately backtracks, yet revisits A.
 */
function makeShadowedBlockGraph(): RoutingGraph {
  const A = 10, B = 11, C = 12;
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0,     lon: 0.000 }],
    [A, { id: A, lat: 0.0,     lon: 0.001 }],
    [3, { id: 3, lat: 0.0,     lon: 0.002 }],
    [B, { id: B, lat: -0.001,  lon: 0.001 }],
    [C, { id: C, lat: -0.001,  lon: 0.002 }],
  ]);
  const dAB = 111, dBC = 111, dCA = 166;
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: A, distanceM: 111, shadowFactor: 0 }]],
    [A, [{ toId: 1, distanceM: 111, shadowFactor: 0 },
         { toId: 3, distanceM: 111, shadowFactor: 0 },
         { toId: B, distanceM: dAB, shadowFactor: 1.0 },
         { toId: C, distanceM: dCA, shadowFactor: 1.0 }]],
    [3, [{ toId: A, distanceM: 111, shadowFactor: 0 }]],
    [B, [{ toId: A, distanceM: dAB, shadowFactor: 1.0 },
         { toId: C, distanceM: dBC, shadowFactor: 1.0 }]],
    [C, [{ toId: B, distanceM: dBC, shadowFactor: 1.0 },
         { toId: A, distanceM: dCA, shadowFactor: 1.0 }]],
  ]);
  return { nodes, adj };
}

/**
 * Extreme detour: direct sunny 111 m vs fully-shadowed ~1116 m (10×) via node 4.
 */
function makeLongDetourGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0,   lon: 0.000 }],
    [3, { id: 3, lat: 0.0,   lon: 0.001 }],
    [4, { id: 4, lat: 0.005, lon: 0.0005 }],
  ]);
  const dLeg = haversineMeters([0.0, 0.0], [0.0005, 0.005]); // ≈ 558 m
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 3, distanceM: 111,  shadowFactor: 0 },
         { toId: 4, distanceM: dLeg, shadowFactor: 1.0 }]],
    [3, [{ toId: 1, distanceM: 111,  shadowFactor: 0 },
         { toId: 4, distanceM: dLeg, shadowFactor: 1.0 }]],
    [4, [{ toId: 1, distanceM: dLeg, shadowFactor: 1.0 },
         { toId: 3, distanceM: dLeg, shadowFactor: 1.0 }]],
  ]);
  return { nodes, adj };
}

/**
 * Deterministic n×n city grid, 4-connected, ~111 m spacing, per-edge shadow
 * from an integer hash. Start = corner (0,0), end = corner (n-1,n-1).
 */
function makeGridGraph(n: number): { graph: RoutingGraph; startId: number; endId: number } {
  const nodes = new Map<number, OsmNode>();
  const adj = new Map<number, GraphEdge[]>();
  const id = (r: number, c: number) => r * n + c + 1;
  const D = 111.195;
  const shadowAt = (r: number, c: number, horizontal: boolean) =>
    (((r * 31 + c * 17 + (horizontal ? 7 : 0)) % 100) / 100);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      nodes.set(id(r, c), { id: id(r, c), lat: r * 0.001, lon: c * 0.001 });
      adj.set(id(r, c), []);
    }
  }
  const link = (a: number, b: number, shadow: number) => {
    adj.get(a)!.push({ toId: b, distanceM: D, shadowFactor: shadow });
    adj.get(b)!.push({ toId: a, distanceM: D, shadowFactor: shadow });
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (c + 1 < n) link(id(r, c), id(r, c + 1), shadowAt(r, c, true));
      if (r + 1 < n) link(id(r, c), id(r + 1, c), shadowAt(r, c, false));
    }
  }
  return { graph: { nodes, adj }, startId: id(0, 0), endId: id(n - 1, n - 1) };
}

describe("paretoRoutes — basic front selection", () => {
  it("two-path graph: returns the direct route first and the shadowed detour", () => {
    const g = makeTwoPathGraph();
    const routes = paretoRoutes(g, 1, 3);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].nodeIds).toEqual([1, 3]); // shortest first
    const mostShadowed = routes[routes.length - 1];
    expect(mostShadowed.nodeIds).toEqual([1, 2, 3]);
    expect(mostShadowed.shadowCoverage).toBeCloseTo(1.0, 5);
  });

  it("uniform-shadow graph: collapses to a single deduplicated route", () => {
    const g = makeLinearGraph();
    const routes = paretoRoutes(g, 1, 3);
    expect(routes).toHaveLength(1);
    expect(routes[0].nodeIds).toEqual([1, 2, 3]);
  });

  it("returns [] when the destination is unreachable", () => {
    const g = makeDisconnectedGraph();
    expect(paretoRoutes(g, 1, 3)).toEqual([]);
  });
});

describe("paretoRoutes — routes must be simple paths (no loops, no back-and-forth)", () => {
  it("never pumps shadow by walking a shadowed cul-de-sac and back", () => {
    const g = makeShadowSpurGraph();
    const routes = paretoRoutes(g, 1, 3);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    for (const r of routes) expectSimplePath(r.nodeIds);
    // Only one simple path exists → exactly one route
    expect(routes).toHaveLength(1);
    expect(routes[0].nodeIds).toEqual([1, 2, 3]);
  });

  it("never loops around a shadowed block (revisit without immediate backtrack)", () => {
    const g = makeShadowedBlockGraph();
    const routes = paretoRoutes(g, 1, 3);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    for (const r of routes) expectSimplePath(r.nodeIds);
  });

  it("grid: all returned routes are simple paths", () => {
    const { graph, startId, endId } = makeGridGraph(12);
    const routes = paretoRoutes(graph, startId, endId);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.length).toBeLessThanOrEqual(3);
    for (const r of routes) expectSimplePath(r.nodeIds);
  });
});

describe("paretoRoutes — detour budget", () => {
  it("default budget excludes absurd detours (10× shadowed loop not offered)", () => {
    const g = makeLongDetourGraph();
    const routes = paretoRoutes(g, 1, 3);
    // shortest = 111 m → budget = 111 × 2 + 250 = 472 m; the 1116 m detour is out
    for (const r of routes) {
      expect(r.distanceM).toBeLessThanOrEqual(472);
    }
    expect(routes[0].nodeIds).toEqual([1, 3]);
  });

  it("maxDetourFactor option admits longer detours", () => {
    const g = makeLongDetourGraph();
    const routes = paretoRoutes(g, 1, 3, { maxDetourFactor: 12 });
    const mostShadowed = routes[routes.length - 1];
    expect(mostShadowed.nodeIds).toEqual([1, 4, 3]);
    expect(mostShadowed.shadowCoverage).toBeCloseTo(1.0, 5);
  });

  it("grid: every route respects the default budget relative to the shortest", () => {
    const { graph, startId, endId } = makeGridGraph(12);
    const routes = paretoRoutes(graph, startId, endId);
    const shortest = routes[0].distanceM;
    for (const r of routes) {
      expect(r.distanceM).toBeLessThanOrEqual(shortest * 2 + 250);
    }
    // Absolute shadowed meters grow along the front: last (most shadowed) ≥ first (shortest)
    const first = routes[0];
    const last = routes[routes.length - 1];
    expect(last.shadowCoverage * last.distanceM)
      .toBeGreaterThanOrEqual(first.shadowCoverage * first.distanceM - 1e-9);
  });
});

// ── Sidewalk sides (#147) ──────────────────────────────────────────────────────

/**
 * A street of `segments` collinear nodes, each segment carrying the two parallel
 * per-sidewalk edges `useNavigation` builds — one labelled "left", one "right",
 * relative to that directed edge's own direction of travel.
 *
 * `shadowedSide[i]` says which sidewalk is in shadow on segment i, so a test can make
 * the search prefer a known side and then assert it was reported.
 */
function makeSidewalkGraph(shadowedSide: Array<"left" | "right">): RoutingGraph {
  const n = shadowedSide.length + 1;
  const nodes = new Map<number, OsmNode>();
  for (let i = 1; i <= n; i++) {
    nodes.set(i, { id: i, lat: 0, lon: (i - 1) * 0.001 });
  }
  const adj = new Map<number, GraphEdge[]>();
  for (let i = 1; i <= n; i++) adj.set(i, []);

  for (let i = 0; i < shadowedSide.length; i++) {
    const a = i + 1;
    const b = i + 2;
    const leftShadow = shadowedSide[i] === "left" ? 1 : 0;
    const rightShadow = shadowedSide[i] === "right" ? 1 : 0;
    // Forward (canonical: a < b) — left-of-canonical is the traveller's left.
    adj.get(a)!.push(
      { toId: b, distanceM: 100, shadowFactor: leftShadow, side: "left" },
      { toId: b, distanceM: 100, shadowFactor: rightShadow, side: "right" }
    );
    // Reverse (b > a, so against canonical) — the traveller now faces the other
    // way, so the sidewalk that is left-of-canonical is on their right.
    adj.get(b)!.push(
      { toId: a, distanceM: 100, shadowFactor: rightShadow, side: "left" },
      { toId: a, distanceM: 100, shadowFactor: leftShadow, side: "right" }
    );
  }
  return { nodes, adj };
}

describe("sidewalk side reporting", () => {
  it("names the side dijkstra actually costed", () => {
    const graph = makeSidewalkGraph(["left", "right", "left"]);
    const res = dijkstra(graph, 1, 4, 1);
    expect(res).not.toBeNull();
    expect(res?.sides).toEqual(["left", "right", "left"]);
  });

  it("reports sides relative to travel direction, not to node ordering", () => {
    // Same street walked backwards. Shadow is a property of the physical sidewalk,
    // so walking 4→1 the shadowed side flips to the traveller's other hand. A naive
    // implementation that ignores canonicality returns the forward answer reversed.
    const graph = makeSidewalkGraph(["left", "right", "left"]);
    const res = dijkstra(graph, 4, 1, 1);
    expect(res).not.toBeNull();
    expect(res?.sides).toEqual(["right", "left", "right"]);
  });

  it("is one shorter than nodeIds", () => {
    const graph = makeSidewalkGraph(["left", "left"]);
    const res = dijkstra(graph, 1, 3, 1);
    expect(res?.nodeIds).toHaveLength(3);
    expect(res?.sides).toHaveLength(2);
  });

  it("reports null where the graph carries no per-sidewalk edges", () => {
    // The linear fixture has plain edges — every segment is unlabelled, not absent.
    const res = dijkstra(makeLinearGraph(), 1, 3, 0);
    expect(res?.sides).toEqual([null, null]);
  });

  it("reports sides through paretoRoutes, which is a separate implementation", () => {
    const graph = makeSidewalkGraph(["left", "right", "left"]);
    const routes = paretoRoutes(graph, 1, 4, { maxDetourFactor: 2 });
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.sides).toHaveLength(r.nodeIds.length - 1);
      // Whichever Pareto member this is, every reported side must be one the
      // graph actually offers for that segment.
      for (const side of r.sides ?? []) expect(["left", "right"]).toContain(side);
    }
    const mostShadowed = routes[routes.length - 1];
    expect(mostShadowed.sides).toEqual(["left", "right", "left"]);
  });

  it("is purely additive — no aggregate moves", () => {
    // The regression guard. If labelling changed which edge the search picked,
    // these would drift, and every shadow number in the product with them.
    const graph = makeSidewalkGraph(["left", "left", "left"]);
    const res = dijkstra(graph, 1, 4, 1)!;
    expect(res.distanceM).toBe(300);
    expect(res.shadowCoverage).toBe(1);
    expect(res.longestContinuousShadowM).toBe(300);
    expect(res.longestContinuousSunM).toBe(0);
    expect(res.shadowTransitions).toBe(0);
    expect(res.turnCount).toBe(0);
  });

  it("switching sides currently costs nothing — the zigzag #147 warns about", () => {
    // Not a desired behaviour, pinned so it is visible rather than surprising.
    // The parallel edges share toId and distanceM, so alternating shadow makes the
    // optimal path cross the street on every segment for free. Charging for that
    // needs the search keyed on (node, side); tracked separately.
    const alternating: Array<"left" | "right"> = [
      "left", "right", "left", "right", "left", "right", "left", "right",
    ];
    const res = dijkstra(makeSidewalkGraph(alternating), 1, 9, 1)!;
    expect(res.sides).toEqual(alternating);
    let flips = 0;
    for (let i = 1; i < (res.sides ?? []).length; i++) {
      if (res.sides![i] !== res.sides![i - 1]) flips++;
    }
    // 7 crossings in 800 m — roughly one every 114 m, against B6's ≤1 per 400 m.
    expect(flips).toBe(7);
  });
});

describe("parallelSidewalkEdges", () => {
  // sampleBothSidewalks reports relative to the canonical direction (low id → high).
  // Here the canonical-left kerb is fully shadowed and canonical-right is in full sun.
  const CANON_LEFT = 1;
  const CANON_RIGHT = 0;

  /** The plain street edge overpass.ts builds, before shadow sampling splits it. */
  const srcEdge = (toId: number, tags: Partial<GraphEdge> = {}): GraphEdge =>
    ({ toId, distanceM: 100, shadowFactor: 0, ...tags });

  it("walking canonically, canonical-left is the traveller's left", () => {
    const [left, right] = parallelSidewalkEdges(1, srcEdge(2), CANON_LEFT, CANON_RIGHT);
    expect(left.side).toBe("left");
    expect(left.shadowFactor).toBe(CANON_LEFT);
    expect(right.side).toBe("right");
    expect(right.shadowFactor).toBe(CANON_RIGHT);
  });

  it("walking against canonical, the shadowed kerb moves to the traveller's right", () => {
    // Same physical street, opposite direction. This is the assertion that fails if
    // the canonicality flip is dropped or inverted — the bug this helper exists to
    // make visible, and which is invisible at pitch 0 and in every aggregate.
    const [left, right] = parallelSidewalkEdges(2, srcEdge(1), CANON_LEFT, CANON_RIGHT);
    expect(left.side).toBe("left");
    expect(left.shadowFactor).toBe(CANON_RIGHT);
    expect(right.side).toBe("right");
    expect(right.shadowFactor).toBe(CANON_LEFT);
  });

  it("labels are always left-then-right regardless of direction", () => {
    for (const [a, b] of [[1, 2], [2, 1]] as const) {
      const pair = parallelSidewalkEdges(a, srcEdge(b), 0.3, 0.7);
      expect(pair.map((e) => e.side)).toEqual(["left", "right"]);
      expect(pair.every((e) => e.toId === b && e.distanceM === 100)).toBe(true);
    }
  });

  it("keeps both kerbs' shadow — the pair carries the same two values either way", () => {
    const fwd = parallelSidewalkEdges(1, srcEdge(2), 0.3, 0.7).map((e) => e.shadowFactor);
    const rev = parallelSidewalkEdges(2, srcEdge(1), 0.3, 0.7).map((e) => e.shadowFactor);
    expect([...fwd].sort()).toEqual([...rev].sort());
    expect(fwd).not.toEqual(rev);
  });

  it("carries the source edge's OSM access tags onto both sidewalks", () => {
    // The split is where access tags used to vanish: an untagged edge reads as
    // "no restriction" to every predicate, so a footway=no street looks walkable.
    const tags = {
      highway: "footway",
      surface: "asphalt",
      cycleway: "lane",
      bicycle: "designated",
      foot: "no",
    };
    for (const [a, b] of [[1, 2], [2, 1]] as const) {
      for (const edge of parallelSidewalkEdges(a, srcEdge(b, tags), 0.3, 0.7)) {
        expect(edge).toMatchObject(tags);
      }
    }
  });
});

// ── E1: travel-mode cost model ───────────────────────────────────────────────
// Behavior: given this graph and this mode, this path wins. Shadow strength is
// 0 throughout so only the mode policy decides.

/**
 * Stairs shortcut: 1→3 direct over steps (100 m) vs 1→2→3 on footways (200 m).
 */
function makeStairsShortcutGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.0 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [
      { toId: 3, distanceM: 100, shadowFactor: 0, highway: "steps" },
      { toId: 2, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
    [2, [
      { toId: 1, distanceM: 100, shadowFactor: 0, highway: "footway" },
      { toId: 3, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
    [3, [
      { toId: 1, distanceM: 100, shadowFactor: 0, highway: "steps" },
      { toId: 2, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
  ]);
  return { nodes, adj };
}

/**
 * Rough shortcut: 1→3 direct on cobblestones (100 m) vs 1→2→3 on asphalt (160 m).
 */
function makeRoughShortcutGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.0 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [
      { toId: 3, distanceM: 100, shadowFactor: 0, surface: "cobblestone" },
      { toId: 2, distanceM: 80, shadowFactor: 0, surface: "asphalt" },
    ]],
    [2, [
      { toId: 1, distanceM: 80, shadowFactor: 0, surface: "asphalt" },
      { toId: 3, distanceM: 80, shadowFactor: 0, surface: "asphalt" },
    ]],
    [3, [
      { toId: 1, distanceM: 100, shadowFactor: 0, surface: "cobblestone" },
      { toId: 2, distanceM: 80, shadowFactor: 0, surface: "asphalt" },
    ]],
  ]);
  return { nodes, adj };
}

/**
 * Cycleway detour: 1→3 direct with no cycleway (200 m) vs 1→2→3 on
 * cycleway lanes (220 m). Walk takes the shortcut; bike takes the lanes.
 */
function makeCyclewayGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.0 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [
      { toId: 3, distanceM: 200, shadowFactor: 0 },
      { toId: 2, distanceM: 110, shadowFactor: 0, cycleway: "lane" },
    ]],
    [2, [
      { toId: 1, distanceM: 110, shadowFactor: 0, cycleway: "lane" },
      { toId: 3, distanceM: 110, shadowFactor: 0, cycleway: "lane" },
    ]],
    [3, [
      { toId: 1, distanceM: 200, shadowFactor: 0 },
      { toId: 2, distanceM: 110, shadowFactor: 0, cycleway: "lane" },
    ]],
  ]);
  return { nodes, adj };
}

describe("dijkstra — travel mode cost (E1)", () => {
  it("walk takes the stairs shortcut; bike walks around it", () => {
    expect(dijkstra(makeStairsShortcutGraph(), 1, 3, 0)!.nodeIds).toEqual([1, 3]);
    expect(
      dijkstra(makeStairsShortcutGraph(), 1, 3, 0, { travelMode: "bike" })!.nodeIds,
    ).toEqual([1, 2, 3]);
  });

  it("walk takes the cobbled shortcut; bike takes smooth asphalt", () => {
    expect(dijkstra(makeRoughShortcutGraph(), 1, 3, 0)!.nodeIds).toEqual([1, 3]);
    expect(
      dijkstra(makeRoughShortcutGraph(), 1, 3, 0, { travelMode: "bike" })!.nodeIds,
    ).toEqual([1, 2, 3]);
  });

  it("walk takes the shorter road; bike prefers the cycleway detour", () => {
    expect(dijkstra(makeCyclewayGraph(), 1, 3, 0)!.nodeIds).toEqual([1, 3]);
    expect(
      dijkstra(makeCyclewayGraph(), 1, 3, 0, { travelMode: "bike" })!.nodeIds,
    ).toEqual([1, 2, 3]);
  });

  it("reported distance stays physical meters, not cost meters", () => {
    const result = dijkstra(makeStairsShortcutGraph(), 1, 3, 0, { travelMode: "bike" })!;
    expect(result.nodeIds).toEqual([1, 2, 3]);
    expect(result.distanceM).toBeCloseTo(200, 5);
  });
});

describe("paretoRoutes — travel mode cost (E1)", () => {
  it("bike mode keeps the untagged front intact (shortest first, detour last)", () => {
    const routes = paretoRoutes(makeTwoPathGraph(), 1, 3, { travelMode: "bike" });
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].nodeIds).toEqual([1, 3]);
    expect(routes[routes.length - 1].nodeIds).toEqual([1, 2, 3]);
    const keys = new Set(routes.map((r) => r.nodeIds.join(",")));
    expect(keys.size).toBe(routes.length);
  });

  it("bike mode prices the stairs shortcut out of the front", () => {
    const routes = paretoRoutes(makeStairsShortcutGraph(), 1, 3, { travelMode: "bike" });
    expect(routes.length).toBeGreaterThan(0);
    // Every returned route avoids steps: the 600 m-cost shortcut never wins a
    // representative against the 200 m footway path.
    for (const r of routes) {
      expect(r.nodeIds).toEqual([1, 2, 3]);
    }
  });
});

/**
 * Dedicated-cycleway detour: 1→3 direct on an ordinary road (200 m) vs
 * 1→2→3 on highway=cycleway (220 m). Walk takes the shortcut.
 */
function makeDedicatedCyclewayGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.0 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [
      { toId: 3, distanceM: 200, shadowFactor: 0, highway: "residential" },
      { toId: 2, distanceM: 110, shadowFactor: 0, highway: "cycleway" },
    ]],
    [2, [
      { toId: 1, distanceM: 110, shadowFactor: 0, highway: "cycleway" },
      { toId: 3, distanceM: 110, shadowFactor: 0, highway: "cycleway" },
    ]],
    [3, [
      { toId: 1, distanceM: 200, shadowFactor: 0, highway: "residential" },
      { toId: 2, distanceM: 110, shadowFactor: 0, highway: "cycleway" },
    ]],
  ]);
  return { nodes, adj };
}

/**
 * Prohibited shortcut: 1→3 direct bans bikes (100 m, bicycle=no) vs 1→2→3
 * ordinary footways (200 m). Walk takes the shortcut.
 */
function makeBicycleNoGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.0 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [
      { toId: 3, distanceM: 100, shadowFactor: 0, highway: "residential", bicycle: "no" },
      { toId: 2, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
    [2, [
      { toId: 1, distanceM: 100, shadowFactor: 0, highway: "footway" },
      { toId: 3, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
    [3, [
      { toId: 1, distanceM: 100, shadowFactor: 0, highway: "residential", bicycle: "no" },
      { toId: 2, distanceM: 100, shadowFactor: 0, highway: "footway" },
    ]],
  ]);
  return { nodes, adj };
}

describe("dijkstra — bike infrastructure and access tags (E1 follow-up)", () => {
  it("walk takes the ordinary road; bike takes the dedicated-cycleway detour", () => {
    expect(dijkstra(makeDedicatedCyclewayGraph(), 1, 3, 0)!.nodeIds).toEqual([1, 3]);
    expect(
      dijkstra(makeDedicatedCyclewayGraph(), 1, 3, 0, { travelMode: "bike" })!.nodeIds,
    ).toEqual([1, 2, 3]);
  });

  it("walk takes the bicycle=no shortcut; bike routes around it", () => {
    expect(dijkstra(makeBicycleNoGraph(), 1, 3, 0)!.nodeIds).toEqual([1, 3]);
    expect(
      dijkstra(makeBicycleNoGraph(), 1, 3, 0, { travelMode: "bike" })!.nodeIds,
    ).toEqual([1, 2, 3]);
  });

  it("bike reports unreachable when only a prohibited edge connects", () => {
    const nodes = new Map<number, OsmNode>([
      [1, { id: 1, lat: 0.0, lon: 0.0 }],
      [2, { id: 2, lat: 0.0, lon: 0.001 }],
    ]);
    const prohibited: RoutingGraph = {
      nodes,
      adj: new Map<number, GraphEdge[]>([
        [1, [{ toId: 2, distanceM: 100, shadowFactor: 0, bicycle: "no" }]],
        [2, [{ toId: 1, distanceM: 100, shadowFactor: 0, bicycle: "no" }]],
      ]),
    };
    expect(dijkstra(prohibited, 1, 2, 0)!).not.toBeNull();
    expect(dijkstra(prohibited, 1, 2, 0, { travelMode: "bike" })).toBeNull();
    expect(paretoRoutes(prohibited, 1, 2, { travelMode: "bike" })).toEqual([]);
  });
});

describe("paretoRoutes — prohibited edges (E1 follow-up)", () => {
  it("no bike representative uses a bicycle=no edge", () => {
    const routes = paretoRoutes(makeBicycleNoGraph(), 1, 3, { travelMode: "bike" });
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.nodeIds).toEqual([1, 2, 3]);
    }
  });
});

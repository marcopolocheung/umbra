/**
 * Seam correctness for the static street adapter: a sharded twin of an
 * Overpass fixture must reconstruct the same `RoutingGraph` behavior as the
 * unsharded source — same reachable components, same edge tags, same route
 * distances, same selected paths.
 *
 * The fixture is a five-node network split across two owner cells with one
 * seam-crossing way, ghost endpoint nodes on both sides, one exact-duplicate
 * seam edge published by both cells, and a closed `highway=pedestrian` plaza
 * that both builders must exclude. Shard `distanceM` values are computed with
 * the same `haversineMeters` the producer uses, so parity is exact — no
 * tolerance is needed or granted. A documented tolerance would only enter if
 * a future producer quantizes coordinates.
 */

import { describe, expect, it } from "vitest";
import {
  bfsReachable,
  dijkstra,
  haversineMeters,
  paretoRoutes,
  reachableFrom,
  type RoutingGraph,
} from "../../routing";
import { buildRoutingGraphFromElements, type OverpassWayElement } from "../../overpass";
import { buildRoutingGraphFromStreetShards } from "../routingGraphAdapter";
import type {
  NavigationStreetEdge,
  NavigationStreetNode,
  NavigationStreetShard,
} from "../shardContract";

const generation = "nyc-2026-09-18-abcdef123456";

// ─── Shared geometry: node id → [lon, lat] ──────────────────────────────────

const coords: Record<number, [number, number]> = {
  101: [-73.99, 40.75],
  102: [-73.99, 40.751],
  103: [-73.99, 40.752],
  201: [-73.988, 40.751],
  202: [-73.986, 40.751],
};

function dist(a: number, b: number): number {
  return haversineMeters(coords[a], coords[b]);
}

// ─── Unsharded Overpass source ───────────────────────────────────────────────

function overpassWays(): OverpassWayElement[] {
  const way = (
    nodes: number[],
    tags: Record<string, string>,
  ): OverpassWayElement => ({
    type: "way",
    nodes,
    geometry: nodes.map((id) => ({ lat: coords[id][1], lon: coords[id][0] })),
    tags,
  });
  return [
    way([101, 102, 103], { highway: "residential", surface: "asphalt" }),
    // Seam-crossing way: cell A owns 102→201, cell B owns 201→102.
    way([102, 201], { highway: "footway", foot: "yes" }),
    way([201, 202], { highway: "steps" }),
    // Closed pedestrian plaza: an area polygon, not a walkable path.
    way([301, 302, 303, 301], { highway: "pedestrian" }),
  ];
}

// Plaza ring geometry is irrelevant — the builder skips the way before
// reading it — but the node refs must exist for the fixture to be well-formed.
coords[301] = [-73.989, 40.7505];
coords[302] = [-73.9885, 40.7505];
coords[303] = [-73.9885, 40.7508];

// ─── Sharded twin ────────────────────────────────────────────────────────────

function shardNode(id: number, isIntersection: boolean): NavigationStreetNode {
  return { id, lat: coords[id][1], lon: coords[id][0], isIntersection };
}

function shardEdge(
  id: string,
  from: number,
  to: number,
  tags: Record<string, string>,
): NavigationStreetEdge {
  return { id, from, to, distanceM: dist(from, to), tags };
}

function cellA(): NavigationStreetShard {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds: { south: 40.749, west: -73.991, north: 40.753, east: -73.989 },
    supportBounds: { south: 40.748, west: -73.992, north: 40.754, east: -73.988 },
    nodes: [
      shardNode(101, false),
      shardNode(102, true),
      shardNode(103, false),
      // Ghost endpoint across the seam. The owner cell (B) records 201 as an
      // intersection; this copy saw only one way and says false — the merge
      // must take the OR, not reject the staleness.
      shardNode(201, false),
    ],
    edges: [
      shardEdge("w1-101-102", 101, 102, { highway: "residential", surface: "asphalt" }),
      shardEdge("w1-102-101", 102, 101, { highway: "residential", surface: "asphalt" }),
      shardEdge("w1-102-103", 102, 103, { highway: "residential", surface: "asphalt" }),
      shardEdge("w1-103-102", 103, 102, { highway: "residential", surface: "asphalt" }),
      shardEdge("w2-102-201", 102, 201, { highway: "footway", foot: "yes" }),
    ],
  };
}

function cellB(): NavigationStreetShard {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds: { south: 40.749, west: -73.989, north: 40.753, east: -73.985 },
    supportBounds: { south: 40.748, west: -73.99, north: 40.754, east: -73.984 },
    nodes: [shardNode(201, true), shardNode(202, false), shardNode(102, true)],
    edges: [
      shardEdge("w2-201-102", 201, 102, { highway: "footway", foot: "yes" }),
      // Exact duplicate of cell A's seam edge: same pair, distance, and tags
      // under a different record id. The merge keeps one copy.
      shardEdge("w2-102-201-dup", 102, 201, { highway: "footway", foot: "yes" }),
      shardEdge("w3-201-202", 201, 202, { highway: "steps" }),
      shardEdge("w3-202-201", 202, 201, { highway: "steps" }),
    ],
  };
}

function referenceGraph(): RoutingGraph {
  // Through a JSON byte round-trip, so the reference enters through the same
  // boundary a captured Overpass response would — no shared object identity
  // with the sharded twin below.
  const captured = JSON.stringify(overpassWays());
  return buildRoutingGraphFromElements(JSON.parse(captured) as OverpassWayElement[]);
}

function staticGraph(): RoutingGraph {
  return buildRoutingGraphFromStreetShards([cellA(), cellB()]);
}

// ─── Canonical comparison ────────────────────────────────────────────────────

interface CanonicalEdge {
  toId: number;
  distanceM: number;
  highway?: string;
  surface?: string;
  smoothness?: string;
  cycleway?: string;
  bicycle?: string;
  foot?: string;
  access?: string;
}

function canonical(graph: RoutingGraph): Map<number, CanonicalEdge[]> {
  const out = new Map<number, CanonicalEdge[]>();
  for (const [id, edges] of graph.adj) {
    out.set(
      id,
      edges
        .map((edge) => ({
          toId: edge.toId,
          distanceM: edge.distanceM,
          highway: edge.highway,
          surface: edge.surface,
          smoothness: edge.smoothness,
          cycleway: edge.cycleway,
          bicycle: edge.bicycle,
          foot: edge.foot,
          access: edge.access,
        }))
        .sort((a, b) => a.toId - b.toId),
    );
  }
  return out;
}

describe("routingGraphAdapter parity with the Overpass builder", () => {
  it("reconstructs the same nodes, flags, and directed edges", () => {
    const reference = referenceGraph();
    const merged = staticGraph();

    expect([...merged.nodes.keys()].sort((a, b) => a - b)).toEqual(
      [...reference.nodes.keys()].sort((a, b) => a - b),
    );
    for (const [id, node] of reference.nodes) {
      expect(merged.nodes.get(id)).toEqual(node);
    }
    // No plaza nodes leak in from either builder.
    expect(merged.nodes.has(301)).toBe(false);

    const refAdj = canonical(reference);
    const mergedAdj = canonical(merged);
    expect([...mergedAdj.keys()].sort((a, b) => a - b)).toEqual(
      [...refAdj.keys()].sort((a, b) => a - b),
    );
    for (const [id, edges] of refAdj) {
      expect(mergedAdj.get(id)).toEqual(edges);
    }
  });

  it("shadowFactor starts at 0 on every merged edge", () => {
    for (const edges of staticGraph().adj.values()) {
      for (const edge of edges) expect(edge.shadowFactor).toBe(0);
    }
  });

  it("agrees on reachable components from every node", () => {
    const reference = referenceGraph();
    const merged = staticGraph();
    for (const id of reference.nodes.keys()) {
      expect([...reachableFrom(merged, id)].sort((a, b) => a - b)).toEqual(
        [...reachableFrom(reference, id)].sort((a, b) => a - b),
      );
      expect([...bfsReachable(merged, id)].sort((a, b) => a - b)).toEqual(
        [...bfsReachable(reference, id)].sort((a, b) => a - b),
      );
    }
  });

  it("selects the same paths at the same distances", () => {
    const reference = referenceGraph();
    const merged = staticGraph();
    const pairs: Array<[number, number]> = [
      [101, 202],
      [101, 103],
      [103, 202],
      [202, 101],
    ];
    for (const [from, to] of pairs) {
      for (const shadowStrength of [0, 1]) {
        const refRoute = dijkstra(reference, from, to, shadowStrength);
        const mergedRoute = dijkstra(merged, from, to, shadowStrength);
        expect(mergedRoute?.nodeIds).toEqual(refRoute?.nodeIds);
        expect(mergedRoute?.distanceM).toBe(refRoute?.distanceM);
      }
    }
    const refPareto = paretoRoutes(reference, 101, 202).map((route) => ({
      nodeIds: route.nodeIds,
      distanceM: route.distanceM,
    }));
    const mergedPareto = paretoRoutes(merged, 101, 202).map((route) => ({
      nodeIds: route.nodeIds,
      distanceM: route.distanceM,
    }));
    expect(mergedPareto).toEqual(refPareto);
  });
});

describe("routingGraphAdapter conflict rejection", () => {
  it("rejects coordinate conflicts for a shared node id", () => {
    const ghost = cellB();
    ghost.nodes = ghost.nodes.map((node) =>
      node.id === 201 ? { ...node, lon: -73.0 } : node,
    );
    expect(() => buildRoutingGraphFromStreetShards([cellA(), ghost])).toThrow(
      /disagree on node 201 coordinates/,
    );
  });

  it("rejects tag conflicts for a shared directed pair", () => {
    const other = cellB();
    other.edges = other.edges.map((edge) =>
      edge.id === "w2-102-201-dup"
        ? { ...edge, tags: { highway: "footway", foot: "no" } }
        : edge,
    );
    expect(() => buildRoutingGraphFromStreetShards([cellA(), other])).toThrow(
      /disagree on edge 102→201/,
    );
  });

  it("rejects distance conflicts for a shared directed pair", () => {
    const other = cellB();
    other.edges = other.edges.map((edge) =>
      edge.id === "w2-102-201-dup" ? { ...edge, distanceM: edge.distanceM + 1 } : edge,
    );
    expect(() => buildRoutingGraphFromStreetShards([cellA(), other])).toThrow(
      /disagree on edge 102→201/,
    );
  });

  it("rejects edges referencing unpublished nodes", () => {
    const orphan = cellA();
    orphan.nodes = orphan.nodes.filter((node) => node.id !== 201);
    expect(() => buildRoutingGraphFromStreetShards([orphan])).toThrow(
      /references an unpublished node/,
    );
  });

  it("merges a lone shard without cross-shard input", () => {
    const merged = buildRoutingGraphFromStreetShards([cellA()]);
    expect(merged.nodes.size).toBe(4);
    expect(merged.nodes.get(201)?.isIntersection).toBe(false);
  });
});

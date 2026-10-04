/**
 * `toCompactGraph` — the CSR layout the L3b search runs over, and the one H3's
 * target-less search and the L3c worker will share. What a search relies on:
 * every reachable id has an index (including edge targets with no node record
 * and negative virtual snap ids), each node's edges keep `adj` order (search
 * order and tie-breaks follow it), and node attributes land at the right index.
 *
 * Deterministic, no network. Run with: npm test
 */

import { describe, expect, it } from "vitest";
import { toCompactGraph } from "../compactGraph";
import type { GraphEdge, RoutingGraph } from "../routing";

const edge = (toId: number, distanceM: number): GraphEdge => ({ toId, distanceM, shadowFactor: 0 });

function graph(): RoutingGraph {
  return {
    nodes: new Map([
      [5_000_000_000, { id: 5_000_000_000, lat: 40.7, lon: -74.0, isIntersection: true }],
      [2, { id: 2, lat: 40.701, lon: -74.0 }],
      [-1, { id: -1, lat: 40.7005, lon: -74.0 }],
    ]),
    adj: new Map([
      [5_000_000_000, [edge(-1, 50), edge(2, 110), edge(-1, 50)]],
      [-1, [edge(5_000_000_000, 50), edge(2, 60)]],
      // 7 has no node record: reachable through an edge, but no coordinates.
      [2, [edge(7, 30)]],
    ]),
  };
}

/** Every (from, to, distanceM) the compact form lists, in its order. */
function listEdges(g: ReturnType<typeof toCompactGraph>) {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < g.nodeCount; i++) {
    for (let e = g.offsets[i]; e < g.offsets[i + 1]; e++) {
      out.push([g.nodeIds[i], g.nodeIds[g.targets[e]], g.edges[e].distanceM]);
    }
  }
  return out;
}

describe("toCompactGraph", () => {
  it("lists exactly the object graph's edges, in adj order per node", () => {
    const g = toCompactGraph(graph());
    expect(listEdges(g)).toEqual([
      [5_000_000_000, -1, 50],
      [5_000_000_000, 2, 110],
      [5_000_000_000, -1, 50],
      [2, 7, 30],
      [-1, 5_000_000_000, 50],
      [-1, 2, 60],
    ]);
    expect(g.offsets[g.nodeCount]).toBe(6);
  });

  it("indexes ids past 2^31, negative virtual ids and edge-only targets", () => {
    const g = toCompactGraph(graph(), [99]);
    for (const id of [5_000_000_000, 2, -1, 7, 99]) {
      const i = g.indexOf.get(id);
      expect(i).toBeDefined();
      expect(g.nodeIds[i!]).toBe(id);
    }
    expect(g.nodeCount).toBe(5);
    // 99 was only an extra id: indexed, with no edges.
    const i99 = g.indexOf.get(99)!;
    expect(g.offsets[i99 + 1] - g.offsets[i99]).toBe(0);
  });

  it("carries coordinates and intersection flags, and marks nodes without a record", () => {
    const g = toCompactGraph(graph());
    const at = (id: number) => g.indexOf.get(id)!;
    expect([g.lat[at(2)], g.lon[at(2)]]).toEqual([40.701, -74.0]);
    expect(g.isIntersection[at(5_000_000_000)]).toBe(1);
    expect(g.isIntersection[at(2)]).toBe(0);
    expect(g.hasCoord[at(-1)]).toBe(1);
    expect(g.hasCoord[at(7)]).toBe(0);
  });

  it("keeps a reference to each source edge, so per-search attributes read the original", () => {
    const source = graph();
    const g = toCompactGraph(source);
    const from = g.indexOf.get(-1)!;
    expect(g.edges[g.offsets[from] + 1]).toBe(source.adj.get(-1)![1]);
  });
});

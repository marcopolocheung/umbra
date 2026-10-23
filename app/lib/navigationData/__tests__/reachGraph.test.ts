import { describe, expect, it } from "vitest";
import { type GraphEdge, parallelSidewalkEdges, type RoutingGraph } from "../../routing";
import { timeAwareGraphFromTable } from "../reachGraph";
import { createShadeTableView } from "../shadeTable";
import type { NavigationShadeShard } from "../shardContract";

const bounds = { south: 40.75, west: -74.0, north: 40.76, east: -73.99 };

/** Three segments, each side and slot a different byte, so a swapped side or slot shows. */
const segments: Array<[number, number]> = [
  [1, 2],
  [2, 3],
  [1, 3],
];
const view = createShadeTableView([
  {
    shard: {
      version: 1,
      dataset: "nyc-navigation",
      generation: "nyc-2026-09-18-000000000000",
      kind: "shade",
      geometryBounds: bounds,
      supportBounds: bounds,
      slots: 768,
      segments,
      payload: { key: "shades/a.bin", bytes: segments.length * 768 * 2, sha256: "a".repeat(64) },
    } satisfies NavigationShadeShard,
    blocks: new Map(
      [7, 8].map((slot) => [slot, Uint8Array.from(segments.flatMap((_, i) => [10 * i + slot, 100 + 10 * i + slot]))]),
    ),
  },
]);

function streets(): RoutingGraph {
  const nodes = new Map([1, 2, 3].map((id) => [id, { id, lat: 40.751 + id / 1e4, lon: -73.995 }]));
  const edge = (toId: number): GraphEdge => ({ toId, distanceM: 40, shadowFactor: 0 });
  return {
    nodes,
    adj: new Map([
      [1, [edge(2), edge(3)]],
      [2, [edge(1), edge(3)]],
      [3, [edge(2), edge(1)]],
    ]),
  };
}

/** The audit's original loop (`routeCompare.audit.ts`, H3a), frozen as the reference. */
function auditReference(graph: RoutingGraph, perBucket: number[]): RoutingGraph {
  const table = new Map<string, { left: number[]; right: number[] }>();
  for (const [lo, hi] of segments) {
    table.set(`${lo},${hi}`, {
      left: perBucket.map((slot) => view.shadowFor(`${lo},${hi}`, slot)?.left ?? 0),
      right: perBucket.map((slot) => view.shadowFor(`${lo},${hi}`, slot)?.right ?? 0),
    });
  }
  const adj = new Map<number, GraphEdge[]>();
  for (const [fromId, edges] of graph.adj) {
    adj.set(fromId, []);
    for (const edge of edges) {
      const t = table.get(`${Math.min(fromId, edge.toId)},${Math.max(fromId, edge.toId)}`)!;
      const canonical = fromId < edge.toId;
      adj.get(fromId)!.push(
        ...parallelSidewalkEdges(fromId, edge, t.left[0], t.right[0]).map((s) => ({
          ...s,
          timeShadow: s.side === "left" ? (canonical ? t.left : t.right) : canonical ? t.right : t.left,
        })),
      );
    }
  }
  return { nodes: graph.nodes, adj };
}

describe("timeAwareGraphFromTable", () => {
  it("builds the same sidewalk edges and per-bucket shade as the audit did", () => {
    const perBucket = [7, 8, 8];
    const built = timeAwareGraphFromTable(streets(), view, perBucket);
    expect(built.adj).toEqual(auditReference(streets(), perBucket).adj);
  });

  it("gives the traveller's left the canonical right when walking against the segment", () => {
    const built = timeAwareGraphFromTable(streets(), view, [7]);
    const forward = built.adj.get(1)!.find((e) => e.toId === 2 && e.side === "left")!;
    const backward = built.adj.get(2)!.find((e) => e.toId === 1 && e.side === "left")!;
    expect(forward.timeShadow).toEqual([view.shadowFor("1,2", 7)!.left]);
    expect(backward.timeShadow).toEqual([view.shadowFor("1,2", 7)!.right]);
  });
});

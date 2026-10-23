import { afterEach, describe, expect, it, vi } from "vitest";
import { bfsReachable, type GraphEdge, parallelSidewalkEdges, type RoutingGraph } from "../../routing";
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

// ─── buildReachGraph: NYC only, else "uncovered" ──────────────────────────────

describe("buildReachGraph", () => {
  const args = { center: [-73.99, 40.75] as [number, number], timeBudgetSec: 1800, departure: new Date("2026-07-01T16:00:00Z"), travelMode: "walk" as const };

  async function withLoaders(overrides: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("../remoteNavigation", async (orig) => ({ ...(await orig<object>()), ...overrides }));
    const { buildReachGraph } = await import("../reachGraph");
    return buildReachGraph(args);
  }
  afterEach(() => vi.doUnmock("../remoteNavigation"));

  const snapshot = (generation = "nyc-2026-09-18-393d4cd24a30") => ({ generation, manifest: {}, base: "x" });

  it("is uncovered with no navigation dataset configured", async () => {
    expect(await withLoaders({ acquireNavigationSnapshot: async () => null })).toMatchObject({ status: "uncovered" });
  });

  it("is uncovered for a quarantined shade generation", async () => {
    const r = await withLoaders({ acquireNavigationSnapshot: async () => snapshot("nyc-2026-09-18-b94934cd765a") });
    expect(r).toMatchObject({ status: "uncovered", reason: "shade generation quarantined" });
  });

  it("is uncovered outside the dataset's support, or where it publishes no shade", async () => {
    const outside = await withLoaders({ acquireNavigationSnapshot: async () => snapshot(), selectNavigationShards: () => null });
    expect(outside).toMatchObject({ status: "uncovered", reason: "outside the shade table" });
    const noShade = await withLoaders({
      acquireNavigationSnapshot: async () => snapshot(),
      selectNavigationShards: () => ({ streets: [], buildings: [], shadeShards: [] }),
    });
    expect(noShade).toMatchObject({ status: "uncovered", reason: "outside the shade table" });
  });
});

// ─── snapStart: off a stray fragment, onto the network ────────────────────────

describe("snapStart", () => {
  /** A 15×15 street grid, plus a 2-node path nearer the tap than any street. */
  function gridWithFragment(): RoutingGraph {
    const nodes = new Map<number, { id: number; lat: number; lon: number }>();
    const adj = new Map<number, GraphEdge[]>();
    const link = (a: number, b: number) => {
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!adj.has(x)) adj.set(x, []);
        adj.get(x)!.push({ toId: y, distanceM: 50, shadowFactor: 0 });
      }
    };
    for (let i = 0; i < 15; i++)
      for (let j = 0; j < 15; j++) {
        const id = i * 15 + j + 1;
        nodes.set(id, { id, lat: 40.75 + i * 0.0005, lon: -73.99 + j * 0.0005 });
        if (j > 0) link(id - 1, id);
        if (i > 0) link(id - 15, id);
      }
    nodes.set(9001, { id: 9001, lat: 40.7537, lon: -73.98625 });
    nodes.set(9002, { id: 9002, lat: 40.7538, lon: -73.98625 });
    link(9001, 9002);
    return { nodes, adj };
  }

  it("re-snaps a start that lands on a cut-off path onto the connected streets", async () => {
    const { snapStart } = await import("../reachGraph");
    const graph = gridWithFragment();
    const id = snapStart([-73.98625, 40.75375], graph, "walk")!;
    expect(id).not.toBeNull();
    expect(bfsReachable(graph, id, "walk").size).toBeGreaterThan(200);
  });

  it("keeps an ordinary start on the network where it was tapped", async () => {
    const { snapStart } = await import("../reachGraph");
    const graph = gridWithFragment();
    const id = snapStart([-73.9875, 40.7525], graph, "walk")!;
    const at = graph.nodes.get(id)!;
    expect(Math.abs(at.lat - 40.7525)).toBeLessThan(0.0003);
  });
});

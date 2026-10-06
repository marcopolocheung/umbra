/**
 * L3 differential parity (#263 — L3a's waste removal, then L3b's typed core):
 * the faster `paretoRoutes` must return exactly what the implementation it
 * replaced returned — same routes, same order, same metrics, bit for bit — on
 * seeded graphs that exercise every branch the search has: static and
 * time-aware, sun and rain, walk/bike/scoot, crossing penalties, the label cap,
 * the detour budget and the sun-streak constraint.
 *
 * The oracle is `paretoRoutesReference` (a frozen copy). Integer edge lengths
 * on a lattice make equal-cost ties common, so heap and Pareto-set ordering
 * differences cannot hide behind distinct floats.
 *
 * Deterministic — seeded PRNG, no network. Run with: npm test
 */

import { describe, expect, it } from "vitest";
import { type DijkstraOptions, type GraphEdge, paretoRoutes, type RoutingGraph } from "../routing";
import { parityCases, randomGraph } from "./paretoCases.fixture";
import { paretoRoutesReference } from "./paretoRoutesReference.fixture";

describe("paretoRoutes parity with the pre-L3 implementation", () => {
  for (const c of parityCases()) {
    const label =
      `seed ${c.seed} ${c.rows}×${c.cols} ${c.opts.objective} ${c.opts.travelMode}` +
      `${c.opts.timeAware ? ` ta×${c.buckets}` : ""}${c.opts.maxLabelsPerNode ? ` cap${c.opts.maxLabelsPerNode}` : ""}` +
      `${c.opts.maxContinuousExposureSec != null ? ` streak${c.opts.maxContinuousExposureSec}` : ""}`;
    it(label, () => {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const expected = paretoRoutesReference(graph, c.start, c.end, c.opts);
      expect(paretoRoutes(graph, c.start, c.end, c.opts)).toStrictEqual(expected);
    });
  }

  it("matches on the id shapes only a compact layout can get wrong", () => {
    // L3b indexes ids itself, so cover what the lattices never produce:
    // negative virtual snap ids (as `snapToReachableEdge` splices in), an edge
    // target with no node record off the route (a dead end the search must
    // still index and price with a zero heuristic), and a destination with no
    // node record at all (unreachable). A *route* through a record-less node
    // is out: `dijkstra`'s result builder dereferences every path node, in
    // both implementations, and no app graph produces one.
    const base = randomGraph(77, 6, 6, 3);
    const nodes = new Map(base.nodes);
    const adj = new Map(base.adj);
    const side = (toId: number, distanceM: number, s: number): GraphEdge => ({
      toId, distanceM, shadowFactor: s, timeShadow: [s, 1 - s, s],
    });
    nodes.set(-1, { id: -1, lat: 40.7001, lon: -73.9998, isIntersection: true });
    nodes.set(-2, { id: -2, lat: 40.7005, lon: -73.996, isIntersection: true });
    adj.set(-1, [side(0, 20, 0.2), side(1, 45, 0.9)]);
    adj.get(0)!.push(side(-1, 20, 0.2));
    adj.get(1)!.push(side(-1, 45, 0.9));
    adj.set(-2, [side(34, 15, 0.7), side(35, 30, 0.1)]);
    adj.get(34)!.push(side(-2, 15, 0.7));
    adj.get(35)!.push(side(-2, 30, 0.1));
    // 900 has no node record; it hangs off node 14 as a cheap dead end.
    adj.get(14)!.push(side(900, 5, 1));
    adj.set(900, [side(14, 5, 1)]);
    const graph: RoutingGraph = { nodes, adj };
    const ta = { timeAware: { bucketMs: 30_000, bucketCount: 3 } };
    for (const [start, end, opts] of [
      [-1, -2, ta],
      [-2, -1, {}],
      [-1, -2, { crossingPenaltyM: 15, objective: "rain" }],
      [-1, 12345, ta],
    ] as Array<[number, number, DijkstraOptions]>) {
      expect(paretoRoutes(graph, start, end, opts)).toStrictEqual(
        paretoRoutesReference(graph, start, end, opts),
      );
    }
    expect(paretoRoutes(graph, -1, -2, ta).length).toBeGreaterThan(0);
  });

  it("matches when equal-length destination labels land in buckets created out of order", () => {
    // Two 100 m (mode-cost) routes reach the destination in different time
    // buckets: via `a` (100 m walked, bucket 1) and via `b` (85 m walked plus a
    // 15 m crossing, bucket 0). All nodes share one coordinate, so the
    // heuristic is 0 and `a` pops first: bucket 1's set is created before
    // bucket 0's. The front is read in creation order and the length sort is
    // stable, so that order decides which route is "shortest".
    const at = { lat: 40.7, lon: -74 };
    const nodes = new Map([
      [1, { id: 1, ...at }],
      [2, { id: 2, ...at }],
      [3, { id: 3, ...at, isIntersection: true }],
      [4, { id: 4, ...at }],
    ]);
    const e = (toId: number, distanceM: number, s: number): GraphEdge => ({
      toId, distanceM, shadowFactor: s, timeShadow: [s, s],
    });
    const adj = new Map<number, GraphEdge[]>([
      [1, [e(2, 50, 0.2), e(3, 40, 0.9)]],
      [2, [e(1, 50, 0.2), e(4, 50, 0.1)]],
      [3, [e(1, 40, 0.9), e(4, 45, 0.6)]],
      [4, [e(2, 50, 0.1), e(3, 45, 0.6)]],
    ]);
    const graph: RoutingGraph = { nodes, adj };
    const opts: DijkstraOptions = { crossingPenaltyM: 15, timeAware: { bucketMs: 65_000, bucketCount: 2 } };
    const expected = paretoRoutesReference(graph, 1, 4, opts);
    expect(expected.map((r) => r.nodeIds)).toEqual([[1, 2, 4], [1, 3, 4]]);
    expect(paretoRoutes(graph, 1, 4, opts)).toStrictEqual(expected);
  });

  it("matches when a node without coordinates sits on a candidate route", () => {
    // Node 900 has no record, so its heuristic is 0. It bridges 14 → 15 by a
    // longer, shaded detour the shortest path never takes, so `dijkstra`'s
    // result builder never reads it, but Pareto routes may.
    const base = randomGraph(91, 5, 6, 3);
    const adj = new Map(base.adj);
    const shaded = (toId: number): GraphEdge => ({ toId, distanceM: 70, shadowFactor: 1, timeShadow: [1, 1, 1] });
    adj.get(14)!.push(shaded(900));
    adj.get(15)!.push(shaded(900));
    adj.set(900, [shaded(14), shaded(15)]);
    const graph: RoutingGraph = { nodes: base.nodes, adj };
    for (const opts of [{}, { timeAware: { bucketMs: 30_000, bucketCount: 3 } }] as DijkstraOptions[]) {
      expect(paretoRoutes(graph, 12, 17, opts)).toStrictEqual(paretoRoutesReference(graph, 12, 17, opts));
    }
  });

  it("matches on a city-scale time-aware lattice with the default cap", () => {
    const graph = randomGraph(424242, 40, 30, 8);
    const opts: DijkstraOptions = {
      crossingPenaltyM: 15,
      straightLineDistM: 2000,
      timeAware: { bucketMs: 120_000, bucketCount: 8 },
    };
    const expected = paretoRoutesReference(graph, 0, 40 * 30 - 1, opts);
    expect(expected.length).toBeGreaterThan(1);
    expect(paretoRoutes(graph, 0, 40 * 30 - 1, opts)).toStrictEqual(expected);
  });
});

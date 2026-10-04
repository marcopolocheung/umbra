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
import { paretoRoutesReference } from "./paretoRoutesReference.fixture";

/** mulberry32 — small, seedable, good enough for fixtures. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIGHWAYS = [undefined, "footway", "residential", "steps", "cycleway"];
const SURFACES = [undefined, "asphalt", "cobblestone", "gravel"];

/**
 * A rows × cols lattice of sidewalk pairs with a few diagonal shortcuts and
 * dropped links, so there are many near-equal paths. Shade comes in 0/1/mixed
 * runs per bucket; some edges carry no `timeShadow` (the static fallback).
 */
function randomGraph(seed: number, rows: number, cols: number, buckets: number): RoutingGraph {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const nodes: RoutingGraph["nodes"] = new Map();
  const adj: RoutingGraph["adj"] = new Map();
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const id = i * cols + j;
      nodes.set(id, {
        id,
        lat: 40.7 + (i * 60) / 110_900,
        lon: -74 + (j * 60) / 84_400,
        ...(r() < 0.6 ? { isIntersection: true } : {}),
      });
      adj.set(id, []);
    }
  }
  const shade = () => {
    const x = r();
    return x < 0.35 ? 0 : x < 0.65 ? 1 : Math.round(r() * 8) / 8;
  };
  const series = () => {
    const base = shade();
    return Array.from({ length: buckets }, () => (r() < 0.3 ? shade() : base));
  };
  const link = (a: number, b: number, distanceM: number) => {
    const tags = {
      highway: pick(HIGHWAYS),
      surface: pick(SURFACES),
      ...(r() < 0.1 ? { bicycle: "designated" } : {}),
      ...(r() < 0.05 ? { foot: "no" } : {}),
    };
    const timed = buckets > 0 && r() < 0.85;
    // Some series are shorter than the horizon (the last entry then covers the
    // rest) and a few are empty (the static factor stands in).
    const len = r() < 0.15 ? Math.floor(r() * buckets) : buckets;
    const L = series().slice(0, len);
    const R = series().slice(0, len);
    const shelterL = shade();
    const shelterR = shade();
    const conf = r() < 0.2 ? 0.3 : 1;
    const make = (toId: number, s: number[], shelter: number, side: "left" | "right"): GraphEdge => ({
      toId,
      distanceM,
      // The static sample and the sweep's bucket 0 are separate measurements.
      shadowFactor: s.length > 0 && r() < 0.5 ? s[0] : shade(),
      shelterFactor: shelter,
      shelterConfidence: conf,
      exposureConfidence: conf,
      side,
      ...tags,
      ...(timed ? { timeShadow: s } : {}),
    });
    adj.get(a)!.push(make(b, L, shelterL, "left"), make(b, R, shelterR, "right"));
    adj.get(b)!.push(make(a, R, shelterR, "left"), make(a, L, shelterL, "right"));
  };
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const id = i * cols + j;
      if (j + 1 < cols && r() > 0.05) link(id, id + 1, 50 + Math.floor(r() * 4) * 10);
      if (i + 1 < rows && r() > 0.05) link(id, id + cols, 50 + Math.floor(r() * 4) * 10);
      if (i + 1 < rows && j + 1 < cols && r() < 0.1) link(id, id + cols + 1, 80);
    }
  }
  return { nodes, adj };
}

interface Case {
  seed: number;
  rows: number;
  cols: number;
  buckets: number;
  opts: DijkstraOptions;
  start: number;
  end: number;
}

function cases(): Case[] {
  const out: Case[] = [];
  const r = rng(20261004);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let seed = 1; seed <= 160; seed++) {
    const rows = 4 + Math.floor(r() * 9);
    const cols = 4 + Math.floor(r() * 9);
    const n = rows * cols;
    const timeAware = r() < 0.6;
    const buckets = timeAware ? 1 + Math.floor(r() * 8) : 0;
    const opts: DijkstraOptions = {
      crossingPenaltyM: pick([0, 0, 15]),
      straightLineDistM: pick([0, 400]),
      travelMode: pick(["walk", "walk", "bike", "scoot"] as const),
      objective: r() < 0.2 ? "rain" : "sun",
      ...(r() < 0.3 ? { maxLabelsPerNode: pick([1, 2, 4, 7]) } : {}),
      ...(r() < 0.3 ? { maxDetourFactor: pick([1.1, 1.5, 3]) } : {}),
      ...(r() < 0.25 ? { maxContinuousExposureSec: pick([30, 90, 200]) } : {}),
      // Small bucket widths so walks cross several buckets on a small lattice.
      ...(timeAware ? { timeAware: { bucketMs: pick([20_000, 60_000, 900_000]), bucketCount: buckets } } : {}),
    };
    const start = Math.floor(r() * n);
    const end = r() < 0.03 ? start : Math.floor(r() * n);
    out.push({ seed, rows, cols, buckets, opts, start, end });
  }
  return out;
}

describe("paretoRoutes parity with the pre-L3 implementation", () => {
  for (const c of cases()) {
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

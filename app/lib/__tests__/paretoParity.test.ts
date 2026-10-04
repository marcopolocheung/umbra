/**
 * L3a differential parity (#263): the faster `paretoRoutes` must return exactly
 * what the implementation it replaced returned — same routes, same order, same
 * metrics, bit for bit — on seeded graphs that exercise every branch the search
 * has: static and time-aware, sun and rain, walk/bike/scoot, crossing
 * penalties, the label cap, the detour budget and the sun-streak constraint.
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
    const L = series();
    const R = series();
    const shelterL = shade();
    const shelterR = shade();
    const conf = r() < 0.2 ? 0.3 : 1;
    const make = (toId: number, s: number[], shelter: number, side: "left" | "right"): GraphEdge => ({
      toId,
      distanceM,
      shadowFactor: s[0] ?? shade(),
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

describe("paretoRoutes parity with the pre-L3a implementation", () => {
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

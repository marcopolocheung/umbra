/**
 * Seeded lattice graphs and search options for the L3 parity suites
 * (`paretoParity.test.ts`, `routingGraphCodec.test.ts`). Shared so every L3
 * slice proves itself on the same cases.
 */

import type { DijkstraOptions, GraphEdge, RoutingGraph } from "../routing";

/** mulberry32 — small, seedable, good enough for fixtures. */
export function rng(seed: number): () => number {
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
export function randomGraph(seed: number, rows: number, cols: number, buckets: number): RoutingGraph {
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

export interface ParityCase {
  seed: number;
  rows: number;
  cols: number;
  buckets: number;
  opts: DijkstraOptions;
  start: number;
  end: number;
}

export function parityCases(): ParityCase[] {
  const out: ParityCase[] = [];
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

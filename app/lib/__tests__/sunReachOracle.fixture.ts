/**
 * The Sun Budget oracles (H3–H5) and their seeded cases, shared by
 * `sunReach.test.ts`, the H4 property tests and H7's formulation check.
 * Exhaustive and slow by design: ground truth on small graphs only.
 */

import type { RoutingGraph } from "../routing";
import type { SunReachOptions, SunReachResult } from "../sunReach";
import { edgeTraversalSeconds, isProhibitedEdge } from "../travelMode";
import { rng } from "./paretoCases.fixture";

/**
 * H3 oracle: every walk from the start, bounded by the time budget, priced
 * the way `paretoRoutes` prices it. States repeat only when (node, arrival,
 * sun) are identical, and identical states have identical futures, so the
 * memo prunes nothing a walk could need. Slow and obviously correct.
 */
export function oracleReach(graph: RoutingGraph, startId: number, o: SunReachOptions): Set<string> {
  const mode = o.travelMode ?? "walk";
  const W = o.timeAware ? o.timeAware.bucketMs / 1000 : Number.POSITIVE_INFINITY;
  const B = o.timeAware?.bucketCount ?? 1;
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (node: number, t: number, s: number) => {
    const state = `${node}|${t}|${s}`;
    if (seen.has(state)) return;
    seen.add(state);
    for (const edge of graph.adj.get(node) ?? []) {
      if (isProhibitedEdge(edge, mode)) continue;
      const sec = edgeTraversalSeconds(edge, mode);
      const nt = t + sec;
      if (nt > o.timeBudgetSec) continue;
      const b = o.timeAware ? Math.min(Math.floor(nt / W), B - 1) : 0;
      const ts = edge.timeShadow;
      const factor = !o.timeAware || !ts || ts.length === 0 ? edge.shadowFactor : ts[Math.min(b, ts.length - 1)];
      const ns = s + sec * (1 - factor);
      if (ns > o.sunBudgetSec) continue;
      out.add(keyOf(node, edge));
      walk(edge.toId, nt, ns);
    }
    // H5: wait until the next bucket begins, standing on the node's shadiest corner.
    if (o.allowWaits && o.timeAware) {
      const boundary = (Math.floor(t / W) + 1) * W;
      if (boundary <= o.timeBudgetSec && Math.floor(t / W) < B - 1) {
        const ns = s + (boundary - t) * (1 - nodeShadeAt(graph, node, Math.floor(t / W)));
        if (ns <= o.sunBudgetSec) walk(node, boundary, ns);
      }
    }
  };
  walk(startId, 0, 0);
  return out;
}

/** The shadiest sidewalk touching `node` in bucket `b`: where a waiting walker stands (H5). */
export function nodeShadeAt(graph: RoutingGraph, node: number, b: number): number {
  let best = 0;
  for (const edge of graph.adj.get(node) ?? []) {
    const ts = edge.timeShadow;
    const f = !ts || ts.length === 0 ? edge.shadowFactor : ts[Math.min(b, ts.length - 1)];
    if (f > best) best = f;
  }
  return best;
}

export const keyOf = (from: number, e: { toId: number; side?: string }) => `${from}>${e.toId}:${e.side ?? ""}`;
export const reachKeys = (r: SunReachResult) => new Set(r.reachable.map((e) => keyOf(e.fromId, e)));
export const undecidedKeys = (r: SunReachResult) => new Set(r.undecided.map((e) => keyOf(e.fromId, e)));
export const subset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k));

/** Small lattices that still cross several buckets inside the time budget. */
export function cases() {
  const r = rng(20261022);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: 60 }, (_, i) => {
    const rows = 3 + Math.floor(r() * 3);
    const cols = 3 + Math.floor(r() * 3);
    const timed = r() < 0.75;
    const buckets = timed ? 2 + Math.floor(r() * 5) : 0;
    const options: SunReachOptions = {
      sunBudgetSec: pick([20, 60, 120]),
      timeBudgetSec: pick([150, 220]),
      travelMode: pick(["walk", "walk", "scoot"] as const),
      ...(timed ? { timeAware: { bucketMs: pick([20_000, 45_000]), bucketCount: buckets } } : {}),
    };
    return { seed: 500 + i, rows, cols, buckets, start: Math.floor(r() * rows * cols), options };
  });
}

/**
 * H5b oracle: every outing — out from the start (waiting where allowed), a stay
 * of `dwellSec` at one corner, home again — within both budgets, and the set of
 * streets the successful ones walk. `finish` is memoized per state, and a state's
 * future depends only on (node, arrival, sun, phase), so nothing is missed.
 */
export function oracleRoundTrip(graph: RoutingGraph, startId: number, o: SunReachOptions): Set<string> {
  const mode = o.travelMode ?? "walk";
  const W = o.timeAware ? o.timeAware.bucketMs / 1000 : Number.POSITIVE_INFINITY;
  const B = o.timeAware?.bucketCount ?? 1;
  const D = o.roundTrip!.dwellSec;
  const bucket = (t: number) => (o.timeAware ? Math.min(Math.floor(t / W), B - 1) : 0);
  const out = new Set<string>();
  const memo = new Map<string, boolean>();
  const finish = (node: number, t: number, s: number, home: boolean): boolean => {
    const state = `${node}|${t}|${s}|${home}`;
    const known = memo.get(state);
    if (known !== undefined) return known;
    memo.set(state, false);
    let ok = home && node === startId;
    for (const edge of graph.adj.get(node) ?? []) {
      if (isProhibitedEdge(edge, mode)) continue;
      const sec = edgeTraversalSeconds(edge, mode);
      const nt = t + sec;
      if (nt > o.timeBudgetSec) continue;
      const ts = edge.timeShadow;
      const f = !o.timeAware || !ts || ts.length === 0 ? edge.shadowFactor : ts[Math.min(bucket(nt), ts.length - 1)];
      const ns = s + sec * (1 - f);
      if (ns > o.sunBudgetSec) continue;
      if (finish(edge.toId, nt, ns, home)) {
        out.add(keyOf(node, edge));
        ok = true;
      }
    }
    if (o.allowWaits && o.timeAware && Math.floor(t / W) < B - 1) {
      const boundary = (Math.floor(t / W) + 1) * W;
      const ns = s + (boundary - t) * (1 - nodeShadeAt(graph, node, Math.floor(t / W)));
      if (boundary <= o.timeBudgetSec && ns <= o.sunBudgetSec && finish(node, boundary, ns, home)) ok = true;
    }
    if (!home) {
      const ns = s + dwellSunAt(graph, node, t, D, o);
      if (t + D <= o.timeBudgetSec && ns <= o.sunBudgetSec && finish(node, t + D, ns, true)) ok = true;
    }
    memo.set(state, ok);
    return ok;
  };
  finish(startId, 0, 0, false);
  return out;
}

/** Sun for standing `D` seconds at `node` from `t`, on its shadiest sidewalk, bucket by bucket. */
export function dwellSunAt(graph: RoutingGraph, node: number, t: number, D: number, o: SunReachOptions): number {
  if (!o.timeAware) return D * (1 - nodeShadeAt(graph, node, 0));
  const W = o.timeAware.bucketMs / 1000;
  const B = o.timeAware.bucketCount;
  let s = 0;
  for (let at = t, end = t + D; at < end; ) {
    const b = Math.min(Math.floor(at / W), B - 1);
    const until = b < B - 1 ? Math.min(end, (b + 1) * W) : end;
    s += (until - at) * (1 - nodeShadeAt(graph, node, b));
    at = until;
  }
  return s;
}

/** Round-trip cases: the seeded lattices with shorter budgets, so the two-phase oracle stays quick. */
export function roundTripCases() {
  const r = rng(20261025);
  return cases().map((c, i) => ({
    ...c,
    options: {
      ...c.options,
      timeBudgetSec: Math.round(c.options.timeBudgetSec * 0.8),
      allowWaits: Boolean(c.options.timeAware) && i % 2 === 0,
      roundTrip: { dwellSec: [0, 15, 40][Math.floor(r() * 3)] },
    } satisfies SunReachOptions,
  }));
}

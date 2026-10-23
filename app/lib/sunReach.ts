/**
 * H3 — Sun Budget reachability: every street a walker can reach from one start
 * on at most `sunBudgetSec` of direct sun and `timeBudgetSec` of walking, one
 * way. Sun is priced the way `paretoRoutes` prices it (H1/H2): each edge costs
 * `seconds × (1 − shade)`, with shade read at the bucket of the walker's arrival
 * at the edge's end. No waiting, no dwell, no return leg — H5 owns those.
 *
 * The answer is a pair of edge sets, never a single guess:
 *   - `reachable` — edges a real walk from the start traverses within both
 *     budgets. Every one is a witness, so this set is always sound.
 *   - `undecided` — edges an optimistic outer bound cannot rule out but no walk
 *     the search kept reaches. Empty when the outcome is `exact`.
 * and an `outcome` that says which of the three the caller has:
 *   - `exact` — `reachable` is the whole truth on the bucketed model.
 *   - `approximate` — a per-slot cap dropped labels; the gap is `undecided`.
 *   - `budget-exhausted` — the work cap stopped the search. An undecided edge
 *     is NOT unreachable, and nothing here may say it is.
 * Method and measurements: `docs/notes/sun-budget-model.md`, "H3".
 */

import { toCompactGraph } from "./compactGraph";
import { NumericMinHeap } from "./minHeap";
import type { RoutingGraph, SidewalkSide } from "./routing";
import { edgeTraversalSeconds, isProhibitedEdge, type TravelModeId } from "./travelMode";

export interface SunReachOptions {
  sunBudgetSec: number;
  timeBudgetSec: number;
  travelMode?: TravelModeId;
  /** H1's bucketed shade; omit for static shade (`shadowFactor`). */
  timeAware?: { bucketMs: number; bucketCount: number };
  /** Labels kept per (node, arrival bucket) once none prunes another. */
  maxLabelsPerSlot?: number;
  /** Work cap: labels created before the search stops (`budget-exhausted`). */
  maxLabels?: number;
}

export type SunReachOutcome = "exact" | "approximate" | "budget-exhausted";

export interface SunReachEdge {
  fromId: number;
  toId: number;
  side?: SidewalkSide;
  distanceM: number;
}

export interface SunReachResult {
  outcome: SunReachOutcome;
  /** Proven reachable, with the least sun any kept walk traversed it on. */
  reachable: Array<SunReachEdge & { sunSec: number; arrivalSec: number }>;
  /** Neither proven reachable nor ruled out. */
  undecided: SunReachEdge[];
  stats: { labels: number; evicted: number; ms: number };
}

/** The walk that proved one street reachable (#379), start first. */
export interface SunReachWalk {
  nodeIds: number[];
  sunSec: number;
  arrivalSec: number;
}

/**
 * A result plus how to replay the walk behind any proven street. Kept apart
 * from `SunReachResult` so the plain result stays cheap to post across threads.
 */
export interface SunReachRun {
  result: SunReachResult;
  /** The walk that proved `fromId → toId` (on `side`), or null if it is not proven. */
  witness(fromId: number, toId: number, side?: string): SunReachWalk | null;
}

export const SUN_REACH_DEFAULTS = { maxLabelsPerSlot: 8, maxLabels: 2_000_000 };

export function sunReach(graph: RoutingGraph, startId: number, options: SunReachOptions): SunReachResult {
  return sunReachRun(graph, startId, options).result;
}

export function sunReachRun(graph: RoutingGraph, startId: number, options: SunReachOptions): SunReachRun {
  const t0 = performance.now();
  const { sunBudgetSec: S, timeBudgetSec: T, travelMode = "walk", timeAware: ta } = options;
  const K = options.maxLabelsPerSlot ?? SUN_REACH_DEFAULTS.maxLabelsPerSlot;
  const maxLabels = options.maxLabels ?? SUN_REACH_DEFAULTS.maxLabels;
  const cg = toCompactGraph(graph, [startId]);
  const N = cg.nodeCount;
  const { offsets, targets } = cg;
  const E = targets.length;
  const B = ta ? ta.bucketCount : 1;
  const W = ta ? ta.bucketMs / 1000 : Number.POSITIVE_INFINITY;
  const bucketOf = (sec: number) => (ta ? Math.min(Math.floor(sec / W), B - 1) : 0);

  // Per-edge seconds and sun per arrival bucket, as `paretoRoutes` computes them.
  const sec = new Float64Array(E);
  const inc = new Float64Array(E * B);
  const minInc = new Float64Array(E);
  const prohibited = new Uint8Array(E);
  for (let e = 0; e < E; e++) {
    const edge = cg.edges[e];
    if (isProhibitedEdge(edge, travelMode)) prohibited[e] = 1;
    sec[e] = edgeTraversalSeconds(edge, travelMode);
    const ts = edge.timeShadow;
    let m = Number.POSITIVE_INFINITY;
    for (let b = 0; b < B; b++) {
      const factor = !ta || !ts || ts.length === 0 ? edge.shadowFactor : ts[Math.min(b, ts.length - 1)];
      inc[e * B + b] = sec[e] * (1 - factor);
      m = Math.min(m, inc[e * B + b]);
    }
    minInc[e] = m;
  }

  // Slack for pruning across arrivals (#370 generalised). Two labels in one
  // bucket are less than a bucket apart, so on any continuation the earlier is
  // priced at most one bucket earlier, and only on the edges whose end falls
  // within Δ before a boundary: the first of them adds at most `jump[k]`, the
  // rest span under Δ seconds and add at most `Δ × frac[k]`. Zero once both
  // are in the last bucket — `sameFuture` exactly.
  const jump = new Float64Array(B);
  const frac = new Float64Array(B);
  for (let k = 1; k < B; k++) {
    for (let e = 0; e < E; e++) {
      if (prohibited[e] || sec[e] === 0) continue;
      const extra = inc[e * B + k - 1] - inc[e * B + k];
      if (extra > jump[k]) jump[k] = extra;
      if (extra / sec[e] > frac[k]) frac[k] = extra / sec[e];
    }
  }
  /** Most extra sun label a (earlier by Δ, same bucket) can pay over b on any continuation. */
  const slack = (ta0: number, delta: number) => {
    if (delta === 0) return 0;
    let s = 0;
    for (let k = bucketOf(ta0) + 1; k < B && k * W <= T; k++) s += jump[k] + delta * frac[k];
    return s;
  };

  // Labels: (node, arrival, sun), struct-of-arrays.
  let cap = 4096;
  let count = 0;
  let lNode = new Int32Array(cap);
  let lT = new Float64Array(cap);
  let lS = new Float64Array(cap);
  let lDead = new Uint8Array(cap);
  // The walk behind each label: the label it extends and the edge it took (−1 at the start).
  let lParent = new Int32Array(cap);
  let lEdge = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const p = new Int32Array(cap); p.set(lParent); lParent = p;
    const ed = new Int32Array(cap); ed.set(lEdge); lEdge = ed;
    const n = new Int32Array(cap); n.set(lNode); lNode = n;
    const t = new Float64Array(cap); t.set(lT); lT = t;
    const s = new Float64Array(cap); s.set(lS); lS = s;
    const d = new Uint8Array(cap); d.set(lDead); lDead = d;
  };
  const slotCount = new Int32Array(N * B);
  const slotLabels = new Int32Array(N * B * K);
  /** a can reach everything b can: no later, and no sunnier by more than the slack. */
  const covers = (a: number, t: number, s: number) =>
    lT[a] <= t && lS[a] + slack(lT[a], t - lT[a]) <= s;
  let evicted = 0;

  const reachSun = new Float64Array(E).fill(Number.POSITIVE_INFINITY);
  const reachT = new Float64Array(E);
  // What proved each edge: the label the walk stood on before taking it, or
  // −1 when the least-time tree did (its parents are `treeEdge`).
  const proofLabel = new Int32Array(E).fill(-1);
  const heap = new NumericMinHeap();
  const startIdx = cg.indexOf.get(startId)!;
  lNode[0] = startIdx;
  lParent[0] = -1;
  lEdge[0] = -1;
  count = 1;
  slotLabels[startIdx * B * K] = 0;
  slotCount[startIdx * B] = 1;
  heap.push(0, 0);
  let exhausted = false;

  while (heap.size > 0) {
    const label = heap.pop();
    if (lDead[label]) continue;
    const u = lNode[label];
    const t = lT[label];
    const s = lS[label];
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      if (prohibited[e]) continue;
      const nt = t + sec[e];
      if (nt > T) continue;
      const ns = s + inc[e * B + bucketOf(nt)];
      if (ns > S) continue;
      // A real walk traverses e within both budgets: e is reachable, whatever
      // happens to the label below.
      if (ns < reachSun[e]) { reachSun[e] = ns; reachT[e] = nt; proofLabel[e] = label; }
      const v = targets[e];
      const slot = v * B + bucketOf(nt);
      const base = slot * K;
      let n = slotCount[slot];
      let dominated = false;
      for (let i = 0; i < n && !dominated; i++) dominated = covers(slotLabels[base + i], nt, ns);
      if (dominated) continue;
      if (count === maxLabels) { exhausted = true; break; }
      if (count === cap) grow();
      const id = count++;
      lNode[id] = v; lT[id] = nt; lS[id] = ns; lParent[id] = label; lEdge[id] = e;
      for (let i = n - 1; i >= 0; i--) {
        const other = slotLabels[base + i];
        if (covers(id, lT[other], lS[other])) {
          lDead[other] = 1;
          slotLabels[base + i] = slotLabels[base + --n];
        }
      }
      if (n === K) {
        // Full of mutually uncovered labels: drop the one with the most
        // time + sun (the new label included), and remember the search is
        // no longer complete.
        let worst = -1;
        let worstKey = nt + ns;
        for (let i = 0; i < n; i++) {
          const o = slotLabels[base + i];
          if (lT[o] + lS[o] > worstKey) { worst = i; worstKey = lT[o] + lS[o]; }
        }
        evicted++;
        if (worst < 0) { lDead[id] = 1; slotCount[slot] = n; continue; }
        lDead[slotLabels[base + worst]] = 1;
        slotLabels[base + worst] = slotLabels[base + --n];
      }
      slotLabels[base + n++] = id;
      slotCount[slot] = n;
      heap.push(id, nt);
    }
    if (exhausted) break;
  }

  // Outer bound: an edge needs both its least-time and its least-sun (every
  // edge at its shadiest bucket) prefix within budget. Two plain Dijkstras.
  // The least-time tree is also a set of real walks, so `treeSun` prices each
  // at its real buckets: a capped search can drop a fast, sunny label, and the
  // tree still proves what it reaches.
  const treeSun = new Float64Array(N);
  const treeEdge = new Int32Array(N).fill(-1);
  const least = (cost: Float64Array, limit: number, pricing: boolean) => {
    const d = new Float64Array(N).fill(Number.POSITIVE_INFINITY);
    d[startIdx] = 0;
    const h = new NumericMinHeap();
    h.push(startIdx, 0);
    while (h.size > 0) {
      const x = h.pop();
      for (let e = offsets[x]; e < offsets[x + 1]; e++) {
        if (prohibited[e]) continue;
        const nd = d[x] + cost[e];
        if (nd <= limit && nd < d[targets[e]]) {
          d[targets[e]] = nd;
          if (pricing) {
            treeSun[targets[e]] = treeSun[x] + inc[e * B + bucketOf(nd)];
            treeEdge[targets[e]] = e;
          }
          h.push(targets[e], nd);
        }
      }
    }
    return d;
  };
  const tMin = least(sec, T, true);
  const sMin = least(minInc, S, false);
  for (let x = 0; x < N; x++) {
    if (tMin[x] === Number.POSITIVE_INFINITY) continue;
    for (let e = offsets[x]; e < offsets[x + 1]; e++) {
      if (prohibited[e]) continue;
      const nt = tMin[x] + sec[e];
      const ns = treeSun[x] + inc[e * B + bucketOf(nt)];
      if (nt <= T && ns <= S && ns < reachSun[e]) { reachSun[e] = ns; reachT[e] = nt; proofLabel[e] = -1; }
    }
  }

  const edgeOut = (e: number, from: number): SunReachEdge => ({
    fromId: cg.nodeIds[from],
    toId: cg.nodeIds[targets[e]],
    ...(cg.edges[e].side ? { side: cg.edges[e].side } : {}),
    distanceM: cg.edges[e].distanceM,
  });
  const reachable: SunReachResult["reachable"] = [];
  const outer: number[] = [];
  const outerFrom: number[] = [];
  for (let x = 0; x < N; x++) {
    for (let e = offsets[x]; e < offsets[x + 1]; e++) {
      if (reachSun[e] < Number.POSITIVE_INFINITY) {
        reachable.push({ ...edgeOut(e, x), sunSec: reachSun[e], arrivalSec: reachT[e] });
      } else if (!prohibited[e] && tMin[x] + sec[e] <= T && sMin[x] + minInc[e] <= S) {
        outer.push(e);
        outerFrom.push(x);
      }
    }
  }
  const complete = !exhausted && evicted === 0;
  const outcome: SunReachOutcome =
    complete || outer.length === 0 ? "exact" : exhausted ? "budget-exhausted" : "approximate";
  const result: SunReachResult = {
    outcome,
    reachable,
    undecided: outcome === "exact" ? [] : outer.map((e, i) => edgeOut(e, outerFrom[i])),
    stats: { labels: count, evicted, ms: performance.now() - t0 },
  };

  // Edge → its source node, for walking a proof back to the start.
  const edgeFrom = new Int32Array(E);
  for (let x = 0; x < N; x++) for (let e = offsets[x]; e < offsets[x + 1]; e++) edgeFrom[e] = x;
  /** Edges from the start to node `x` along the least-time tree, start first. */
  const treePath = (x: number): number[] => {
    const path: number[] = [];
    for (let node = x; node !== startIdx; node = edgeFrom[treeEdge[node]]) path.push(treeEdge[node]);
    return path.reverse();
  };
  /** Edges of the walk a label stands on, start first. */
  const labelPath = (label: number): number[] => {
    const path: number[] = [];
    for (let l = label; lEdge[l] >= 0; l = lParent[l]) path.push(lEdge[l]);
    return path.reverse();
  };
  const witness = (fromId: number, toId: number, side?: string): SunReachWalk | null => {
    const from = cg.indexOf.get(fromId);
    if (from === undefined) return null;
    for (let e = offsets[from]; e < offsets[from + 1]; e++) {
      if (cg.nodeIds[targets[e]] !== toId || (side !== undefined && cg.edges[e].side !== side)) continue;
      if (reachSun[e] === Number.POSITIVE_INFINITY) continue;
      const edges = [...(proofLabel[e] >= 0 ? labelPath(proofLabel[e]) : treePath(from)), e];
      return {
        nodeIds: [startId, ...edges.map((pe) => cg.nodeIds[targets[pe]])],
        sunSec: reachSun[e],
        arrivalSec: reachT[e],
      };
    }
    return null;
  };
  return { result, witness };
}

/**
 * H3b: what the map paints from every Sun Budget result proven so far.
 *
 * `sunReach` proves an edge reachable with a real walk, and a walk within
 * budgets (S, T) is within any wider (S', T'). So the union of `reachable` over
 * every cached result whose budgets are both ≤ the current ones is still
 * proven — and never shrinks as the slider widens, even though a single
 * `approximate` result can (sun-budget-model.md, H3). Undecided edges are the
 * current result's, minus anything already proven.
 */

import type { SunReachEdge, SunReachResult } from "../sunReach";

export interface CachedReach {
  sunSec: number;
  timeSec: number;
  result: SunReachResult;
}

export interface ReachRegion {
  proven: SunReachEdge[];
  undecided: SunReachEdge[];
}

const keyOf = (e: SunReachEdge) => `${e.fromId}>${e.toId}:${e.side ?? ""}`;

export function mergeRegion(cache: CachedReach[], current: CachedReach): ReachRegion {
  const proven = new Map<string, SunReachEdge>();
  for (const entry of cache) {
    if (entry.sunSec > current.sunSec || entry.timeSec > current.timeSec) continue;
    for (const edge of entry.result.reachable) proven.set(keyOf(edge), edge);
  }
  for (const edge of current.result.reachable) proven.set(keyOf(edge), edge);
  return {
    proven: [...proven.values()],
    undecided: current.result.undecided.filter((edge) => !proven.has(keyOf(edge))),
  };
}

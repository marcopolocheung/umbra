import { describe, expect, it } from "vitest";
import type { SunReachEdge, SunReachResult } from "../../sunReach";
import { type CachedReach, mergeRegion } from "../mergeRegion";

const edge = (fromId: number, toId: number): SunReachEdge => ({ fromId, toId, side: "left", distanceM: 50 });
const reached = (e: SunReachEdge) => ({ ...e, sunSec: 1, arrivalSec: 1 });
const result = (reachable: SunReachEdge[], undecided: SunReachEdge[] = []): SunReachResult => ({
  outcome: undecided.length ? "approximate" : "exact",
  reachable: reachable.map(reached),
  undecided,
  stats: { labels: 0, evicted: 0, ms: 0 },
});
const ids = (edges: SunReachEdge[]) => edges.map((e) => `${e.fromId}>${e.toId}`).sort();

describe("mergeRegion", () => {
  it("keeps an edge an approximate result lost when the budget widened", () => {
    // At 8 min the search proved 1>2; at 10 min the capped search dropped it.
    const narrow: CachedReach = { sunSec: 480, timeSec: 1200, result: result([edge(1, 2), edge(2, 3)]) };
    const wide: CachedReach = { sunSec: 600, timeSec: 1200, result: result([edge(2, 3), edge(3, 4)], [edge(1, 2)]) };
    const region = mergeRegion([narrow], wide);
    expect(ids(region.proven)).toEqual(["1>2", "2>3", "3>4"]);
    // Proven wins: 1>2 is not also drawn as undecided.
    expect(region.undecided).toEqual([]);
  });

  it("never borrows from a result with a wider budget than the one shown", () => {
    const wide: CachedReach = { sunSec: 600, timeSec: 1200, result: result([edge(1, 2), edge(5, 6)]) };
    const narrow: CachedReach = { sunSec: 480, timeSec: 1200, result: result([edge(1, 2)]) };
    expect(ids(mergeRegion([wide], narrow).proven)).toEqual(["1>2"]);
    // A wider sun budget with a shorter walk is not ≤ on both, so it is not used either.
    const mixed: CachedReach = { sunSec: 300, timeSec: 1800, result: result([edge(7, 8)]) };
    expect(ids(mergeRegion([mixed], narrow).proven)).toEqual(["1>2"]);
  });

  it("only grows as the sun budget steps up through shrinking approximate results", () => {
    const steps: CachedReach[] = [
      { sunSec: 60, timeSec: 1200, result: result([edge(1, 2)]) },
      { sunSec: 120, timeSec: 1200, result: result([edge(2, 3)], [edge(1, 2)]) },
      { sunSec: 180, timeSec: 1200, result: result([edge(3, 4)], [edge(2, 3)]) },
    ];
    const cache: CachedReach[] = [];
    let prev = new Set<string>();
    for (const step of steps) {
      const next = new Set(ids(mergeRegion(cache, step).proven));
      expect([...prev].every((k) => next.has(k))).toBe(true);
      cache.push(step);
      prev = next;
    }
    expect([...prev].sort()).toEqual(["1>2", "2>3", "3>4"]);
  });
});

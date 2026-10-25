/**
 * H7 — the integer program against the oracle and the label search, on
 * whole-second fixtures small enough for CI. The full distribution report is
 * `npm run eval:h7` (`docs/notes/sun-budget-formulation.md`).
 */

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });
import { randomGraph } from "../../__tests__/paretoCases.fixture";
import { oracleReach } from "../../__tests__/sunReachOracle.fixture";
import type { GraphEdge, RoutingGraph } from "../../routing";
import { sunReach } from "../../sunReach";
import { integerSecondsGraph, streetKey, streetProgram, streetsOf } from "../model";
import { loadHighs, solveFixture } from "../solve";

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
const timeAware = { bucketMs: 30_000, bucketCount: 3 };

describe("H7 — the integer program equals the oracle and the search", () => {
  for (const seed of [11, 12]) {
    it(`seed ${seed}: three implementations, one region; the LP of the least-sun program is tight`, async () => {
      const graph = integerSecondsGraph(randomGraph(seed, 3, 3, 3));
      const o = { sunBudgetSec: 30, timeBudgetSec: 90, timeAware };
      const r = await solveFixture(graph, 0, o);
      expect(same(r.ipRegion, oracleReach(graph, 0, o))).toBe(true);
      expect(r.searchOutcome).toBe("exact");
      expect(same(r.searchRegion, r.ipRegion)).toBe(true);
      // A min-cost flow with one forced arc set: integral, so no gap.
      for (const s of r.streets) if (s.integerSun !== null) expect(s.integerSun - s.lpSun!).toBeLessThan(1e-6);
    });
  }
});

/** A graph from edges in walking SECONDS, one direction each. */
function secondsGraph(edges: Array<[number, number, number, number[]]>): RoutingGraph {
  const ids = [...new Set(edges.flatMap(([a, b]) => [a, b]))];
  const graph: RoutingGraph = { nodes: new Map(ids.map((id) => [id, { id, lat: 40.7 + id / 1000, lon: -74 }])), adj: new Map() };
  for (const id of ids) graph.adj.set(id, []);
  for (const [a, b, sec, ts] of edges) graph.adj.get(a)!.push({ toId: b, distanceM: sec * 1.4, shadowFactor: ts[0], timeShadow: ts } as GraphEdge);
  return graph;
}

describe("H7 — where the relaxation is loose (the resource-constrained form)", () => {
  it("the LP blends a fast sunny walk with a slow shaded one and undercuts every real walk", async () => {
    // 0→1 two ways: fast (10 s, full sun) or slow (40 s via 2, full shade);
    // then the street 1→3 (1 s, shaded). Sun budget 5 s: only the slow way
    // fits, arriving at 41 s. The LP takes half of each: 5 s of sun, arriving
    // at (11 + 41) / 2 = 26 s — no walk arrives then.
    const graph = secondsGraph([
      [0, 1, 10, [0]],
      [0, 2, 20, [1]],
      [2, 1, 20, [1]],
      [1, 3, 1, [1]],
    ]);
    const street = streetsOf(graph).find((s) => s.fromId === 1 && s.toId === 3)!;
    const o = { sunBudgetSec: 5, timeBudgetSec: 60 };
    const highs = await loadHighs();
    const ip = highs.solve(streetProgram(graph, 0, street, o, false, "earliest")!);
    const lp = highs.solve(streetProgram(graph, 0, street, o, true, "earliest")!);
    expect(ip.ObjectiveValue).toBeCloseTo(41, 6);
    expect(lp.ObjectiveValue).toBeCloseTo(26, 6);
    // The search agrees with the integer answer, not the bound: 1→3 is reached at 41 s.
    const searched = sunReach(graph, 0, o).reachable.find((e) => e.fromId === 1 && e.toId === 3);
    expect(searched?.arrivalSec).toBeCloseTo(41, 6);
  });
});

describe("H7 — an independent check catches a wrong dominance rule", () => {
  it("dropping the bucket-boundary slack (#246) loses a street the integer program proves", async () => {
    // H3's #246 fixture in whole seconds: two ways to node 3 (50 s / 50 s sun,
    // 55 s / 55 s sun); 3→4 (7 s) is sunny until 60 s, shaded after. Only the
    // later arrival reaches 4 on ≤ 55.5 s. Pruning without slack keeps the
    // earlier, sun-cheaper label and drops the one that works.
    const graph = secondsGraph([
      [0, 1, 25, [0, 0]],
      [1, 3, 25, [0, 0]],
      [0, 2, 27, [0, 0]],
      [2, 3, 28, [0, 0]],
      [3, 4, 7, [0, 1]],
    ]);
    const o = { sunBudgetSec: 55.5, timeBudgetSec: 120, timeAware: { bucketMs: 60_000, bucketCount: 2 } };
    const r = await solveFixture(graph, 0, o);
    expect(r.ipRegion.has(streetKey({ fromId: 3, toId: 4, side: null }))).toBe(true);
    // The shipped search keeps it (its slack covers the boundary)…
    expect(r.searchRegion.has("3>4:")).toBe(true);
    // …and a search with the slack removed would not: the rule the IP is there to catch.
    const naive = naiveDominance(graph, 0, o);
    expect(naive.has("3>4:")).toBe(false);
  });
});

/**
 * The wrong rule, implemented independently: a label at a node prunes any
 * later label with no less sun, regardless of buckets (no slack, no #246).
 */
function naiveDominance(graph: RoutingGraph, start: number, o: { sunBudgetSec: number; timeBudgetSec: number; timeAware: { bucketMs: number; bucketCount: number } }): Set<string> {
  const W = o.timeAware.bucketMs / 1000;
  const B = o.timeAware.bucketCount;
  const kept = new Map<number, Array<{ t: number; s: number }>>();
  const out = new Set<string>();
  const queue = [{ node: start, t: 0, s: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.t - b.t);
    const { node, t, s } = queue.shift()!;
    for (const e of graph.adj.get(node) ?? []) {
      const nt = t + e.distanceM / 1.4;
      if (nt > o.timeBudgetSec) continue;
      const ns = s + (e.distanceM / 1.4) * (1 - e.timeShadow![Math.min(Math.floor(nt / W), B - 1, e.timeShadow!.length - 1)]);
      if (ns > o.sunBudgetSec) continue;
      out.add(`${node}>${e.toId}:`);
      const at = kept.get(e.toId) ?? [];
      if (at.some((l) => l.t <= nt && l.s <= ns)) continue;
      kept.set(e.toId, [...at.filter((l) => !(nt <= l.t && ns <= l.s)), { t: nt, s: ns }]);
      queue.push({ node: e.toId, t: nt, s: ns });
    }
  }
  return out;
}

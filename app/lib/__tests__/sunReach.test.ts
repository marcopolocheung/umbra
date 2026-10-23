import { describe, expect, it } from "vitest";
import type { GraphEdge, RoutingGraph } from "../routing";
import { type SunReachOptions, type SunReachResult, sunReach } from "../sunReach";
import { edgeTraversalSeconds, isProhibitedEdge } from "../travelMode";
import { randomGraph, rng } from "./paretoCases.fixture";

/**
 * H3 oracle: every walk from the start, bounded by the time budget, priced
 * the way `paretoRoutes` prices it. States repeat only when (node, arrival,
 * sun) are identical, and identical states have identical futures, so the
 * memo prunes nothing a walk could need. Slow and obviously correct.
 */
function oracleReach(graph: RoutingGraph, startId: number, o: SunReachOptions): Set<string> {
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
  };
  walk(startId, 0, 0);
  return out;
}

const keyOf = (from: number, e: { toId: number; side?: string }) => `${from}>${e.toId}:${e.side ?? ""}`;
const reachKeys = (r: SunReachResult) => new Set(r.reachable.map((e) => keyOf(e.fromId, e)));
const undecidedKeys = (r: SunReachResult) => new Set(r.undecided.map((e) => keyOf(e.fromId, e)));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((k) => b.has(k));

/** Small lattices that still cross several buckets inside the time budget. */
function cases() {
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

describe("sunReach against the exhaustive oracle", () => {
  for (const c of cases()) {
    it(`seed ${c.seed} ${c.rows}×${c.cols} ${c.buckets ? `${c.buckets} buckets` : "static"}`, () => {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const truth = oracleReach(graph, c.start, c.options);
      const result = sunReach(graph, c.start, c.options);
      expect(result.outcome).toBe("exact");
      expect(reachKeys(result)).toEqual(truth);
      expect(result.undecided).toEqual([]);
    });
  }

  // 60 exhaustive oracles: ~6 s under a loaded full suite, past vitest's 5 s default.
  it("stays sound when the slot cap drops labels: reachable ⊆ truth ⊆ reachable ∪ undecided", { timeout: 30_000 }, () => {
    let approximate = 0;
    for (const c of cases()) {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const truth = oracleReach(graph, c.start, c.options);
      const result = sunReach(graph, c.start, { ...c.options, maxLabelsPerSlot: 1 });
      const lower = reachKeys(result);
      expect(subset(lower, truth)).toBe(true);
      expect(subset(truth, new Set([...lower, ...undecidedKeys(result)]))).toBe(true);
      if (result.outcome === "approximate") {
        approximate++;
        expect(result.stats.evicted).toBeGreaterThan(0);
      } else {
        expect(lower).toEqual(truth);
      }
    }
    expect(approximate).toBeGreaterThan(0);
  });

  it("proves the whole time-only region even when the slot cap drops labels", () => {
    // With sun unbounded, the least-time tree is itself a set of witness walks,
    // so a capped search must not leave any time-reachable edge undecided.
    for (const c of cases().slice(0, 20)) {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const options = { ...c.options, sunBudgetSec: 1e9 };
      const result = sunReach(graph, c.start, { ...options, maxLabelsPerSlot: 1 });
      expect(reachKeys(result)).toEqual(oracleReach(graph, c.start, options));
      expect(result.outcome).toBe("exact");
    }
  });

  it("says budget-exhausted, not unreachable, when the work cap stops it", () => {
    const graph = randomGraph(7, 5, 5, 4);
    const options: SunReachOptions = {
      sunBudgetSec: 120,
      timeBudgetSec: 220,
      timeAware: { bucketMs: 20_000, bucketCount: 4 },
    };
    const truth = oracleReach(graph, 12, options);
    const result = sunReach(graph, 12, { ...options, maxLabels: 5 });
    expect(result.outcome).toBe("budget-exhausted");
    expect(result.undecided.length).toBeGreaterThan(0);
    expect(subset(reachKeys(result), truth)).toBe(true);
    expect(subset(truth, new Set([...reachKeys(result), ...undecidedKeys(result)]))).toBe(true);
  });
});

describe("sunReach monotonicity (H3 acceptance)", () => {
  it("never shrinks the region when either budget widens", () => {
    for (const c of cases().slice(0, 25)) {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      let prev = new Set<string>();
      for (const [sun, time] of [[10, 100], [20, 100], [20, 150], [60, 150], [60, 220], [120, 220]]) {
        const result = sunReach(graph, c.start, { ...c.options, sunBudgetSec: sun, timeBudgetSec: time });
        expect(result.outcome).toBe("exact");
        const next = reachKeys(result);
        expect(subset(prev, next)).toBe(true);
        prev = next;
      }
    }
  });
});

describe("sunReach — the bucket-boundary merge (#246)", () => {
  // The H4 merge fixture: A reaches node 3 at 50 s with 50 s of sun, B at 55 s
  // with 55 s. 3→4 ends in the sunny bucket for A (57 s) and the shaded one for
  // B (62 s), so only the later arrival reaches 4 on 55.5 s of sun.
  const node = (id: number, alongM: number) => [id, { id, lat: 40.7 + alongM / 111_320, lon: -74 }] as const;
  const graph: RoutingGraph = { nodes: new Map([node(0, 0), node(1, 35), node(2, 38.5), node(3, 70), node(4, 79.8)]), adj: new Map() };
  const link = (a: number, b: number, distanceM: number, timeShadow: number[]) => {
    const e = (toId: number): GraphEdge => ({ toId, distanceM, shadowFactor: 0, timeShadow });
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!graph.adj.has(x)) graph.adj.set(x, []);
      graph.adj.get(x)!.push(e(y));
    }
  };
  link(0, 1, 35, [0, 0]);
  link(1, 3, 35, [0, 0]);
  link(0, 2, 38.5, [0, 0]);
  link(2, 3, 38.5, [0, 0]);
  link(3, 4, 9.8, [0, 1]);

  it("keeps the later arrival and reaches node 4", () => {
    const options: SunReachOptions = { sunBudgetSec: 55.5, timeBudgetSec: 120, timeAware: { bucketMs: 60_000, bucketCount: 2 } };
    const result = sunReach(graph, 0, options);
    expect(result.outcome).toBe("exact");
    const into4 = result.reachable.find((e) => e.fromId === 3 && e.toId === 4);
    expect(into4?.sunSec).toBeCloseTo(55, 6);
    expect(reachKeys(result)).toEqual(oracleReach(graph, 0, options));
  });
});

describe("sunReach — the pruning slack covers every boundary and every short edge", () => {
	/** A graph from edges given in walking SECONDS (walk speed 1.4 m/s), both directions. */
	function secondsGraph(edges: Array<[number, number, number, number[]]>): RoutingGraph {
		const ids = [...new Set(edges.flatMap(([a, b]) => [a, b]))];
		const graph: RoutingGraph = { nodes: new Map(ids.map((id) => [id, { id, lat: 40.7 + id / 1000, lon: -74 }])), adj: new Map() };
		for (const [a, b, sec, timeShadow] of edges) {
			const e = (toId: number): GraphEdge => ({ toId, distanceM: sec * 1.4, shadowFactor: timeShadow[0], timeShadow });
			for (const [x, y] of [[a, b], [b, a]]) {
				if (!graph.adj.has(x)) graph.adj.set(x, []);
				graph.adj.get(x)!.push(e(y));
			}
		}
		return graph;
	}
	const SUNNY = [0, 0, 0];
	const SHADE = [1, 1, 1];

	// In both fixtures A reaches node 3 at 50 s on 35 s of sun and B at 56 s on
	// more; only B's later clock carries the last edge into shade. A must not
	// prune B, or that edge is lost while the search still reports `exact`.

	it("sums the slack over every boundary still inside the time budget", () => {
		// Boundaries at 60 s and 120 s. A pays 8 s more at each (16 s); B is 15 s
		// behind, so one boundary's slack (8 + Δ 6) would wrongly let A prune B.
		const graph = secondsGraph([
			[0, 1, 35, SUNNY], [1, 3, 15, SHADE],
			[0, 2, 50, SUNNY], [2, 3, 6, SHADE],
			[3, 4, 8, [0, 1, 1]], [4, 5, 50, SHADE], [5, 6, 8, [0, 0, 1]],
		]);
		const options: SunReachOptions = { sunBudgetSec: 50.5, timeBudgetSec: 125, timeAware: { bucketMs: 60_000, bucketCount: 3 } };
		const result = sunReach(graph, 0, { ...options, maxLabelsPerSlot: 64 });
		expect(result.reachable.some((e) => e.fromId === 5 && e.toId === 6)).toBe(true);
		expect(reachKeys(result)).toEqual(oracleReach(graph, 0, options));
	});

	it("charges the short-edge term: two short edges in one window cost twice the largest jump", () => {
		// Two 4.5 s edges both end inside A's last 6 s before 60 s. A pays 9 s
		// more; B is 6 s behind, so the jump alone (4.5 s) would let A prune B.
		const graph = secondsGraph([
			[0, 1, 35, [0, 0]], [1, 3, 15, [1, 1]],
			[0, 2, 41, [0, 0]], [2, 3, 15, [1, 1]],
			[3, 4, 4.5, [0, 1]], [4, 5, 4.5, [0, 1]],
		]);
		const options: SunReachOptions = { sunBudgetSec: 42, timeBudgetSec: 66, timeAware: { bucketMs: 60_000, bucketCount: 2 } };
		const result = sunReach(graph, 0, options);
		expect(result.outcome).toBe("exact");
		expect(result.reachable.some((e) => e.fromId === 4 && e.toId === 5)).toBe(true);
		expect(reachKeys(result)).toEqual(oracleReach(graph, 0, options));
	});
});


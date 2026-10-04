import { describe, expect, it } from "vitest";
import { DETOUR_FLAT_M, paretoRoutes } from "../routing";
import type { GraphEdge, RoutingGraph } from "../routing";
import { edgeTraversalSeconds, modeAdjustedDistanceM } from "../travelMode";

/**
 * H4 — a correctness oracle for the H1/H2 Pareto search.
 *
 * The production search is a label-setting algorithm: it prunes by dominance,
 * bounds the detour budget, and buckets time-aware exposure. This oracle is the
 * ground truth for a *small* graph: enumerate every simple path start→end,
 * compute each one's exact (cost metres, sun seconds) with the same per-edge
 * rules, and take the Pareto front. Slow and obviously correct.
 *
 * It found a real gap — the search drops a Pareto point at a bucket-boundary
 * merge — measured below and published in `docs/notes/sun-budget-model.md`.
 *
 * Fixtures must place node coordinates consistently with their edge distances:
 * the search's straight-line heuristic reads coordinates, so arbitrary
 * positions give it an inadmissible bound and it can mis-prune the optimum.
 */

interface EdgeSpec {
	from: number;
	to: number;
	distanceM: number;
	shadowFactor: number;
	/** H1 per-bucket shadow, when the fixture is time-aware. */
	timeShadow?: number[];
}

function buildGraph(distanceAlongM: number[], edges: EdgeSpec[]): RoutingGraph {
	const nodeIds = distanceAlongM.map((_, id) => id);
	const nodes = new Map(
		nodeIds.map((id) => [id, { id, lat: 40.7 + distanceAlongM[id] / 111_320, lon: -74 }]),
	);
	const adj = new Map<number, GraphEdge[]>();
	for (const id of nodeIds) adj.set(id, []);
	for (const e of edges) {
		const edge = (toId: number): GraphEdge => ({
			toId,
			distanceM: e.distanceM,
			shadowFactor: e.shadowFactor,
			...(e.timeShadow ? { timeShadow: e.timeShadow } : {}),
		});
		adj.get(e.from)!.push(edge(e.to));
		adj.get(e.to)!.push(edge(e.from));
	}
	return { nodes, adj };
}

interface PathMetrics {
	distM: number;
	exposureSec: number;
	nodeIds: number[];
}

/**
 * Every simple path start→end with its exact cost and sun seconds. The rules
 * mirror the production label update: mode-adjusted metres, the H2 traversal
 * clock, and the exposure factor read from `timeShadow[arrivalBucket]` when
 * time-aware else `shadowFactor`, where the bucket is chosen from the arrival
 * at the edge's *end* (production's `newArrivalSec`).
 */
function enumeratePaths(
	graph: RoutingGraph,
	startId: number,
	endId: number,
	options: { timeAware?: { bucketMs: number; bucketCount: number } } = {},
): PathMetrics[] {
	const out: PathMetrics[] = [];
	const bucketOf = (arrivalSec: number): number => {
		const ta = options.timeAware!;
		return Math.min(ta.bucketCount - 1, Math.floor(arrivalSec / (ta.bucketMs / 1000)));
	};
	const walk = (
		nodeId: number,
		visited: Set<number>,
		distM: number,
		exposureSec: number,
		arrivalSec: number,
		path: number[],
	) => {
		if (nodeId === endId) {
			out.push({ distM, exposureSec, nodeIds: [...path] });
			return;
		}
		for (const edge of graph.adj.get(nodeId) ?? []) {
			if (visited.has(edge.toId)) continue; // simple paths only, like the search's U-turn ban
			const edgeSec = edgeTraversalSeconds(edge, "walk");
			const nextArrival = arrivalSec + edgeSec;
			const factor =
				options.timeAware && edge.timeShadow
					? edge.timeShadow[Math.min(bucketOf(nextArrival), edge.timeShadow.length - 1)]
					: edge.shadowFactor;
			visited.add(edge.toId);
			path.push(edge.toId);
			walk(
				edge.toId,
				visited,
				distM + modeAdjustedDistanceM(edge, "walk"),
				exposureSec + edgeSec * (1 - factor),
				nextArrival,
				path,
			);
			path.pop();
			visited.delete(edge.toId);
		}
	};
	walk(startId, new Set([startId]), 0, 0, 0, [startId]);
	return out;
}

/** The detour budget `paretoRoutes` derives from the shortest path (walk). */
function budgetFor(paths: PathMetrics[]): number {
	const shortest = Math.min(...paths.map((p) => p.distM));
	return shortest + shortest * (2.0 - 1) + DETOUR_FLAT_M;
}

/** True when some path is at least as good on both axes and strictly better on one. */
function isDominated(candidate: PathMetrics, paths: PathMetrics[]): boolean {
	return paths.some(
		(p) =>
			p.distM <= candidate.distM &&
			p.exposureSec <= candidate.exposureSec &&
			(p.distM < candidate.distM || p.exposureSec < candidate.exposureSec),
	);
}

/** The production options a fixture uses; mirrors how `useRouting` calls it. */
const walkOptions = { travelMode: "walk" as const, maxDetourFactor: 2.0 };
const leastSun = (paths: PathMetrics[]): number => Math.min(...paths.map((p) => p.exposureSec));

describe("H4 oracle — exact on a static fixture (one time bucket)", () => {
	const graph = buildGraph(
		[0, 100, 140, 200],
		[
			{ from: 0, to: 1, distanceM: 100, shadowFactor: 0 }, // short, open
			{ from: 1, to: 3, distanceM: 100, shadowFactor: 0 },
			{ from: 0, to: 2, distanceM: 140, shadowFactor: 0.9 }, // longer, shaded
			{ from: 2, to: 3, distanceM: 140, shadowFactor: 0.9 },
			{ from: 1, to: 2, distanceM: 90, shadowFactor: 0.2 }, // a dominated cross-link
		],
	);
	const allPaths = enumeratePaths(graph, 0, 3);
	const withinBudget = allPaths.filter((p) => p.distM <= budgetFor(allPaths));

	it("enumerates the simple paths and keeps only those inside the budget", () => {
		expect(allPaths).toHaveLength(4);
		expect(withinBudget.length).toBeGreaterThanOrEqual(2);
	});

	it("the production shortest equals the oracle's least-distance path", () => {
		const shortest = paretoRoutes(graph, 0, 3, walkOptions)[0];
		expect(shortest.distanceM).toBeCloseTo(Math.min(...withinBudget.map((p) => p.distM)), 6);
	});

	it("the production least-exposed option equals the oracle's minimum sun seconds", () => {
		const results = paretoRoutes(graph, 0, 3, walkOptions);
		const prodMin = Math.min(...results.map((r) => r.exposure!.exposedDurationSec));
		expect(prodMin).toBeCloseTo(leastSun(withinBudget), 6);
	});

	it("no returned option is dominated by an enumerable path", () => {
		for (const r of paretoRoutes(graph, 0, 3, walkOptions)) {
			const candidate: PathMetrics = {
				distM: r.distanceM,
				exposureSec: r.exposure!.exposedDurationSec,
				nodeIds: r.nodeIds,
			};
			expect(isDominated(candidate, withinBudget)).toBe(false);
		}
	});
});

describe("H4 oracle — a randomized 2×3 grid (static)", () => {
	function gridGraph(): RoutingGraph {
		let seed = 1234567;
		const lcg = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const nodes = new Map(
			[0, 1, 2, 3, 4, 5].map((id) => {
				const row = Math.floor(id / 3);
				const col = id % 3;
				return [id, { id, lat: 40.7 + (col * 100) / 111_320, lon: -74 + (row * 100) / 111_320 }];
			}),
		);
		const adj = new Map<number, GraphEdge[]>([0, 1, 2, 3, 4, 5].map((id) => [id, []]));
		const link = (a: number, b: number) => {
			const distanceM = 90 + Math.round(lcg() * 60);
			const shadowFactor = Math.round(lcg() * 10) / 10;
			const mk = (toId: number): GraphEdge => ({ toId, distanceM, shadowFactor });
			adj.get(a)!.push(mk(b));
			adj.get(b)!.push(mk(a));
		};
		for (let r = 0; r < 2; r++)
			for (let c = 0; c < 3; c++) {
				const id = r * 3 + c;
				if (c < 2) link(id, id + 1);
				if (r < 1) link(id, id + 3);
			}
		return { nodes, adj };
	}

	it("the production front is exact against exhaustive enumeration", () => {
		const graph = gridGraph();
		const allPaths = enumeratePaths(graph, 0, 5);
		const within = allPaths.filter((p) => p.distM <= budgetFor(allPaths));
		const results = paretoRoutes(graph, 0, 5, walkOptions);
		expect(results[0].distanceM).toBeCloseTo(Math.min(...within.map((p) => p.distM)), 6);
		expect(Math.min(...results.map((r) => r.exposure!.exposedDurationSec))).toBeCloseTo(
			leastSun(within),
			6,
		);
		for (const r of results) {
			expect(
				isDominated(
					{ distM: r.distanceM, exposureSec: r.exposure!.exposedDurationSec, nodeIds: r.nodeIds },
					within,
				),
			).toBe(false);
		}
	});
});

describe("H4 oracle — the bucket-boundary dominance gap (the published defect)", () => {
	// Two routes reach node 3 in the *same* bucket (bucket 0): A at 50 s with
	// 50 s of sun, B at 55 s with 55 s of sun. The production dominance rule
	// drops B (A is no later, no longer, no sunnier within the bucket) — but B's
	// next edge, 3→4, finishes at 62 s, inside the shaded bucket 1, while A's
	// finishes at 57 s, still in bucket 0. So B's continuation is cheaper in sun,
	// and dropping it loses a Pareto point.
	const graph = buildGraph(
		[0, 35, 38.5, 70, 79.8],
		[
			{ from: 0, to: 1, distanceM: 35, shadowFactor: 0, timeShadow: [0, 0] },
			{ from: 1, to: 3, distanceM: 35, shadowFactor: 0, timeShadow: [0, 0] },
			{ from: 0, to: 2, distanceM: 38.5, shadowFactor: 0, timeShadow: [0, 0] },
			{ from: 2, to: 3, distanceM: 38.5, shadowFactor: 0, timeShadow: [0, 0] },
			{ from: 3, to: 4, distanceM: 9.8, shadowFactor: 0, timeShadow: [0, 1] },
		],
	);
	const timeAware = { bucketMs: 60_000, bucketCount: 2 };

	it("the oracle finds a lower-sun path than the production search returns", () => {
		const paths = enumeratePaths(graph, 0, 4, { timeAware });
		const oracleMin = leastSun(paths);
		const results = paretoRoutes(graph, 0, 4, { ...walkOptions, timeAware });
		const prodMin = Math.min(...results.map((r) => r.exposure!.exposedDurationSec));

		// The oracle's best is 0-2-3-4: 55 s of sun, then a fully shaded final
		// edge. Production keeps only 0-1-3-4 (57 s) — it dropped 0-2-3-4.
		expect(oracleMin).toBeCloseTo(55, 6);
		expect(prodMin).toBeCloseTo(57, 6);
		expect(prodMin).toBeGreaterThan(oracleMin);
		expect(results.some((r) => r.nodeIds.join() === "0,2,3,4")).toBe(false);
	});
});

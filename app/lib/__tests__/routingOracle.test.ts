import { describe, expect, it } from "vitest";
import { DETOUR_FLAT_M, paretoRoutes } from "../routing";
import type { GraphEdge, RoutingGraph } from "../routing";
import { edgeTraversalSeconds, modeAdjustedDistanceM } from "../travelMode";

/**
 * H4 — a correctness oracle for the H1/H2 Pareto search.
 *
 * The production search is a label-setting algorithm: it prunes by dominance,
 * bounds the detour budget, and buckets time-aware exposure. None of that is
 * obviously correct, and its own tests check fixtures, not exhaustiveness. This
 * oracle is the ground truth for a *small* graph: enumerate every simple path
 * start→end, compute each one's exact (cost metres, sun seconds) with the same
 * per-edge rules, and take the Pareto front. Slow and obviously correct.
 *
 * The claim it can make: on these fixtures the production representatives are
 * all Pareto-optimal, and its shortest and least-exposed options are the true
 * extremes. The gap — front points the three representatives do not show — is
 * reported in docs/notes/sun-budget-model.md.
 */

interface EdgeSpec {
	from: number;
	to: number;
	distanceM: number;
	shadowFactor: number;
	/** H1 per-bucket shadow, when the fixture is time-aware. */
	timeShadow?: number[];
	highway?: string;
	isIntersection?: boolean;
}

/**
 * Build a graph whose node coordinates are consistent with the edge distances:
 * node `id` sits `distanceAlongM[id]` metres north of node 0. The search's
 * straight-line heuristic reads coordinates, so a fixture with arbitrary
 * positions would give it an inadmissible bound and mis-prune the optimum.
 */
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
			...(e.highway ? { highway: e.highway } : {}),
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
 * mirror the production label update: mode-adjusted metres (plus the crossing
 * penalty at interior intersections), the H2 traversal clock, and the exposure
 * factor read from `timeShadow[arrivalBucket]` when time-aware else
 * `shadowFactor`.
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
	const walk = (nodeId: number, visited: Set<number>, distM: number, exposureSec: number, arrivalSec: number, path: number[]) => {
		if (nodeId === endId) {
			out.push({ distM, exposureSec, nodeIds: [...path] });
			return;
		}
		for (const edge of graph.adj.get(nodeId) ?? []) {
			if (visited.has(edge.toId)) continue; // simple paths only, like the search's U-turn ban
			const nextArrival = arrivalSec + edgeTraversalSeconds(edge, "walk");
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
				exposureSec + edgeTraversalSeconds(edge, "walk") * (1 - factor),
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

/** The detour budget `paretoRoutes` derives from the shortest path. */
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

describe("H4 oracle — the production front is Pareto-optimal on fixtures", () => {
	// Two routes to the destination: a short open one and a longer shaded one,
	// plus a dominated middle that no search should ever return.
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
		// 0-1-3, 0-2-3, 0-1-2-3, 0-2-1-3 are the simple paths.
		expect(allPaths).toHaveLength(4);
		expect(withinBudget.length).toBeGreaterThanOrEqual(2);
	});

	it("the production shortest equals the oracle's least-distance path", () => {
		const shortest = paretoRoutes(graph, 0, 3, walkOptions)[0];
		const oracleMin = Math.min(...withinBudget.map((p) => p.distM));
		expect(shortest.distanceM).toBeCloseTo(oracleMin, 6);
	});

	it("the production least-exposed option equals the oracle's minimum sun seconds", () => {
		const results = paretoRoutes(graph, 0, 3, walkOptions);
		const prodMin = Math.min(...results.map((r) => r.exposure!.exposedDurationSec));
		const oracleMin = Math.min(...withinBudget.map((p) => p.exposureSec));
		expect(prodMin).toBeCloseTo(oracleMin, 6);
	});

	it("no returned option is dominated by an enumerable path", () => {
		const results = paretoRoutes(graph, 0, 3, walkOptions);
		for (const r of results) {
			const candidate: PathMetrics = {
				distM: r.distanceM,
				exposureSec: r.exposure!.exposedDurationSec,
				nodeIds: r.nodeIds,
			};
			expect(isDominated(candidate, withinBudget)).toBe(false);
		}
	});
});

describe("H4 oracle — time-aware exposure (H1)", () => {
	// The shaded route's shade only exists in the later bucket; a static run
	// would misprice it, so the time-aware search must differ from the static one.
	const graph = buildGraph(
		[0, 100, 150, 200],
		[
			{ from: 0, to: 1, distanceM: 100, shadowFactor: 0.5, timeShadow: [0.5, 0.5] },
			{ from: 1, to: 3, distanceM: 100, shadowFactor: 0.5, timeShadow: [0.5, 0.5] },
			{ from: 0, to: 2, distanceM: 150, shadowFactor: 0.5, timeShadow: [0.0, 0.95] },
			{ from: 2, to: 3, distanceM: 150, shadowFactor: 0.5, timeShadow: [0.0, 0.95] },
		],
	);
	const timeAware = { bucketMs: 60_000, bucketCount: 2 };

	it("prices each edge at the bucket the walker arrives in", () => {
		const paths = enumeratePaths(graph, 0, 3, { timeAware });
		const viaShort = paths.find((p) => p.nodeIds.join() === "0,1,3")!;
		const viaShade = paths.find((p) => p.nodeIds.join() === "0,2,3")!;
		// 0-2-3 is longer but its second edge is nearly fully shaded once the
		// walker arrives in bucket 1, so its sun seconds drop below 0-1-3's.
		expect(viaShade.exposureSec).toBeLessThan(viaShort.exposureSec);
	});

	it("the production time-aware search agrees with the oracle on the least sun", () => {
		const results = paretoRoutes(graph, 0, 3, { ...walkOptions, timeAware });
		const prodMin = Math.min(...results.map((r) => r.exposure!.exposedDurationSec));
		const paths = enumeratePaths(graph, 0, 3, { timeAware }).filter((p) => p.distM <= budgetFor(enumeratePaths(graph, 0, 3, { timeAware })));
		const oracleMin = Math.min(...paths.map((p) => p.exposureSec));
		expect(prodMin).toBeCloseTo(oracleMin, 6);
	});
});

describe("H4 oracle — model properties", () => {
	const graph = buildGraph(
		[0, 100, 140, 200],
		[
			{ from: 0, to: 1, distanceM: 100, shadowFactor: 0 },
			{ from: 1, to: 3, distanceM: 100, shadowFactor: 0 },
			{ from: 0, to: 2, distanceM: 140, shadowFactor: 0.9 },
			{ from: 2, to: 3, distanceM: 140, shadowFactor: 0.9 },
		],
	);
	const paths = enumeratePaths(graph, 0, 3);

	it("widening the detour budget never removes a feasible path", () => {
		const feasible = (factor: number): number => {
			const shortest = Math.min(...paths.map((p) => p.distM));
			const budget = shortest + shortest * (factor - 1) + DETOUR_FLAT_M;
			return paths.filter((p) => p.distM <= budget).length;
		};
		expect(feasible(2.5)).toBeGreaterThanOrEqual(feasible(2.0));
		expect(feasible(2.0)).toBeGreaterThanOrEqual(feasible(1.0));
	});

	it("a longer all-shade route carries fewer sun seconds than a shorter open one", () => {
		const short = paths.find((p) => p.nodeIds.join() === "0,1,3")!;
		const shaded = paths.find((p) => p.nodeIds.join() === "0,2,3")!;
		expect(shaded.distM).toBeGreaterThan(short.distM);
		expect(shaded.exposureSec).toBeLessThan(short.exposureSec);
	});
});

describe("H4 oracle — a randomized 2×3 grid", () => {
	// A deterministic pseudo-random fixture: a 2×3 grid with seeded shadow
	// factors, corner to corner. Coordinates are the grid's own geometry, so the
	// straight-line heuristic stays admissible (it never exceeds the grid path).
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
		for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
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
		const oracleMinDist = Math.min(...within.map((p) => p.distM));
		const oracleMinSun = Math.min(...within.map((p) => p.exposureSec));
		expect(results[0].distanceM).toBeCloseTo(oracleMinDist, 6);
		expect(Math.min(...results.map((r) => r.exposure!.exposedDurationSec))).toBeCloseTo(
			oracleMinSun,
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

describe("H4 oracle — the H1 bucket approximation gap", () => {
	// The production model reads shadow from `timeShadow[bucketOf(arrival)]`,
	// sampled at bucket boundaries. When the real shadow changes *inside* a
	// bucket, the sampled value misprices the edge. Here the walker reaches the
	// shaded edge at t=181.4 s, inside bucket 3 ([180, 240)), where the shadow
	// has just turned on; the bucket's boundary sample still says "open", so the
	// whole edge is charged as sun. The gap is one edge's traversal seconds.
	const bucketSec = 60;
	const stepOn = (t: number): number => (t >= 181 ? 1 : 0);
	const graph = buildGraph(
		[0, 154, 254],
		[
			{ from: 0, to: 1, distanceM: 154, shadowFactor: 0 }, // 110 s at 1.4 m/s
			{
				from: 1,
				to: 2,
				distanceM: 100,
				shadowFactor: 0,
				// Boundary samples at 0/60/120/180 s — all still open.
				timeShadow: [0, 1, 2, 3].map((b) => stepOn(b * bucketSec)),
			},
		],
	);
	const timeAware = { bucketMs: bucketSec * 1000, bucketCount: 4 };
	const edgeSec = edgeTraversalSeconds({ distanceM: 100, shadowFactor: 0 } as GraphEdge, "walk");

	it("the bucketed model over-charges by up to one edge's traversal seconds", () => {
		const firstEdgeSec = 154 / 1.4; // 110 s, open
		const endArrivalSec = firstEdgeSec + 100 / 1.4; // 181.43 s
		// Continuous truth: the first edge is open (110 s), the shaded edge's
		// shadow is on at arrival (0 s).
		const truth = firstEdgeSec + edgeSec * (1 - stepOn(endArrivalSec));
		const results = paretoRoutes(graph, 0, 2, { ...walkOptions, timeAware });
		const bucketed = Math.min(...results.map((r) => r.exposure!.exposedDurationSec));
		expect(truth).toBeCloseTo(firstEdgeSec, 6);
		// The bucket boundary sample still reads "open", so the whole shaded edge
		// is charged as sun: the gap is that edge's traversal seconds.
		expect(bucketed - truth).toBeCloseTo(edgeSec, 6);
	});
});

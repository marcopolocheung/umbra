/**
 * L4 (#270): `searchStrategy: "direct"` against the Pareto front it replaces,
 * on the same 161 seeded lattices the L3 parity oracle uses, at production
 * settings.
 *
 * The ladder is not exact: a least-sun route in a concave dent of the front is
 * invisible to a weighted sum. What it is held to: the same cost-shortest
 * route, a bounded number of least-sun misses against the exact front, and —
 * on real NYC routes, where the shipped front's cap is what loses the long
 * shaded detours — `server/navigation-prep/audit/routeCompare.audit.ts`.
 * Rain is excluded by design: it keeps the plain front.
 */

import { describe, expect, it } from "vitest";
import {
  type DijkstraOptions,
  type GraphEdge,
  type OsmNode,
  paretoRoutes,
  type RouteResult,
  type RoutingGraph,
} from "../routing";
import { parityCases, randomGraph } from "./paretoCases.fixture";

const sunOf = (r: RouteResult) => r.exposure?.exposedDurationSec ?? Number.POSITIVE_INFINITY;

/** Production settings for one seeded lattice: walk, 15 m crossings, the
 * default 2.0 detour, 15-minute buckets when time-aware, no streak cap. */
function productionOptions(c: ReturnType<typeof parityCases>[number], timed: boolean): DijkstraOptions {
  return {
    crossingPenaltyM: 15,
    travelMode: "walk",
    objective: "sun",
    straightLineDistM: c.opts.straightLineDistM,
    ...(timed ? { timeAware: { bucketMs: 15 * 60_000, bucketCount: Math.max(1, c.buckets) } } : {}),
  };
}

const sunCases = () => {
  const seen = new Set<string>();
  const out: Array<{ c: ReturnType<typeof parityCases>[number]; timed: boolean }> = [];
  for (const c of parityCases()) {
    if (c.opts.objective === "rain") continue;
    for (const timed of [false, true]) {
      if (seen.has(`${c.seed}-${timed}`)) continue;
      seen.add(`${c.seed}-${timed}`);
      out.push({ c, timed });
    }
  }
  return out;
};

const leastSun = (rs: RouteResult[]) => Math.min(...rs.map(sunOf));

describe("paretoRoutes direct strategy vs the shipped front (cap 20)", () => {
  for (const { c, timed } of sunCases()) {
    it(`seed ${c.seed} ${c.rows}×${c.cols}${timed ? " time-aware" : ""}`, () => {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const opts = productionOptions(c, timed);
      const shipped = paretoRoutes(graph, c.start, c.end, opts);
      const direct = paretoRoutes(graph, c.start, c.end, { ...opts, searchStrategy: "direct" });
      if (shipped.length === 0) {
        expect(direct).toEqual([]);
        return;
      }
      expect(direct.length).toBeGreaterThan(0);
      // The first route is a cost-shortest one: no shipped route is cheaper
      // to walk (equal-cost ties may pick another path, so sun is not compared).
      expect(direct[0].distanceM).toBeLessThanOrEqual(Math.max(...shipped.map((r) => r.distanceM)) + 1e-6);
    });
  }
});

it("misses the exact least-sun route on at most 5 of the seeded lattices", () => {
  // The ladder finds the supported points of the front; a least-sun route in
  // a concave dent of it is invisible to a weighted sum. Measured 2026-10-07:
  // 5 of 276 production-setting lattices, each by 12–36 s of sun. A rise here
  // is a regression; a fall is welcome.
  let misses = 0;
  for (const { c, timed } of sunCases()) {
    const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
    const opts = productionOptions(c, timed);
    const exact = paretoRoutes(graph, c.start, c.end, { ...opts, maxLabelsPerNode: 1e9 });
    if (exact.length === 0) continue;
    const direct = paretoRoutes(graph, c.start, c.end, { ...opts, searchStrategy: "direct" });
    if (leastSun(direct) > leastSun(exact) + 1e-6) misses++;
  }
  expect(misses).toBeLessThanOrEqual(5);
});

describe("paretoRoutes direct strategy", () => {
  const node = (id: number, lat: number, lon: number): [number, OsmNode] => [id, { id, lat, lon }];
  const edge = (toId: number, distanceM: number, shadowFactor: number): GraphEdge => ({ toId, distanceM, shadowFactor });

  /**
   * A short sunny street and a longer shaded one between the same corners:
   *   1 → 2 → 4   400 m, bare
   *   1 → 3 → 4   600 m, fully shaded
   */
  function twoStreets(): RoutingGraph {
    const nodes = new Map([node(1, 0, 0), node(2, 0.0018, 0), node(3, 0, 0.0027), node(4, 0.0018, 0.0027)]);
    const adj = new Map<number, GraphEdge[]>([
      [1, [edge(2, 200, 0), edge(3, 300, 1)]],
      [2, [edge(1, 200, 0), edge(4, 200, 0)]],
      [3, [edge(1, 300, 1), edge(4, 300, 1)]],
      [4, [edge(2, 200, 0), edge(3, 300, 1)]],
    ]);
    return { nodes, adj };
  }

  it("offers both the shortest street and the shaded detour", () => {
    const routes = paretoRoutes(twoStreets(), 1, 4, { searchStrategy: "direct" });
    expect(routes[0].nodeIds).toEqual([1, 2, 4]);
    expect(routes.some((r) => r.nodeIds.join() === "1,3,4" && r.shadowCoverage === 1)).toBe(true);
  });

  it("keeps the shaded detour no matter how many near-equal short variants exist", () => {
    // The front evicts its longest labels first once a node's set is full,
    // which is exactly the shaded detour. Fan the short street out into many
    // equal-cost sunny variants and the direct search must still find it.
    const g = twoStreets();
    for (let k = 0; k < 30; k++) {
      const id = 100 + k;
      g.nodes.set(id, { id, lat: 0.0009, lon: 0.00001 * k });
      g.adj.get(1)!.push(edge(id, 200, 0.01 * (k % 3)));
      g.adj.set(id, [edge(1, 200, 0), edge(2, 1, 0)]);
      g.adj.get(2)!.push(edge(id, 1, 0));
    }
    const routes = paretoRoutes(g, 1, 4, { searchStrategy: "direct", maxLabelsPerNode: 2 });
    expect(routes.some((r) => r.nodeIds.join() === "1,3,4")).toBe(true);
  });

  it("leaves rain on the front", () => {
    const g = twoStreets();
    for (const edges of g.adj.values()) for (const e of edges) e.shelterFactor = e.shadowFactor;
    const front = paretoRoutes(g, 1, 4, { objective: "rain" });
    const direct = paretoRoutes(g, 1, 4, { objective: "rain", searchStrategy: "direct" });
    expect(direct).toEqual(front);
  });
});

/**
 * L3c (#263): the routing worker searches a graph rebuilt from typed arrays, so
 * the rebuild must be exact — same keys in the same order, same edges in the
 * same order, every number bit-identical, absent optional fields still absent —
 * and `paretoRoutes` on it must return what it returns on the original.
 */

import { describe, expect, it } from "vitest";
import { type GraphEdge, paretoRoutes, type RoutingGraph } from "../routing";
import { packRoutingGraph, transferList, unpackRoutingGraph } from "../routingGraphCodec";
import { parityCases, randomGraph } from "./paretoCases.fixture";

const roundTrip = (g: RoutingGraph) => unpackRoutingGraph(packRoutingGraph(g));

/** Strip `name`, the one field the codec deliberately drops. */
const withoutName = (g: RoutingGraph): RoutingGraph => ({
  nodes: g.nodes,
  adj: new Map([...g.adj].map(([id, edges]) => [id, edges.map(({ name: _name, ...rest }) => rest)])),
});

function edgeCaseGraph(): RoutingGraph {
  const big = 2 ** 31 + 12345;
  const nodes: RoutingGraph["nodes"] = new Map([
    [big, { id: big, lat: 40.75, lon: -73.98, isIntersection: true }],
    [-1, { id: -1, lat: 40.7501, lon: -73.9801 }],
    [7, { id: 7, lat: 40.7502, lon: -73.9802, isIntersection: false }],
    // A node record with no adj entry at all.
    [8, { id: 8, lat: 40.7503, lon: -73.9803 }],
  ]);
  const full: GraphEdge = {
    toId: -1,
    distanceM: 12.345678901234567,
    shadowFactor: 0.1 + 0.2,
    shelterFactor: 0,
    shelterConfidence: Number.NaN,
    exposureConfidence: 1,
    side: "left",
    highway: "footway",
    surface: "asphalt",
    smoothness: "bad",
    cycleway: "lane",
    bicycle: "designated",
    foot: "yes",
    access: "permissive",
    timeShadow: [0, 0.125, 1],
  };
  const adj: RoutingGraph["adj"] = new Map([
    // Key order differs from `nodes` order on purpose.
    [-1, [
      { toId: big, distanceM: 3, shadowFactor: 1, side: "right", timeShadow: [] },
      // Edge-only target: 999 has no node record.
      { toId: 999, distanceM: 4, shadowFactor: 0, highway: "steps" },
    ]],
    [big, [full, { toId: 7, distanceM: 5, shadowFactor: 0.5 }]],
    [7, []],
    // An adj key with no node record.
    [999, [{ toId: -1, distanceM: 4, shadowFactor: 0, highway: "steps", foot: "no" }]],
  ]);
  return { nodes, adj };
}

describe("routing graph codec", () => {
  it("round-trips ids, order, values and absence exactly", () => {
    const g = edgeCaseGraph();
    const back = roundTrip(g);
    expect([...back.nodes.keys()]).toEqual([...g.nodes.keys()]);
    expect([...back.adj.keys()]).toEqual([...g.adj.keys()]);
    // `isIntersection: false` reads like absence to the search; the codec emits absence.
    const nodes = new Map(g.nodes);
    nodes.set(7, { id: 7, lat: 40.7502, lon: -73.9802 });
    expect(back).toStrictEqual({ nodes, adj: g.adj });
    const empty = back.adj.get(-1)![0];
    expect(empty.timeShadow).toEqual([]);
    expect("shelterFactor" in empty).toBe(false);
    expect(Number.isNaN(back.adj.get(2 ** 31 + 12345)![0].shelterConfidence)).toBe(true);
  });

  it("drops only `name`", () => {
    const g = edgeCaseGraph();
    g.adj.get(7)!.push({ toId: 8, distanceM: 1, shadowFactor: 0, name: "Broadway" });
    expect(roundTrip(g).adj).toStrictEqual(withoutName(g).adj);
  });

  it("transfers every typed-array buffer, each once", () => {
    const packed = packRoutingGraph(edgeCaseGraph());
    const list = transferList(packed);
    // Independent of transferList: every typed array anywhere in the packed graph.
    const typed = [...Object.values(packed), ...Object.values(packed.tags)].filter(ArrayBuffer.isView);
    expect(new Set(list)).toEqual(new Set(typed.map((a) => a.buffer)));
    expect(new Set(list).size).toBe(list.length);
    for (const b of list) expect(b).toBeInstanceOf(ArrayBuffer);
  });

  it("round-trips the parity lattices", () => {
    // The generator writes some tags as `highway: undefined`; the codec emits
    // them absent, which every reader (`edge.highway`) sees identically.
    const definedOnly = (g: RoutingGraph): RoutingGraph => ({
      nodes: g.nodes,
      adj: new Map(
        [...g.adj].map(([id, edges]) => [
          id,
          edges.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as GraphEdge),
        ]),
      ),
    });
    for (const c of parityCases().slice(0, 20)) {
      const g = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      expect(roundTrip(g)).toStrictEqual(definedOnly(g));
    }
  });

  describe("paretoRoutes on the rebuilt graph matches the original", () => {
    for (const c of parityCases()) {
      it(`seed ${c.seed}`, () => {
        const g = randomGraph(c.seed, c.rows, c.cols, c.buckets);
        expect(paretoRoutes(roundTrip(g), c.start, c.end, c.opts)).toStrictEqual(
          paretoRoutes(g, c.start, c.end, c.opts),
        );
      });
    }

    it("with negative virtual endpoints and an edge-only target", () => {
      const g = randomGraph(77, 6, 6, 3);
      const edge = (toId: number, distanceM: number, s: number): GraphEdge => ({
        toId, distanceM, shadowFactor: s, timeShadow: [s, 1 - s, s],
      });
      g.nodes.set(-1, { id: -1, lat: 40.7001, lon: -73.9998, isIntersection: true });
      g.nodes.set(-2, { id: -2, lat: 40.7005, lon: -73.996, isIntersection: true });
      g.adj.set(-1, [edge(0, 20, 0.2), edge(1, 45, 0.9)]);
      g.adj.get(0)!.push(edge(-1, 20, 0.2));
      g.adj.get(1)!.push(edge(-1, 45, 0.9));
      g.adj.set(-2, [edge(34, 15, 0.7), edge(35, 30, 0.1)]);
      g.adj.get(34)!.push(edge(-2, 15, 0.7));
      g.adj.get(35)!.push(edge(-2, 30, 0.1));
      g.adj.get(14)!.push(edge(900, 5, 1));
      g.adj.set(900, [edge(14, 5, 1)]);
      const opts = { timeAware: { bucketMs: 30_000, bucketCount: 3 }, crossingPenaltyM: 15 };
      const expected = paretoRoutes(g, -1, -2, opts);
      expect(expected.length).toBeGreaterThan(0);
      expect(paretoRoutes(roundTrip(g), -1, -2, opts)).toStrictEqual(expected);
    });
  });
});

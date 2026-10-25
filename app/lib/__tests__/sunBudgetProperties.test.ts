/**
 * H4 — the Sun Budget property tests the brief lists, beyond H3's
 * monotonicity on one-way walks (`sunReach.test.ts`):
 *   1. widening a budget never removes a reachable street — with waits and
 *      round trips too, and for what the map paints (`mergeRegion`) even when
 *      a single result is only `approximate`;
 *   2. geometry-based exposure (the published shade table) never depends on
 *      the map: zoom, viewport or basemap;
 *   3. a start time propagates through every leg and every stay: departing
 *      one bucket later is the same as the sky arriving one bucket earlier.
 * Results and method: `docs/notes/sun-budget-model.md`, "H4 — properties".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { timeAwareGraphFromTable } from "../navigationData/reachGraph";
import { createShadeTableView, departureFromShadeTable, shadeSlotsForDeparture } from "../navigationData/shadeTable";
import type { NavigationShadeShard } from "../navigationData/shardContract";
import { type CachedReach, mergeRegion } from "../reach/mergeRegion";
import type { GraphEdge, RoutingGraph } from "../routing";
import { type SunReachOptions, type SunReachWalk, sunReach, sunReachRun } from "../sunReach";
import { edgeTraversalSeconds, isProhibitedEdge } from "../travelMode";
import { routeNeedsCanvas } from "../../hooks/useRouting";
import { randomGraph } from "./paretoCases.fixture";
import { cases, reachKeys, roundTripCases, subset } from "./sunReachOracle.fixture";

/** Widening steps: sun first, then time, then both — every step ≥ the last on both budgets. */
const LADDER: Array<[number, number]> = [[10, 100], [20, 100], [20, 150], [60, 150], [60, 220], [120, 220]];

describe("H4 property 1 — a wider budget never removes a street", () => {
  for (const variant of ["waits", "round trip", "round trip with waits"] as const) {
    it(`on exact results, ${variant}`, () => {
      let checked = 0;
      for (const c of cases().slice(0, 25)) {
        if (variant !== "round trip" && !c.options.timeAware) continue;
        const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
        const extra: Partial<SunReachOptions> = {
          ...(variant.includes("waits") ? { allowWaits: true } : {}),
          ...(variant.startsWith("round trip") ? { roundTrip: { dwellSec: 15 } } : {}),
        };
        let prev = new Set<string>();
        for (const [sun, time] of LADDER) {
          const result = sunReach(graph, c.start, { ...c.options, ...extra, sunBudgetSec: sun, timeBudgetSec: time, maxLabelsPerSlot: 256 });
          const next = reachKeys(result);
          // A round trip is exact only when its bound leaves nothing undecided;
          // the property is claimed for exact results, as H3 claims it.
          if (result.outcome === "exact") {
            expect(subset(prev, next), `seed ${c.seed} ${sun}/${time}`).toBe(true);
            checked++;
          }
          prev = result.outcome === "exact" ? next : new Set();
        }
      }
      expect(checked).toBeGreaterThan(30);
    });
  }

  it("what the map paints never shrinks, even from capped, approximate results (B − ε ⊆ B)", () => {
    // One-step widenings of 1 s of sun at slot caps 1–2, where single results
    // are known to shrink (H3: 90 shrinks in 4,800 widenings). The painted
    // region is `mergeRegion` over every result so far.
    let shrinksAlone = 0;
    for (const c of [...cases().slice(0, 20), ...roundTripCases().slice(0, 10)]) {
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      for (const cap of [1, 2]) {
        const cache: CachedReach[] = [];
        let prevPainted = new Set<string>();
        let prevAlone = new Set<string>();
        for (let sun = 10; sun <= 40; sun++) {
          const result = sunReach(graph, c.start, { ...c.options, sunBudgetSec: sun, maxLabelsPerSlot: cap });
          const entry: CachedReach = { sunSec: sun, timeSec: c.options.timeBudgetSec, result };
          cache.push(entry);
          const painted = new Set(mergeRegion(cache, entry).proven.map((e) => `${e.fromId}>${e.toId}:${e.side ?? ""}`));
          expect(subset(prevPainted, painted), `seed ${c.seed} cap ${cap} sun ${sun}`).toBe(true);
          const alone = reachKeys(result);
          if (!subset(prevAlone, alone)) shrinksAlone++;
          prevPainted = painted;
          prevAlone = alone;
        }
      }
    }
    // The property must be tested where it is needed: single results do shrink here.
    expect(shrinksAlone).toBeGreaterThan(0);
  });
});

describe("H4 property 2 — geometry exposure never depends on the map", () => {
  // A two-segment shade table; every byte different, so a swapped slot or side shows.
  const bounds = { south: 40.75, west: -74.0, north: 40.76, east: -73.99 };
  const segments: Array<[number, number]> = [[1, 2], [2, 3]];
  const slots = [40, 41, 42];
  const view = createShadeTableView([
    {
      shard: {
        version: 1,
        dataset: "nyc-navigation",
        generation: "nyc-2026-09-18-000000000000",
        kind: "shade",
        geometryBounds: bounds,
        supportBounds: bounds,
        slots: 768,
        segments,
        payload: { key: "shades/a.bin", bytes: segments.length * 768 * 2, sha256: "a".repeat(64) },
      } satisfies NavigationShadeShard,
      blocks: new Map(slots.map((slot) => [slot, Uint8Array.from(segments.flatMap((_, i) => [3 * i + slot, 100 + 3 * i + slot]))])),
    },
  ]);
  const streets = (): RoutingGraph => {
    const nodes = new Map([1, 2, 3].map((id) => [id, { id, lat: 40.751 + id / 1e4, lon: -73.995 }]));
    const edge = (toId: number): GraphEdge => ({ toId, distanceM: 40, shadowFactor: 0 });
    return { nodes, adj: new Map([[1, [edge(2)]], [2, [edge(1), edge(3)]], [3, [edge(2)]]]) };
  };

  it("reads each sidewalk's own column at each bucket's own slot — the table, not the map", () => {
    // Values, not just determinism: a swapped side or slot fails here.
    const g = timeAwareGraphFromTable(streets(), view, slots);
    const forward = g.adj.get(1)!.filter((e) => e.toId === 2);
    const left = forward.find((e) => e.side === "left")!;
    const right = forward.find((e) => e.side === "right")!;
    expect(left.timeShadow).toEqual(slots.map((slot) => view.shadowFor("1,2", slot)!.left));
    expect(right.timeShadow).toEqual(slots.map((slot) => view.shadowFor("1,2", slot)!.right));
    // Walking against the stored direction swaps which column is your left.
    const back = g.adj.get(2)!.find((e) => e.toId === 1 && e.side === "left")!;
    expect(back.timeShadow).toEqual(slots.map((slot) => view.shadowFor("1,2", slot)!.right));
  });

  it("a Directions route the table covers never reads the canvas, whatever the map's state", () => {
    // `routeNeedsCanvas` is the one gate on the pixel path (invariant #5).
    for (const coverageConfidence of [0, 0.2, 0.49, 1]) {
      expect(routeNeedsCanvas({ departureFromTable: true, rain: false, coverageConfidence })).toBe(false);
    }
    // Off the table, low coverage still falls back, and rain never does.
    expect(routeNeedsCanvas({ departureFromTable: false, rain: false, coverageConfidence: 0.2 })).toBe(true);
    expect(routeNeedsCanvas({ departureFromTable: false, rain: true, coverageConfidence: 0.2 })).toBe(false);
  });

  it("the table path's code never calls a map, canvas or style API", () => {
    // A hidden zoom or basemap dependency needs one of these calls; this cannot
    // catch a value smuggled in through a global, and the note says so.
    const files = ["../navigationData/reachGraph.ts", "../navigationData/shadeTable.ts", "../sunReach.ts", "../reach/mergeRegion.ts"];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/getZoom|getCanvas|readBuildingShadowMask|queryRenderedFeatures|querySourceFeatures|getStyle|maplibre/);
    }
    expect(departureFromShadeTable.length).toBe(5);
    expect(sunReachRun.length).toBe(3);
  });
});

describe("H4 property 3 — a start time reaches every leg and every stay", () => {
  // Two halves. (a) The app: departing one bucket later reads the shade table
  // one slot later for every bucket — the graph's sky moves one bucket earlier.
  // (b) The search: on that moved sky, every step it prices — streets, waits,
  // the stay, the walk home — costs what the original sky costs with the
  // clock started one bucket in.

  it("(a) a departure 15 min later reads every bucket one slot later", () => {
    const departure = new Date("2026-07-01T14:00:00Z"); // 10:00 New York, in daylight
    const later = new Date(departure.getTime() + 15 * 60_000);
    const n = 6;
    const early = shadeSlotsForDeparture(departure, n + 1, -240).perBucket;
    expect(shadeSlotsForDeparture(later, n, -240).perBucket).toEqual(early.slice(1));
  });

  /** The same graph with every edge's sky moved `k` buckets earlier (bucket b ← old b + k). */
  const skyEarlier = (graph: RoutingGraph, k: number): RoutingGraph => ({
    nodes: graph.nodes,
    adj: new Map(
      [...graph.adj].map(([from, edges]) => [
        from,
        edges.map((e) => {
          if (!e.timeShadow?.length) return e;
          const ts = e.timeShadow;
          return { ...e, timeShadow: ts.map((_, b) => ts[Math.min(b + k, ts.length - 1)]) };
        }),
      ]),
    ),
  });

  for (const variant of ["one way", "waits", "round trip"] as const) {
    it(`(b) ${variant}: every proof on the later sky re-prices exactly with the clock started a bucket in`, () => {
      let compared = 0;
      for (const c of cases()) {
        if (!c.options.timeAware || c.buckets < 3) continue;
        const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
        const options: SunReachOptions = {
          ...c.options,
          ...(variant === "waits" ? { allowWaits: true } : {}),
          ...(variant === "round trip" ? { roundTrip: { dwellSec: 25 } } : {}),
          maxLabelsPerSlot: 256,
        };
        const run = sunReachRun(skyEarlier(graph, 1), c.start, options);
        const W = options.timeAware!.bucketMs / 1000;
        for (const edge of run.result.reachable.slice(0, 15)) {
          const walk = run.witness(edge.fromId, edge.toId, edge.side)!;
          const costs = priceFrom(graph, walk, options, W);
          const match = costs.some((k) => Math.abs(k.s - walk.sunSec) < 1e-6 && Math.abs(k.t - walk.arrivalSec) < 1e-6);
          expect(match, `seed ${c.seed} ${edge.fromId}>${edge.toId}`).toBe(true);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(50);
    });
  }
});

/**
 * Every (arrival, sun) a walk can cost on `graph` with its clock started at
 * `offset` seconds: each street, wait and stay priced at bucket
 * ⌊(offset + t) / W⌋. Several when parallel sidewalks share a side.
 */
function priceFrom(graph: RoutingGraph, walk: SunReachWalk, o: SunReachOptions, offset: number): Array<{ t: number; s: number }> {
  const mode = o.travelMode ?? "walk";
  const W = o.timeAware!.bucketMs / 1000;
  const B = o.timeAware!.bucketCount;
  const bucket = (t: number) => Math.min(Math.floor((offset + t) / W), B - 1);
  const shadeAt = (e: GraphEdge, t: number) => {
    const ts = e.timeShadow;
    return !ts || ts.length === 0 ? e.shadowFactor : ts[Math.min(bucket(t), ts.length - 1)];
  };
  const nodeShade = (node: number, t: number) => Math.max(0, ...(graph.adj.get(node) ?? []).map((e) => shadeAt(e, t)));
  const stand = (node: number, st: { t: number; s: number }, seconds: number) => {
    let s = st.s;
    for (let at = st.t, end = st.t + seconds; at < end; ) {
      const step = bucket(at) < B - 1 ? Math.min(end, (Math.floor((offset + at) / W) + 1) * W - offset) : end;
      s += (step - at) * (1 - nodeShade(node, at));
      at = step;
    }
    return { t: st.t + seconds, s };
  };
  let states = [{ t: 0, s: 0 }];
  for (let i = 0; i < walk.nodeIds.length; i++) {
    for (const w of walk.waits.filter((x) => x.atNode === i)) states = states.map((st) => stand(walk.nodeIds[i], st, w.seconds));
    if (walk.dwell?.atNode === i) states = states.map((st) => stand(walk.nodeIds[i], st, walk.dwell!.seconds));
    if (i + 1 === walk.nodeIds.length) break;
    const edges = (graph.adj.get(walk.nodeIds[i]) ?? []).filter(
      (e) => e.toId === walk.nodeIds[i + 1] && !isProhibitedEdge(e, mode) && (e.side ?? null) === walk.sides[i],
    );
    states = states.flatMap((st) =>
      edges.map((e) => {
        const sec = edgeTraversalSeconds(e, mode);
        return { t: st.t + sec, s: st.s + sec * (1 - shadeAt(e, st.t + sec)) };
      }),
    );
  }
  return states;
}

describe("stayExposure — one pricing of a stay for routes and Sun Budget (#391)", () => {
  it("prices a round trip's stay exactly as the Sun Budget search does", async () => {
    const { stayExposure } = await import("../sunReach");
    let compared = 0;
    for (const c of roundTripCases().slice(0, 20)) {
      if (!c.options.timeAware) continue;
      const graph = randomGraph(c.seed, c.rows, c.cols, c.buckets);
      const run = sunReachRun(graph, c.start, { ...c.options, allowWaits: false });
      for (const edge of run.result.reachable.slice(0, 5)) {
        const walk = run.witness(edge.fromId, edge.toId, edge.side)!;
        if (!walk.dwell || walk.dwell.seconds === 0) continue;
        // Re-price the outing with stayExposure for the stay and plain arrival
        // pricing for the streets: it must total the reported sun.
        const mode = c.options.travelMode ?? "walk";
        const W = c.options.timeAware!.bucketMs / 1000;
        const B = c.options.timeAware!.bucketCount;
        let t = 0;
        let s = 0;
        for (let i = 0; i < walk.nodeIds.length; i++) {
          if (walk.dwell.atNode === i) {
            for (const p of stayExposure(graph, walk.nodeIds[i], t, walk.dwell.seconds, c.options.timeAware)) s += p.durationSec * (1 - p.shade);
            t += walk.dwell.seconds;
          }
          if (i + 1 === walk.nodeIds.length) break;
          const e = (graph.adj.get(walk.nodeIds[i]) ?? []).find(
            (x) => x.toId === walk.nodeIds[i + 1] && !isProhibitedEdge(x, mode) && (x.side ?? null) === walk.sides[i],
          )!;
          const sec = edgeTraversalSeconds(e, mode);
          t += sec;
          const ts = e.timeShadow;
          s += sec * (1 - (!ts || ts.length === 0 ? e.shadowFactor : ts[Math.min(Math.floor(t / W), B - 1, ts.length - 1)]));
        }
        expect(s, `seed ${c.seed}`).toBeCloseTo(walk.sunSec, 6);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(10);
  });
});

describe("stayExposure at a stop snapped mid-block (#391 review)", () => {
  it("stands on the street's shadiest sidewalk, not the one sidewalk the snap copied", async () => {
    const { stayExposure } = await import("../sunReach");
    const { snapToEdge } = await import("../routing");
    // One street 1–2 with a sunny left sidewalk and a shaded right one, both ways.
    const graph: RoutingGraph = {
      nodes: new Map([[1, { id: 1, lat: 40.75, lon: -73.99 }], [2, { id: 2, lat: 40.751, lon: -73.99 }]]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 111, shadowFactor: 0, side: "left" }, { toId: 2, distanceM: 111, shadowFactor: 1, side: "right" }]],
        [2, [{ toId: 1, distanceM: 111, shadowFactor: 1, side: "left" }, { toId: 1, distanceM: 111, shadowFactor: 0, side: "right" }]],
      ]),
    };
    const v = snapToEdge([-73.99, 40.7505], graph, -1);
    expect(v).toBe(-1);
    // The snap copied one sidewalk only (the sunny left, first found).
    expect(graph.adj.get(v)!.every((e) => e.shadowFactor === 0)).toBe(true);
    expect(stayExposure(graph, v, 0, 600, undefined)).toEqual([{ durationSec: 600, shade: 1 }]);
    // A real corner keeps its own sidewalks only.
    expect(stayExposure(graph, 1, 0, 600, undefined)).toEqual([{ durationSec: 600, shade: 1 }]);
  });
});

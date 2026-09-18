import assert from "node:assert/strict";
import test from "node:test";
import { busShard } from "../src/build";
import type { BusNormalized } from "../src/normalizeBus";

/**
 * Three stops across two boroughs. `hub` is a boundary stop both feeds list, so
 * every edge touching it lands in both shards; `q1->q2` touches neither
 * Brooklyn stop, so route Q2 is Queens-only.
 */
function twoBoroughGraph(): BusNormalized {
  const route = (id: string) => ({
    id,
    shortName: id,
    longName: `${id} line`,
    type: 3,
    color: "000000",
    textColor: "FFFFFF",
    variants: 1,
  });
  const edge = (from: string, to: string, id: string) => ({
    from,
    to,
    route: id,
    direction: 0,
    medianSec: 300,
    trips: 8,
    distM: 400,
  });
  const headway = (id: string) => ({
    route: id,
    direction: 0,
    dayType: "weekday" as const,
    hour: 9,
    medianSec: 600,
    trips: 6,
    services: 1,
  });
  return {
    kind: "bus",
    feeds: [],
    stops: [
      { id: "bus:hub", name: "Hub", lat: 40.7, lon: -73.9, feeds: ["bus-b", "bus-q"] },
      { id: "bus:bk1", name: "Brooklyn One", lat: 40.69, lon: -73.95, feeds: ["bus-b"] },
      { id: "bus:q1", name: "Queens One", lat: 40.74, lon: -73.87, feeds: ["bus-q"] },
      { id: "bus:q2", name: "Queens Two", lat: 40.75, lon: -73.85, feeds: ["bus-q"] },
    ],
    edges: [
      edge("bus:hub", "bus:bk1", "B1"),
      edge("bus:hub", "bus:q1", "Q1"),
      edge("bus:q1", "bus:q2", "Q2"),
    ],
    routes: [route("B1"), route("Q1"), route("Q2")],
    headways: [headway("B1"), headway("Q1"), headway("Q2")],
    stats: {
      uniqueStops: 4,
      stopRows: 5,
      nameVariants: 0,
      variants: 3,
      displayRoutes: 3,
      pooledTrips: 24,
      edges: {
        tripsSeen: 24,
        pairsSeen: 24,
        droppedSameNode: 0,
        droppedNonPositive: 0,
        droppedFast: 0,
        droppedSparse: 0,
        edgesKept: 3,
        geomShipped: 0,
        geomUnsliced: 0,
      },
      representativeDates: { weekday: null, saturday: null, sunday: null },
      unrepresentedServices: [],
      sparseHeadwayBuckets: 0,
    },
  };
}

test("a bus shard carries only the routes its own edges use", () => {
  const bus = twoBoroughGraph();
  const brooklyn = busShard(bus, "bus-b");
  assert.deepEqual(
    brooklyn.edges.map((e) => `${e.from}->${e.to}`),
    ["bus:hub->bus:bk1", "bus:hub->bus:q1"],
  );
  // Q2 runs entirely between two Queens stops, so Brooklyn must not carry it.
  assert.deepEqual(brooklyn.routes.map((r) => r.id), ["B1", "Q1"]);
  assert.deepEqual(brooklyn.headways.map((h) => h.route), ["B1", "Q1"]);
});

test("a boundary stop's routes reach both shards", () => {
  const bus = twoBoroughGraph();
  const queens = busShard(bus, "bus-q");
  // hub is listed by both feeds, so B1 appears in Queens too.
  assert.deepEqual(queens.routes.map((r) => r.id), ["B1", "Q1", "Q2"]);
  assert.deepEqual(queens.stops.map((s) => s.id), ["bus:bk1", "bus:hub", "bus:q1", "bus:q2"]);
});

test("every shard's routes and headways agree with its edges", () => {
  const bus = twoBoroughGraph();
  for (const feedId of ["bus-b", "bus-q"]) {
    const shard = busShard(bus, feedId);
    const used = new Set(shard.edges.map((e) => e.route));
    assert.deepEqual(new Set(shard.routes.map((r) => r.id)), used, `${feedId} routes`);
    for (const row of shard.headways) {
      assert.ok(used.has(row.route), `${feedId} headway ${row.route}`);
    }
  }
});

test("a shard ships no route-level shape table", () => {
  // Route-level shapes were one polyline per route:direction, which cannot
  // represent a branched route: 54 of 56 subway route:dir pairs had >10% of
  // their served stations more than 400 m off the shipped line. Geometry lives
  // on the edge instead, sliced per stop pair, so there is still no shape table.
  const shard = busShard(twoBoroughGraph(), "bus-b") as unknown as Record<string, unknown>;
  assert.equal("shapes" in shard, false);
  assert.ok(shard.edges, "edges carry the geometry a client needs");
});

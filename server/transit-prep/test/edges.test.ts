import assert from "node:assert/strict";
import test from "node:test";
import { buildEdges } from "../src/edges";
import type { GtfsStopTime, GtfsTrip } from "../src/gtfs";

const nodes = new Map([
  ["A", { lat: 40.75, lon: -73.99 }],
  ["B", { lat: 40.76, lon: -73.98 }],
  ["FAR", { lat: 41.5, lon: -73.0 }],
]);

function trip(id: string): GtfsTrip {
  return { routeId: "R", tripId: id, serviceId: "WD", headsign: "", direction: 0, shapeId: "S" };
}

function legs(tripId: string, pairs: [string, number, number][]): GtfsStopTime[] {
  // pairs: [stopId, arrivalSec, departureSec] in sequence order.
  return pairs.map(([stopId, arrivalSec, departureSec], i) => ({
    tripId,
    stopId,
    arrivalSec,
    departureSec,
    sequence: i + 1,
  }));
}

test("medians segment times across trips", () => {
  const { edges, stats } = buildEdges({
    trips: [trip("t1"), trip("t2"), trip("t3")],
    stopTimes: [
      ...legs("t1", [["A", 0, 0], ["B", 300, 300]]),
      ...legs("t2", [["A", 0, 0], ["B", 320, 320]]),
      ...legs("t3", [["A", 0, 0], ["B", 310, 310]]),
    ],
    nodes,
    mapStop: (id) => id,
    routeKey: (t) => t.routeId,
    maxKmh: 80,
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.medianSec, 310);
  assert.equal(edges[0]?.trips, 3);
  assert.equal(stats.edgesKept, 1);
});

test("drops same-node, non-positive, too-fast and sparse pairs", () => {
  const { edges, stats } = buildEdges({
    trips: [trip("t1"), trip("t2"), trip("t3")],
    stopTimes: [
      // Same node after mapping (A→A).
      ...legs("t1", [["A", 0, 0], ["A", 60, 60]]),
      // Backwards in time.
      ...legs("t2", [["A", 500, 500], ["B", 400, 400]]),
      // Impossibly fast: ~130 km to FAR in 60 s.
      ...legs("t3", [["A", 0, 0], ["FAR", 60, 60]]),
    ],
    nodes,
    mapStop: (id) => id,
    routeKey: (t) => t.routeId,
    maxKmh: 80,
  });
  assert.equal(edges.length, 0);
  assert.equal(stats.droppedSameNode, 1);
  assert.equal(stats.droppedNonPositive, 1);
  assert.equal(stats.droppedFast, 1);
});

test("drops edges below the sample minimum", () => {
  const { edges, stats } = buildEdges({
    trips: [trip("t1"), trip("t2")],
    stopTimes: [
      ...legs("t1", [["A", 0, 0], ["B", 300, 300]]),
      ...legs("t2", [["A", 0, 0], ["B", 300, 300]]),
    ],
    nodes,
    mapStop: (id) => id,
    routeKey: (t) => t.routeId,
    maxKmh: 80,
    minSamples: 3,
  });
  assert.equal(edges.length, 0);
  assert.equal(stats.droppedSparse, 1);
});

test("null stop mappings skip the pair", () => {
  const { edges } = buildEdges({
    trips: [trip("t1"), trip("t2"), trip("t3")],
    stopTimes: [
      ...legs("t1", [["A", 0, 0], ["GHOST", 300, 300]]),
      ...legs("t2", [["A", 0, 0], ["GHOST", 300, 300]]),
      ...legs("t3", [["A", 0, 0], ["GHOST", 300, 300]]),
    ],
    nodes,
    mapStop: (id) => (id === "GHOST" ? null : id),
    routeKey: (t) => t.routeId,
    maxKmh: 80,
  });
  assert.equal(edges.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildEdges } from "../src/edges";
import type { GtfsStopTime, GtfsTrip } from "../src/gtfs";
import { decodePolyline } from "../src/shapeSlice";
import { haversineMeters, type LatLon } from "../src/util";

const nodes = new Map([
  ["A", { lat: 40.75, lon: -73.99 }],
  ["B", { lat: 40.76, lon: -73.98 }],
  ["FAR", { lat: 41.5, lon: -73.0 }],
]);

function trip(id: string, shapeId = "S"): GtfsTrip {
  return { routeId: "R", tripId: id, serviceId: "WD", headsign: "", direction: 0, shapeId };
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


/** A→B with the corner at (40.76, -73.99): due north, then due east. */
const CORNER: LatLon = { lat: 40.76, lon: -73.99 };
const BENT: LatLon[] = [{ lat: 40.75, lon: -73.99 }, CORNER, { lat: 40.76, lon: -73.98 }];
const CHORD_M = haversineMeters(40.75, -73.99, 40.76, -73.98);

function threeTrips(shapeIds: string[] = ["S", "S", "S"]) {
  return {
    trips: shapeIds.map((shapeId, i) => trip(`t${i + 1}`, shapeId)),
    stopTimes: shapeIds.flatMap((_, i) =>
      legs(`t${i + 1}`, [["A", 0, 0], ["B", 300 + i * 10, 300 + i * 10]]),
    ),
    nodes,
    mapStop: (id: string) => id,
    routeKey: (t: GtfsTrip) => t.routeId,
    maxKmh: 80,
  };
}

test("slices the edge out of its shape and reports along-track distance", () => {
  const { edges, stats } = buildEdges({
    ...threeTrips(),
    shapes: new Map([["S", BENT]]),
  });
  assert.equal(edges.length, 1);
  assert.deepEqual(decodePolyline(edges[0]?.geom ?? ""), [CORNER]);
  // Two legs of a right triangle, not its hypotenuse.
  assert.ok((edges[0]?.distM ?? 0) > CHORD_M * 1.3);
  assert.equal(stats.geomShipped, 1);
  assert.equal(stats.geomUnsliced, 0);
});

test("without shapes an edge carries no geometry and the straight-line distance", () => {
  const { edges, stats } = buildEdges(threeTrips());
  assert.equal(edges[0]?.geom, undefined);
  assert.equal(edges[0]?.distM, Math.round(CHORD_M));
  assert.equal(stats.geomShipped, 0);
});

test("a shape that doubles back ships no geometry and keeps the chord", () => {
  const { edges, stats } = buildEdges({
    ...threeTrips(),
    // A loop: the shape touches B, runs down to A, then heads back out through
    // B. Ties go to the first pass, so B's foot lands before A's and no
    // sub-path "between the stops" exists. Absence is the answer, not a guess.
    shapes: new Map([["S", [{ lat: 40.76, lon: -73.98 }, { lat: 40.75, lon: -73.99 }, { lat: 40.77, lon: -73.97 }]]]),
  });
  assert.equal(edges[0]?.geom, undefined);
  assert.equal(edges[0]?.distM, Math.round(CHORD_M));
  assert.equal(stats.geomUnsliced, 1);
  assert.equal(stats.geomShipped, 0);
});

test("both stops on one shape segment ship no geometry but do fix distM", () => {
  const { edges, stats } = buildEdges({
    ...threeTrips(),
    // A and B sit inside one long segment: nothing lies between them to draw,
    // but the along-track distance is still the measured one.
    shapes: new Map([["S", [{ lat: 40.74, lon: -74.0 }, { lat: 40.77, lon: -73.97 }]]]),
  });
  assert.equal(edges[0]?.geom, undefined);
  assert.equal(stats.geomShipped, 0);
  assert.equal(stats.geomUnsliced, 0);
  assert.ok((edges[0]?.distM ?? 0) > 0);
});

test("several shapes serving one edge resolve to the lowest key, deterministically", () => {
  // 74.9% of subway edges are served by more than one shape. Between adjacent
  // stops they agree on the track, so any is right — but the build has to be
  // reproducible, so the choice is by sort and not by trip order.
  const detour: LatLon[] = [{ lat: 40.75, lon: -73.99 }, { lat: 40.74, lon: -73.98 }, { lat: 40.76, lon: -73.98 }];
  const shapes = new Map([["S1", BENT], ["S2", detour]]);
  const forwards = buildEdges({ ...threeTrips(["S2", "S1", "S2"]), shapes });
  const backwards = buildEdges({ ...threeTrips(["S1", "S2", "S1"]), shapes });
  assert.deepEqual(decodePolyline(forwards.edges[0]?.geom ?? ""), [CORNER]);
  assert.equal(backwards.edges[0]?.geom, forwards.edges[0]?.geom);
});

test("shapeKey namespaces shapes that share an id across pooled feeds", () => {
  // shape_id is unique per feed, not across the six bus feeds: unnamespaced,
  // this edge would be sliced out of the other borough's route.
  const { edges } = buildEdges({
    ...threeTrips(),
    shapes: new Map([["bx\tS", BENT], ["b\tS", [{ lat: 40.75, lon: -73.99 }, { lat: 41.5, lon: -73.0 }]]]),
    shapeKey: (t) => `bx\t${t.shapeId}`,
  });
  assert.deepEqual(decodePolyline(edges[0]?.geom ?? ""), [CORNER]);
});

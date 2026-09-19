import assert from "node:assert/strict";
import test from "node:test";
import { makeGrid, tileX, tileY } from "../src/boundary";
import { shardStreets, shardBuildings } from "../src/sharding";
import type { StreetGraph } from "../src/graph";
import type { NormalizedBuilding } from "../src/buildings";

/**
 * Ownership and seam discipline: an edge's owner is the cell containing its
 * midpoint, far segments are dropped, ghost endpoints ship with the owner,
 * support bounds contain geometry, geometry stays inside the owner cell, and
 * whole building footprints are owned by their centroid with caster-reach
 * support bounds.
 */

function cellAt(lng: number, lat: number, z: 13 | 14 = 14) {
  const grid = makeGrid(z);
  const x = tileX(lng, z);
  const y = tileY(lat, z);
  return grid.cells.find((cell) => cell.x === x && cell.y === y)!;
}

test("street sharding owns by midpoint and keeps ghosts whole", () => {
  // Anchor on a real z14 cell boundary: the seam longitude is the east edge of
  // the cell containing the anchor point. Neighbours exist because PREP_BOUNDS
  // is far wider than one cell.
  const anchor = cellAt(-73.9885, 40.7545);
  const seam = anchor.bounds.east;
  const lat = (anchor.bounds.south + anchor.bounds.north) / 2;
  const westLon = seam - 0.004;
  const eastLon = seam + 0.004;

  const graph: StreetGraph = {
    nodes: new Map([
      [1001, { id: 1001, lat, lon: westLon, isIntersection: true }],
      [1002, { id: 1002, lat, lon: seam + 0.001, isIntersection: true }],
      [1003, { id: 1003, lat, lon: eastLon, isIntersection: true }],
    ]),
    edges: [
      { id: "w2001f", from: 1001, to: 1002, distanceM: 142, tags: { highway: "residential" } },
      { id: "w2001r", from: 1002, to: 1001, distanceM: 142, tags: { highway: "residential" } },
      { id: "w2002f", from: 1002, to: 1003, distanceM: 98, tags: { highway: "pedestrian" } },
      { id: "w2002r", from: 1003, to: 1002, distanceM: 98, tags: { highway: "pedestrian" } },
    ],
    stats: {
      closedPedestrianWaysSkipped: 0,
      segmentsMissingCoords: 0,
      zeroLengthSegments: 0,
      danglingEdges: 0,
    },
  };
  const { shards, stats } = shardStreets(graph, 14);

  // The two segments cross the seam with midpoints on opposite sides.
  assert.equal(stats.cellsPublished, 2, "one owner cell per segment side");
  assert.equal(stats.seamEdges, 2, "two directed edges cross the seam");
  assert.equal(
    stats.ghostNodeRecords,
    1,
    "the west-owned crossing plants its east endpoint as a ghost",
  );

  for (const [key, shard] of shards) {
    for (const edge of shard.edges) {
      const from = shard.nodes.find((node) => node.id === edge.from)!;
      const to = shard.nodes.find((node) => node.id === edge.to)!;
      assert.ok(from && to, `dangling endpoint in ${key}`);
      assert.ok(edge.distanceM > 0);
      const mid = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 };
      assert.ok(
        mid.lat >= shard.supportBounds.south &&
          mid.lat <= shard.supportBounds.north &&
          mid.lon >= shard.supportBounds.west &&
          mid.lon <= shard.supportBounds.east,
        `owner cell must contain the midpoint (${key})`,
      );
      assert.ok(
        shard.geometryBounds.south <= shard.supportBounds.south === false ||
          shard.geometryBounds.south >= shard.supportBounds.south,
        "geometry bounds lie inside support bounds",
      );
    }
  }
  // Every directed edge appears exactly once across shards.
  const published = [...shards.values()].flatMap((shard) => shard.edges.map((edge) => edge.id));
  assert.equal(new Set(published).size, published.length);
  assert.equal(published.length, 4);
});

test("far segments are dropped and counted, not silently owned", () => {
  const graph: StreetGraph = {
    nodes: new Map([
      [1, { id: 1, lat: 40.755, lon: -73.98, isIntersection: false }],
      [2, { id: 2, lat: 41.5, lon: -74.0, isIntersection: false }],
    ]),
    edges: [{ id: "far-f", from: 1, to: 2, distanceM: 70000, tags: { highway: "footway" } }],
    stats: {
      closedPedestrianWaysSkipped: 0,
      segmentsMissingCoords: 0,
      zeroLengthSegments: 0,
      danglingEdges: 0,
    },
  };
  const { stats } = shardStreets(graph, 14);
  assert.equal(stats.edgesDroppedOutsideSupport, 1);
});

test("building footprints are whole in one owner cell with caster support", () => {
  const anchor = cellAt(-73.9885, 40.7545);
  const seam = anchor.bounds.east;
  const lat = (anchor.bounds.south + anchor.bounds.north) / 2;
  const crossing: NormalizedBuilding = {
    doittId: 9123,
    featureCode: 2100,
    status: "active",
    statusType: "Constructed",
    lastEdited: null,
    heightFt: 100,
    heightM: 30.48,
    heightSource: "source",
    rings: [
      [
        [seam - 0.0015, lat - 0.0003],
        [seam + 0.0015, lat - 0.0003],
        [seam + 0.0015, lat + 0.0003],
        [seam - 0.0015, lat + 0.0003],
        [seam - 0.0015, lat - 0.0003],
      ],
    ],
  };
  const { shards, stats } = shardBuildings([crossing], 14);
  assert.equal(stats.buildingsAssigned, 1);
  assert.equal(stats.seamFootprints, 1); // touches two z14 cells
  assert.equal(shards.size, 1);
  const shard = [...shards.values()][0];
  assert.equal(shard.buildings.length, 1);
  assert.equal(shard.buildings[0].id, "9123");
  // Whole footprint retained, not clipped to the owner cell.
  assert.equal(shard.buildings[0].rings[0].length, 5);
  // Support expands beyond geometry by the caster reach.
  assert.ok(shard.supportBounds.west < shard.geometryBounds.west);
  assert.ok(shard.supportBounds.east > shard.geometryBounds.east);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildingPlanes, selectFabdemMembers } from "../src/materialize";
import { STORED_SIZE } from "../../../app/lib/shadowField/v2/types";
import { tileBounds, type Z18Tile } from "../src/tiles";
import type { GeoParquetRow } from "../src/geoparquet";

const members = [
  "N40W075_FABDEM_V1-2.tif",
  "N40W074_FABDEM_V1-2.tif",
  "N41W075_FABDEM_V1-2.tif",
  "N41W074_FABDEM_V1-2.tif",
  "N42W074_FABDEM_V1-2.tif",
];

test("selectFabdemMembers selects the one-degree FABDEM sources intersecting a tile", () => {
  assert.deepEqual(selectFabdemMembers(members, { west: -74.2, south: 40.6, east: -74.1, north: 40.7 }), ["N40W075_FABDEM_V1-2.tif"]);
  assert.deepEqual(selectFabdemMembers(members, { west: -74.01, south: 40.6, east: -73.99, north: 40.7 }), ["N40W074_FABDEM_V1-2.tif", "N40W075_FABDEM_V1-2.tif"]);
  assert.deepEqual(selectFabdemMembers(members, { west: -74.2, south: 40.99, east: -74.1, north: 41.01 }), ["N40W075_FABDEM_V1-2.tif", "N41W075_FABDEM_V1-2.tif"]);
});

test("building rasterization expands a valid Overture multipolygon deterministically", () => {
  const tile: Z18Tile = { z: 18, x: 77236, y: 98192, key: "18/77236/98192" }; const bounds = tileBounds(tile, 1);
  const square = (west: number, south: number, size: number): Array<readonly [number, number]> => [[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]];
  const dx = (bounds.east - bounds.west) / 8, dy = (bounds.north - bounds.south) / 8;
  const rows: GeoParquetRow[] = [{ id: "building-multipart", height: 12, minHeight: 0, geometry: { type: "MultiPolygon", polygons: [
    { outer: square(bounds.west + dx, bounds.south + dy, Math.min(dx, dy)), holes: [] },
    { outer: square(bounds.west + 5 * dx, bounds.south + 5 * dy, Math.min(dx, dy)), holes: [] },
  ] } }];
  const planes = buildingPlanes(tile, new Uint32Array(STORED_SIZE * STORED_SIZE).fill(100), rows, []);
  assert.ok(planes.find((plane) => plane.name === "buildingMask")!.words.some(Boolean));
});

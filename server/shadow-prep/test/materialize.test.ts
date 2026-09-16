import assert from "node:assert/strict";
import test from "node:test";
import { buildingPlanes, selectFabdemMembers } from "../src/materialize";
import { STORED_SIZE } from "../../../app/lib/shadowField/v2/types";
import { tileBounds, type Z18Tile } from "../src/tiles";
import type { PolygonalCoverage } from "../src/admission";
import type { GeoParquetRow } from "../src/geoparquet";

const world: PolygonalCoverage = { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] };

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
  const planes = buildingPlanes(tile, new Uint32Array(STORED_SIZE * STORED_SIZE).fill(100), rows, [], { buildings: [world], parts: [world] });
  assert.ok(planes.find((plane) => plane.name === "buildingMask")!.words.some(Boolean));
});

test("building support derives from admitted source coverage, not occupancy", () => {
  const tile: Z18Tile = { z: 18, x: 77236, y: 98192, key: "18/77236/98192" }; const bounds = tileBounds(tile, 1);
  const westHalf: PolygonalCoverage = { type: "Polygon", coordinates: [[[bounds.west, bounds.south], [(bounds.west + bounds.east) / 2, bounds.south], [(bounds.west + bounds.east) / 2, bounds.north], [bounds.west, bounds.north], [bounds.west, bounds.south]]] };
  const rows: GeoParquetRow[] = [];
  const half = buildingPlanes(tile, new Uint32Array(STORED_SIZE * STORED_SIZE).fill(100), rows, [], { buildings: [westHalf], parts: [world] });
  const support = half.find((plane) => plane.name === "buildingSupport")!.words;
  // Western cells are covered by both sources; eastern cells are outside the
  // admitted building extract and stay explicitly unknown — with zero mask.
  assert.ok(support.slice(0, STORED_SIZE * STORED_SIZE).some((value) => value === 1));
  assert.ok(support.slice(0, STORED_SIZE * STORED_SIZE).some((value) => value === 2));
  assert.ok(!half.find((plane) => plane.name === "buildingMask")!.words.some(Boolean));
  const none = buildingPlanes(tile, new Uint32Array(STORED_SIZE * STORED_SIZE).fill(100), rows, [], { buildings: [], parts: [world] });
  assert.ok(none.find((plane) => plane.name === "buildingSupport")!.words.every((value) => value === 2));
});

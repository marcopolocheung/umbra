#!/usr/bin/env node
/**
 * S1 stage 1 — acquire and cache every input the audit reads.
 *
 * Three sources, all cached under studies/shade-audit/cache/ so a re-run never
 * re-hits a public host (the studies/README.md contract):
 *
 * 1. The 2017 1-ft LiDAR LAZ tiles covering each sample block, selected
 *    spatially through the city's own tile-grid FeatureServer and downloaded
 *    from finder.nyc.gov. The *surface* point cloud — this is the dataset the
 *    brief insists on, not the city's bare-earth DEM, which strips buildings
 *    and trees and therefore casts no shadow.
 * 2. The 2021 6-in TNC/UVM land-cover windows (Zenodo 14053441, CC BY-NC-SA
 *    4.0) for each block, read remotely through HTTP-range requests and cached
 *    as .npz-free raw dumps (a flat uint8 array + json sidecar).
 * 3. The Umbra navigation generation's street + building shards for each
 *    block, read from the locally published generation (identical bytes to the
 *    deployed current.json pointer; SHA-256 verified against the manifest).
 *
 * Node 20 has fetch and crypto.subtle. No app imports here — stage 2 bundles
 * the app modules; this stage only acquires bytes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");

/** The ArcGIS FeatureServer that indexes every 2017 LAZ tile. */
const LAS_INDEX =
  "https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_2017_LiDAR_TopoBathymetric_LAS_Tile_Grid_Index/FeatureServer/0";
/** NYC OTI's public blob host for the 2017 LiDAR suite. */
const LAZ_BASE =
  "https://finder.nyc.gov/LiDAR/2017/NYC_2017_LiDAR_Suite/LiDAR_point_clouds/Classified/TopoBathymetric_Classified_LAZ";
/** Zenodo record 14053441: TNC/UVM NYC land cover 2021, 6 in, CC BY-NC-SA 4.0. */
const LANDCOVER_URL =
  "https://zenodo.org/api/records/14053441/files/landcover_nyc_2021_6in.tif/content";
/** The locally published NYC navigation generation (matches deployed current.json). */
const NAV_ROOT = process.env.NAVIGATION_LOCAL_ROOT
  ? process.env.NAVIGATION_LOCAL_ROOT
  : join(process.env.HOME, "shade-prep-data-nyc-navigation/normalized/nyc-2026-09-18-9f2924750af1");

const R_EARTH_M = 6378137;

function bboxAround(lng, lat, halfM) {
  const dLat = halfM / 111320;
  const dLng = halfM / Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180));
  return { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "umbra-s1-study/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "User-Agent": "umbra-s1-study/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. LiDAR tile selection
// ---------------------------------------------------------------------------

/**
 * Select the LAZ tiles overlapping a block bbox, in EPSG:2263 (US survey feet),
 * through a spatial query against the tile-grid index. The query is an envelope
 * intersect, so a returned tile may only clip a corner of the block — the
 * surface builder unions whatever it gets.
 */
async function selectLazTiles(bbox) {
  const envelope = {
    xmin: bbox.west,
    ymin: bbox.south,
    xmax: bbox.east,
    ymax: bbox.north,
    spatialReference: { wkid: 4326 },
  };
  const url =
    `${LAS_INDEX}/query?where=1%3D1&outFields=LAS_ID,azure_url` +
    `&geometry=${encodeURIComponent(JSON.stringify(envelope))}` +
    `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&returnGeometry=false&f=json`;
  const body = await fetchJson(url);
  return body.features.map((feature) => ({
    id: feature.attributes.LAS_ID,
    url: feature.attributes.azure_url,
  }));
}

async function downloadLaz(tile) {
  const path = join(CACHE, "lidar", `${tile.id}.laz`);
  if (existsSync(path)) return { ...tile, path, cached: true };
  const bytes = await fetchBuffer(`${LAZ_BASE}/${tile.id}.laz`);
  mkdirSync(join(CACHE, "lidar"), { recursive: true });
  writeFileSync(path, bytes);
  return { ...tile, path, cached: false };
}

// ---------------------------------------------------------------------------
// 2. Land-cover windows (via a one-shot python/rasterio range read)
// ---------------------------------------------------------------------------

/**
 * Read the land-cover window for a block from the remote GeoTIFF once, cache it
 * as a flat uint8 dump + JSON sidecar. Uses rasterio /vsicurl over HTTP ranges
 * so the 1.7 GB source is never downloaded whole.
 */
function downloadLandcoverWindow(block, bbox) {
  const stem = join(CACHE, "landcover", block.slug);
  if (existsSync(`${stem}.bin`) && existsSync(`${stem}.json`)) return { cached: true };
  mkdirSync(join(CACHE, "landcover"), { recursive: true });
  // The truth march attributes a blocker up to 400 m beyond the block, so the
  // class window must span the full truth-surface extent (±675 m) + margin.
  const script = `
import json, sys
import numpy as np
import rasterio
from rasterio.warp import transform as wt

url = "${LANDCOVER_URL}"
EXT_FT = 675 * 3937 / 1200 + 50  # truth-surface extent in US survey feet + margin
cx, cy = wt("EPSG:4326", "EPSG:2263", [${block.lng}], [${block.lat}])
cx, cy = cx[0], cy[0]
with rasterio.open(f"/vsicurl/{url}") as ds:
    r0, c0 = ds.index(cx - EXT_FT, cy + EXT_FT)   # top-left = max y
    r1, c1 = ds.index(cx + EXT_FT, cy - EXT_FT)
    r0, c0, r1, c1 = min(r0, r1), min(c0, c1), max(r0, r1) + 1, max(c0, c1) + 1
    w = rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0)
    a = ds.read(1, window=w)
    bounds = ds.window_bounds(w)
    a.tofile("${stem}.bin")
    json.dump({"shape": list(a.shape), "dtype": str(a.dtype),
               "window": [int(r0), int(c0), int(r1), int(c1)],
               "bounds_2263": list(bounds),
               "crs": "EPSG:2263"}, open("${stem}.json", "w"))
print("ok")
`;
  // Zenodo throttles burst range-reads with 429s; retry with backoff.
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      execFileSync("python3", ["-c", script], { stdio: ["ignore", "pipe", "inherit"] });
      return { cached: false };
    } catch (error) {
      lastError = error;
      execFileSync("sleep", ["90"]);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 3. Umbra navigation shards
// ---------------------------------------------------------------------------

function downloadNavShards(block, bbox) {
  const manifest = JSON.parse(
    readFileSync(join(NAV_ROOT, "navigation/nyc/nyc-2026-09-18-9f2924750af1/manifest.json"), "utf8"),
  );
  // Must match 30-eval.mjs's shard selection exactly: the truth-surface
  // extent (±675 m) around the block, which in turn covers the field's own
  // query padding. Padded in degrees latitude (as 30-eval does), not metres
  // split per axis.
  const padDeg = 675 / 111320;
  const overlaps = (ref) =>
    ref.geometryBounds.south <= bbox.north &&
    ref.geometryBounds.north >= bbox.south &&
    ref.geometryBounds.west <= bbox.east &&
    ref.geometryBounds.east >= bbox.west;
  const padded = (ref) =>
    ref.geometryBounds.south - padDeg <= bbox.north &&
    ref.geometryBounds.north + padDeg >= bbox.south &&
    ref.geometryBounds.west - padDeg <= bbox.east &&
    ref.geometryBounds.east + padDeg >= bbox.west;
  const streets = manifest.streetShards.filter(overlaps);
  const buildings = manifest.buildingShards.filter(padded);
  let fetched = 0;
  for (const ref of [...streets, ...buildings]) {
    const path = join(CACHE, "umbra-shards", ref.key);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    const bytes = readFileSync(join(NAV_ROOT, "navigation/nyc/nyc-2026-09-18-9f2924750af1", ref.key));
    if (sha256Hex(bytes) !== ref.sha256) throw new Error(`shard hash mismatch ${ref.key}`);
    if (bytes.byteLength !== ref.bytes) throw new Error(`shard byte mismatch ${ref.key}`);
    writeFileSync(path, bytes);
    fetched++;
  }
  return { streets: streets.length, buildings: buildings.length, fetched };
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const { blocks } = JSON.parse(readFileSync(join(HERE, "blocks.json"), "utf8"));
  const plan = {};
  for (const block of blocks) {
    const bbox = bboxAround(block.lng, block.lat, block.halfM);
    process.stderr.write(`\n== ${block.slug} (${block.borough})\n`);
    const tiles = await selectLazTiles(bbox);
    process.stderr.write(`  laz tiles: ${tiles.length}\n`);
    const laz = [];
    for (const tile of tiles) laz.push(await downloadLaz(tile));
    const landcover = downloadLandcoverWindow(block, bbox);
    const nav = downloadNavShards(block, bbox);
    process.stderr.write(
      `  landcover: ${landcover.cached ? "cached" : "fetched"}; nav shards: ${nav.streets} streets / ${nav.buildings} buildings (${nav.fetched} fetched)\n`,
    );
    plan[block.slug] = { laz: laz.map((t) => ({ id: t.id, cached: t.cached })), nav };
  }
  writeFileSync(join(CACHE, "acquisition.json"), `${JSON.stringify(plan, null, 2)}\n`);
  process.stderr.write("\nacquisition plan written to cache/acquisition.json\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { quantizeHeight } from "../../../app/lib/shadowField/v2/format";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import type { Admission, AdmittedAsset, PolygonalCoverage } from "./admission";
import { joinBuildingParts, ownsCellCentre, wholeFoundationQ, type OverturePart, type RawBuilding } from "./buildings";
import { selectCanopy } from "./canopy";
import type { GeoParquetRow } from "./geoparquet";
import { receipt } from "./sources";
import { tileBounds, tileCellLonLat, type Z18Tile } from "./tiles";

const exec = promisify(execFile);
const words = STORED_SIZE * STORED_SIZE;
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], value: Uint32Array): ComponentPlane => ({ name, type, words: value });
const asRing = (points: readonly (readonly [number, number])[]) => ({ coordinates: points.map(([x, y]) => [x, y]) });
const supported = (coverage: PolygonalCoverage, point: readonly [number, number]): boolean => {
  const polygons = coverage.type === "Polygon" ? [coverage.coordinates as number[][][]] : coverage.coordinates as number[][][][];
  const inside = (ring: number[][]): boolean => { let value = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) value = !value; } return value; };
  return polygons.some((polygon) => inside(polygon[0]) && !polygon.slice(1).some(inside));
};

async function sourcePath(asset: AdmittedAsset): Promise<string> {
  if (!/zip/i.test(asset.format)) return asset.path;
  // FABDEM deliveries are ZIP containers, not GDAL datasets themselves. Pick a
  // deterministic GeoTIFF member; a selected archive with multiple rasters is
  // rejected here rather than allowing GDAL to choose an implicit one.
  const listing = await exec("unzip", ["-Z1", asset.path]); const members = listing.stdout.split(/\r?\n/).filter((name) => /\.tiff?$/i.test(name)).sort();
  if (members.length !== 1) throw new Error(`raw ZIP ${asset.filename} must contain exactly one selected GeoTIFF, found ${members.length}`);
  return `/vsizip/${asset.path}/${members[0]}`;
}
async function xyzRaster(source: string, tile: Z18Tile, args: string[]): Promise<Float64Array> {
  const directory = await mkdtemp(join(tmpdir(), "shadow-prep-raster-")); const output = join(directory, "tile.xyz"); const bounds = tileBounds(tile, 1);
  try {
    await exec("gdalwarp", ["-overwrite", "-q", "-te", String(bounds.west), String(bounds.south), String(bounds.east), String(bounds.north), "-ts", String(STORED_SIZE), String(STORED_SIZE), "-r", "bilinear", "-of", "XYZ", ...args, source, output], { maxBuffer: 1024 * 1024 });
    const rows = (await readFile(output, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    if (rows.length !== words) throw new Error(`GDAL yielded ${rows.length} raster samples; expected ${words}`);
    const result = new Float64Array(words);
    for (let index = 0; index < rows.length; index++) { const value = Number(rows[index].trim().split(/\s+/).at(-1)); result[index] = Number.isFinite(value) ? value : Number.NaN; }
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function terrainPlanes(admission: Admission, tile: Z18Tile): Promise<ComponentPlane[]> {
  const terrain = receipt(admission, "fabdem-v1.2"); const asset = terrain.assets[0];
  // GDAL applies the installed, admitted EGM2008→EGM96 grids while resampling;
  // admission has already persisted and hash-pinned the applicable PROJ result.
  const values = await xyzRaster(await sourcePath(asset), tile, ["-s_srs", "EPSG:4326+3855", "-t_srs", "EPSG:4326+5773"]);
  const ground = new Uint32Array(words);
  for (let index = 0; index < words; index++) { if (!Number.isFinite(values[index])) throw new Error(`FABDEM nodata in required support tile ${tile.key}`); ground[index] = quantizeHeight(values[index]) >>> 0; }
  return [plane("groundQ", "i32", ground), plane("foundationQ", "i32", new Uint32Array(words)), plane("foundationPresent", "u32", new Uint32Array(words))];
}

function rawBuilding(row: GeoParquetRow): Omit<RawBuilding, "parts"> {
  if (row.geometry.polygons.length !== 1) throw new Error(`building ${row.id} is not a single polygon; release selection must expand multipart features deterministically`);
  const polygon = row.geometry.polygons[0]; return { id: row.id, outer: asRing(polygon.outer), holes: polygon.holes.map(asRing), height: row.height, minHeight: row.minHeight };
}
function featureId(id: string): number { let value = 2166136261; for (const character of id) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); } return value >>> 0; }
export function buildingPlanes(tile: Z18Tile, terrain: Uint32Array, buildingRows: GeoParquetRow[], partRows: GeoParquetRow[]): ComponentPlane[] {
  const parent = buildingRows.map(rawBuilding); const parts: OverturePart[] = partRows.map((row) => {
    if (row.geometry.polygons.length !== 1) throw new Error(`building part ${row.id} is not a single polygon`);
    const polygon = row.geometry.polygons[0]; return { id: row.id, buildingId: row.buildingId!, height: row.height, minHeight: row.minHeight, outer: asRing(polygon.outer), holes: polygon.holes.map(asRing) };
  });
  const buildings = joinBuildingParts(parent, parts); const agl = new Uint32Array(words), mask = new Uint32Array(words), support = new Uint32Array(words), ids = new Uint32Array(words), priority = new Uint32Array(words), foundationQ = new Uint32Array(words), foundationPresent = new Uint32Array(words);
  const cellsByBuilding = new Map<string, number[]>();
  for (const building of buildings) cellsByBuilding.set(building.id, []);
  for (let index = 0; index < words; index++) {
    const x = index % STORED_SIZE, y = Math.floor(index / STORED_SIZE); const [lon, lat] = tileCellLonLat(tile, x, y);
    for (const building of buildings) if (ownsCellCentre(building.outer, building.holes, lon, lat)) cellsByBuilding.get(building.id)!.push(index);
  }
  for (const building of buildings) {
    const cells = cellsByBuilding.get(building.id)!; if (!cells.length) continue;
    const foundation = wholeFoundationQ(cells.map((index) => terrain[index] | 0));
    const features = [{ id: building.id, height: building.height, minHeight: building.minHeight, outer: building.outer, holes: building.holes }, ...building.parts.filter((part) => part.outer).map((part) => ({ id: part.id, height: part.height, minHeight: part.minHeight, outer: part.outer!, holes: part.holes ?? [] }))];
    for (const feature of features) for (let index = 0; index < words; index++) {
      const [lon, lat] = tileCellLonLat(tile, index % STORED_SIZE, Math.floor(index / STORED_SIZE)); if (!ownsCellCentre(feature.outer, feature.holes, lon, lat)) continue;
      const height = quantizeHeight(feature.height - feature.minHeight); const roof = foundation + height; const oldRoof = mask[index] ? (terrain[index] | 0) + (agl[index] | 0) : -Infinity;
      if (roof > oldRoof || (roof === oldRoof && featureId(feature.id) < ids[index])) { agl[index] = height >>> 0; mask[index] = 1; ids[index] = featureId(feature.id); priority[index] = feature === features[0] ? 1 : 2; foundationQ[index] = foundation >>> 0; foundationPresent[index] = 1; }
    }
  }
  // Foundation values are returned alongside building planes so the caller can
  // keep the derived terrain-relative basis in the terrain component.
  return [plane("buildingAglQ", "i32", agl), plane("buildingMask", "u32", mask), plane("buildingSupport", "u32", support), plane("buildingFeatureId", "u32", ids), plane("buildingPriority", "u32", priority), plane("foundationQ", "i32", foundationQ), plane("foundationPresent", "u32", foundationPresent)];
}

interface Fallback { geometry: PolygonalCoverage; heightQ: number; id: number; }
async function fallbackFeatures(admission: Admission): Promise<Fallback[]> {
  const document = JSON.parse(await readFile(receipt(admission, "osm-tree-fallback").path, "utf8")) as { elements?: Array<{ id?: number; type?: string; lat?: number; lon?: number; geometry?: Array<{ lat?: number; lon?: number }>; tags?: Record<string, string> }> };
  return (document.elements ?? []).flatMap((element) => {
    const metres = Number(element.tags?.height ?? element.tags?.["est_height"]); if (!Number.isFinite(metres) || metres <= 0) return [];
    const points = element.geometry?.map((point) => [point.lon, point.lat] as number[]) ?? (Number.isFinite(element.lon) && Number.isFinite(element.lat) ? [[element.lon!, element.lat!]] : []); if (!points.length) return [];
    const ring = points.length >= 4 ? points : (() => { const [x, y] = points[0]; const d = .000015; return [[x-d,y-d],[x+d,y-d],[x+d,y+d],[x-d,y+d],[x-d,y-d]]; })(); if (ring.length >= 4 && (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1])) ring.push([...ring[0]]);
    return [{ geometry: { type: "Polygon" as const, coordinates: [ring] }, heightQ: quantizeHeight(metres), id: Number(element.id ?? 0) >>> 0 }];
  });
}
export async function canopyPlanes(admission: Admission, tile: Z18Tile): Promise<ComponentPlane[]> {
  const nativeAssets = receipt(admission, "chmv2-height").assets; const fallback = await fallbackFeatures(admission); const height = new Uint32Array(words), base = new Uint32Array(words), mask = new Uint32Array(words), support = new Uint32Array(words), fallbackTop = new Uint32Array(words), fallbackBase = new Uint32Array(words), fallbackMask = new Uint32Array(words), fallbackId = new Uint32Array(words), flags = new Uint32Array(words);
  const nativeValues = new Float64Array(words); nativeValues.fill(Number.NaN);
  for (const asset of nativeAssets) {
    const values = await xyzRaster(await sourcePath(asset), tile, ["-t_srs", "EPSG:4326"]);
    for (let index = 0; index < words; index++) { const point = tileCellLonLat(tile, index % STORED_SIZE, Math.floor(index / STORED_SIZE)); if (supported(asset.supportCoverage, point)) nativeValues[index] = values[index]; }
  }
  for (let index = 0; index < words; index++) {
    const point = tileCellLonLat(tile, index % STORED_SIZE, Math.floor(index / STORED_SIZE)); const nativeAvailable = nativeAssets.some((asset) => supported(asset.supportCoverage, point));
    const native = Number.isFinite(nativeValues[index]); const selected = selectCanopy({ heightQ: native ? quantizeHeight(nativeValues[index]) : 0, valid: native, nodata: nativeAvailable && !native });
    if (selected.source === "native") { support[index] = 1; height[index] = selected.heightQ >>> 0; mask[index] = selected.heightQ > 0 ? 1 : 0; flags[index] = 1; continue; }
    const tree = fallback.find((item) => supported(item.geometry, point));
    if (tree) { fallbackTop[index] = tree.heightQ >>> 0; fallbackMask[index] = 1; fallbackId[index] = tree.id; flags[index] = 2; }
    // 2 is explicit unknown support; nodata with no fallback remains unknown.
    support[index] = 2; flags[index] |= 4;
  }
  return [plane("canopyHeightAglQ", "i32", height), plane("canopyBaseAglQ", "i32", base), plane("canopyMask", "u32", mask), plane("canopySupport", "u32", support), plane("fallbackCrownTopAglQ", "i32", fallbackTop), plane("fallbackCrownBaseAglQ", "i32", fallbackBase), plane("fallbackCanopyMask", "u32", fallbackMask), plane("fallbackFeatureId", "u32", fallbackId), plane("flagsAndMaterial", "u32", flags)];
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import type { Admission } from "./admission";
import { normalizeBuildings, type RawBuilding } from "./buildings";
import { selectCanopy, type CanopyCell } from "./canopy";
import { candidateBytesPerTile, candidateDescriptorKey, completedCandidate, writeCandidate } from "./candidates";
import { readGeoParquet } from "./geoparquet";
import { buildingPlanes, canopyPlanes, terrainPlanes } from "./materialize";
import { receipt } from "./sources";
import { supportTiles, type Z18Tile } from "./tiles";
import { fileHash, requireRoot, sha256 } from "./util";
import { candidateStore } from "./storage";

export interface NormalizedTile { tile: string; terrain: ComponentPlane[]; buildings: ComponentPlane[]; canopy: ComponentPlane[]; evidence: Record<string, string>; }
export const NORMALIZER_VERSION = "nyc-z18-normalizer-v1";
export const BILINEAR_TERRAIN_POLICY = "FABDEM-native-zip/bilinear/z18-vertices/EGM2008-to-EGM96/quantize-once-1-over-64";
export const TREE_MODEL_RECIPE = "tree-model-v2/native-nearest/fallback-explicit-height-only";
export interface NormalizationPlan { normalizationId: string; supportPath: string; supportHash: string; tiles: Z18Tile[]; maximumCandidateBytes: number; requiredFreeBytes: number; }
export interface NormalizationRun { normalizationId: string; requestedTiles: number; completedTiles: number; skippedTiles: number; descriptors: string[]; }
export interface NormalizeOptions { shard?: { index: number; count: number }; smoke?: boolean; }
const cells = STORED_SIZE * STORED_SIZE;
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], words: Uint32Array): ComponentPlane => ({ name, type, words });

/** Fixture-only normalizer; it is intentionally not reachable from the production CLI. */
export function normalizeFixture(tile: string, groundQ: number, features: RawBuilding[], canopy: CanopyCell[]): NormalizedTile {
  if (canopy.length !== cells) throw new Error("fixture canopy must include true 258×258 border support");
  const terrain = new Uint32Array(cells); terrain.fill(groundQ >>> 0);
  const buildingAgl = new Uint32Array(cells); const foundation = new Uint32Array(cells); const crownTop = new Uint32Array(cells); const flags = new Uint32Array(cells);
  const buildings = normalizeBuildings(features); // validates stable IDs, holes and parts before any clipping.
  for (const building of buildings) for (const part of building.parts) { buildingAgl[0] = Math.max(buildingAgl[0], Math.round(part.height * 64)); foundation[0] = groundQ >>> 0; }
  canopy.forEach((cell, index) => { const chosen = selectCanopy(cell); crownTop[index] = chosen.heightQ >>> 0; flags[index] = chosen.source === "native" ? 1 : chosen.source === "osm" ? 2 : 4; });
  return { tile, terrain: [plane("groundQ", "i32", terrain), plane("foundationQ", "i32", foundation)], buildings: [plane("buildingAglQ", "i32", buildingAgl)], canopy: [plane("crownBaseAglQ", "i32", new Uint32Array(cells)), plane("crownTopAglQ", "i32", crownTop), plane("flagsAndMaterial", "u32", flags)], evidence: { fixture: "explicit-test-only", wholeFeatureCount: String(buildings.length) } };
}

function geometry(value: unknown): import("./admission").PolygonalCoverage {
  const candidate = value as { type?: string; coordinates?: unknown };
  if ((candidate.type !== "Polygon" && candidate.type !== "MultiPolygon") || !Array.isArray(candidate.coordinates)) throw new Error("frozen support geometry is not a polygon or multipolygon");
  return candidate as import("./admission").PolygonalCoverage;
}
async function frozenSupport(): Promise<{ path: string; hash: string; geometry: import("./admission").PolygonalCoverage }> {
  const root = requireRoot(); const path = join(root, "acquisition", "nyc-five-borough-20km-support.geojson");
  const manifestPath = join(root, "acquisition", "nyc-acquisition-manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { support?: { filename?: string; sha256?: string } };
  if (manifest.support?.filename !== "acquisition/nyc-five-borough-20km-support.geojson" || !/^[a-f0-9]{64}$/.test(String(manifest.support.sha256))) throw new Error("frozen support acquisition manifest lacks the exact pinned support hash");
  const hash = await fileHash(path); if (hash !== manifest.support.sha256) throw new Error(`frozen support hash mismatch: expected ${manifest.support.sha256}, got ${hash}`);
  const document = JSON.parse(await readFile(path, "utf8")) as { type?: string; geometry?: unknown; features?: Array<{ geometry?: unknown }> };
  // The frozen acquisition emitter uses a one-feature FeatureCollection. Accept
  // that wrapper, but not a collection whose union/order would be an unstated
  // normalization recipe.
  const supportObject = document.type === "Feature" ? document.geometry : document.type === "FeatureCollection" && document.features?.length === 1 ? document.features[0].geometry : document;
  return { path, hash, geometry: geometry(supportObject) };
}
function coverageContains(coverage: import("./admission").PolygonalCoverage, point: number[]): boolean {
  const polygons = coverage.type === "Polygon" ? [coverage.coordinates as number[][][]] : coverage.coordinates as number[][][][];
  const insideRing = (ring: number[][]): boolean => { let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++) { const a=ring[i],b=ring[j]; if ((a[1]>point[1]) !== (b[1]>point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside; } return inside; };
  return polygons.some((polygon) => insideRing(polygon[0]) && !polygon.slice(1).some(insideRing));
}
function sourceCoversSupport(admission: Admission, support: import("./admission").PolygonalCoverage): void {
  const rings = support.type === "Polygon" ? support.coordinates as number[][][] : (support.coordinates as number[][][][]).flat();
  // CHMv2 is intentionally allowed to be partial: the pinned validity mask
  // declares those gaps and only those gaps may consult the fallback. The other
  // complete sources must cover the exact frozen support, not merely its bbox.
  for (const source of admission.receipts.filter((item) => ["terrain", "buildings", "building-parts", "canopy-fallback"].includes(item.role))) for (const point of rings.flat()) if (!source.assets.some((asset) => coverageContains(asset.supportCoverage, point))) throw new Error(`admitted ${source.id} coverage does not contain frozen support vertex ${point[0]},${point[1]}`);
}
export async function planNormalization(admission: Admission): Promise<NormalizationPlan> {
  if (admission.blockers.length) throw new Error(`normalization requires successful Item-5 admission: ${admission.blockers.join("; ")}`);
  if (!admission.datum.operationHash || !admission.datum.operationEvidence) throw new Error("normalization requires the recorded EGM2008→EGM96 PROJ operation");
  const support = await frozenSupport(); sourceCoversSupport(admission, support.geometry); const tiles = supportTiles(support.geometry);
  if (!tiles.length) throw new Error("frozen support intersects no z18 tiles");
  const receiptAggregate = admission.receipts.map((item) => `${item.id}:${item.sha256}`).sort().join("\n");
  const normalizationId = sha256(Buffer.from(JSON.stringify({ receiptAggregate, supportHash: support.hash, operation: admission.datum.operationHash, normalizer: NORMALIZER_VERSION, terrain: BILINEAR_TERRAIN_POLICY, tree: TREE_MODEL_RECIPE }))).slice(0, 32);
  const maximumCandidateBytes = tiles.length * candidateBytesPerTile();
  return { normalizationId, supportPath: support.path, supportHash: support.hash, tiles, maximumCandidateBytes, requiredFreeBytes: Math.ceil(maximumCandidateBytes * 1.25) };
}
export function deterministicShard<T extends { key: string }>(items: readonly T[], shard?: { index: number; count: number }): T[] {
  const sorted = [...items].sort((a, b) => a.key.localeCompare(b.key)); if (!shard) return sorted;
  if (!Number.isInteger(shard.index) || !Number.isInteger(shard.count) || shard.count < 1 || shard.index < 0 || shard.index >= shard.count) throw new Error("invalid deterministic shard index/count");
  return sorted.filter((_, index) => index % shard.count === shard.index);
}
function supportCounts(planes: ComponentPlane[]): { known: number; empty: number; unknown: number } {
  const values = planes.find((item) => item.name === "canopySupport" || item.name === "buildingSupport")?.words;
  if (!values) return { known: STORED_SIZE * STORED_SIZE, empty: 0, unknown: 0 };
  let known = 0, empty = 0, unknown = 0; for (const value of values) { if (value === 2) unknown++; else if (value === 1) known++; else empty++; } return { known, empty, unknown };
}
/** Item 6 is deliberately candidate-only. The full vector prepass occurs before
 * any tile descriptor; each independent tile then streams GDAL output through
 * bounded scratch and publishes planes before its completion descriptor. */
export async function normalizeAdmitted(admission: Admission, suppliedPlan?: NormalizationPlan, options: NormalizeOptions = {}): Promise<NormalizationRun> {
  const plan = suppliedPlan ?? await planNormalization(admission);
  const buildings = await readGeoParquet(receipt(admission, "overture-buildings").path, "buildings");
  const parts = await readGeoParquet(receipt(admission, "overture-building-parts").path, "parts");
  // Validate and parent-join complete records before clipping. No tile can be
  // marked completed if the global authoritative vector stream is malformed.
  for (const row of [...buildings, ...parts]) if (row.height < 0 || row.minHeight < 0 || row.minHeight > row.height) throw new Error(`missing, invalid, or contradictory building/part height: ${row.recordId}`);
  const parentIds = new Set(buildings.map((row) => row.recordId)); for (const part of parts) if (!parentIds.has(part.buildingId!)) throw new Error(`building part ${part.recordId} has no complete parent ${part.buildingId}`);
  const store = candidateStore(requireRoot()); const selected = deterministicShard(options.smoke ? plan.tiles.slice(0, Math.min(4, plan.tiles.length)) : plan.tiles, options.shard); const descriptors: string[] = []; let completedTiles = 0, skippedTiles = 0;
  for (const tile of selected) {
    const prior = await completedCandidate(store, plan.normalizationId, tile.key); if (prior) { skippedTiles++; descriptors.push(`${tile.key}:${(await store.head(candidateDescriptorKey(plan.normalizationId, tile.key)))!.sha256}`); continue; }
    const terrain = await terrainPlanes(admission, tile); const ground = terrain.find((item) => item.name === "groundQ")!.words;
    const rawBuilding = buildingPlanes(tile, ground, buildings, parts);
    for (const name of ["foundationQ", "foundationPresent"] as const) terrain.find((item) => item.name === name)!.words.set(rawBuilding.find((item) => item.name === name)!.words);
    const building = rawBuilding.filter((item) => item.name !== "foundationQ" && item.name !== "foundationPresent"); const canopy = await canopyPlanes(admission, tile);
    await writeCandidate(store, { schemaVersion: 1, normalizationId: plan.normalizationId, tile: tile.key, gutter: 1, byteOrder: "little-endian-u32", support: { terrain: { known: STORED_SIZE * STORED_SIZE, empty: 0, unknown: 0 }, buildings: supportCounts(building), canopy: supportCounts(canopy) } }, { terrain, buildings: building, canopy });
    completedTiles++; descriptors.push(`${tile.key}:${(await store.head(candidateDescriptorKey(plan.normalizationId, tile.key)))!.sha256}`);
  }
  return { normalizationId: plan.normalizationId, requestedTiles: selected.length, completedTiles, skippedTiles, descriptors };
}

/** Legacy build boundary: candidates never become build inputs. */
export async function normalizeProduction(admission: Admission): Promise<NormalizedTile[]> {
  void admission;
  throw new Error("Item 6 candidates are external-only and cannot be consumed by build");
}

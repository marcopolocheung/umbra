import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, link, mkdir, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DuckDBConnection } from "@duckdb/node-api";
import { admit, loadRegion, validateBoundary, type PolygonalCoverage } from "./admission";
import { approveDatumControls, packageDatumControls } from "./controls";
import { readGeoParquet, validateGeoParquetSchema } from "./geoparquet";
import { assembleReceipts } from "./receipts";
import { planNormalization } from "./normalize";
import { canonicalSupportFeature, envelope, intersectsSupport, loadFrozenSupport, supportGeometry, SUPPORT_FILENAME } from "./support";
import { fileHash, requireRoot, writeJson } from "./util";

const FABDEM_URL = "https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N40W080-N50W070_FABDEM_V1-2.zip";
const FABDEM_SHA256 = "9e069402fa68f272d248e57338cf8b99f789b8b81b4243fe035d19ef8270fc39";
const CHM_BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3";
const OVERTURE_RELEASE = "2026-08-19.0";
const OVERTURE_ROOT = `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=buildings`;
const OVERTURE_HTTP = `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${OVERTURE_RELEASE}/theme=buildings`;
const CONTROL_POINTS: Record<string, [number, number]> = {
  "brooklyn-prospect": [-73.9709, 40.6602], "manhattan-midtown": [-73.9857, 40.7580], "manhattan-park": [-73.9712, 40.7829], "queens-flushing": [-73.8297, 40.7675], "staten-island": [-74.1502, 40.5795],
};
const WORKLOADS: Record<string, string> = {
  "workload-dense-tall-overpass.json": "40.748,-74.005,40.765,-73.978",
  "workload-open-overpass.json": "40.735,-73.858,40.752,-73.825",
  "workload-canopy-heavy-overpass.json": "40.766,-73.986,40.801,-73.948",
  "workload-waterfront-boundary-overpass.json": "40.692,-74.026,40.718,-73.994",
  "workload-long-low-sun-overpass.json": "40.733,-73.963,40.756,-73.905",
};
const GRID_URLS = {
  "us_nga_egm08_25.tif": "https://cdn.proj.org/us_nga_egm08_25.tif",
  "us_nga_egm96_15.tif": "https://cdn.proj.org/us_nga_egm96_15.tif",
} as const;
// Public Overpass instances are independent community services.  Use the
// primary first, but rotate to the documented alternate on a transient
// overload rather than making a resumed immutable acquisition start over.
const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.osm.ch/api/interpreter"] as const;
const OVERPASS_URL = OVERPASS_URLS[0];
const GRID_HASHES = {
  "us_nga_egm08_25.tif": "4191d471eefebf24091b56dbc604353cb3b8cf8cc70e448bb9ae56a272bef17a",
  "us_nga_egm96_15.tif": "db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d",
} as const;
const SUPPORT_CONSTRUCTION = "union five verified borough polygons; EPSG:32618 20000 metre buffer; WGS84 canonical GeoJSON";
// The DCP-26b + 20 km frozen-support envelope intersects these native CHMv2
// cells. Keeping their names in source lets --plan disclose every COG URL
// without fetching the 56 MB index; execute independently derives the same
// set from that pinned index and rejects a changed selection.
const NYC_CHM_TILE_IDS = ["0302323322", "0302323323", "0302323332", "0302323333", "0320101100", "0320101101", "0320101102", "0320101103", "0320101110", "0320101111", "0320101112", "0320101113", "0320101120", "0320101121"] as const;

export interface DownloadReceipt { url: string; path: string; sha256: string; bytes: number; status?: number; headers?: Record<string, string>; reused: boolean; }
export interface AcquisitionPlan { mode: "plan"; root: string; expectedFreeBytes: number; sources: Array<{ url: string; path: string; note: string }>; policy: string; }
type PriorDownload = Pick<DownloadReceipt, "path" | "sha256">;

function rawPath(root: string, name: string): string { return join(root, "raw", name); }
function overpassQuery(bbox: string): string {
  const [south, west, north, east] = bbox.split(","); const bounds = `(${south},${west},${north},${east})`;
  // The normalizer only accepts explicit height/est_height. Filtering here
  // avoids asking a public Overpass instance to serialize large wood polygons
  // which would be discarded locally and can trigger its response-size limit.
  return `[out:json][timeout:180];(nwr["natural"~"tree|wood"]["height"]${bounds};nwr["natural"~"tree|wood"]["est_height"]${bounds};);out body geom;`;
}
function fallbackQuery(support: PolygonalCoverage): string {
  const [west, south, east, north] = envelope(support);
  return overpassQuery(`${south},${west},${north},${east}`);
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

/** The official Overture client writes a small resumable-download sidecar next
 * to its requested output. It is neither source data nor an immutable asset,
 * so keep new sidecars out of raw and remove only the exact stale sidecars
 * produced by older versions of this workflow. */
async function clearOvertureDownloadState(root: string): Promise<void> {
  const raw = join(root, "raw");
  let entries: string[];
  try { entries = await readdir(raw); } catch { return; }
  const stateName = /^\.overture-2026-08-19-(?:buildings|building-parts)-nyc-support\.parquet\.\d+\.extract\.stac-download\.state$/;
  await Promise.all(entries.filter((entry) => stateName.test(entry)).map((entry) => rm(join(raw, entry), { force: true })));
}
async function toolVersions(): Promise<Record<string, string>> {
  const execute = promisify(execFile); const output: Record<string, string> = { node: process.version };
  for (const [name, args] of [["gdalinfo", ["--version"]], ["proj", []], ["unzip", ["-v"]]] as const) {
    try { const result = await execute(name, args); output[name] = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/, 1)[0] || "available"; } catch { output[name] = "unavailable"; }
  }
  return output;
}
async function priorDownloads(root: string): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  try { const values = JSON.parse(await readFile(join(root, "evidence", "acquisition-downloads.json"), "utf8")) as { downloads?: PriorDownload[] }; for (const item of values.downloads ?? []) known.set(item.path, item.sha256); } catch { /* a first run has no journal */ }
  // A completed older bundle has no acquisition-downloads journal, but its
  // receipt manifest is itself the immutable authority for every raw object.
  try {
    const receipts = JSON.parse(await readFile(rawPath(root, "source-receipts.json"), "utf8")) as Array<{ assets?: Array<{ filename?: string; sha256?: string }> }>;
    for (const receipt of receipts) for (const asset of receipt.assets ?? []) if (typeof asset.filename === "string" && /^[a-f0-9]{64}$/.test(String(asset.sha256))) known.set(rawPath(root, asset.filename), String(asset.sha256));
  } catch { /* no completed receipt manifest yet */ }
  return known;
}
async function publishTemporary(temporary: string, destination: string, expectedHash?: string): Promise<{ sha256: string; bytes: number; reused: boolean }> {
  const sha256 = await fileHash(temporary); if (expectedHash && sha256 !== expectedHash) throw new Error(`download hash mismatch for ${basename(destination)}: expected ${expectedHash}, got ${sha256}`);
  const bytes = (await stat(temporary)).size; await mkdir(dirname(destination), { recursive: true });
  try { await link(temporary, destination); await rm(temporary, { force: true }); return { sha256, bytes, reused: false }; }
  catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fileHash(destination);
    if (existing !== sha256) throw new Error(`refusing to replace existing immutable object ${destination}`);
    return { sha256, bytes: (await stat(destination)).size, reused: true };
  }
}

/** Stream a response into a same-directory temporary object, hash it, then use
 * link(2) to publish without ever replacing an already admitted raw object. */
export async function downloadImmutable(url: string, destination: string, options: { expectedHash?: string; method?: "GET" | "POST"; body?: string; previousHash?: string; adoptExisting?: boolean; onProgress?: (received: number, total?: number) => void } = {}): Promise<DownloadReceipt> {
  if (await exists(destination)) {
    const actual = await fileHash(destination); const accepted = options.expectedHash ?? options.previousHash;
    if (accepted === actual) { const bytes = (await stat(destination)).size; options.onProgress?.(bytes, bytes); return { url, path: destination, sha256: actual, bytes, reused: true }; }
    if (!accepted && options.adoptExisting) { const bytes = (await stat(destination)).size; options.onProgress?.(bytes, bytes); return { url, path: destination, sha256: actual, bytes, reused: true }; }
    throw new Error(`existing object has no matching immutable hash: ${destination}`);
  }
  const response = await fetch(url, { method: options.method ?? "GET", body: options.body, headers: options.body ? { "content-type": "application/x-www-form-urlencoded", "user-agent": "ShadeMapNavigation personal-source-prep/1.0" } : undefined });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
  await mkdir(dirname(destination), { recursive: true }); const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.download`);
  const hash = createHash("sha256"); const total = Number(response.headers.get("content-length")) || undefined; let received = 0;
  try {
    const input = Readable.fromWeb(response.body as never); input.on("data", (chunk: Buffer) => { hash.update(chunk); received += chunk.length; options.onProgress?.(received, total); });
    await pipeline(input, createWriteStream(temporary, { flags: "wx" }));
    const published = await publishTemporary(temporary, destination, options.expectedHash);
    const headers = Object.fromEntries(["content-length", "content-type", "etag", "last-modified"].flatMap((name) => response.headers.get(name) === null ? [] : [[name, response.headers.get(name)!]]));
    return { url, path: destination, ...published, status: response.status, headers };
  } finally { await rm(temporary, { force: true }); }
}

function humanBytes(value: number): string { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${value} B`; }
async function runVisible(command: string, args: string[], label: string): Promise<void> {
  process.stderr.write(`[acquire] ${label}: starting\n`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args); let error = "";
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => { error += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${label} failed (${code}): ${error.trim()}`)));
  });
  process.stderr.write(`[acquire] ${label}: complete\n`);
}

interface ChmTile { id: string; url: string; geometry: PolygonalCoverage; }
export function selectChmTiles(index: unknown, support: PolygonalCoverage): ChmTile[] {
  const features = (index as { features?: Array<{ properties?: Record<string, unknown>; geometry?: unknown }> }).features;
  if (!Array.isArray(features)) throw new Error("CHMv2 tile index is not a GeoJSON FeatureCollection");
  const selected = features.map((feature) => {
    const properties = feature.properties ?? {}; const id = String(properties.tile ?? properties.id ?? properties.name ?? "");
    const href = String(properties.href ?? properties.url ?? properties.cog ?? "");
    if (!id) return undefined;
    const url = /^https:\/\//.test(href) ? href : `${CHM_BASE}/chm/${id}.tif`;
    return { id, url, geometry: supportGeometry(feature.geometry) };
  }).filter((tile): tile is ChmTile => !!tile && intersectsSupport(tile.geometry, support)).sort((a, b) => a.id.localeCompare(b.id));
  if (selected.length !== 14) throw new Error(`pinned CHMv2 selection must contain exactly 14 COGs, found ${selected.length}`);
  if (new Set(selected.map((tile) => tile.id)).size !== selected.length) throw new Error("CHMv2 tile index selected duplicate tile identifiers");
  return selected;
}

async function buildSupport(root: string): Promise<{ path: string; sha256: string }> {
  const region = await loadRegion(); const boundary = rawPath(root, region.boundary.localName); await validateBoundary(boundary, region.boundary);
  const existing = join(root, "acquisition", SUPPORT_FILENAME);
  if (await exists(existing)) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "acquisition", "nyc-acquisition-manifest.json"), "utf8")) as { support?: { filename?: string; sha256?: string; bufferMetres?: number; construction?: string } };
      const hash = await fileHash(existing);
      if (manifest.support?.filename === `acquisition/${SUPPORT_FILENAME}` && manifest.support.sha256 === hash && manifest.support.bufferMetres === 20000 && manifest.support.construction === SUPPORT_CONSTRUCTION) return { path: existing, sha256: hash };
    } catch { /* an unverified support object is never reused */ }
    throw new Error(`refusing to replace existing unverified frozen support ${existing}`);
  }
  const temporary = join(root, "acquisition", `.support-${process.pid}.geojson`); await mkdir(dirname(temporary), { recursive: true });
  // OGR's SQLite geometry engine performs the union and 20,000 metre buffer in
  // UTM zone 18N, then returns only the WGS84 result. No degree buffer is used.
  const exec = promisify(execFile);
  const layer = basename(boundary).replace(/\.[^.]+$/, ""); const sql = `SELECT ST_Transform(ST_Buffer(ST_Union(ST_Transform(geometry,32618)),20000),4326) AS geometry FROM "${layer.replaceAll('"', '""')}"`;
  try { await exec("ogr2ogr", ["-f", "GeoJSON", temporary, boundary, "-dialect", "sqlite", "-sql", sql]); }
  catch (error) { throw new Error(`support construction requires GDAL/SQLite geometry support: ${(error as Error).message}`); }
  const output = canonicalSupportFeature(supportGeometry(JSON.parse(await readFile(temporary, "utf8")))); await rm(temporary, { force: true });
  const path = join(root, "acquisition", SUPPORT_FILENAME); const stage = `${path}.${process.pid}.tmp`; await writeJson(stage, output); const published = await publishTemporary(stage, path);
  const support = { path, sha256: published.sha256 };
  await writeJson(join(root, "acquisition", "nyc-acquisition-manifest.json"), { schemaVersion: 1, createdAt: new Date().toISOString(), boundary: { filename: `raw/${region.boundary.localName}`, sha256: await fileHash(boundary), release: `NYC DCP ${region.boundary.release}` }, support: { filename: `acquisition/${SUPPORT_FILENAME}`, sha256: support.sha256, bufferMetres: 20000, construction: SUPPORT_CONSTRUCTION } });
  return support;
}

async function extractOverture(root: string, kind: "building" | "building_part", support: PolygonalCoverage): Promise<DownloadReceipt> {
  const filename = kind === "building" ? "overture-2026-08-19-buildings-nyc-support.parquet" : "overture-2026-08-19-building-parts-nyc-support.parquet";
  const destination = rawPath(root, filename); const previous = (await priorDownloads(root)).get(destination);
  if (await exists(destination)) {
    const hash = await fileHash(destination); if (previous && hash !== previous) throw new Error(`existing Overture extract has no recorded immutable hash: ${destination}`);
    return { url: `${OVERTURE_HTTP}/type=${kind}/`, path: destination, sha256: hash, bytes: (await stat(destination)).size, reused: true };
  }
  // Keep client scratch outside raw: raw is deliberately an allow-listed,
  // uploadable immutable bundle and must never contain resume sidecars.
  const scratch = join(root, "acquisition", `.overture-${kind}-${process.pid}.extract`);
  await mkdir(dirname(scratch), { recursive: true });
  const connection = await DuckDBConnection.create(); const temporary = scratch; const downloaded = `${temporary}.stac-download`;
  try {
    // The official Overture client resolves the release STAC catalog first,
    // avoiding a global scan of hundreds of Parquet partitions.
    const [west, south, east, north] = envelope(support);
    await runVisible("overturemaps", ["download", "--bbox", `${west},${south},${east},${north}`, "-f", "geoparquet", "-o", downloaded, "-t", kind, "-r", OVERTURE_RELEASE], `Overture ${kind} STAC selection/download`);
    await connection.run("INSTALL spatial; LOAD spatial;");
    const supportJson = JSON.stringify(canonicalSupportFeature(support).features[0].geometry).replaceAll("'", "''");
    const fields = kind === "building" ? "id, geometry, height, min_height" : "id, geometry, height, min_height, building_id";
    // DuckDB reads GeoParquet's WKB extension as its native GEOMETRY type.
    // Passing it directly works for both the release metadata and spatial
    // predicate; re-wrapping it with ST_GeomFromWKB is a type error.
    const query = `COPY (SELECT ${fields} FROM read_parquet('${downloaded.replaceAll("'", "''")}') WHERE ST_Intersects(geometry, ST_GeomFromGeoJSON('${supportJson}'))) TO '${temporary.replaceAll("'", "''")}' (FORMAT PARQUET)`;
    await connection.run(query);
  } finally { connection.closeSync(); await rm(downloaded, { force: true }); await rm(`${downloaded}.state`, { force: true }); }
  const published = await publishTemporary(temporary, destination); await validateGeoParquetSchema(destination, kind === "building" ? "buildings" : "parts");
  return { url: `${OVERTURE_HTTP}/type=${kind}/`, path: destination, ...published };
}
async function validateOvertureSelection(root: string): Promise<void> {
  const buildings = await readGeoParquet(rawPath(root, "overture-2026-08-19-buildings-nyc-support.parquet"), "buildings");
  const parts = await readGeoParquet(rawPath(root, "overture-2026-08-19-building-parts-nyc-support.parquet"), "parts");
  const seen = new Set<string>();
  for (const row of buildings) {
    if (!row.id || seen.has(row.id) || row.height < 0 || row.minHeight < 0 || row.minHeight > row.height || !row.geometry.polygons.length) throw new Error(`invalid Overture building record ${row.id || "unnamed"}`);
    seen.add(row.id);
  }
  for (const row of parts) if (!row.id || row.height < 0 || row.minHeight < 0 || row.minHeight > row.height || !row.geometry.polygons.length || !row.buildingId || !seen.has(row.buildingId)) throw new Error(`invalid Overture building_part record ${row.id || "unnamed"}`);
}

function staticPlan(root: string): AcquisitionPlan {
  const regionUrl = "https://data.cityofnewyork.us/api/geospatial/gthc-hcne?method=export&format=GeoJSON";
  const sources = [
    { url: regionUrl, path: rawPath(root, "nyc-borough-boundaries-26b.geojson"), note: "DCP 26b pinned boundary" }, { url: FABDEM_URL, path: rawPath(root, "fabdem-v1-2-N40W080.zip"), note: "FABDEM v1.2 archive" },
    ...Object.entries(GRID_URLS).map(([name, url]) => ({ url, path: join(root, "proj", name), note: "pinned NGA PROJ grid" })), { url: `${CHM_BASE}/tiles.geojson`, path: join(root, "acquisition", "chmv2", "tiles.geojson"), note: "CHMv2 tile index" },
    ...NYC_CHM_TILE_IDS.map((id) => ({ url: `${CHM_BASE}/chm/${id}.tif`, path: rawPath(root, `chmv2-height/${id}.tif`), note: "frozen CHMv2 support COG" })),
    { url: `${OVERTURE_HTTP}/type=building/`, path: rawPath(root, "overture-2026-08-19-buildings-nyc-support.parquet"), note: "direct pinned GeoParquet building query" }, { url: `${OVERTURE_HTTP}/type=building_part/`, path: rawPath(root, "overture-2026-08-19-building-parts-nyc-support.parquet"), note: "direct pinned GeoParquet building_part query" },
    ...Object.entries(CONTROL_POINTS).map(([name, [x, y]]) => ({ url: `https://epqs.nationalmap.gov/v1/json?x=${x}&y=${y}&units=Meters&wkid=4326&includeDate=true`, path: rawPath(root, `3dep-controls/${name}.json`), note: "USGS control" })),
    { url: OVERPASS_URL, path: rawPath(root, "osm-fallback/osm-vegetation-nyc-support-overpass.json"), note: "bounded OSM vegetation fallback" }, ...Object.entries(WORKLOADS).map(([name, bbox]) => ({ url: `${OVERPASS_URL}?data=${encodeURIComponent(overpassQuery(bbox))}`, path: rawPath(root, name), note: "bounded OSM workload snapshot" })),
  ];
  return { mode: "plan", root, expectedFreeBytes: 16 * 1024 * 1024 * 1024, sources, policy: "Personal, non-commercial preparation only. FABDEM-derived output must retain CC BY-NC-SA 4.0 attribution and must not be public, paid, ad-supported, or customer-distributed." };
}

export async function acquire(mode: "plan" | "execute"): Promise<unknown> {
  const root = requireRoot(); const plan = staticPlan(root); if (mode === "plan") return plan;
  await mkdir(root, { recursive: true }); await clearOvertureDownloadState(root); const free = Number((await statfs(root)).bavail) * Number((await statfs(root)).bsize); if (free < plan.expectedFreeBytes) throw new Error(`acquisition requires ${plan.expectedFreeBytes} bytes free, found ${free}`);
  const previous = await priorDownloads(root); const downloads: DownloadReceipt[] = []; let sequence = 0; const totalSources = plan.sources.length;
  const get = async (url: string, path: string, expectedHash?: string, method?: "GET" | "POST", body?: string, alternatives: readonly string[] = []) => {
    const current = ++sequence; const label = basename(path); let last = 0;
    let result: DownloadReceipt | undefined;
    const endpoints = [url, ...alternatives];
    for (let attempt = 0; attempt < 4; attempt++) try {
      const endpoint = endpoints[attempt % endpoints.length];
      result = await downloadImmutable(endpoint, path, { expectedHash, previousHash: previous.get(path), method, body, adoptExisting: true, onProgress: (received, total) => {
        const now = Date.now(); if (now - last < 500 && received !== total) return; last = now;
        const percent = total ? ` ${(received / total * 100).toFixed(1)}%` : ""; process.stderr.write(`\r[acquire ${current}/${totalSources}] ${label}: ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ""}${percent}`);
      } }); break;
    } catch (error) {
      if (!/download failed \((?:406|429|502|503|504)\)/.test(String(error)) || attempt === 3) throw error;
      const seconds = 5 * 2 ** attempt; process.stderr.write(`\n[acquire ${current}/${totalSources}] ${label}: Overpass unavailable/rate-limited; retrying in ${seconds}s\n`); await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    if (!result) throw new Error(`acquisition did not obtain ${label}`);
    process.stderr.write(`\r[acquire ${current}/${totalSources}] ${label}: ${humanBytes(result.bytes)} ${result.reused ? "reused" : "downloaded"}\n`); return result;
  };
  const region = await loadRegion(); downloads.push(await get(region.boundary.url, rawPath(root, region.boundary.localName), region.boundary.sha256));
  downloads.push(await get(FABDEM_URL, rawPath(root, "fabdem-v1-2-N40W080.zip"), FABDEM_SHA256));
  for (const [name, url] of Object.entries(GRID_URLS)) downloads.push(await get(url, join(root, "proj", name), GRID_HASHES[name as keyof typeof GRID_HASHES]));
  downloads.push(await get(`${CHM_BASE}/tiles.geojson`, join(root, "acquisition", "chmv2", "tiles.geojson")));
  const support = await buildSupport(root); const supportInput = (await loadFrozenSupport()).geometry;
  const index = JSON.parse(await readFile(join(root, "acquisition", "chmv2", "tiles.geojson"), "utf8")); const chmTiles = selectChmTiles(index, supportInput);
  if (chmTiles.map((tile) => tile.id).join("\n") !== NYC_CHM_TILE_IDS.join("\n")) throw new Error("CHMv2 tile index selection drifted from the pinned NYC fourteen-Cog plan");
  const mask = { type: "FeatureCollection", features: chmTiles.map((tile) => ({ type: "Feature", properties: { tile: tile.id }, geometry: tile.geometry })) }; const maskPath = rawPath(root, "chmv2-validity-mask-nyc-support.geojson");
  if (await exists(maskPath)) {
    const hash = await fileHash(maskPath); if (previous.get(maskPath) && previous.get(maskPath) !== hash) throw new Error(`existing CHMv2 mask has no matching immutable receipt hash: ${maskPath}`);
    downloads.push({ url: `${CHM_BASE}/tiles.geojson`, path: maskPath, sha256: hash, bytes: (await stat(maskPath)).size, reused: true });
  } else { const maskTemporary = `${maskPath}.${process.pid}.tmp`; await writeJson(maskTemporary, mask); downloads.push({ url: `${CHM_BASE}/tiles.geojson`, path: maskPath, ...(await publishTemporary(maskTemporary, maskPath)) }); }
  for (const tile of chmTiles) downloads.push(await get(tile.url, rawPath(root, `chmv2-height/${tile.id}.tif`)));
  downloads.push(await extractOverture(root, "building", supportInput)); downloads.push(await extractOverture(root, "building_part", supportInput)); await validateOvertureSelection(root);
  for (const [name, [x, y]] of Object.entries(CONTROL_POINTS)) downloads.push(await get(`https://epqs.nationalmap.gov/v1/json?x=${x}&y=${y}&units=Meters&wkid=4326&includeDate=true`, rawPath(root, `3dep-controls/${name}.json`)));
  downloads.push(await get(OVERPASS_URL, rawPath(root, "osm-fallback/osm-vegetation-nyc-support-overpass.json"), undefined, "POST", `data=${encodeURIComponent(fallbackQuery(supportInput))}`, OVERPASS_URLS.slice(1)));
  for (const [name, bbox] of Object.entries(WORKLOADS)) downloads.push(await get(OVERPASS_URL, rawPath(root, name), undefined, "POST", `data=${encodeURIComponent(overpassQuery(bbox))}`, OVERPASS_URLS.slice(1)));
  await writeJson(join(root, "evidence", "acquisition-downloads.json"), { schemaVersion: 1, acquiredAt: new Date().toISOString(), downloads, support });
  // Admission intentionally runs once before receipts only to retain the exact
  // PROJ operation. Its expected missing-receipts failure never admits data.
  try { await admit(); } catch { /* receipt assembly follows datum evidence */ }
  const controls = await packageDatumControls(); if (controls.observedWorstResidual > 0.000000001) throw new Error(`datum control residual ${controls.observedWorstResidual} m exceeds 1e-9 m; no decision recorded`);
  const decision = await approveDatumControls("NYC-DATUM-ROUNDTRIP-2026-09-13-R1", 0.000000001); const receipts = await assembleReceipts(); const admission = await admit(); const normalization = await planNormalization(admission);
  const handoff = { schemaVersion: 1, createdAt: new Date().toISOString(), support, tileCount: normalization.tiles.length, versions: await toolVersions(), datum: { operationHash: admission.datum.operationHash, gridHashes: admission.datum.gridHashes, controls, decision }, receipts, objects: downloads.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), receiptHash: await fileHash(rawPath(root, "source-receipts.json")), s3Layout: ["raw/source-receipts.json", "raw/<every receipt asset filename>", `raw/${region.boundary.localName}`, `acquisition/${SUPPORT_FILENAME}`, "acquisition/nyc-acquisition-manifest.json", "proj/us_nga_egm08_25.tif", "proj/us_nga_egm96_15.tif", "evidence/<datum control output and report>"], normalizePlan: normalization };
  await writeJson(join(root, "evidence", "nyc-acquisition-handoff.json"), handoff); return handoff;
}

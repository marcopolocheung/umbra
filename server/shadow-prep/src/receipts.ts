import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChmNormalization, DatumControlEvidence, PolygonalCoverage, RawAsset, Receipt } from "./admission";
import { fileHash, requireRoot, sha256, writeJson } from "./util";
import { loadFrozenSupport } from "./support";

const TERRAIN: PolygonalCoverage = { type: "Polygon", coordinates: [[[-80, 40], [-70, 40], [-70, 50], [-80, 50], [-80, 40]]] };
const CHM_BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3";
const OVERTURE_RELEASE = "2026-08-19.0";
const OVERTURE_BASE = `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${OVERTURE_RELEASE}/theme=buildings`;
const WORKLOADS = {
  "workload-dense-tall": ["workload-dense-tall-overpass.json", "40.748,-74.005,40.765,-73.978"],
  "workload-open": ["workload-open-overpass.json", "40.735,-73.858,40.752,-73.825"],
  "workload-canopy-heavy": ["workload-canopy-heavy-overpass.json", "40.766,-73.986,40.801,-73.948"],
  "workload-waterfront-boundary": ["workload-waterfront-boundary-overpass.json", "40.692,-74.026,40.718,-73.994"],
  "workload-long-low-sun": ["workload-long-low-sun-overpass.json", "40.733,-73.963,40.756,-73.905"],
} as const;

const rectangle = (text: string): PolygonalCoverage => {
  const [south, west, north, east] = text.split(",").map(Number);
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
};

async function asset(raw: string, filename: string, publisherUrl: string, release: string, format: string, horizontalCrs: string, verticalDatum: string, supportCoverage: PolygonalCoverage): Promise<RawAsset> {
  const path = join(raw, filename); const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`selected raw asset is not a file: ${filename}`);
  return { filename, publisherUrl, release, sha256: await fileHash(path), format, acquiredAt: metadata.mtime.toISOString(), horizontalCrs, verticalDatum, supportCoverage };
}

/** Use the endpoint actually recorded by acquire, including a failover
 * instance when the primary public Overpass service was overloaded. */
async function acquiredUrl(root: string, filename: string, fallback: string): Promise<string> {
  try {
    const journal = JSON.parse(await readFile(join(root, "evidence", "acquisition-downloads.json"), "utf8")) as { downloads?: Array<{ path?: string; url?: string }> };
    const expected = join(root, "raw", filename);
    const hit = journal.downloads?.find((download) => download.path === expected && typeof download.url === "string");
    return hit?.url ?? fallback;
  } catch { return fallback; }
}

function chmPolicy(kind: "chmv2-height" | "chmv2-validity-mask"): ChmNormalization {
  return { kind, heightFormat: "Cloud-Optimized GeoTIFF, Float32 canopy height metres AGL, EPSG:3857", maskFormat: "GeoJSON selected authoritative tile-availability mask", validZero: true, nodata: "GeoTIFF nodata is unavailable; valid numeric zero remains zero", maskHole: "unavailable", osmFallback: "only-on-unavailable" };
}

export async function assembleReceipts(): Promise<{ receiptCount: number; rawAssetCount: number; receiptPath: string; acquisitionManifestPath: string }> {
  const root = requireRoot(); const raw = join(root, "raw"); const evidence = join(root, "evidence");
  const frozenSupport = await loadFrozenSupport(); const SUPPORT = frozenSupport.geometry;
  const operation = await readFile(join(evidence, "datum-operation.txt"), "utf8");
  const decision = JSON.parse(await readFile(join(evidence, "datum-control-decision.json"), "utf8")) as DatumControlEvidence;
  const mask = JSON.parse(await readFile(join(raw, "chmv2-validity-mask-nyc-support.geojson"), "utf8")) as { features?: Array<{ properties?: { tile?: string }; geometry?: PolygonalCoverage }> };
  const tiles = new Map((mask.features ?? []).map((feature) => [feature.properties?.tile, feature.geometry] as const));
  if (tiles.size !== 14 || [...tiles.values()].some((geometry) => !geometry)) throw new Error("the CHMv2 selected availability mask must contain exactly the fourteen selected tile geometries");
  const heightAssets = await Promise.all([...tiles.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(async ([tile, coverage]) => asset(raw, `chmv2-height/${tile}.tif`, `${CHM_BASE}/chm/${tile}.tif`, "CHMv2 ml3 public AWS Open Data release (2026-03 index)", "Cloud-Optimized GeoTIFF Float32", "EPSG:3857", "AGL", coverage!)));
  const controls = await Promise.all(["brooklyn-prospect", "manhattan-midtown", "manhattan-park", "queens-flushing", "staten-island"].map(async (name) => {
    const source = JSON.parse(await readFile(join(raw, "3dep-controls", `${name}.json`), "utf8")) as { location?: { x?: number; y?: number } };
    const x = source.location?.x; const y = source.location?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`malformed 3DEP control ${name}`);
    const epsilon = 0.000001;
    return asset(raw, `3dep-controls/${name}.json`, `https://epqs.nationalmap.gov/v1/json?x=${x}&y=${y}&units=Meters&wkid=4326&includeDate=true`, "USGS National Map Elevation Point Query Service response", "USGS EPQS JSON", "EPSG:4326", "vertical datum not declared by response", { type: "Polygon", coordinates: [[[x! - epsilon, y! - epsilon], [x! + epsilon, y! - epsilon], [x! + epsilon, y! + epsilon], [x! - epsilon, y! + epsilon], [x! - epsilon, y! - epsilon]]] });
  }));
  const workloads: Receipt[] = await Promise.all(Object.entries(WORKLOADS).map(async ([id, [filename, bbox]]) => ({
    id: id as Receipt["id"], role: "workload" as const, licence: "ODbL 1.0", rights: "https://www.openstreetmap.org/copyright",
    assets: [await asset(raw, filename, await acquiredUrl(root, filename, "https://overpass-api.de/api/interpreter"), "Overpass API snapshot recorded inside raw response", "Overpass JSON (out body geom)", "EPSG:4326", "AGL", rectangle(bbox))],
  })));
  const receipts: Receipt[] = [
    { id: "fabdem-v1.2", role: "terrain", licence: "CC BY-NC-SA 4.0", rights: "https://creativecommons.org/licenses/by-nc-sa/4.0/", assets: [await asset(raw, "fabdem-v1-2-N40W080.zip", "https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N40W080-N50W070_FABDEM_V1-2.zip", "FABDEM V1-2, University of Bristol, 2023-01-17", "ZIP archive containing original FABDEM V1-2 tiles", "EPSG:4326", "EGM2008", TERRAIN)], normalization: { kind: "terrain", datumOperation: operation, datumOperationHash: sha256(Buffer.from(operation)) } },
    { id: "overture-buildings", role: "buildings", licence: "ODbL 1.0", rights: "https://docs.overturemaps.org/attribution/", assets: [await asset(raw, "overture-2026-08-19-buildings-nyc-support.parquet", `${OVERTURE_BASE}/type=building/`, `Overture ${OVERTURE_RELEASE}; direct GeoParquet query against frozen support`, "GeoParquet 1.1", "EPSG:4326", "AGL", SUPPORT)], normalization: { kind: "buildings", selection: `direct GeoParquet query; release=${OVERTURE_RELEASE}; support-sha256=${frozenSupport.hash}; type=building; native id ascending at normalization`, priority: "overture-then-osm", missingHeight: "reject", raisedStructure: "retain-conflict" } },
    { id: "overture-building-parts", role: "building-parts", licence: "ODbL 1.0", rights: "https://docs.overturemaps.org/attribution/", assets: [await asset(raw, "overture-2026-08-19-building-parts-nyc-support.parquet", `${OVERTURE_BASE}/type=building_part/`, `Overture ${OVERTURE_RELEASE}; direct GeoParquet query against frozen support`, "GeoParquet 1.1", "EPSG:4326", "AGL", SUPPORT)], normalization: { kind: "building-parts", selection: `direct GeoParquet query; release=${OVERTURE_RELEASE}; support-sha256=${frozenSupport.hash}; type=building_part; native id ascending at normalization`, priority: "overture-then-osm", missingHeight: "reject", raisedStructure: "retain-conflict" } },
    { id: "chmv2-height", role: "canopy-height", licence: "CC BY 4.0", rights: "https://creativecommons.org/licenses/by/4.0/", assets: heightAssets, normalization: chmPolicy("chmv2-height") },
    { id: "chmv2-validity-mask", role: "canopy-mask", licence: "CC BY 4.0", rights: "https://creativecommons.org/licenses/by/4.0/", assets: [await asset(raw, "chmv2-validity-mask-nyc-support.geojson", `${CHM_BASE}/tiles.geojson`, "CHMv2 ml3 authoritative tile index selected against frozen support", "GeoJSON tile-availability mask", "EPSG:4326", "AGL", { type: "MultiPolygon", coordinates: [...tiles.values()].map((geometry) => geometry!.coordinates as number[][][]) })], normalization: chmPolicy("chmv2-validity-mask") },
    { id: "osm-tree-fallback", role: "canopy-fallback", licence: "ODbL 1.0", rights: "https://www.openstreetmap.org/copyright", assets: [await asset(raw, "osm-fallback/osm-vegetation-nyc-support-overpass.json", await acquiredUrl(root, "osm-fallback/osm-vegetation-nyc-support-overpass.json", "https://overpass-api.de/api/interpreter"), "Overpass OSM snapshot acquired through bounded NYC support query", "Overpass JSON (out body geom)", "EPSG:4326", "AGL", SUPPORT)], normalization: { kind: "osm-tree-fallback", policy: "only-when-chmv2-unavailable" } },
    { id: "usgs-3dep-controls", role: "control", licence: "USGS public domain", rights: "https://www.usgs.gov/information-policies-and-instructions/usgs-copyrights-and-credits", assets: controls, datumControlEvidence: decision },
    ...workloads,
  ];
  const receiptPath = join(raw, "source-receipts.json"); await writeJson(receiptPath, receipts);
  const supportPath = join(root, "acquisition", "nyc-five-borough-20km-support.geojson");
  const acquisitionManifestPath = join(root, "acquisition", "nyc-acquisition-manifest.json");
  await writeJson(acquisitionManifestPath, { schemaVersion: 1, createdAt: new Date().toISOString(), boundary: { filename: "raw/nyc-borough-boundaries-26b.geojson", sha256: await fileHash(join(raw, "nyc-borough-boundaries-26b.geojson")), release: "NYC DCP 26b" }, support: { filename: "acquisition/nyc-five-borough-20km-support.geojson", sha256: await fileHash(supportPath), bufferMetres: 20000, construction: "union five verified borough polygons; EPSG:32618 20000 metre buffer; WGS84 canonical GeoJSON", selectionEnvelope: SUPPORT }, receipts });
  return { receiptCount: receipts.length, rawAssetCount: receipts.reduce((sum, receipt) => sum + receipt.assets.length, 0), receiptPath, acquisitionManifestPath };
}

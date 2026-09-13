import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { directoryBytes, fileHash, files, json, requireRoot, sha256, writeJson } from "./util";
import { DATUM_CONTROL_THRESHOLD_BLOCKER, NGA_GRID_SHA256, transformHeight, validateDatumOperation, validateDatumOutput } from "./datum";

const REQUIRED_RECEIPTS = ["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls", "workload-dense-tall", "workload-open", "workload-canopy-heavy", "workload-waterfront-boundary", "workload-long-low-sun"] as const;
export type ReceiptId = typeof REQUIRED_RECEIPTS[number];
type ReceiptRole = "terrain" | "buildings" | "building-parts" | "canopy-height" | "canopy-mask" | "canopy-fallback" | "control" | "workload";
export interface PolygonalCoverage { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][]; }
/** Every raw byte is represented here; a receipt is a logical source, not a file. */
export interface RawAsset { filename: string; publisherUrl: string; release: string; sha256: string; format: string; acquiredAt: string; horizontalCrs: string; verticalDatum: string; supportCoverage: PolygonalCoverage; }
export interface DatumControlEvidence {
  outputFilename: string; outputSha256: string; reportFilename: string; reportSha256: string; operation: string; operationHash: string;
  metric: string; units: string; evaluatedPopulation: number; methodVersionHash: string; observedWorstResidual: number;
  thresholdStatus: "unadmitted" | "approved"; signedDecisionId?: string; maximumResidual?: number;
}
export interface TerrainNormalization { kind: "terrain"; datumOperation: string; datumOperationHash: string; }
export interface BuildingNormalization { kind: "buildings" | "building-parts"; selection: string; priority: "overture-then-osm"; missingHeight: "reject"; raisedStructure: "retain-conflict"; }
export interface ChmNormalization { kind: "chmv2-height" | "chmv2-validity-mask"; heightFormat: string; maskFormat: string; validZero: true; nodata: string; maskHole: "unavailable"; osmFallback: "only-on-unavailable"; }
export interface FallbackNormalization { kind: "osm-tree-fallback"; policy: "only-when-chmv2-unavailable"; }
export interface Receipt { id: ReceiptId; licence: string; rights: string; role: ReceiptRole; assets: RawAsset[]; normalization?: TerrainNormalization | BuildingNormalization | ChmNormalization | FallbackNormalization; datumControlEvidence?: DatumControlEvidence; }
export type AdmittedAsset = RawAsset & { path: string; bytes: number };
export type AdmittedReceipt = Receipt & { assets: AdmittedAsset[]; sha256: string; path: string; bytes: number; url: string; release: string; horizontalCrs: string; verticalDatum: string; };
export interface Source { id: string; kind: string; url: string; licence: string; horizontalCrs: string; verticalDatum: string; required: boolean; selection?: string; }
export interface Region { id: string; boundary: { url: string; localName: string; sha256: string; release: string; requiredBoroughs: string[]; licence: string }; support: { initialBufferMetres: number; exteriorPolicy: string }; datum: { horizontal: string; inputVertical: string; outputVertical: string; operation: string; grids: string[] }; sources: Source[]; workloads: { requiredCategories: string[]; graphCapture: string }; }
export interface Admission { region: string; admittedAt: string; boundary: { path: string; sha256: string; boroughs: string[]; release: string }; support: Region["support"]; datum: Region["datum"] & { gridPaths: string[]; gridHashes: Record<string, string>; ballparkAllowed: false; operationHash: string | null; operationEvidence?: { path: string; sha256: string } }; receipts: AdmittedReceipt[]; blockers: string[]; rawBytes: number; }

export async function loadRegion(): Promise<Region> { return json<Region>(new URL("../regions/new-york-city-v1.json", import.meta.url).pathname); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
const ROLE_BY_RECEIPT: Record<ReceiptId, ReceiptRole> = { "fabdem-v1.2": "terrain", "overture-buildings": "buildings", "overture-building-parts": "building-parts", "chmv2-height": "canopy-height", "chmv2-validity-mask": "canopy-mask", "osm-tree-fallback": "canopy-fallback", "usgs-3dep-controls": "control", "workload-dense-tall": "workload", "workload-open": "workload", "workload-canopy-heavy": "workload", "workload-waterfront-boundary": "workload", "workload-long-low-sun": "workload" };

export async function validateBoundary(path: string, boundary: Region["boundary"]): Promise<{ path: string; sha256: string; boroughs: string[] }> {
  const actual = await fileHash(path);
  if (actual !== boundary.sha256) throw new Error(`DCP ${boundary.release} boundary hash mismatch: expected ${boundary.sha256}, got ${actual}`);
  const document = JSON.parse(await readFile(path, "utf8")) as { features?: Array<{ properties?: Record<string, unknown> }> };
  const boroughs = [...new Set((document.features ?? []).map((feature) => String(feature.properties?.boroname ?? feature.properties?.boro_name ?? feature.properties?.BoroName ?? feature.properties?.boro ?? "")))].sort();
  const missing = boundary.requiredBoroughs.filter((name) => !boroughs.includes(name));
  if (missing.length || boroughs.length !== 5) throw new Error(`DCP ${boundary.release} boundary does not contain exactly the five required boroughs: ${missing.join(", ")}`);
  return { path, sha256: actual, boroughs };
}

async function boundary(region: Region, raw: string): Promise<{ path: string; sha256: string; boroughs: string[] }> {
  const path = join(raw, region.boundary.localName);
  if (!(await exists(path))) {
    const response = await fetch(region.boundary.url);
    if (!response.ok) throw new Error(`DCP boundary download failed: ${response.status}`);
    await mkdir(raw, { recursive: true }); await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  }
  return validateBoundary(path, region.boundary);
}

async function grids(names: string[]): Promise<{ paths: string[]; hashes: Record<string, string>; blockers: string[] }> {
  const directories = process.env.PROJ_DATA ? process.env.PROJ_DATA.split(delimiter).filter(Boolean) : [];
  const paths: string[] = []; const hashes: Record<string, string> = {}; const blockers: string[] = [];
  if (!directories.length) blockers.push("PROJ_DATA must name the read-only pinned NGA-grid directory");
  for (const name of names) {
    let found: string | undefined;
    for (const directory of directories) { const candidate = join(directory, name); if (await exists(candidate)) { found = candidate; break; } }
    if (!found) blockers.push(`missing required NGA grid ${name}`);
    else {
      const hash = await fileHash(found); hashes[name] = hash;
      if (NGA_GRID_SHA256[name] !== hash) blockers.push(`NGA grid hash mismatch for ${name}`);
      else paths.push(found);
    }
  }
  return { paths, hashes, blockers };
}

function validUrl(value: string): boolean { try { const url = new URL(value); return ["https:", "http:", "s3:"].includes(url.protocol); } catch { return false; } }
function validAcquiredAt(value: string): boolean { return Number.isFinite(Date.parse(value)) && /T/.test(value); }
function validRights(value: string): boolean { return validUrl(value); }
function safeRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function validCoverage(value: unknown): value is PolygonalCoverage {
  if (!value || typeof value !== "object") return false;
  const geometry = value as PolygonalCoverage;
  if (!(geometry.type === "Polygon" || geometry.type === "MultiPolygon") || !Array.isArray(geometry.coordinates)) return false;
  const rings = geometry.type === "Polygon" ? geometry.coordinates as number[][][] : (geometry.coordinates as number[][][][]).flat();
  return rings.length > 0 && rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2 && coordinate.every(Number.isFinite)) && ring[0][0] === ring.at(-1)?.[0] && ring[0][1] === ring.at(-1)?.[1]);
}
function validAsset(value: unknown): value is RawAsset {
  const asset = value as Partial<RawAsset>;
  return !!asset && [asset.filename, asset.publisherUrl, asset.release, asset.sha256, asset.format, asset.acquiredAt, asset.horizontalCrs, asset.verticalDatum].every((field) => typeof field === "string" && field.length > 0) && safeRelative(asset.filename) && validUrl(asset.publisherUrl!) && /^[a-f0-9]{64}$/.test(asset.sha256!) && validAcquiredAt(asset.acquiredAt!) && validCoverage(asset.supportCoverage);
}
function isForbiddenSubstitute(receipt: Receipt, asset: RawAsset): boolean {
  if (!(receipt.role === "terrain" || receipt.role === "canopy-height" || receipt.role === "canopy-mask" || receipt.role === "buildings" || receipt.role === "building-parts")) return false;
  return /(?:^|[\/_ .-])(normalized|intermediate|mosaic)(?:$|[\/_ .-])/i.test(`${asset.filename} ${asset.format}`);
}
function validNormalization(receipt: Receipt): boolean {
  const policy = receipt.normalization as Record<string, unknown> | undefined;
  if (receipt.id === "fabdem-v1.2") return !!policy && policy.kind === "terrain" && typeof policy.datumOperation === "string" && /^[a-f0-9]{64}$/.test(String(policy.datumOperationHash)) && policy.datumOperationHash === sha256(Buffer.from(String(policy.datumOperation))) && /EGM2008/i.test(String(policy.datumOperation)) && /EGM96/i.test(String(policy.datumOperation)) && /us_nga_egm08_25\.tif/i.test(String(policy.datumOperation)) && /us_nga_egm96_15\.tif/i.test(String(policy.datumOperation));
  if (receipt.id === "overture-buildings" || receipt.id === "overture-building-parts") return !!policy && policy.kind === (receipt.id === "overture-buildings" ? "buildings" : "building-parts") && typeof policy.selection === "string" && policy.selection.length > 0 && policy.priority === "overture-then-osm" && policy.missingHeight === "reject" && policy.raisedStructure === "retain-conflict";
  if (receipt.id === "chmv2-height" || receipt.id === "chmv2-validity-mask") return !!policy && policy.kind === receipt.id && typeof policy.heightFormat === "string" && policy.heightFormat.length > 0 && typeof policy.maskFormat === "string" && policy.maskFormat.length > 0 && policy.validZero === true && typeof policy.nodata === "string" && policy.nodata.length > 0 && policy.maskHole === "unavailable" && policy.osmFallback === "only-on-unavailable";
  if (receipt.id === "osm-tree-fallback") return !!policy && policy.kind === "osm-tree-fallback" && policy.policy === "only-when-chmv2-unavailable";
  return receipt.normalization === undefined;
}
async function validateDatumControls(raw: string, receipt: Receipt): Promise<{ blockers: string[] }> {
  const evidence = receipt.datumControlEvidence;
  if (!evidence || typeof evidence !== "object") return { blockers: ["independent datum-control evidence is missing"] };
  const common = safeRelative(evidence.outputFilename) && /^[a-f0-9]{64}$/.test(evidence.outputSha256) && safeRelative(evidence.reportFilename) && /^[a-f0-9]{64}$/.test(evidence.reportSha256) && typeof evidence.operation === "string" && /^[a-f0-9]{64}$/.test(evidence.operationHash) && evidence.operationHash === sha256(Buffer.from(evidence.operation)) && /EGM2008/i.test(evidence.operation) && /EGM96/i.test(evidence.operation) && /us_nga_egm08_25\.tif/i.test(evidence.operation) && /us_nga_egm96_15\.tif/i.test(evidence.operation) && typeof evidence.metric === "string" && evidence.metric.length > 0 && typeof evidence.units === "string" && evidence.units.length > 0 && Number.isInteger(evidence.evaluatedPopulation) && evidence.evaluatedPopulation > 0 && /^[a-f0-9]{64}$/.test(evidence.methodVersionHash) && Number.isFinite(evidence.observedWorstResidual) && evidence.observedWorstResidual >= 0;
  if (!common) return { blockers: ["incomplete datum-control transformation evidence"] };
  const evidenceDirectory = join(raw, "..", "evidence"); const output = join(evidenceDirectory, evidence.outputFilename); const report = join(evidenceDirectory, evidence.reportFilename);
  if (!(await exists(output)) || !(await exists(report)) || (await fileHash(output)) !== evidence.outputSha256 || (await fileHash(report)) !== evidence.reportSha256) return { blockers: ["missing or hash-mismatched retained datum-control evidence"] };
  if (evidence.thresholdStatus === "unadmitted") return { blockers: [DATUM_CONTROL_THRESHOLD_BLOCKER] };
  if (evidence.thresholdStatus !== "approved" || !safeRelative(evidence.signedDecisionId) || !Number.isFinite(evidence.maximumResidual) || evidence.maximumResidual! < 0) return { blockers: ["approved datum-control evidence is unsigned or incomplete"] };
  if (evidence.observedWorstResidual > evidence.maximumResidual!) return { blockers: ["datum-control observed worst residual exceeds the approved maximum residual"] };
  return { blockers: [] };
}

function datumReceipt(receipts: Admission["receipts"]): AdmittedReceipt | undefined {
  return receipts.find((receipt) => receipt.id === "fabdem-v1.2");
}

function validateRecordedDatumOperation(receipts: Admission["receipts"], output: string, operationError?: string): string[] {
  if (operationError) return [];
  const terrain = datumReceipt(receipts);
  if (!terrain) return [];
  const recorded = terrain?.normalization as TerrainNormalization | undefined;
  if (!recorded || recorded.datumOperationHash !== sha256(Buffer.from(output)) || recorded.datumOperation !== output) return ["recorded terrain PROJ operation does not exactly match the NYC --grid-check known_available output"];
  const controls = receipts.find((receipt) => receipt.id === "usgs-3dep-controls")?.datumControlEvidence;
  if (controls && controls.operationHash !== recorded.datumOperationHash) return ["datum-control evidence does not use the recorded terrain PROJ operation"];
  return [];
}
export async function validateReceipts(raw: string, values: unknown): Promise<{ receipts: Admission["receipts"]; recordedPaths: string[]; blockers: string[] }> {
  const blockers: string[] = [];
  if (!Array.isArray(values)) return { receipts: [], recordedPaths: [], blockers: ["source receipt manifest is not an array"] };
  if (values.length !== REQUIRED_RECEIPTS.length) blockers.push(`source receipt manifest must contain exactly ${REQUIRED_RECEIPTS.length} receipts`);
  const receipts: Admission["receipts"] = []; const recordedPaths: string[] = []; const ids = new Set<string>(); const filenames = new Set<string>();
  for (const value of values) {
    const receipt = value as Partial<Receipt>;
    if (!receipt.id || !REQUIRED_RECEIPTS.includes(receipt.id as ReceiptId)) { blockers.push(`unknown source receipt ${String(receipt.id)}`); continue; }
    if (ids.has(receipt.id)) { blockers.push(`duplicate source receipt ${receipt.id}`); continue; }
    ids.add(receipt.id);
    if (![receipt.licence, receipt.rights, receipt.role].every((field) => typeof field === "string" && field.length > 0) || !validRights(receipt.rights!) || !Array.isArray(receipt.assets) || !receipt.assets.length) { blockers.push(`incomplete pinned receipt ${receipt.id}`); continue; }
    const pinned = receipt as Receipt;
    if (pinned.role !== ROLE_BY_RECEIPT[pinned.id]) { blockers.push(`wrong role for source receipt ${pinned.id}`); continue; }
    if (!validNormalization(pinned)) { blockers.push(`missing or invalid source-specific normalization metadata for ${pinned.id}`); continue; }
    const admittedAssets: AdmittedAsset[] = [];
    for (const asset of pinned.assets) {
      if (!validAsset(asset)) { blockers.push(`incomplete immutable raw asset for ${pinned.id}`); continue; }
      if (isForbiddenSubstitute(pinned, asset)) { blockers.push(`normalized intermediate or regional mosaic is not a raw asset for ${pinned.id}: ${asset.filename}`); continue; }
      if (filenames.has(asset.filename)) { blockers.push(`duplicate source filename ${asset.filename}`); continue; } filenames.add(asset.filename);
      const path = join(raw, asset.filename);
      if (!(await exists(path))) { blockers.push(`missing pinned input ${pinned.id}: ${asset.filename}`); continue; }
      if (!(await stat(path)).isFile()) { blockers.push(`pinned input is not a raw file ${pinned.id}: ${asset.filename}`); continue; }
      const actual = await fileHash(path); if (actual !== asset.sha256) { blockers.push(`hash mismatch for ${pinned.id}: ${asset.filename}`); continue; }
      admittedAssets.push({ ...asset, path, bytes: (await stat(path)).size }); recordedPaths.push(path);
    }
    if (admittedAssets.length !== pinned.assets.length) continue;
    if (pinned.id === "usgs-3dep-controls") blockers.push(...(await validateDatumControls(raw, pinned)).blockers);
    const primary = admittedAssets[0];
    receipts.push({ ...pinned, assets: admittedAssets, sha256: sha256(Buffer.from(admittedAssets.map((asset) => asset.sha256).sort().join("\n"))), path: primary.path, bytes: admittedAssets.reduce((total, asset) => total + asset.bytes, 0), url: primary.publisherUrl, release: primary.release, horizontalCrs: primary.horizontalCrs, verticalDatum: primary.verticalDatum });
  }
  for (const id of REQUIRED_RECEIPTS) if (!ids.has(id)) blockers.push(`missing required source receipt ${id}`);
  return { receipts, recordedPaths, blockers };
}
export async function validateRecordedRawFiles(raw: string, allowed: Iterable<string>): Promise<string[]> {
  const recorded = new Set(allowed);
  const blockers: string[] = [];
  for (const path of await files(raw)) if (!recorded.has(path)) blockers.push(`unrecorded production input ${path}`);
  return blockers;
}

export async function admit(): Promise<Admission> {
  const root = requireRoot(); const region = await loadRegion(); const raw = join(root, "raw"); const blockers: string[] = [];
  let pinnedBoundary: { path: string; sha256: string; boroughs: string[] };
  try { pinnedBoundary = await boundary(region, raw); } catch (error) { throw new Error(`boundary admission blocked: ${(error as Error).message}`); }
  const grid = await grids(region.datum.grids); blockers.push(...grid.blockers);
  const operation = await validateDatumOperation(grid.paths); if (operation.error) blockers.push(operation.error);
  const operationEvidencePath = join(root, "evidence", "datum-operation.txt");
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(operationEvidencePath, operation.output);
  const operationHash = sha256(Buffer.from(operation.output));
  const receiptFile = join(raw, "source-receipts.json");
  let receiptValues: unknown;
  try { receiptValues = (await exists(receiptFile)) ? await json<unknown>(receiptFile) : undefined; } catch { blockers.push("source receipt manifest is invalid JSON"); }
  const checked = await validateReceipts(raw, receiptValues); blockers.push(...checked.blockers);
  blockers.push(...validateRecordedDatumOperation(checked.receipts, operation.output, operation.error));
  const allowed = new Set([join(raw, region.boundary.localName), receiptFile, ...checked.recordedPaths]);
  blockers.push(...await validateRecordedRawFiles(raw, allowed));
  const admission: Admission = { region: region.id, admittedAt: new Date().toISOString(), boundary: { ...pinnedBoundary, release: region.boundary.release }, support: region.support, datum: { ...region.datum, gridPaths: grid.paths, gridHashes: grid.hashes, ballparkAllowed: false, operationHash: operation.error ? null : operationHash, operationEvidence: { path: operationEvidencePath, sha256: operationHash } }, receipts: checked.receipts, blockers, rawBytes: await directoryBytes(raw) };
  await writeJson(join(root, "admission", `${region.id}.json`), admission); await writeJson(join(root, "evidence", "source-manifest.json"), admission);
  if (blockers.length) throw new Error(`regional manifest rejected:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  return admission;
}

export { transformHeight, validateDatumOutput };

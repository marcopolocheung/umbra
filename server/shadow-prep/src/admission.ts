import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { directoryBytes, fileHash, files, json, requireRoot, sha256, writeJson } from "./util";
import { DATUM_CONTROL_THRESHOLD_BLOCKER, NGA_GRID_SHA256, transformHeight, validateDatumOperation, validateDatumOutput } from "./datum";

const REQUIRED_RECEIPTS = ["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls", "workload-dense-tall", "workload-open", "workload-canopy-heavy", "workload-waterfront-boundary", "workload-long-low-sun"] as const;
export type ReceiptId = typeof REQUIRED_RECEIPTS[number];
type ReceiptRole = "terrain" | "buildings" | "building-parts" | "canopy-height" | "canopy-mask" | "canopy-fallback" | "control" | "workload";
export interface DatumControlEvidence { outputFilename: string; outputSha256: string; operation: string; operationHash: string; thresholdStatus: "unadmitted"; }
export interface Receipt { id: ReceiptId; assetId: string; url: string; release: string; filename: string; sha256: string; horizontalCrs: string; verticalDatum: string; licence: string; rights: string; supportExtent: string; acquiredAt: string; role: ReceiptRole; validZero?: boolean; nodata?: string; datumControlEvidence?: DatumControlEvidence; }
export interface Source { id: string; kind: string; url: string; licence: string; horizontalCrs: string; verticalDatum: string; required: boolean; selection?: string; }
export interface Region { id: string; boundary: { url: string; localName: string; sha256: string; release: string; requiredBoroughs: string[]; licence: string }; support: { initialBufferMetres: number; exteriorPolicy: string }; datum: { horizontal: string; inputVertical: string; outputVertical: string; operation: string; grids: string[] }; sources: Source[]; workloads: { requiredCategories: string[]; graphCapture: string }; }
export interface Admission { region: string; admittedAt: string; boundary: { path: string; sha256: string; boroughs: string[]; release: string }; support: Region["support"]; datum: Region["datum"] & { gridPaths: string[]; gridHashes: Record<string, string>; ballparkAllowed: false; operationHash: string | null }; receipts: Array<Receipt & { path: string; bytes: number }>; blockers: string[]; rawBytes: number; }

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
  const directories = process.env.PROJ_DATA ? [process.env.PROJ_DATA] : [];
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

function receiptPath(raw: string, receipt: Receipt): string {
  if (receipt.filename.startsWith("/") || receipt.filename.includes("..")) throw new Error(`unsafe receipt filename ${receipt.filename}`);
  return join(raw, receipt.filename);
}
function validUrl(value: string): boolean { try { const url = new URL(value); return ["https:", "http:", "s3:"].includes(url.protocol); } catch { return false; } }
function validAcquiredAt(value: string): boolean { return Number.isFinite(Date.parse(value)) && /T/.test(value); }
function validRights(value: string): boolean { return validUrl(value); }
async function validateDatumControls(raw: string, receipt: Receipt): Promise<{ paths: string[]; blockers: string[] }> {
  const evidence = receipt.datumControlEvidence;
  if (!evidence || typeof evidence !== "object") return { paths: [], blockers: ["independent datum-control evidence is missing"] };
  if (evidence.thresholdStatus !== "unadmitted") return { paths: [], blockers: ["datum-control evidence must explicitly retain an unadmitted residual threshold"] };
  if (!evidence.outputFilename || evidence.outputFilename.startsWith("/") || evidence.outputFilename.includes("..") || !/^[a-f0-9]{64}$/.test(evidence.outputSha256) || !/^[a-f0-9]{64}$/.test(evidence.operationHash) || evidence.operationHash !== sha256(Buffer.from(evidence.operation)) || !evidence.operation.includes("EGM2008") || !evidence.operation.includes("EGM96") || !evidence.operation.includes("us_nga_egm08_25.tif") || !evidence.operation.includes("us_nga_egm96_15.tif")) return { paths: [], blockers: ["incomplete datum-control transformation evidence"] };
  const path = join(raw, evidence.outputFilename);
  if (!(await exists(path))) return { paths: [], blockers: ["missing retained datum-control transformation output"] };
  if ((await fileHash(path)) !== evidence.outputSha256) return { paths: [], blockers: ["datum-control transformation output hash mismatch"] };
  return { paths: [path], blockers: [DATUM_CONTROL_THRESHOLD_BLOCKER] };
}
export async function validateReceipts(raw: string, values: unknown): Promise<{ receipts: Admission["receipts"]; recordedPaths: string[]; blockers: string[] }> {
  const blockers: string[] = [];
  if (!Array.isArray(values)) return { receipts: [], recordedPaths: [], blockers: ["source receipt manifest is not an array"] };
  if (values.length !== REQUIRED_RECEIPTS.length) blockers.push(`source receipt manifest must contain exactly ${REQUIRED_RECEIPTS.length} receipts`);
  const receipts: Admission["receipts"] = []; const recordedPaths: string[] = []; const ids = new Set<string>(); const assets = new Set<string>(); const filenames = new Set<string>();
  for (const value of values) {
    const receipt = value as Partial<Receipt>;
    if (!receipt.id || !REQUIRED_RECEIPTS.includes(receipt.id as ReceiptId)) { blockers.push(`unknown source receipt ${String(receipt.id)}`); continue; }
    if (ids.has(receipt.id)) { blockers.push(`duplicate source receipt ${receipt.id}`); continue; }
    ids.add(receipt.id);
    if (![receipt.assetId, receipt.url, receipt.release, receipt.filename, receipt.sha256, receipt.horizontalCrs, receipt.verticalDatum, receipt.licence, receipt.rights, receipt.supportExtent, receipt.acquiredAt, receipt.role].every((field) => typeof field === "string" && field.length > 0) || !/^[a-f0-9]{64}$/.test(receipt.sha256!) || !validUrl(receipt.url!) || !validRights(receipt.rights!) || !validAcquiredAt(receipt.acquiredAt!)) { blockers.push(`incomplete pinned receipt ${receipt.id}`); continue; }
    const pinned = receipt as Receipt;
    if (pinned.role !== ROLE_BY_RECEIPT[pinned.id]) { blockers.push(`wrong role for source receipt ${pinned.id}`); continue; }
    if (assets.has(pinned.assetId)) { blockers.push(`duplicate source asset receipt ${pinned.assetId}`); continue; } assets.add(pinned.assetId);
    if (filenames.has(pinned.filename)) { blockers.push(`duplicate source filename ${pinned.filename}`); continue; } filenames.add(pinned.filename);
    let path: string; try { path = receiptPath(raw, pinned); } catch (error) { blockers.push((error as Error).message); continue; }
    if (!(await exists(path))) { blockers.push(`missing pinned input ${receipt.id}: ${receipt.filename}`); continue; }
    const actual = await fileHash(path); if (actual !== receipt.sha256) { blockers.push(`hash mismatch for ${receipt.id}`); continue; }
    const bytes = (await stat(path)).size;
    if (receipt.id === "chmv2-height" && (receipt.validZero !== true || typeof receipt.nodata !== "string")) blockers.push("CHMv2 height receipt must declare valid-zero and nodata semantics");
    if (receipt.id === "chmv2-validity-mask" && (typeof receipt.validZero !== "boolean" || typeof receipt.nodata !== "string")) blockers.push("CHMv2 validity-mask receipt must declare valid-zero and nodata semantics");
    recordedPaths.push(path);
    if (receipt.id === "usgs-3dep-controls") {
      if (pinned.datumControlEvidence && filenames.has(pinned.datumControlEvidence.outputFilename)) blockers.push("datum-control transformation output must be a distinct recorded raw file");
      else if (pinned.datumControlEvidence) filenames.add(pinned.datumControlEvidence.outputFilename);
      const controls = await validateDatumControls(raw, pinned); blockers.push(...controls.blockers); recordedPaths.push(...controls.paths);
    }
    receipts.push({ ...(receipt as Receipt), path, bytes });
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
  const receiptFile = join(raw, "source-receipts.json");
  let receiptValues: unknown;
  try { receiptValues = (await exists(receiptFile)) ? await json<unknown>(receiptFile) : undefined; } catch { blockers.push("source receipt manifest is invalid JSON"); }
  const checked = await validateReceipts(raw, receiptValues); blockers.push(...checked.blockers);
  const allowed = new Set([join(raw, region.boundary.localName), receiptFile, ...checked.recordedPaths]);
  blockers.push(...await validateRecordedRawFiles(raw, allowed));
  const admission: Admission = { region: region.id, admittedAt: new Date().toISOString(), boundary: { ...pinnedBoundary, release: region.boundary.release }, support: region.support, datum: { ...region.datum, gridPaths: grid.paths, gridHashes: grid.hashes, ballparkAllowed: false, operationHash: operation.error ? null : sha256(Buffer.from(operation.output)) }, receipts: checked.receipts, blockers, rawBytes: await directoryBytes(raw) };
  await writeJson(join(root, "admission", `${region.id}.json`), admission); await writeJson(join(root, "evidence", "source-manifest.json"), admission);
  if (blockers.length) throw new Error(`regional manifest rejected:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  return admission;
}

export { transformHeight, validateDatumOutput };

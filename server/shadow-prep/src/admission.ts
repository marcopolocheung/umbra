import { execFile } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { directoryBytes, fileHash, files, json, requireRoot, sha256, writeJson } from "./util";

const exec = promisify(execFile);
const REQUIRED_RECEIPTS = ["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls", "workload-dense-tall", "workload-open", "workload-canopy-heavy", "workload-waterfront-boundary", "workload-long-low-sun"] as const;
export type ReceiptId = typeof REQUIRED_RECEIPTS[number];
export interface Receipt { id: ReceiptId; assetId: string; url: string; release: string; filename: string; sha256: string; horizontalCrs: string; verticalDatum: string; licence: string; acquiredAt: string; role: "terrain" | "buildings" | "building-parts" | "canopy-height" | "canopy-mask" | "canopy-fallback" | "control" | "workload"; validZero?: boolean; nodata?: string; }
export interface Source { id: string; kind: string; url: string; licence: string; horizontalCrs: string; verticalDatum: string; required: boolean; selection?: string; }
export interface Region { id: string; boundary: { url: string; localName: string; sha256: string; release: string; requiredBoroughs: string[]; licence: string }; support: { initialBufferMetres: number; exteriorPolicy: string }; datum: { horizontal: string; inputVertical: string; outputVertical: string; operation: string; grids: string[] }; sources: Source[]; workloads: { requiredCategories: string[]; graphCapture: string }; }
export interface Admission { region: string; admittedAt: string; boundary: { path: string; sha256: string; boroughs: string[]; release: string }; support: Region["support"]; datum: Region["datum"] & { gridPaths: string[]; gridHashes: Record<string, string>; ballparkAllowed: false; operationHash: string }; receipts: Array<Receipt & { path: string; bytes: number }>; blockers: string[]; rawBytes: number; }

export async function loadRegion(): Promise<Region> { return json<Region>(new URL("../regions/new-york-city-v1.json", import.meta.url).pathname); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

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
  const directories = [process.env.PROJ_DATA, "/usr/share/proj", "/usr/local/share/proj"].filter(Boolean) as string[];
  const paths: string[] = []; const hashes: Record<string, string> = {}; const blockers: string[] = [];
  for (const name of names) {
    let found: string | undefined;
    for (const directory of directories) { const candidate = join(directory, name); if (await exists(candidate)) { found = candidate; break; } }
    if (!found) blockers.push(`missing required NGA grid ${name}`);
    else { paths.push(found); hashes[name] = await fileHash(found); }
  }
  return { paths, hashes, blockers };
}

export function validateDatumOutput(output: string): string | undefined {
  return !output.trim() || /ballpark/i.test(output) || !/egm08/i.test(output) || !/egm96/i.test(output) ? "EGM2008→EGM96 operation is absent, ballpark, or does not name both NGA grids" : undefined;
}
export async function validateDatumOperation(gridPaths: string[]): Promise<{ output: string; error?: string }> {
  if (gridPaths.length !== 2) return { output: "", error: "required EGM grids are absent" };
  try {
    const result = await exec("projinfo", ["-s", "EPSG:4326+3855", "-t", "EPSG:4326+5773", "--bbox", "-74.26,40.49,-73.70,40.92", "--spatial-test", "intersects", "--grid-check", "known_available"]);
    const output = `${result.stdout}${result.stderr}`;
    const error = validateDatumOutput(output); if (error) return { output, error };
    return { output };
  } catch (error) { return { output: "", error: `PROJ datum operation check failed: ${(error as Error).message}` }; }
}

function receiptPath(raw: string, receipt: Receipt): string {
  if (receipt.filename.startsWith("/") || receipt.filename.includes("..")) throw new Error(`unsafe receipt filename ${receipt.filename}`);
  return join(raw, receipt.filename);
}
export async function validateReceipts(raw: string, values: unknown): Promise<{ receipts: Admission["receipts"]; blockers: string[] }> {
  const blockers: string[] = [];
  if (!Array.isArray(values)) return { receipts: [], blockers: ["source receipt manifest is not an array"] };
  const receipts: Admission["receipts"] = []; const ids = new Set<string>(); const assets = new Set<string>();
  for (const value of values) {
    const receipt = value as Partial<Receipt>;
    if (!receipt.id || !REQUIRED_RECEIPTS.includes(receipt.id as ReceiptId)) { blockers.push(`unknown source receipt ${String(receipt.id)}`); continue; }
    ids.add(receipt.id);
    if (![receipt.assetId, receipt.url, receipt.release, receipt.filename, receipt.sha256, receipt.horizontalCrs, receipt.verticalDatum, receipt.licence, receipt.acquiredAt, receipt.role].every((field) => typeof field === "string" && field.length > 0) || !/^[a-f0-9]{64}$/.test(receipt.sha256!)) { blockers.push(`incomplete pinned receipt ${receipt.id}`); continue; }
    const pinned = receipt as Receipt;
    if (assets.has(pinned.assetId)) { blockers.push(`duplicate source asset receipt ${pinned.assetId}`); continue; } assets.add(pinned.assetId);
    let path: string; try { path = receiptPath(raw, pinned); } catch (error) { blockers.push((error as Error).message); continue; }
    if (!(await exists(path))) { blockers.push(`missing pinned input ${receipt.id}: ${receipt.filename}`); continue; }
    const actual = await fileHash(path); if (actual !== receipt.sha256) { blockers.push(`hash mismatch for ${receipt.id}`); continue; }
    const bytes = (await stat(path)).size;
    if (receipt.id === "chmv2-height" && (receipt.validZero !== true || typeof receipt.nodata !== "string")) blockers.push("CHMv2 height receipt must declare valid-zero and nodata semantics");
    if (receipt.id === "chmv2-validity-mask" && receipt.role !== "canopy-mask") blockers.push("CHMv2 mask receipt has wrong role");
    receipts.push({ ...(receipt as Receipt), path, bytes });
  }
  for (const id of REQUIRED_RECEIPTS) if (!ids.has(id)) blockers.push(`missing required source receipt ${id}`);
  return { receipts, blockers };
}

export async function admit(): Promise<Admission> {
  const root = requireRoot(); const region = await loadRegion(); const raw = join(root, "raw"); const blockers: string[] = [];
  let pinnedBoundary: { path: string; sha256: string; boroughs: string[] };
  try { pinnedBoundary = await boundary(region, raw); } catch (error) { throw new Error(`boundary admission blocked: ${(error as Error).message}`); }
  const grid = await grids(region.datum.grids); blockers.push(...grid.blockers);
  const operation = await validateDatumOperation(grid.paths); if (operation.error) blockers.push(operation.error);
  const receiptFile = join(raw, "source-receipts.json");
  const checked = await validateReceipts(raw, (await exists(receiptFile)) ? await json<unknown>(receiptFile) : undefined); blockers.push(...checked.blockers);
  const allowed = new Set([join(raw, region.boundary.localName), receiptFile, ...checked.receipts.map((item) => item.path)]);
  for (const path of await files(raw)) if (!allowed.has(path)) blockers.push(`unrecorded production input ${path}`);
  const admission: Admission = { region: region.id, admittedAt: new Date().toISOString(), boundary: { ...pinnedBoundary, release: region.boundary.release }, support: region.support, datum: { ...region.datum, gridPaths: grid.paths, gridHashes: grid.hashes, ballparkAllowed: false, operationHash: sha256(Buffer.from(operation.output)) }, receipts: checked.receipts, blockers, rawBytes: await directoryBytes(raw) };
  await writeJson(join(root, "admission", `${region.id}.json`), admission); await writeJson(join(root, "evidence", "source-manifest.json"), admission);
  if (blockers.length) throw new Error(`regional manifest rejected:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  return admission;
}

/** AGL building and canopy heights never receive an absolute geoid shift. */
export function transformHeight(heightMetres: number, egm08MinusEgm96: number, isAgl: boolean): number { return isAgl ? heightMetres : heightMetres + egm08MinusEgm96; }

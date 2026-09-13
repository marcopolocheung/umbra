import { mkdir, readFile, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { NGA_GRID_SHA256 } from "./datum";
import { loadRegion, type RawAsset, type Receipt, type Region } from "./admission";
import { S3Store, type ObjectStore } from "./storage";
import { directoryBytes, fileHash, requireRoot, sha256, writeJson } from "./util";

const DEFAULT_MAX_SCRATCH_BYTES = 180 * 1024 * 1024 * 1024;
interface Item { key: string; destination: string; sha256?: string; }
export interface StageResult { staged: number; reused: number; stagedBytes: number; maxScratchBytes: number; sourceReceiptSha256: string; }
export interface StageOptions { root?: string; region?: Region; gridHashes?: Record<string, string>; maxScratchBytes?: number; }

function safeRelative(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe staged path ${value}`);
  return value;
}
function inside(root: string, path: string): string {
  if (relative(root, path).startsWith("..")) throw new Error(`staged path escapes root: ${path}`);
  return path;
}
function maximumScratchBytes(): number {
  const supplied = process.env.SHADE_PREP_SCRATCH_MAX_BYTES; const value = supplied === undefined ? DEFAULT_MAX_SCRATCH_BYTES : Number(supplied);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("SHADE_PREP_SCRATCH_MAX_BYTES must be a positive integer");
  return value;
}
async function localMatches(path: string, expected?: string): Promise<boolean> {
  try { return !!expected && (await fileHash(path)) === expected; } catch { return false; }
}
async function stageOne(store: ObjectStore, item: Item): Promise<"staged" | "reused"> {
  if (await localMatches(item.destination, item.sha256)) return "reused";
  const head = await store.head(item.key); if (!head) throw new Error(`required staged object is missing: ${item.key}`);
  if (item.sha256 && head.sha256 && head.sha256 !== item.sha256) throw new Error(`S3 metadata hash mismatch for ${item.key}`);
  await mkdir(dirname(item.destination), { recursive: true });
  const temporary = `${item.destination}.${process.pid}.stage`;
  try {
    await store.copyToFile(item.key, temporary);
    const actual = await fileHash(temporary); if (item.sha256 ? actual !== item.sha256 : !!head.sha256 && actual !== head.sha256) throw new Error(`download hash mismatch for ${item.key}`);
    await rename(temporary, item.destination);
  } finally { await rm(temporary, { force: true }); }
  return "staged";
}
async function preflight(store: ObjectStore, items: Item[], root: string, maximum: number): Promise<number> {
  let incoming = 0;
  for (const item of items) {
    if (await localMatches(item.destination, item.sha256)) continue;
    const head = await store.head(item.key); if (!head) throw new Error(`required staged object is missing: ${item.key}`);
    if (item.sha256 && head.sha256 && head.sha256 !== item.sha256) throw new Error(`S3 metadata hash mismatch for ${item.key}`);
    incoming += head.bytes;
  }
  await mkdir(root, { recursive: true }); const used = await directoryBytes(root); const required = used + incoming;
  if (required > maximum) throw new Error(`raw staging needs ${required} bytes, exceeding SHADE_PREP_SCRATCH_MAX_BYTES=${maximum}`);
  const volume = await statfs(root); const free = Number(volume.bavail) * Number(volume.bsize); if (free < Math.ceil(incoming * 1.25)) throw new Error(`raw staging needs ${Math.ceil(incoming * 1.25)} bytes free, found ${free}`);
  return incoming;
}

/** Materializes the immutable Item-5 input set into a bounded job scratch area.
 * The manifest is fetched first; all large objects stream to temporary files,
 * verify their recorded SHA-256, then rename into the exact local layout used by
 * admission. Nothing here writes to S3. */
export async function stageAdmittedInputs(store: ObjectStore = new S3Store(process.env.SHADE_PREP_RAW_BUCKET ?? "", process.env.SHADE_PREP_RAW_PREFIX ?? ""), options: StageOptions = {}): Promise<StageResult> {
  const root = options.root ?? requireRoot(); const raw = join(root, "raw"); const region = options.region ?? await loadRegion(); const maximum = options.maxScratchBytes ?? maximumScratchBytes(); const gridHashes = options.gridHashes ?? NGA_GRID_SHA256;
  const receiptItem = { key: "raw/source-receipts.json", destination: inside(root, join(raw, "source-receipts.json")) };
  await preflight(store, [receiptItem], root, maximum); await stageOne(store, receiptItem);
  let receipts: Receipt[];
  try { receipts = JSON.parse(await readFile(receiptItem.destination, "utf8")) as Receipt[]; } catch { throw new Error("staged source-receipts.json is invalid JSON"); }
  if (!Array.isArray(receipts)) throw new Error("staged source-receipts.json is not an array");
  const grids = region.datum.grids.map((name) => { const hash = gridHashes[name]; if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new Error(`no pinned hash configured for PROJ grid ${name}`); return { key: `proj/${name}`, destination: inside(root, join(root, "proj", name)), sha256: hash }; });
  const items: Item[] = [
    { key: `raw/${safeRelative(region.boundary.localName)}`, destination: inside(root, join(raw, region.boundary.localName)), sha256: region.boundary.sha256 },
    { key: "acquisition/nyc-five-borough-20km-support.geojson", destination: inside(root, join(root, "acquisition", "nyc-five-borough-20km-support.geojson")) },
    { key: "acquisition/nyc-acquisition-manifest.json", destination: inside(root, join(root, "acquisition", "nyc-acquisition-manifest.json")) },
    ...grids,
  ];
  for (const receipt of receipts) {
    for (const asset of receipt.assets ?? []) {
      const value = asset as RawAsset; const filename = safeRelative(String(value.filename ?? "")); const hash = String(value.sha256 ?? "");
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`staged receipt has no valid raw hash for ${filename}`);
      items.push({ key: `raw/${filename}`, destination: inside(root, join(raw, filename)), sha256: hash });
    }
    const controls = receipt.datumControlEvidence;
    if (controls) for (const [name, hash] of [[controls.outputFilename, controls.outputSha256], [controls.reportFilename, controls.reportSha256]] as const) {
      const filename = safeRelative(name); if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`staged receipt has no valid evidence hash for ${filename}`);
      items.push({ key: `evidence/${filename}`, destination: inside(root, join(root, "evidence", filename)), sha256: hash });
    }
  }
  const deduplicated = new Map<string, Item>(); for (const item of items) { const previous = deduplicated.get(item.destination); if (previous && (previous.key !== item.key || previous.sha256 !== item.sha256)) throw new Error(`staged input collision at ${item.destination}`); deduplicated.set(item.destination, item); }
  const unique = [...deduplicated.values()]; const incoming = await preflight(store, unique, root, maximum); let staged = 0, reused = 0;
  for (const item of unique) (await stageOne(store, item)) === "staged" ? staged++ : reused++;
  process.env.PROJ_DATA = `${join(root, "proj")}:/usr/share/proj`;
  const result = { staged, reused, stagedBytes: incoming, maxScratchBytes: maximum, sourceReceiptSha256: sha256(await readFile(receiptItem.destination)) };
  await writeJson(join(root, "evidence", "s3-stage-inputs.json"), result); return result;
}

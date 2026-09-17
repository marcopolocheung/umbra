/// <reference lib="webworker" />
import { composeTile, type ComposedTile } from "../shadowField/v2/compose";
import { decodeBrowserTileBundle } from "../shadowField/v2/bundle";
import { MAX_DECODED_BYTES, COMPONENT_FLAGS, STORED_SIZE } from "../shadowField/v2/types";
import { parseCoverageIndex, parseGenerationRoot, type CoverageIndex, type GenerationRoot } from "../shadowField/v2/artifacts";
import { parseShadowCurrent, type ShadowCurrentV2 } from "../shadowField/remoteCatalog";
import type { DebugWorkerCommand, DebugWorkerEvent } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;
const OUTPUT_BYTES = STORED_SIZE * STORED_SIZE * 24;
const PEAK_TILE_BYTES = MAX_DECODED_BYTES * 3 + OUTPUT_BYTES;
const MAX_CONCURRENT = 2;

type Page = { tile: string; data: ComposedTile; bytes: number; lastUsed: number };
let baseUrl = "";
let budget = 96 * 1024 * 1024;
let generation: string | undefined;
let root: GenerationRoot | undefined;
let coverage: CoverageIndex | undefined;
const interests = new Map<string, Set<string>>();
const pages = new Map<string, Page>();
const queued = new Set<string>();
const loading = new Set<string>();
let compressedBytes = 0;
let transientBytes = 0;
let serial = 0;
let incompleteCount = 0;
let errorCount = 0;
let evictedCount = 0;

function post(event: DebugWorkerEvent, transfer?: Transferable[]) { self.postMessage(event, transfer ?? []); }
function requested(): Set<string> { return new Set([...interests.values()].flatMap((tiles) => [...tiles])); }
function workerBytes() { return transientBytes + [...pages.values()].reduce((sum, page) => sum + page.bytes, 0); }
function accounting(requestId: number) {
  post({ type: "accounting", requestId, generation, accounting: {
    compressedBytes, workerBytes: workerBytes(), requested: requested().size, inFlight: loading.size,
    ready: pages.size, incomplete: incompleteCount, error: errorCount, evicted: evictedCount,
  }});
}
function isLeased(tile: string) { return requested().has(tile); }
function evictUntil(required: number, requestId: number): boolean {
  while (workerBytes() + required > budget) {
    const victim = [...pages.values()].filter((page) => !isLeased(page.tile)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return false;
    pages.delete(victim.tile);
    evictedCount++;
    post({ type: "tileEvicted", requestId, generation: generation!, tile: victim.tile });
  }
  return true;
}
function cacheName() { return `nyc-shadow-${generation}`; }
async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function fetchBytes(path: string, cache: RequestCache, expected?: { bytes: number; sha256: string }) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, { headers: { Accept: path.endsWith(".json") ? "application/json" : "application/octet-stream" }, cache });
  if (!response.ok) throw new Error(`shadow request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected && (bytes.byteLength !== expected.bytes || await sha256Hex(bytes) !== expected.sha256)) throw new Error("shadow artifact binding mismatch");
  return bytes;
}
async function loadGeneration(requestId: number) {
  try {
    const currentBytes = await fetchBytes("/_shadow/current.json", "no-cache");
    const current = parseShadowCurrent(JSON.parse(new TextDecoder().decode(currentBytes)));
    if (current.version !== 2) throw new Error("shadow debug requires a v2 generation");
    const v2 = current as ShadowCurrentV2;
    const rootBytes = await fetchBytes(v2.generationPath, "force-cache");
    if (await sha256Hex(rootBytes) !== v2.generationSha256) throw new Error("NYC shadow generation hash mismatch");
    const nextRoot = parseGenerationRoot(JSON.parse(new TextDecoder().decode(rootBytes)));
    if (nextRoot.generation !== v2.generation || nextRoot.tilePathTemplate !== v2.tilePathTemplate || nextRoot.tileCount !== v2.tileCount) throw new Error("NYC shadow pointer/root mismatch");
    const coverageBytes = await fetchBytes(nextRoot.artifacts.coverage.path, "force-cache", nextRoot.artifacts.coverage);
    const nextCoverage = parseCoverageIndex(JSON.parse(new TextDecoder().decode(coverageBytes)), { generation: nextRoot.generation, bytesLength: coverageBytes.byteLength });
    if (nextCoverage.availableTileCount !== nextRoot.availableTileCount || nextCoverage.activationTileCount !== nextRoot.activationTileCount) throw new Error("NYC shadow coverage/root count mismatch");
    generation = nextRoot.generation; root = nextRoot; coverage = nextCoverage;
    pages.clear(); interests.clear(); queued.clear(); loading.clear(); compressedBytes = 0; transientBytes = 0;
    incompleteCount = 0; errorCount = 0; evictedCount = 0;
    post({ type: "generationReady", requestId, generation, root, coverage }); accounting(requestId);
  } catch (error) {
    errorCount++;
    post({ type: "tileError", requestId, generation: generation ?? "unconfigured", tile: "generation", error: errorMessage(error) });
  }
}
async function cachedBundle(tile: string): Promise<{ bytes: Uint8Array; source: "cache" | "network" }> {
  const path = root!.tilePathTemplate.replace("{z}", "18").replace("{x}", tile.split("/")[1]).replace("{y}", tile.split("/")[2]);
  const url = `${baseUrl}${path}`;
  const cache = typeof caches === "undefined" ? undefined : await caches.open(cacheName());
  const hit = cache && await cache.match(url);
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), source: "cache" };
  const response = await fetch(url, { headers: { Accept: "application/octet-stream" }, cache: "force-cache" });
  if (!response.ok) throw new Error(`tile request failed (${response.status})`);
  if (cache) await cache.put(url, response.clone());
  return { bytes: new Uint8Array(await response.arrayBuffer()), source: "network" };
}
function stagingPixels(tile: ComposedTile): { pixels: Uint8Array; complete: boolean } {
  const pixels = new Uint8Array(256 * 256 * 4);
  let complete = tile.evidence?.complete ?? true;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const stored = (y + 1) * STORED_SIZE + x + 1;
    const at = (y * 256 + x) * 4;
    const flags = tile.flagsAndMaterial[stored];
    const unknown = (flags & (COMPONENT_FLAGS.buildingUnknown | COMPONENT_FLAGS.canopyUnknown)) !== 0;
    const edge = x === 0 || y === 0 || x === 255 || y === 255;
    if (unknown) { pixels.set([255, 208, 0, 210], at); complete = false; }
    else if (flags & COMPONENT_FLAGS.buildingPresent) pixels.set([255, 0, 185, 185], at);
    else if (flags & COMPONENT_FLAGS.canopyPresent) pixels.set([0, 255, 100, 175], at);
    else pixels.set([0, 0, 0, 0], at);
    if (edge) pixels.set([0, 240, 255, 255], at);
  }
  return { pixels, complete };
}
async function loadTile(tile: string, requestId: number, pinnedGeneration: string) {
  if (!root || generation !== pinnedGeneration || pages.has(tile)) return;
  loading.add(tile); post({ type: "tileLoading", requestId, generation, tile }); accounting(requestId);
  if (!evictUntil(PEAK_TILE_BYTES, requestId)) {
    loading.delete(tile); incompleteCount++; post({ type: "tileIncomplete", requestId, generation, tile, error: "96 MiB worker budget refusal" }); accounting(requestId); return;
  }
  transientBytes += PEAK_TILE_BYTES;
  let source: "cache" | "network" = "network";
  try {
    const bundle = await cachedBundle(tile); source = bundle.source; compressedBytes += bundle.bytes.byteLength;
    if (generation !== pinnedGeneration || !isLeased(tile)) return;
    const components = await decodeBrowserTileBundle(bundle.bytes, { rootIdentity: root.identity });
    if (components.some((component) => component.identity.generation !== generation || component.identity.tile !== tile)) throw new Error("bundle generation/tile mismatch");
    const composed = composeTile(components, { reserve: (bytes) => workerBytes() + bytes <= budget });
    // Decoded component planes and decompression scratch die here; pages retain only the composed field.
    pages.set(tile, { tile, data: composed, bytes: composed.accounting?.outputBytes ?? OUTPUT_BYTES, lastUsed: ++serial });
    const staged = stagingPixels(composed);
    post({ type: "tileReady", requestId, generation, tile, pixels: staged.pixels, complete: staged.complete, cacheSource: source }, [staged.pixels.buffer]);
    if (!staged.complete) { incompleteCount++; post({ type: "tileIncomplete", requestId, generation, tile, cacheSource: source }); }
  } catch (error) {
    errorCount++;
    post({ type: "tileError", requestId, generation: pinnedGeneration, tile, error: errorMessage(error), cacheSource: source });
  } finally {
    transientBytes -= PEAK_TILE_BYTES; loading.delete(tile); accounting(requestId); drain(requestId, pinnedGeneration);
  }
}
function drain(requestId: number, pinnedGeneration = generation) {
  if (!generation || !root || generation !== pinnedGeneration) return;
  for (const tile of requested()) {
    if (loading.size >= MAX_CONCURRENT) break;
    if (pages.has(tile) || loading.has(tile) || queued.has(tile)) continue;
    queued.add(tile);
    queueMicrotask(() => { queued.delete(tile); void loadTile(tile, requestId, pinnedGeneration!); });
  }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

self.onmessage = (event: MessageEvent<DebugWorkerCommand>) => {
  const command = event.data;
  if (command.type === "configureGeneration") { baseUrl = command.baseUrl.replace(/\/$/, ""); budget = command.budget; void loadGeneration(command.requestId); return; }
  if (command.type === "shutdown") { interests.clear(); pages.clear(); queued.clear(); loading.clear(); return; }
  if (!generation || command.generation !== generation) return; // stale command from a superseded root
  if (command.type === "setBudget") { budget = command.budget; if (!evictUntil(0, command.requestId)) { incompleteCount++; post({ type: "tileIncomplete", requestId: command.requestId, generation, tile: "budget", error: "worker budget below leased pages" }); } accounting(command.requestId); return; }
  if (command.type === "releaseInterest") interests.delete(command.interestId);
  if (command.type === "setInterests") {
    // Coverage is the acquisition authority. Even a malformed/stale caller
    // cannot turn an activation footprint or an arbitrary URL into a request.
    interests.set(command.interestId, new Set(command.tiles.filter((tile) => {
      const match = /^18\/(\d+)\/(\d+)$/.exec(tile);
      if (!match || !coverage) return false;
      return coverage.available.rows.some((row) => row.y === Number(match[2]) && row.runs.some(([start, end]) => Number(match[1]) >= start && Number(match[1]) <= end));
    })));
  }
  accounting(command.requestId); drain(command.requestId, generation);
};

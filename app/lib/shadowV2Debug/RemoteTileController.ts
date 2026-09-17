import { composeTile, type ComposedTile } from "../shadowField/v2/compose";
import { decodeBrowserTileBundle } from "../shadowField/v2/bundle";
import { MAX_DECODED_BYTES, COMPONENT_FLAGS, STORED_SIZE } from "../shadowField/v2/types";
import { coverageSetHas, parseCoverageIndex, parseGenerationRoot, type CoverageIndex, type GenerationRoot } from "../shadowField/v2/artifacts";
import { parseShadowCurrent, type ShadowCurrentV2 } from "../shadowField/remoteCatalog";
import type { DebugAccounting, DebugWorkerCommand, DebugWorkerEvent } from "./protocol";

const OUTPUT_BYTES = STORED_SIZE * STORED_SIZE * 24;
/** The reservation includes three decoded source planes, scratch, and one composed page. */
export const PEAK_TILE_BYTES = MAX_DECODED_BYTES * 3 + OUTPUT_BYTES;
export const MAX_CONCURRENT_TILE_LOADS = 2;

type FetchResponse = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; clone(): FetchResponse };
type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;
type CacheLike = { match(input: string): Promise<FetchResponse | undefined>; put(input: string, response: FetchResponse): Promise<void> };
type CacheStorageLike = { open(name: string): Promise<CacheLike> };
type Page = { tile: string; data: ComposedTile; bytes: number; lastUsed: number };

export interface RemoteTileControllerOptions {
  fetch?: FetchLike;
  caches?: CacheStorageLike;
  schedule?: (task: () => void) => void;
  now?: () => number;
  sha256?: (bytes: Uint8Array) => Promise<string>;
  emit: (event: DebugWorkerEvent, transfer?: Transferable[]) => void;
}

/**
 * Browser-independent v2 debug transport core. The dedicated Worker is merely
 * an adapter for this controller, which keeps all acquisition policy testable.
 */
export class RemoteTileController {
  private readonly fetch: FetchLike;
  private readonly cacheStorage?: CacheStorageLike;
  private readonly schedule: (task: () => void) => void;
  private readonly now: () => number;
  private readonly emit: RemoteTileControllerOptions["emit"];
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  private baseUrl = "";
  private budget = 96 * 1024 * 1024;
  private generation?: string;
  private root?: GenerationRoot;
  private coverage?: CoverageIndex;
  private interests = new Map<string, Set<string>>();
  private pages = new Map<string, Page>();
  private loading = new Set<string>();
  private scheduled = new Set<string>();
  private activeReservations = new Map<string, number>();
  private activeCompressed = new Map<string, number>();
  private cacheEntries = new Map<string, number>();
  /** A terminal failure is retried only after a fresh interest revision. */
  private terminal = new Map<string, number>();
  private interestRevision = 0;
  private serial = 0;
  private generationRevision = 0;
  private incompleteCount = 0;
  private errorCount = 0;
  private evictedCount = 0;

  constructor(options: RemoteTileControllerOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init) as Promise<FetchResponse>);
    this.cacheStorage = options.caches ?? (typeof caches === "undefined" ? undefined : caches as unknown as CacheStorageLike);
    this.schedule = options.schedule ?? queueMicrotask;
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.digest = options.sha256 ?? sha256Hex;
  }

  handle(command: DebugWorkerCommand) {
    if (command.type === "configureGeneration") {
      this.baseUrl = command.baseUrl.replace(/\/$/, "");
      this.budget = command.budget;
      void this.loadGeneration(command.requestId, ++this.generationRevision);
      return;
    }
    if (command.type === "shutdown") { this.reset(undefined, command.requestId); return; }
    if (!this.generation || command.generation !== this.generation) return;
    if (command.type === "setBudget") {
      this.budget = command.budget;
      if (!this.evictUntil(0, command.requestId)) this.incomplete(command.requestId, "budget", "worker budget below leased pages");
      this.accounting(command.requestId);
      return;
    }
    if (command.type === "releaseInterest") this.replaceInterest(command.interestId, new Set(), command.requestId);
    if (command.type === "setInterests") {
      const allowed = new Set(command.tiles.filter((tile) => this.available(tile)));
      this.replaceInterest(command.interestId, allowed, command.requestId);
    }
    this.accounting(command.requestId);
    this.drain(command.requestId, this.generationRevision);
  }

  private async loadGeneration(requestId: number, revision: number) {
    try {
      // Do not let data from an old root remain visible while a new pointer wins.
      this.reset(undefined, requestId);
      const currentBytes = await this.fetchBytes("/_shadow/current.json", "no-cache");
      if (revision !== this.generationRevision) return;
      const current = parseShadowCurrent(JSON.parse(new TextDecoder().decode(currentBytes)));
      if (current.version !== 2) throw new Error("shadow debug requires a v2 generation");
      const v2 = current as ShadowCurrentV2;
      const rootBytes = await this.fetchBytes(v2.generationPath, "force-cache");
      if (await this.digest(rootBytes) !== v2.generationSha256) throw new Error("NYC shadow generation hash mismatch");
      const root = parseGenerationRoot(JSON.parse(new TextDecoder().decode(rootBytes)));
      if (root.generation !== v2.generation || root.tilePathTemplate !== v2.tilePathTemplate || root.tileCount !== v2.tileCount)
        throw new Error("NYC shadow pointer/root mismatch");
      const coverageBytes = await this.fetchBytes(root.artifacts.coverage.path, "force-cache", root.artifacts.coverage);
      const coverage = parseCoverageIndex(JSON.parse(new TextDecoder().decode(coverageBytes)), { generation: root.generation, bytesLength: coverageBytes.byteLength });
      if (coverage.availableTileCount !== root.availableTileCount || coverage.activationTileCount !== root.activationTileCount)
        throw new Error("NYC shadow coverage/root count mismatch");
      if (revision !== this.generationRevision) return;
      this.generation = root.generation;
      this.root = root;
      this.coverage = coverage;
      this.emit({ type: "generationReady", requestId, generation: root.generation, root, coverage });
      this.accounting(requestId);
    } catch (error) {
      if (revision !== this.generationRevision) return;
      this.errorCount++;
      this.emit({ type: "tileError", requestId, generation: "unconfigured", tile: "generation", error: errorMessage(error) });
      this.accounting(requestId);
    }
  }

  private reset(nextGeneration: string | undefined, requestId: number) {
    for (const tile of this.pages.keys()) this.emit({ type: "tileReleased", requestId, generation: this.generation ?? nextGeneration ?? "unconfigured", tile });
    this.generation = nextGeneration;
    this.root = undefined; this.coverage = undefined;
    this.interests.clear(); this.pages.clear(); this.loading.clear(); this.scheduled.clear();
    this.activeReservations.clear(); this.activeCompressed.clear(); this.cacheEntries.clear(); this.terminal.clear();
    this.incompleteCount = 0; this.errorCount = 0; this.evictedCount = 0;
  }

  private available(tile: string): boolean {
    try {
      const match = /^18\/(\d+)\/(\d+)$/.exec(tile);
      return !!match && !!this.coverage && coverageSetHas(this.coverage.available, Number(match[1]), Number(match[2]));
    } catch { return false; }
  }
  private leasedTiles(): Set<string> { return new Set([...this.interests.values()].flatMap((items) => [...items])); }
  private leased(tile: string) { return this.leasedTiles().has(tile); }
  private workerBytes() { return [...this.pages.values()].reduce((n, page) => n + page.bytes, 0) + [...this.activeReservations.values()].reduce((n, bytes) => n + bytes, 0); }
  private cacheBytes() { return [...this.cacheEntries.values()].reduce((n, bytes) => n + bytes, 0); }
  private compressedBytes() { return [...this.activeCompressed.values()].reduce((n, bytes) => n + bytes, 0); }

  private accounting(requestId: number) {
    const accounting: Omit<DebugAccounting, "stagingBytes" | "gpuBytes"> = {
      cacheBytes: this.cacheBytes(), compressedBytes: this.compressedBytes(), workerBytes: this.workerBytes(),
      requested: this.leasedTiles().size, inFlight: this.loading.size + this.scheduled.size,
      ready: this.pages.size, incomplete: this.incompleteCount, error: this.errorCount, evicted: this.evictedCount,
    };
    this.emit({ type: "accounting", requestId, generation: this.generation, accounting });
  }

  private replaceInterest(id: string, tiles: Set<string>, requestId: number) {
    this.interestRevision++;
    const prior = this.interests.get(id) ?? new Set<string>();
    this.interests.set(id, tiles);
    for (const tile of prior) {
      if (!tiles.has(tile) && !this.leased(tile)) this.releaseTile(tile, requestId);
    }
  }
  private releaseTile(tile: string, requestId: number) {
    // A page may remain resident for LRU reuse, but it has no staging/GPU lease.
    this.emit({ type: "tileReleased", requestId, generation: this.generation!, tile });
  }

  private evictUntil(required: number, requestId: number): boolean {
    while (this.workerBytes() + required > this.budget) {
      const victim = [...this.pages.values()].filter((page) => !this.leased(page.tile)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) return false;
      this.pages.delete(victim.tile); this.evictedCount++;
      this.emit({ type: "tileEvicted", requestId, generation: this.generation!, tile: victim.tile });
    }
    return true;
  }
  private incomplete(requestId: number, tile: string, error: string) {
    this.incompleteCount++;
    this.emit({ type: "tileIncomplete", requestId, generation: this.generation!, tile, error });
  }

  private drain(requestId: number, revision: number) {
    if (!this.generation || !this.root) return;
    for (const tile of this.leasedTiles()) {
      if (this.loading.size + this.scheduled.size >= MAX_CONCURRENT_TILE_LOADS) break;
      if (this.pages.has(tile) || this.loading.has(tile) || this.scheduled.has(tile) || this.terminal.get(tile) === this.interestRevision) continue;
      this.scheduled.add(tile);
      // Count queued work before scheduling it: two microtasks cannot open a
      // third fetch before either of the first two has marked itself loading.
      this.schedule(() => {
        this.scheduled.delete(tile);
        if (revision !== this.generationRevision || !this.leased(tile) || this.pages.has(tile) || this.loading.has(tile)) {
          this.accounting(requestId); return;
        }
        void this.loadTile(tile, requestId, revision);
      });
    }
    this.accounting(requestId);
  }

  private async loadTile(tile: string, requestId: number, revision: number) {
    if (!this.root || !this.generation || revision !== this.generationRevision || !this.leased(tile)) return;
    this.loading.add(tile);
    this.emit({ type: "tileLoading", requestId, generation: this.generation, tile });
    if (!this.evictUntil(PEAK_TILE_BYTES, requestId)) {
      this.loading.delete(tile); this.incomplete(requestId, tile, "96 MiB worker budget refusal"); this.terminal.set(tile, this.interestRevision); this.accounting(requestId); this.drain(requestId, revision); return;
    }
    this.activeReservations.set(tile, PEAK_TILE_BYTES);
    this.accounting(requestId);
    let source: "cache" | "network" = "network";
    try {
      const bundle = await this.cachedBundle(tile);
      source = bundle.source;
      this.activeCompressed.set(tile, bundle.bytes.byteLength);
      this.accounting(requestId);
      if (!this.currentLease(tile, revision)) return;
      const components = await decodeBrowserTileBundle(bundle.bytes, { rootIdentity: this.root.identity });
      if (components.some((component) => component.identity.generation !== this.generation || component.identity.tile !== tile))
        throw new Error("bundle generation/tile mismatch");
      if (!this.currentLease(tile, revision)) return;
      const composed = composeTile(components, { reserve: (bytes) => bytes <= OUTPUT_BYTES });
      if (!this.currentLease(tile, revision)) return;
      // The injected clock is deterministic in tests; the serial breaks ties
      // when several completions share the same clock tick.
      this.pages.set(tile, { tile, data: composed, bytes: composed.accounting?.outputBytes ?? OUTPUT_BYTES, lastUsed: this.now() + ++this.serial / 1_000_000 });
      const staged = stagingPixels(composed);
      this.emit({ type: "tileReady", requestId, generation: this.generation!, tile, pixels: staged.pixels, complete: staged.complete, cacheSource: source }, [staged.pixels.buffer]);
      if (!staged.complete) this.incomplete(requestId, tile, "unknown source support");
    } catch (error) {
      if (this.currentLease(tile, revision)) {
        this.errorCount++;
        this.emit({ type: "tileError", requestId, generation: this.generation!, tile, error: errorMessage(error), cacheSource: source });
        this.terminal.set(tile, this.interestRevision);
      }
    } finally {
      this.activeCompressed.delete(tile); this.activeReservations.delete(tile); this.loading.delete(tile);
      this.accounting(requestId); this.drain(requestId, revision);
    }
  }
  private currentLease(tile: string, revision: number) { return revision === this.generationRevision && !!this.generation && this.leased(tile); }

  private async cachedBundle(tile: string): Promise<{ bytes: Uint8Array; source: "cache" | "network" }> {
    const [z, x, y] = tile.split("/");
    const path = this.root!.tilePathTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const url = `${this.baseUrl}${path}`;
    const cache = this.cacheStorage && await this.cacheStorage.open(`nyc-shadow-${this.generation}`);
    const hit = cache && await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      this.cacheEntries.set(tile, bytes.byteLength);
      return { bytes, source: "cache" };
    }
    const response = await this.fetch(url, { headers: { Accept: "application/octet-stream" }, cache: "force-cache" });
    if (!response.ok) throw new Error(`tile request failed (${response.status})`);
    if (cache) await cache.put(url, response.clone());
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.cacheEntries.set(tile, bytes.byteLength);
    return { bytes, source: "network" };
  }
  private async fetchBytes(path: string, cache: RequestCache, expected?: { bytes: number; sha256: string }) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { headers: { Accept: path.endsWith(".json") ? "application/json" : "application/octet-stream" }, cache });
    if (!response.ok) throw new Error(`shadow request failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (expected && (bytes.byteLength !== expected.bytes || await this.digest(bytes) !== expected.sha256)) throw new Error("shadow artifact binding mismatch");
    return bytes;
  }
}

function stagingPixels(tile: ComposedTile): { pixels: Uint8Array; complete: boolean } {
  const pixels = new Uint8Array(256 * 256 * 4);
  let complete = tile.evidence?.complete ?? true;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const stored = (y + 1) * STORED_SIZE + x + 1; const at = (y * 256 + x) * 4;
    const flags = tile.flagsAndMaterial[stored]; const unknown = (flags & (COMPONENT_FLAGS.buildingUnknown | COMPONENT_FLAGS.canopyUnknown)) !== 0;
    const edge = x === 0 || y === 0 || x === 255 || y === 255;
    if (unknown) { pixels.set([255, 208, 0, 210], at); complete = false; }
    else if (flags & COMPONENT_FLAGS.buildingPresent) pixels.set([255, 0, 185, 185], at);
    else if (flags & COMPONENT_FLAGS.canopyPresent) pixels.set([0, 255, 100, 175], at);
    if (edge) pixels.set([0, 240, 255, 255], at);
  }
  return { pixels, complete };
}
async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

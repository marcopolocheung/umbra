import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { decodeBrowserTileBundle, encodeBrowserTileBundle } from "../../../app/lib/shadowField/v2/bundle";
import { encodeComponent } from "../../../app/lib/shadowField/v2/format";
import { STORED_SIZE, type Component, type ComponentKind, type ComponentPlane, type SupportState } from "../../../app/lib/shadowField/v2/types";
import type { CandidateDescriptor } from "./candidates";
import type { ObjectStore } from "./storage";
import { sha256 } from "./util";

export const BROWSER_PACK_VERSION = "nyc-candidate-browser-pack-v1";
export interface BrowserPackIdentity {
  /** Immutable identifier for this publish attempt, never a mutable alias. */
  generation: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
}
export interface PackedBrowserTile {
  tile: string;
  key: string;
  bytes: number;
  sha256: string;
  componentHashes: Record<ComponentKind, { transportHash: string; physicsHash: string }>;
}
export interface PackBenchmark {
  version: 1;
  normalizationId: string;
  generation: string;
  requestedTiles: number;
  packedTiles: number;
  rawBytesRead: number;
  packedBytes: number;
  elapsedMs: number;
  tilesPerMinute: number;
  sourceBytesPerTile: number;
  packedBytesPerTile: number;
  compressionRatio: number;
}
export interface PackReconciliation {
  version: 1;
  generation: string;
  expectedTiles: number;
  verifiedTiles: number;
  manifestKey: string;
  manifestSha256: string;
}
export interface CandidateTileIndex {
  version: 1;
  normalizationId: string;
  expectedTiles: number;
  tiles: string[];
  sha256: string;
}
export interface PackShardReceipt {
  version: 1;
  generation: string;
  identity: BrowserPackIdentity;
  shardIndex: number;
  shardCount: number;
  tiles: PackedBrowserTile[];
  sha256: string;
}

export const NYC_FIVE_BOROUGH_TILE_COUNT = 61_442;

const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));
const hash = (value: string) => sha256(new TextEncoder().encode(value));

export function browserPackIdentity(normalizationId: string, generationSuffix = ""): BrowserPackIdentity {
  if (!/^[a-f0-9]{32}$/.test(normalizationId)) throw new Error("normalization id must be a 32-character hex value");
  if (generationSuffix && !/^[a-z0-9-]{1,48}$/.test(generationSuffix)) throw new Error("generation suffix must be lowercase letters, digits, and hyphens");
  return {
    generation: `nyc-${normalizationId}${generationSuffix ? `-${generationSuffix}` : ""}`,
    recipeHash: hash(BROWSER_PACK_VERSION),
    // This is the exact transform policy that created the candidate planes.
    datumHash: hash("EGM2008-to-EGM96/us_nga_egm08_25.tif/us_nga_egm96_15.tif"),
    // A real HLOD hierarchy is a later, separately hashed package.  This
    // identity deliberately says that no such hierarchy was used here.
    hierarchyHash: hash("no-hlod-hierarchy/candidate-browser-pack-v1"),
  };
}

function supportState(value: CandidateDescriptor["support"][ComponentKind]): SupportState {
  if (value.unknown > 0) return "unknown";
  if (value.known === 0) return "known-empty";
  return "present";
}

function componentSourceHash(items: CandidateDescriptor["components"][ComponentKind]): string {
  return hash(items.map((item) => `${item.name}:${item.type}:${item.sha256}`).sort().join("\n"));
}

function asLittleEndianWords(bytes: Uint8Array, name: string): Uint32Array {
  const expectedBytes = STORED_SIZE * STORED_SIZE * 4;
  if (bytes.byteLength !== expectedBytes) throw new Error(`${name} has ${bytes.byteLength} bytes, expected ${expectedBytes}`);
  const words = new Uint32Array(STORED_SIZE * STORED_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < words.length; index++) words[index] = view.getUint32(index * 4, true);
  return words;
}

async function readPlanes(store: ObjectStore, items: CandidateDescriptor["components"][ComponentKind]): Promise<ComponentPlane[]> {
  const output: ComponentPlane[] = [];
  for (const item of items) {
    const bytes = await store.read(item.path);
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256)
      throw new Error(`candidate plane hash mismatch: ${item.path}`);
    output.push({ name: item.name as ComponentPlane["name"], type: item.type as ComponentPlane["type"], words: asLittleEndianWords(bytes, item.path) });
  }
  return output;
}

function component(
  kind: ComponentKind,
  descriptor: CandidateDescriptor,
  identity: BrowserPackIdentity,
  planes: ComponentPlane[],
): Component {
  const sourceHash = componentSourceHash(descriptor.components[kind]);
  const support = supportState(descriptor.support[kind]);
  return {
    kind,
    identity: { ...identity, tile: descriptor.tile, sourceHash, licenceHash: hash(`private-candidate-input/${kind}/${descriptor.normalizationId}`) },
    support,
    evidence: {
      packVersion: BROWSER_PACK_VERSION,
      normalizationId: descriptor.normalizationId,
      candidatePlaneHash: sourceHash,
    },
    tables: {
      licences: [{ id: "private-candidate-input", notice: "Private candidate input; not a public distribution artifact." }],
      provenance: [{ id: `candidate-${kind}`, source: `candidate/${descriptor.normalizationId}`, support }],
      evidence: [{ id: "candidate-planes", subject: `${kind} candidate plane hashes`, hash: sourceHash }],
    },
    planes: planes.map((plane) => ({ ...plane, provenanceTableIndex: 0, materialTableIndex: 0 })),
  };
}

/** Pack one descriptor only after every input plane has passed its descriptor hash. */
export async function packCandidateDescriptor(
  store: ObjectStore,
  descriptor: CandidateDescriptor,
  identity = browserPackIdentity(descriptor.normalizationId),
): Promise<{ bytes: Uint8Array; packed: PackedBrowserTile }> {
  if (descriptor.schemaVersion !== 1 || descriptor.gutter !== 1 || descriptor.byteOrder !== "little-endian-u32" || !identity.generation.startsWith(`nyc-${descriptor.normalizationId}`))
    throw new Error("unsupported candidate descriptor");
  const components = await Promise.all((["terrain", "buildings", "canopy"] as const).map(async (kind) => {
    const value = component(kind, descriptor, identity, await readPlanes(store, descriptor.components[kind]));
    return { component: value, encoded: await encodeComponent(value, gzip) };
  }));
  const bundle = encodeBrowserTileBundle(descriptor.tile, components);
  // Decode now: this protects the full-pack operation from publishing a merely
  // well-framed but unusable browser object.
  const decoded = await decodeBrowserTileBundle(bundle.bytes);
  if (decoded.length !== 3) throw new Error("browser bundle readback failed");
  const digest = sha256(bundle.bytes);
  return {
    bytes: bundle.bytes,
    packed: {
      tile: descriptor.tile,
      key: `generations/${identity.generation}/tiles/${descriptor.tile.replaceAll("/", "-")}.smb`,
      bytes: bundle.bytes.byteLength,
      sha256: digest,
      componentHashes: Object.fromEntries(components.map(({ component: value, encoded }) => [value.kind, { transportHash: encoded.transportHash, physicsHash: encoded.physicsHash }])) as PackedBrowserTile["componentHashes"],
    },
  };
}

/** Frozen, numeric z18 tile ordering used for immutable index and array work. */
export function compareTiles(left: string, right: string): number {
  const parse = (tile: string) => {
    const match = /^18\/(\d+)\/(\d+)$/.exec(tile);
    if (!match) throw new Error(`invalid z18 tile ${tile}`);
    return [Number(match[1]), Number(match[2])];
  };
  const [leftX, leftY] = parse(left); const [rightX, rightY] = parse(right);
  return leftX - rightX || leftY - rightY;
}

export function candidateTileIndex(normalizationId: string, tiles: string[], expectedTiles = NYC_FIVE_BOROUGH_TILE_COUNT): CandidateTileIndex {
  if (!/^[a-f0-9]{32}$/.test(normalizationId)) throw new Error("normalization id must be a 32-character hex value");
  const ordered = [...new Set(tiles)].sort(compareTiles);
  if (ordered.length !== tiles.length) throw new Error("candidate index contains duplicate tiles");
  if (ordered.length !== expectedTiles) throw new Error(`candidate index expected ${expectedTiles} tiles, found ${ordered.length}`);
  const body = { version: 1 as const, normalizationId, expectedTiles, tiles: ordered };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function contiguousShard<T>(values: readonly T[], shardIndex: number, shardCount: number): T[] {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > values.length) throw new Error("shard count must be between 1 and the tile count");
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) throw new Error("shard index is outside the array range");
  return values.slice(Math.floor(values.length * shardIndex / shardCount), Math.floor(values.length * (shardIndex + 1) / shardCount));
}

/** Deterministic, low-risk benchmark. It writes nothing unless an output store is supplied. */
export async function benchmarkCandidatePack(
  store: ObjectStore,
  descriptors: CandidateDescriptor[],
  output?: ObjectStore,
  concurrency = 1,
  onPacked?: (entry: PackedBrowserTile) => void,
  suppliedIdentity?: BrowserPackIdentity,
): Promise<PackBenchmark> {
  if (!descriptors.length) throw new Error("benchmark requires at least one descriptor");
  const identity = suppliedIdentity ?? browserPackIdentity(descriptors[0].normalizationId);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error("pack concurrency must be an integer from 1 through 32");
  const start = performance.now();
  const ordered = [...descriptors].sort((a, b) => a.tile.localeCompare(b.tile));
  const results: Array<{ bytes: Uint8Array; packed: PackedBrowserTile }> = new Array(ordered.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ordered.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= ordered.length) return;
      const result = await packCandidateDescriptor(store, ordered[index], identity);
      if (output) {
        const prior = await output.head(result.packed.key);
        if (!prior) await output.write(result.packed.key, result.bytes, "application/octet-stream");
        else if (prior.bytes !== result.bytes.byteLength || prior.sha256 !== result.packed.sha256)
          throw new Error(`immutable packed-object collision: ${result.packed.key}`);
      }
      onPacked?.(result.packed);
      results[index] = result;
    }
  }));
  const rawBytesRead = ordered.reduce((total, descriptor) => total + Object.values(descriptor.components).flat().reduce((bytes, item) => bytes + item.bytes, 0), 0);
  const packedBytes = results.reduce((total, result) => total + result.bytes.byteLength, 0);
  const elapsedMs = performance.now() - start;
  return {
    version: 1,
    normalizationId: descriptors[0].normalizationId,
    generation: identity.generation,
    requestedTiles: descriptors.length,
    packedTiles: descriptors.length,
    rawBytesRead,
    packedBytes,
    elapsedMs,
    tilesPerMinute: descriptors.length / Math.max(elapsedMs / 60_000, Number.EPSILON),
    sourceBytesPerTile: rawBytesRead / descriptors.length,
    packedBytesPerTile: packedBytes / descriptors.length,
    compressionRatio: packedBytes / rawBytesRead,
  };
}

/** Content-addressable manifest record for a later upload/promotion pass. */
export function browserPackManifest(entries: PackedBrowserTile[], identity: BrowserPackIdentity): { version: 1; generation: string; identity: BrowserPackIdentity; tiles: PackedBrowserTile[]; sha256: string } {
  const tiles = [...entries].sort((a, b) => a.tile.localeCompare(b.tile));
  const body = { version: 1 as const, generation: identity.generation, identity, tiles };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function browserPackShardReceipt(entries: PackedBrowserTile[], identity: BrowserPackIdentity, shardIndex: number, shardCount: number): PackShardReceipt {
  if (!entries.length) throw new Error("cannot write an empty shard receipt");
  const tiles = [...entries].sort((a, b) => compareTiles(a.tile, b.tile));
  const body = { version: 1 as const, generation: identity.generation, identity, shardIndex, shardCount, tiles };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

function receiptKey(identity: BrowserPackIdentity, shardIndex: number, shardCount: number): string {
  return `generations/${identity.generation}/shards/${String(shardIndex).padStart(3, "0")}-of-${String(shardCount).padStart(3, "0")}.json`;
}

async function writeImmutableJson(output: ObjectStore, key: string, value: unknown): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const digest = sha256(bytes);
  const prior = await output.head(key);
  if (!prior) await output.write(key, bytes, "application/json");
  else if (prior.bytes !== bytes.byteLength || prior.sha256 !== digest) throw new Error(`immutable packed-object collision: ${key}`);
  const readback = await output.read(key);
  if (sha256(readback) !== digest) throw new Error(`packed object readback mismatch: ${key}`);
  return { bytes, sha256: digest };
}

/** Each array child proves only its immutable, disjoint range. */
export async function reconcileBrowserPackShard(output: ObjectStore, entries: PackedBrowserTile[], identity: BrowserPackIdentity, shardIndex: number, shardCount: number): Promise<PackReconciliation> {
  await verifyPackedEntries(output, entries, identity, true);
  const receipt = browserPackShardReceipt(entries, identity, shardIndex, shardCount);
  const key = receiptKey(identity, shardIndex, shardCount);
  const written = await writeImmutableJson(output, key, receipt);
  return { version: 1, generation: identity.generation, expectedTiles: entries.length, verifiedTiles: entries.length, manifestKey: key, manifestSha256: written.sha256 };
}

async function verifyPackedEntries(output: ObjectStore, entries: PackedBrowserTile[], identity: BrowserPackIdentity, decode: boolean): Promise<void> {
  if (!entries.length) throw new Error("cannot reconcile an empty browser pack");
  for (const entry of [...entries].sort((a, b) => compareTiles(a.tile, b.tile))) {
    const metadata = await output.head(entry.key);
    if (!metadata || metadata.bytes !== entry.bytes || metadata.sha256 !== entry.sha256) throw new Error(`packed object metadata mismatch: ${entry.key}`);
    if (!decode) continue;
    const bytes = await output.read(entry.key);
    if (sha256(bytes) !== entry.sha256) throw new Error(`packed object readback mismatch: ${entry.key}`);
    const components = await decodeBrowserTileBundle(bytes);
    if (components.length !== 3 || components.some((component) => component.identity.generation !== identity.generation || component.identity.tile !== entry.tile)) throw new Error(`packed object decode mismatch: ${entry.key}`);
  }
}

/** Gate final manifest creation on all array receipts plus a fresh R2 metadata scan. */
export async function aggregateBrowserPack(output: ObjectStore, index: CandidateTileIndex, identity: BrowserPackIdentity, shardCount: number): Promise<PackReconciliation> {
  const entries: PackedBrowserTile[] = [];
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
    const key = receiptKey(identity, shardIndex, shardCount);
    const receipt = JSON.parse(new TextDecoder().decode(await output.read(key))) as PackShardReceipt;
    const body = { version: receipt.version, generation: receipt.generation, identity: receipt.identity, shardIndex: receipt.shardIndex, shardCount: receipt.shardCount, tiles: receipt.tiles };
    if (receipt.sha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex") || receipt.version !== 1 || receipt.generation !== identity.generation || JSON.stringify(receipt.identity) !== JSON.stringify(identity) || receipt.shardIndex !== shardIndex || receipt.shardCount !== shardCount)
      throw new Error(`invalid shard receipt: ${key}`);
    const expected = contiguousShard(index.tiles, shardIndex, shardCount);
    if (receipt.tiles.length !== expected.length || receipt.tiles.some((entry, i) => entry.tile !== expected[i])) throw new Error(`shard receipt tile range mismatch: ${key}`);
    entries.push(...receipt.tiles);
  }
  if (entries.length !== index.expectedTiles || entries.some((entry, i) => entry.tile !== index.tiles[i])) throw new Error("shard receipts do not cover the frozen candidate index exactly");
  await verifyPackedEntries(output, entries, identity, false);
  const manifest = browserPackManifest(entries, identity);
  const manifestKey = `generations/${identity.generation}/manifest.json`;
  const written = await writeImmutableJson(output, manifestKey, manifest);
  return { version: 1, generation: identity.generation, expectedTiles: index.expectedTiles, verifiedTiles: entries.length, manifestKey, manifestSha256: written.sha256 };
}

/**
 * Re-read every uploaded object before publishing the immutable manifest. This
 * is intentionally separate from `current.json`: only a complete NYC run may
 * later promote that pointer.
 */
export async function reconcileBrowserPack(
  output: ObjectStore,
  entries: PackedBrowserTile[],
  identity: BrowserPackIdentity,
): Promise<PackReconciliation> {
  if (!entries.length) throw new Error("cannot reconcile an empty browser pack");
  await verifyPackedEntries(output, entries, identity, true);
  const manifest = browserPackManifest(entries, identity);
  const manifestKey = `generations/${identity.generation}/manifest.json`;
  const written = await writeImmutableJson(output, manifestKey, manifest);
  return { version: 1, generation: identity.generation, expectedTiles: entries.length, verifiedTiles: entries.length, manifestKey, manifestSha256: written.sha256 };
}

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

const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));
const hash = (value: string) => sha256(new TextEncoder().encode(value));

export function browserPackIdentity(normalizationId: string): BrowserPackIdentity {
  if (!/^[a-f0-9]{32}$/.test(normalizationId)) throw new Error("normalization id must be a 32-character hex value");
  return {
    generation: `nyc-${normalizationId}`,
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
  if (descriptor.schemaVersion !== 1 || descriptor.gutter !== 1 || descriptor.byteOrder !== "little-endian-u32" || identity.generation !== `nyc-${descriptor.normalizationId}`)
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

/** Deterministic, low-risk benchmark. It writes nothing unless an output store is supplied. */
export async function benchmarkCandidatePack(
  store: ObjectStore,
  descriptors: CandidateDescriptor[],
  output?: ObjectStore,
  concurrency = 1,
): Promise<PackBenchmark> {
  if (!descriptors.length) throw new Error("benchmark requires at least one descriptor");
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
      const result = await packCandidateDescriptor(store, ordered[index]);
      if (output) {
        const prior = await output.head(result.packed.key);
        if (!prior) await output.write(result.packed.key, result.bytes, "application/octet-stream");
        else if (prior.bytes !== result.bytes.byteLength || prior.sha256 !== result.packed.sha256)
          throw new Error(`immutable packed-object collision: ${result.packed.key}`);
      }
      results[index] = result;
    }
  }));
  const rawBytesRead = ordered.reduce((total, descriptor) => total + Object.values(descriptor.components).flat().reduce((bytes, item) => bytes + item.bytes, 0), 0);
  const packedBytes = results.reduce((total, result) => total + result.bytes.byteLength, 0);
  const elapsedMs = performance.now() - start;
  return {
    version: 1,
    normalizationId: descriptors[0].normalizationId,
    generation: browserPackIdentity(descriptors[0].normalizationId).generation,
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

import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { decodeBrowserTileBundle, encodeBrowserTileBundle } from "../../../app/lib/shadowField/v2/bundle";
import { COMPOSITOR_VERSION, composeTile } from "../../../app/lib/shadowField/v2/compose";
import { encodeComponent } from "../../../app/lib/shadowField/v2/format";
import { TreeModelV2 } from "../../../app/lib/shadowField/v2/treeModel";
import { RECEIVER_MODEL_VERSION } from "../../../app/lib/shadowField/v2/receivers";
import {
  assertExactSupportState,
  assertStrictSupportValues,
  countSupportCells,
  deriveComponentState,
  maskHasOccupiedCell,
} from "../../../app/lib/shadowField/v2/support";
import {
  assembleTileBounds,
  assertArtifactBudget,
  artifactBytes,
  buildCoverageIndex,
  buildGenerationRoot,
  buildNotices,
  licenceRecordsFor,
  MAX_BOUNDS_BYTES,
  MAX_COVERAGE_BYTES,
  MAX_NOTICES_BYTES,
  parseZ18Tile,
  reduceComposedTile,
  reduceConservativeBounds,
  ROOF_BELOW_TERRAIN_ANOMALY,
  sortTilesYX,
  tileIntersectsCoverage,
  type ArtifactRef,
  type CoverageGeometry,
  type GenerationRoot,
  type LeafBoundsArrays,
  type ReducedBounds,
  type RegionLicenceInput,
} from "../../../app/lib/shadowField/v2/artifacts";
import { STORED_SIZE, type Component, type ComponentKind, type ComponentPlane, type SupportState } from "../../../app/lib/shadowField/v2/types";
import type { CandidateDescriptor } from "./candidates";
import { boundSourceHash, REPAIR_POLICY_VERSION, repairBuildingSupport, repairPolicyHash } from "./repair";
import { licenceHashFor } from "./notices";
import type { ObjectStore } from "./storage";
import { sha256 } from "./util";
import { NORMALIZER_VERSION } from "./versions";

export const BROWSER_PACK_VERSION = "nyc-candidate-browser-pack-v1";
/** PR2 recipe: repaired building support, mask-aware states, bound identities. */
export const BROWSER_PACK_VERSION_V2 = "nyc-candidate-browser-pack-v2";
/** The hierarchy identity names the reduction policy; artifact bytes bind via the generation root. */
export const HIERARCHY_POLICY_V2 = "tile-bounds-pyramid-v1";
export interface BrowserPackIdentity {
  /** Immutable identifier for this publish attempt, never a mutable alias. */
  generation: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  /** Present only for the v2 recipe; selects strict support/model validation. */
  model?: PackModelIdentity;
}
/** Model identities pinned through every v2 component. */
export interface PackModelIdentity {
  normalizerHash: string;
  compositorHash: string;
  treeModelHash: string;
  receiverHash: string;
}
export function packModelIdentity(): PackModelIdentity {
  return {
    normalizerHash: hash(NORMALIZER_VERSION),
    compositorHash: hash(COMPOSITOR_VERSION),
    treeModelHash: hash(TreeModelV2.version),
    receiverHash: hash(RECEIVER_MODEL_VERSION),
  };
}
export interface PackedBrowserTile {
  tile: string;
  key: string;
  bytes: number;
  sha256: string;
  componentHashes: Record<ComponentKind, { transportHash: string; physicsHash: string }>;
  /** Reduced bounds of the repaired, composed tile; present for the v2 recipe. */
  bounds?: ReducedBounds;
  /** Conservative-fallback marker (e.g. roof-below-terrain); absent when compose succeeds. */
  boundsAnomaly?: string;
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
  /** Present once the generation root and compact artifacts are published. */
  generationKey?: string;
  generationSha256?: string;
  coverageKey?: string;
  boundsKey?: string;
  noticesKey?: string;
  /** Tiles whose bounds used the conservative fallback; PR4's buried-roof input. */
  anomalies?: Array<{ tile: string; reason: string }>;
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
  /** v2 repair provenance, unanimous across a generation's shards. */
  repair?: { policy: typeof REPAIR_POLICY_VERSION; policyHash: string; supportGeometryHash: string; regionFileSha256: string };
  /** Per-tile reduced bounds aligned with `tiles`; required for the v2 recipe. */
  bounds?: LeafBoundsArrays;
  /** Tiles whose bounds used the conservative fallback instead of composition. */
  anomalies?: Array<{ tile: string; reason: string }>;
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

/** v2 generation identity: same normalization, new recipe, bound model hashes. */
export function browserPackIdentityV2(normalizationId: string, generationSuffix = ""): BrowserPackIdentity {
  const base = browserPackIdentity(normalizationId, generationSuffix);
  return {
    generation: base.generation,
    recipeHash: hash(BROWSER_PACK_VERSION_V2),
    datumHash: base.datumHash,
    hierarchyHash: hash(HIERARCHY_POLICY_V2),
    model: packModelIdentity(),
  };
}

/** Evidence input for the pack-time repair (hash-pinned, never raw sources). */
export interface RepairContext {
  geometry: CoverageGeometry;
  geometryHash: string;
  descriptorHash: string;
  regionInput: RegionLicenceInput;
}

function supportPlane(planes: ComponentPlane[], name: "buildingSupport" | "canopySupport"): Uint32Array {
  const found = planes.find((item) => item.name === name)?.words;
  if (!found) throw new Error(`repaired component lacks ${name}`);
  return found;
}

function maskPlane(planes: ComponentPlane[], name: "buildingMask" | "canopyMask"): Uint32Array | undefined {
  return planes.find((item) => item.name === name)?.words;
}

/** v2 component: repaired support, mask-aware state, bound source/licence identity. */
function componentV2(
  kind: ComponentKind,
  descriptor: CandidateDescriptor,
  identity: BrowserPackIdentity,
  planes: ComponentPlane[],
  repair: RepairContext,
): Component {
  if (!identity.model) throw new Error("v2 packing requires the bound model identity");
  const originalSourceHash = componentSourceHash(descriptor.components[kind]);
  const licenceHash = licenceHashFor(kind, repair.regionInput, hash);
  const licences = licenceRecordsFor(kind, repair.regionInput).map((entry) => ({
    id: entry.id,
    notice: entry.notice,
    ...(entry.url ? { url: entry.url } : {}),
  }));
  const evidence: Record<string, string> = {
    packVersion: BROWSER_PACK_VERSION_V2,
    normalizationId: descriptor.normalizationId,
    candidatePlaneHash: originalSourceHash,
  };
  const evidenceTable: Array<{ id: string; subject: string; hash: string }> = [
    { id: "candidate-planes", subject: `${kind} candidate plane hashes`, hash: originalSourceHash },
  ];
  let support: SupportState;
  let sourceHash = originalSourceHash;
  if (kind === "terrain") {
    support = "present";
  } else {
    const supportName = kind === "buildings" ? "buildingSupport" : "canopySupport";
    const maskName = kind === "buildings" ? "buildingMask" : "canopyMask";
    let supportWords = supportPlane(planes, supportName);
    if (kind === "buildings") {
      const { support: corrected, receipt } = repairBuildingSupport({
        tile: descriptor.tile,
        mask: maskPlane(planes, maskName) ?? new Uint32Array(STORED_SIZE * STORED_SIZE),
        originalSupport: supportWords,
        geometry: repair.geometry,
        geometryHash: repair.geometryHash,
        originalDescriptorHash: repair.descriptorHash,
      });
      planes = planes.map((plane) => (plane.name === supportName ? { ...plane, words: corrected } : plane));
      supportWords = corrected;
      sourceHash = boundSourceHash(originalSourceHash, receipt);
      evidence.repairPolicy = REPAIR_POLICY_VERSION;
      evidence.repairPolicyHash = receipt.policyHash;
      evidence.supportGeometryHash = receipt.supportGeometryHash;
      evidence.originalDescriptorHash = receipt.originalDescriptorHash;
      evidence.originalSupportPlaneHash = receipt.originalSupportPlaneHash;
      evidence.correctedSupportPlaneHash = receipt.correctedSupportPlaneHash;
      evidenceTable.push(
        { id: "repair-policy", subject: "building support repair policy", hash: receipt.policyHash },
        { id: "repair-support-geometry", subject: "frozen support geometry", hash: receipt.supportGeometryHash },
        { id: "repair-support-plane", subject: "corrected building support plane", hash: receipt.correctedSupportPlaneHash },
      );
    }
    assertStrictSupportValues(kind, supportName, supportWords);
    const counts = countSupportCells(supportWords);
    const maskWords = maskPlane(planes, maskName);
    if (maskWords === undefined) throw new Error(`repaired component lacks ${maskName}`);
    const occupied = maskHasOccupiedCell(maskWords);
    support = deriveComponentState(counts, occupied);
    assertExactSupportState(kind, support, counts, occupied);
  }
  return {
    kind,
    // The v2 model block rides as sibling identity fields; the pack envelope
    // `model` is transport-only and never serialized into a component.
    identity: {
      generation: identity.generation,
      tile: descriptor.tile,
      sourceHash,
      recipeHash: identity.recipeHash,
      datumHash: identity.datumHash,
      hierarchyHash: identity.hierarchyHash,
      licenceHash,
      ...identity.model,
    },
    support,
    evidence,
    tables: {
      licences,
      provenance: [{ id: `candidate-${kind}`, source: `candidate/${descriptor.normalizationId}`, support }],
      evidence: evidenceTable,
    },
    planes: planes.map((plane) => ({ ...plane, provenanceTableIndex: 0, materialTableIndex: 0 })),
  };
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

export interface PackDescriptorOptions {
  /** v2 recipe: repair building support and bind model/licence identities. */
  recipe?: 1 | 2;
  /** Required for the v2 recipe; builds the per-descriptor repair context. */
  repairFor?: (descriptor: CandidateDescriptor) => RepairContext;
}

/** Pack one descriptor only after every input plane has passed its descriptor hash. */
export async function packCandidateDescriptor(
  store: ObjectStore,
  descriptor: CandidateDescriptor,
  identity = browserPackIdentity(descriptor.normalizationId),
  options: PackDescriptorOptions = {},
): Promise<{ bytes: Uint8Array; packed: PackedBrowserTile }> {
  if (descriptor.schemaVersion !== 1 || descriptor.gutter !== 1 || descriptor.byteOrder !== "little-endian-u32" || !identity.generation.startsWith(`nyc-${descriptor.normalizationId}`))
    throw new Error("unsupported candidate descriptor");
  const recipe = options.recipe ?? 1;
  if (recipe === 2 && !identity.model) throw new Error("v2 packing requires browserPackIdentityV2");
  const repair = recipe === 2 ? options.repairFor?.(descriptor) : undefined;
  if (recipe === 2 && !repair) throw new Error("v2 packing requires a repair context");
  const components = await Promise.all((["terrain", "buildings", "canopy"] as const).map(async (kind) => {
    const value = recipe === 2
      ? componentV2(kind, descriptor, identity, await readPlanes(store, descriptor.components[kind]), repair!)
      : component(kind, descriptor, identity, await readPlanes(store, descriptor.components[kind]));
    return { component: value, encoded: await encodeComponent(value, gzip) };
  }));
  const bundle = encodeBrowserTileBundle(descriptor.tile, components);
  // Decode now: this protects the full-pack operation from publishing a merely
  // well-framed but unusable browser object. The decoder enforces physics,
  // shared identity, and (for v2) support strictness on the readback.
  const decoded = await decodeBrowserTileBundle(bundle.bytes);
  if (decoded.length !== 3) throw new Error("browser bundle readback failed");
  // Bounds derive from the repaired, composed tile — never from
  // pre-composition planes — so they cannot drift from composition semantics.
  // v1 packs skip this entirely: the readback decode above is their only gate.
  // Tiles the shared composer rejects (observed: whole-feature foundations on
  // steep real terrain) fall back to the conservative plane reduction, and the
  // anomaly travels with the packed entry into shard reports for PR4.
  let boundsEntry: Pick<PackedBrowserTile, "bounds" | "boundsAnomaly"> = {};
  if (recipe === 2) {
    try {
      boundsEntry = { bounds: reduceComposedTile(composeTile(decoded, { reserve: () => true })) };
    } catch (error) {
      if (!(error instanceof Error) || !/roof below terrain/.test(error.message)) throw error;
      const byKind = new Map(decoded.map((component) => [component.kind, component]));
      boundsEntry = {
        bounds: reduceConservativeBounds(byKind.get("terrain"), byKind.get("buildings"), byKind.get("canopy")),
        boundsAnomaly: ROOF_BELOW_TERRAIN_ANOMALY,
      };
    }
  }
  const digest = sha256(bundle.bytes);
  return {
    bytes: bundle.bytes,
    packed: {
      tile: descriptor.tile,
      key: `generations/${identity.generation}/tiles/${descriptor.tile.replaceAll("/", "-")}.smb`,
      bytes: bundle.bytes.byteLength,
      sha256: digest,
      componentHashes: Object.fromEntries(components.map(({ component: value, encoded }) => [value.kind, { transportHash: encoded.transportHash, physicsHash: encoded.physicsHash }])) as PackedBrowserTile["componentHashes"],
      ...boundsEntry,
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
  options: PackDescriptorOptions = {},
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
      const result = await packCandidateDescriptor(store, ordered[index], identity, options);
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

export function browserPackShardReceipt(
  entries: PackedBrowserTile[],
  identity: BrowserPackIdentity,
  shardIndex: number,
  shardCount: number,
  repair?: { policy: typeof REPAIR_POLICY_VERSION; policyHash: string; supportGeometryHash: string; regionFileSha256: string },
): PackShardReceipt {
  if (!entries.length) throw new Error("cannot write an empty shard receipt");
  const tiles = [...entries].sort((a, b) => compareTiles(a.tile, b.tile));
  const body: Omit<PackShardReceipt, "sha256"> = { version: 1, generation: identity.generation, identity, shardIndex, shardCount, tiles };
  if (identity.model) {
    if (!repair) throw new Error("v2 shard receipts require repair provenance");
    if (entries.some((entry) => !entry.bounds)) throw new Error("v2 shard receipts require per-tile bounds");
    const bounds: LeafBoundsArrays = { minG: [], maxG: [], maxTopQ: [], maxCrownQ: [], coverage: [] };
    const anomalies: Array<{ tile: string; reason: string }> = [];
    for (const entry of tiles) {
      bounds.minG.push(entry.bounds!.minG);
      bounds.maxG.push(entry.bounds!.maxG);
      bounds.maxTopQ.push(entry.bounds!.maxTopQ);
      bounds.maxCrownQ.push(entry.bounds!.maxCrownQ);
      bounds.coverage.push(entry.bounds!.coverage);
      if (entry.boundsAnomaly) anomalies.push({ tile: entry.tile, reason: entry.boundsAnomaly });
    }
    body.repair = repair;
    body.bounds = bounds;
    if (anomalies.length) body.anomalies = anomalies;
  }
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
export async function reconcileBrowserPackShard(
  output: ObjectStore,
  entries: PackedBrowserTile[],
  identity: BrowserPackIdentity,
  shardIndex: number,
  shardCount: number,
  repair?: { policy: typeof REPAIR_POLICY_VERSION; policyHash: string; supportGeometryHash: string; regionFileSha256: string },
): Promise<PackReconciliation> {
  await verifyPackedEntries(output, entries, identity, true);
  const receipt = browserPackShardReceipt(entries, identity, shardIndex, shardCount, repair);
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
    // The readback decode enforces physics, shared identity, the full model
    // block, and strict v2 support; binding the generation root here as well
    // proves recipe/datum/hierarchy/model against the pack identity.
    const rootIdentity = identity.model
      ? {
          recipeHash: identity.recipeHash,
          datumHash: identity.datumHash,
          hierarchyHash: identity.hierarchyHash,
          ...identity.model,
        }
      : undefined;
    const components = await decodeBrowserTileBundle(
      bytes,
      rootIdentity ? { rootIdentity } : undefined,
    );
    if (components.length !== 3 || components.some((component) => component.identity.generation !== identity.generation || component.identity.tile !== entry.tile)) throw new Error(`packed object decode mismatch: ${entry.key}`);
    if (identity.model) {
      for (const component of components) {
        if (
          component.identity.recipeHash !== identity.recipeHash ||
          component.identity.datumHash !== identity.datumHash ||
          component.identity.hierarchyHash !== identity.hierarchyHash ||
          component.identity.normalizerHash !== identity.model.normalizerHash ||
          component.identity.compositorHash !== identity.model.compositorHash ||
          component.identity.treeModelHash !== identity.model.treeModelHash ||
          component.identity.receiverHash !== identity.model.receiverHash
        )
          throw new Error(`packed object model identity mismatch: ${entry.key}`);
      }
    }
  }
}

export interface GenerationArtifactInputs {
  /** Borough-boundary geometry for the activation clip, with its pinned file record. */
  borough: CoverageGeometry;
  boroughFile: { filename: string; sha256: string };
  regionInput: RegionLicenceInput;
  activationRule?: string;
  /** Published in bounds.json so clients defer these tiles until PR4 policy. */
  anomalies?: Array<{ tile: string; reason: string }>;
}

export interface ManifestArtifactBinding {
  coverageSha256: string;
  boundsSha256: string;
  noticesSha256: string;
}

/** Content-addressable manifest record binding the packed tiles (v2 also binds the compact artifacts). */
export function browserPackManifestV2(
  entries: PackedBrowserTile[],
  identity: BrowserPackIdentity,
  artifacts: ManifestArtifactBinding,
): { version: 2; generation: string; identity: BrowserPackIdentity; tiles: PackedBrowserTile[]; artifacts: ManifestArtifactBinding; sha256: string } {
  if (!identity.model) throw new Error("v2 manifests require the bound model identity");
  // Numeric tile order, matching receipts and the candidate index.
  const tiles = [...entries].sort((a, b) => compareTiles(a.tile, b.tile));
  const body = { version: 2 as const, generation: identity.generation, identity, tiles, artifacts };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

function servedPath(generation: string, filename: string): string {
  return `/_shadow/generations/${generation}/${filename}`;
}

function r2Key(generation: string, filename: string): string {
  return `generations/${generation}/${filename}`;
}

/**
 * Write one immutable artifact and prove the stored bytes are exactly the
 * canonical bytes the hashes bind (guards the JSON roundtrip, uniformly).
 */
async function writeVerifiedArtifact(
  output: ObjectStore,
  generation: string,
  filename: string,
  canonicalBytes: Uint8Array,
): Promise<ArtifactRef> {
  const written = await writeImmutableJson(output, r2Key(generation, filename), JSON.parse(new TextDecoder().decode(canonicalBytes)));
  if (written.sha256 !== sha256(canonicalBytes) || written.bytes.byteLength !== canonicalBytes.byteLength)
    throw new Error(`${filename} artifact hash mismatch`);
  return { path: servedPath(generation, filename), sha256: written.sha256, bytes: written.bytes.byteLength };
}

/** Assemble and publish the compact artifacts plus the generation root. All inputs verified first. */
export async function publishGenerationArtifacts(
  output: ObjectStore,
  index: CandidateTileIndex,
  identity: BrowserPackIdentity,
  entries: PackedBrowserTile[],
  inputs: GenerationArtifactInputs,
): Promise<{
  coverage: ArtifactRef;
  bounds: ArtifactRef;
  notices: ArtifactRef;
  manifest: ArtifactRef;
  generation: ArtifactRef;
  root: GenerationRoot;
}> {
  if (!identity.model) throw new Error("generation artifacts require the v2 identity");
  if (entries.length !== index.expectedTiles) throw new Error("artifact assembly needs the complete tile set");
  const byTile = new Map(entries.map((entry) => [entry.tile, entry]));

  // Coverage: availability is the exact packed set; activation clips to the boroughs.
  const activationTiles = index.tiles.filter((tile) => {
    const { x, y } = parseZ18Tile(tile);
    return tileIntersectsCoverage(inputs.borough, x, y);
  });
  const coverage = buildCoverageIndex({
    generation: identity.generation,
    availableTiles: index.tiles,
    activationTiles,
    activationRule: inputs.activationRule ?? "logical-tile-area-intersects-borough-boundary",
    activationBoundary: inputs.boroughFile,
  });
  const coverageBytes = artifactBytes(coverage);
  assertArtifactBudget("coverage.json", coverageBytes.byteLength, MAX_COVERAGE_BYTES);
  const coverageRef = await writeVerifiedArtifact(output, identity.generation, "coverage.json", coverageBytes);

  // Bounds: leaf entries align with coverage-available tiles in (y, x) order.
  const leafByTile = new Map<string, ReducedBounds>();
  for (const tile of sortTilesYX(index.tiles)) {
    const bounds = byTile.get(tile)?.bounds;
    if (!bounds) throw new Error(`bounds assembly lacks tile ${tile}`);
    leafByTile.set(tile, bounds);
  }
  const boundsArtifact = assembleTileBounds(identity.generation, leafByTile, inputs.anomalies ?? []);
  const boundsBytes = artifactBytes(boundsArtifact);
  assertArtifactBudget("bounds.json", boundsBytes.byteLength, MAX_BOUNDS_BYTES);
  const boundsRef = await writeVerifiedArtifact(output, identity.generation, "bounds.json", boundsBytes);

  // Notices: the same canonical bindings the packer hashed into licenceHash values.
  const licenceHashes = {
    terrain: licenceHashFor("terrain", inputs.regionInput, hash),
    buildings: licenceHashFor("buildings", inputs.regionInput, hash),
    canopy: licenceHashFor("canopy", inputs.regionInput, hash),
  };
  const notices = buildNotices({ generation: identity.generation, input: inputs.regionInput, licenceHashes });
  const noticesBytes = artifactBytes(notices);
  assertArtifactBudget("notices.json", noticesBytes.byteLength, MAX_NOTICES_BYTES);
  const noticesRef = await writeVerifiedArtifact(output, identity.generation, "notices.json", noticesBytes);

  // The manifest binds tiles and compact artifacts; the root binds everything.
  // Refs already carry the verified canonical bytes from writeVerifiedArtifact.
  const manifest = browserPackManifestV2(entries, identity, {
    coverageSha256: coverageRef.sha256,
    boundsSha256: boundsRef.sha256,
    noticesSha256: noticesRef.sha256,
  });
  const manifestBytes = artifactBytes(manifest);
  const manifestRef = await writeVerifiedArtifact(output, identity.generation, "manifest.json", manifestBytes);

  const root = buildGenerationRoot({
    generation: identity.generation,
    identity: {
      recipeHash: identity.recipeHash,
      datumHash: identity.datumHash,
      hierarchyHash: identity.hierarchyHash,
      ...identity.model,
    },
    manifest: manifestRef,
    coverage: coverageRef,
    bounds: boundsRef,
    notices: noticesRef,
    tileCount: index.expectedTiles,
    availableTileCount: coverage.availableTileCount,
    activationTileCount: coverage.activationTileCount,
  });
  const rootBytes = artifactBytes(root);
  const generationRef = await writeVerifiedArtifact(output, identity.generation, "generation.json", rootBytes);
  return {
    coverage: coverageRef,
    bounds: boundsRef,
    notices: noticesRef,
    manifest: manifestRef,
    generation: generationRef,
    root,
  };
}

/** Gate final manifest creation on all array receipts plus a fresh R2 metadata scan. */
export async function aggregateBrowserPack(
  output: ObjectStore,
  index: CandidateTileIndex,
  identity: BrowserPackIdentity,
  shardCount: number,
  generationInputs?: GenerationArtifactInputs,
): Promise<PackReconciliation> {
  const entries: PackedBrowserTile[] = [];
  let repair: PackShardReceipt["repair"];
  const shardBounds = new Map<string, ReducedBounds>();
  const aggregateAnomalies: Array<{ tile: string; reason: string }> = [];
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
    const key = receiptKey(identity, shardIndex, shardCount);
    const receipt = JSON.parse(new TextDecoder().decode(await output.read(key))) as PackShardReceipt;
    const body: Omit<PackShardReceipt, "sha256"> = { version: receipt.version, generation: receipt.generation, identity: receipt.identity, shardIndex: receipt.shardIndex, shardCount: receipt.shardCount, tiles: receipt.tiles };
    if (receipt.repair !== undefined || receipt.bounds !== undefined || receipt.anomalies !== undefined || identity.model) {
      if (!receipt.repair || !receipt.bounds) throw new Error(`v2 shard receipt lacks repair/bounds: ${key}`);
      body.repair = receipt.repair;
      body.bounds = receipt.bounds;
      if (receipt.anomalies !== undefined) body.anomalies = receipt.anomalies;
    }
    if (receipt.sha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex") || receipt.version !== 1 || receipt.generation !== identity.generation || JSON.stringify(receipt.identity) !== JSON.stringify(identity) || receipt.shardIndex !== shardIndex || receipt.shardCount !== shardCount)
      throw new Error(`invalid shard receipt: ${key}`);
    if (identity.model) {
      const provenance = {
        policy: receipt.repair!.policy,
        policyHash: receipt.repair!.policyHash,
        supportGeometryHash: receipt.repair!.supportGeometryHash,
        regionFileSha256: receipt.repair!.regionFileSha256,
      };
      if (!repair) repair = provenance;
      else if (JSON.stringify(repair) !== JSON.stringify(provenance)) throw new Error(`shard repair provenance diverges: ${key}`);
      for (const [name, array] of Object.entries(receipt.bounds!) as Array<[string, unknown[]]>) {
        if (array.length !== receipt.tiles.length) throw new Error(`shard bounds ${name} misaligned: ${key}`);
      }
      receipt.tiles.forEach((entry, position) => {
        const bounds = {
          minG: receipt.bounds!.minG[position],
          maxG: receipt.bounds!.maxG[position],
          maxTopQ: receipt.bounds!.maxTopQ[position],
          maxCrownQ: receipt.bounds!.maxCrownQ[position],
          coverage: receipt.bounds!.coverage[position],
        };
        // The parallel arrays must agree with the per-tile bounds the shard
        // packed; either side corrupting silently would poison the pyramid.
        if (JSON.stringify(bounds) !== JSON.stringify(entry.bounds)) throw new Error(`shard bounds disagree with packed entry: ${entry.tile}`);
        shardBounds.set(entry.tile, bounds);
      });
      for (const anomaly of receipt.anomalies ?? []) {
        if (anomaly.reason !== ROOF_BELOW_TERRAIN_ANOMALY || !receipt.tiles.some((entry) => entry.tile === anomaly.tile))
          throw new Error(`invalid shard anomaly: ${anomaly.tile}`);
        aggregateAnomalies.push(anomaly);
      }
    }
    const expected = contiguousShard(index.tiles, shardIndex, shardCount);
    if (receipt.tiles.length !== expected.length || receipt.tiles.some((entry, i) => entry.tile !== expected[i])) throw new Error(`shard receipt tile range mismatch: ${key}`);
    entries.push(...receipt.tiles);
  }
  if (entries.length !== index.expectedTiles || entries.some((entry, i) => entry.tile !== index.tiles[i])) throw new Error("shard receipts do not cover the frozen candidate index exactly");
  await verifyPackedEntries(output, entries, identity, false);
    if (identity.model) {
      if (!generationInputs) throw new Error("v2 aggregation requires borough and region inputs");
      // Shard-time and aggregate-time licence inputs must be the same pinned
      // region file, or tiles and notices.json silently diverge.
      if (!repair || repair.regionFileSha256 !== generationInputs.regionInput.regionFileSha256)
        throw new Error("shard licence provenance diverges from aggregate region input");
      const anomalies = [...aggregateAnomalies].sort((a, b) => (a.tile < b.tile ? -1 : a.tile > b.tile ? 1 : 0));
      for (const entry of entries) {
        const bounds = shardBounds.get(entry.tile);
        if (!bounds) throw new Error(`aggregation lacks bounds for ${entry.tile}`);
        entry.bounds = bounds;
      }
      const published = await publishGenerationArtifacts(output, index, identity, entries, { ...generationInputs, anomalies });
      return {
        version: 1,
        generation: identity.generation,
        expectedTiles: index.expectedTiles,
        verifiedTiles: entries.length,
        manifestKey: r2Key(identity.generation, "manifest.json"),
        manifestSha256: published.manifest.sha256,
        generationKey: r2Key(identity.generation, "generation.json"),
        generationSha256: published.generation.sha256,
        coverageKey: r2Key(identity.generation, "coverage.json"),
        boundsKey: r2Key(identity.generation, "bounds.json"),
        noticesKey: r2Key(identity.generation, "notices.json"),
        ...(anomalies.length ? { anomalies } : {}),
      };
    }
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

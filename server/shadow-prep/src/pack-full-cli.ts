import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateDescriptorKey, type CandidateDescriptor } from "./candidates";
import {
  NYC_FIVE_BOROUGH_TILE_COUNT,
  aggregateBrowserPack,
  benchmarkCandidatePack,
  browserPackIdentityV2,
  componentLicenceHashes,
  candidateTileIndex,
  contiguousShard,
  reconcileBrowserPackShard,
  type CandidateTileIndex,
  type ComponentLicenceHashes,
  type PackedBrowserTile,
  type RepairContext,
} from "./pack";
import { verifyCandidateTileGeometry, REPAIR_POLICY_VERSION, repairPolicyHash } from "./repair";
import { loadAdmittedLicenceInput, loadRegionDocument } from "./notices";
import { parseS3ObjectSpec, r2StoreFromEnvironment, S3Store, isConditionalWriteConflict, type ObjectStore } from "./storage";
import { supportGeometry } from "./support";
import { sha256 } from "./util";
import type { CoverageGeometry } from "../../../app/lib/shadowField/v2/artifacts";
import { decodeBrowserTileBundle } from "../../../app/lib/shadowField/v2/bundle";
import { composeTile } from "../../../app/lib/shadowField/v2/compose";
import { parseGenerationNotices, parseGenerationRoot } from "../../../app/lib/shadowField/v2/artifacts";

const NORMALIZATION_ID = "70e3507f16d472adf5475b614a60cb16";
const GENERATION_SUFFIX = "five-borough-v2";
// The candidate index is recipe-independent: v2 reuses the frozen v1 index
// bucket path rather than rebuilding it.
const INDEX_KEY = `browser-pack/nyc-${NORMALIZATION_ID}-five-borough-v1/candidate-index.json`;

function optional(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} needs a value`);
  return result;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseIndex(value: Uint8Array): CandidateTileIndex {
  const index = JSON.parse(new TextDecoder().decode(value)) as CandidateTileIndex;
  const rebuilt = candidateTileIndex(index.normalizationId, index.tiles, index.expectedTiles);
  if (index.version !== 1 || index.normalizationId !== NORMALIZATION_ID || index.expectedTiles !== NYC_FIVE_BOROUGH_TILE_COUNT || index.sha256 !== rebuilt.sha256)
    throw new Error("candidate index failed identity or hash validation");
  return index;
}

function report(value: unknown): Promise<void> {
  const path = optional("--report");
  const text = `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(text);
  return path ? writeFile(resolve(path), text) : Promise.resolve();
}

async function sourceAndIndexStore(): Promise<{ source: S3Store; indexStore: S3Store }> {
  return {
    source: new S3Store(requiredEnvironment("SHADE_PREP_S3_BUCKET")),
    indexStore: new S3Store(requiredEnvironment("SHADE_PREP_EVIDENCE_BUCKET")),
  };
}

/**
 * Evidence-file loader for hash-pinned geometry inputs. Values are either a
 * local path (dev/smoke) or `s3:<bucket>:<key>` (Batch, resolved against the
 * evidence bucket layout). Bytes are always hash-verified before parsing.
 */
export async function loadEvidenceBytes(spec: string, expectedHash: string): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("evidence hash must be a sha256 hex digest");
  let bytes: Uint8Array;
  if (spec.startsWith("s3:")) {
    const { bucket, key } = parseS3ObjectSpec(spec);
    const scratch = await mkdtemp(join(tmpdir(), "shadow-prep-evidence-"));
    const store = new S3Store(bucket);
    const destination = join(scratch, "evidence");
    await store.copyToFile(key, destination);
    bytes = new Uint8Array(await readFile(destination));
  } else {
    bytes = new Uint8Array(await readFile(resolve(spec)));
  }
  if (sha256(bytes) !== expectedHash) throw new Error(`evidence hash mismatch for ${spec}`);
  return bytes;
}

async function loadSupportGeometry(): Promise<{ geometry: CoverageGeometry; geometryHash: string }> {
  const spec = optional("--support-geometry");
  const hash = optional("--support-sha256");
  if (!spec || !hash) throw new Error("v2 packing requires --support-geometry and --support-sha256");
  const bytes = await loadEvidenceBytes(spec, hash);
  return { geometry: supportGeometry(JSON.parse(new TextDecoder().decode(bytes))), geometryHash: hash };
}

async function loadCandidateTileGeometry(): Promise<{ geometry: CoverageGeometry; geometryHash: string }> {
  const spec = optional("--candidate-tile-geometry");
  const hash = optional("--candidate-tile-sha256");
  if (!spec || !hash) throw new Error("v2 packing requires --candidate-tile-geometry and --candidate-tile-sha256");
  const bytes = await loadEvidenceBytes(spec, hash);
  return { geometry: supportGeometry(JSON.parse(new TextDecoder().decode(bytes))), geometryHash: hash };
}

async function loadBoroughBoundary(): Promise<{ geometry: CoverageGeometry; file: { filename: string; sha256: string } }> {
  const spec = optional("--borough-boundary");
  if (!spec) throw new Error("v2 aggregation requires --borough-boundary");
  const regionPath = optional("--region-file");
  const region = await loadRegionDocument(regionPath);
  const bytes = await loadEvidenceBytes(spec, region.boundarySha256);
  return {
    geometry: supportGeometry(JSON.parse(new TextDecoder().decode(bytes))),
    file: { filename: region.boundaryLocalName, sha256: region.boundarySha256 },
  };
}

/** v2 publication binds notices to a completed admission, never merely to the
 * static region plan.  Operators must pass the evidence artifact they staged
 * with the candidate inputs. */
async function loadV2LicenceInput() {
  const admission = optional("--admission-manifest");
  if (!admission) throw new Error("v2 packing requires --admission-manifest (the admitted source-receipts/acquisition manifest)");
  return loadAdmittedLicenceInput(admission, optional("--region-file"));
}

async function buildIndex(): Promise<void> {
  const { source, indexStore } = await sourceAndIndexStore();
  const prefix = `normalized/${NORMALIZATION_ID}/tiles/`;
  const descriptorPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}18-(\\d+)-(\\d+)/descriptor\\.json$`);
  // S3 lists descriptor-last candidate records; filtering before parsing means
  // the one-time scan does not download 279 GB of raw planes.
  const keys = await source.listKeys(prefix);
  const tiles = keys.flatMap((key) => {
    const match = descriptorPattern.exec(key);
    return match ? [`18/${match[1]}/${match[2]}`] : [];
  });
  const index = candidateTileIndex(NORMALIZATION_ID, tiles);
  const body = new TextEncoder().encode(`${JSON.stringify(index)}\n`);
  const prior = await indexStore.head(INDEX_KEY);
  if (!prior) await indexStore.write(INDEX_KEY, body, "application/json");
  else if (prior.bytes !== body.byteLength || prior.sha256 !== sha256(body))
    throw new Error(`immutable candidate-index collision: ${INDEX_KEY}`);
  const readback = await indexStore.read(INDEX_KEY);
  if (new TextDecoder().decode(readback) !== new TextDecoder().decode(body)) throw new Error("candidate-index readback mismatch");
  await report({ action: "build-index", indexKey: INDEX_KEY, expectedTiles: index.expectedTiles, indexSha256: index.sha256, listedObjects: keys.length });
}

async function loadIndex(indexStore: S3Store): Promise<CandidateTileIndex> {
  return parseIndex(await indexStore.read(INDEX_KEY));
}

async function packShard(): Promise<void> {
  const count = Number(optional("--array-shards"));
  const shardIndex = Number(optional("--shard-index") ?? process.env.AWS_BATCH_JOB_ARRAY_INDEX);
  if (!Number.isInteger(count) || !Number.isInteger(shardIndex)) throw new Error("--array-shards and --shard-index (or AWS_BATCH_JOB_ARRAY_INDEX) must be integers");
  const { source, indexStore } = await sourceAndIndexStore();
  const index = await loadIndex(indexStore);
  const { geometry, geometryHash } = await loadSupportGeometry();
  const candidateTiles = await loadCandidateTileGeometry();
  // Candidate selection and source support are distinct evidence. The
  // unbuffered output target must reproduce the frozen index exactly; the
  // wider admitted support geometry below determines whether each cell is
  // known by the source.
  verifyCandidateTileGeometry(candidateTiles.geometry, index.tiles);
  const regionInput = await loadV2LicenceInput();
  const tiles = contiguousShard(index.tiles, shardIndex, count);
  const descriptors: CandidateDescriptor[] = [];
  const descriptorHashes = new Map<string, string>();
  for (const tile of tiles) {
    const key = candidateDescriptorKey(NORMALIZATION_ID, tile);
    const bytes = await source.read(key);
    descriptorHashes.set(tile, sha256(bytes));
    const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as CandidateDescriptor;
    if (descriptor.normalizationId !== NORMALIZATION_ID || descriptor.tile !== tile) throw new Error(`candidate descriptor identity mismatch: ${tile}`);
    descriptors.push(descriptor);
  }
  const identity = browserPackIdentityV2(NORMALIZATION_ID, GENERATION_SUFFIX);
  const repairFor = (descriptor: CandidateDescriptor): RepairContext => {
    const descriptorHash = descriptorHashes.get(descriptor.tile);
    if (!descriptorHash) throw new Error(`missing descriptor hash for ${descriptor.tile}`);
    return { geometry, geometryHash, descriptorHash, regionInput };
  };
  const r2 = r2StoreFromEnvironment();
  const entries: PackedBrowserTile[] = [];
  const benchmark = await benchmarkCandidatePack(source, descriptors, r2, 1, (entry) => entries.push(entry), identity, { recipe: 2, repairFor });
  const reconciliation = await reconcileBrowserPackShard(r2, entries, identity, shardIndex, count, {
    policy: REPAIR_POLICY_VERSION,
    policyHash: repairPolicyHash(),
    supportGeometryHash: geometryHash,
    candidateTileGeometryHash: candidateTiles.geometryHash,
    regionFileSha256: regionInput.regionFileSha256,
    receiptManifestSha256: regionInput.receiptManifestSha256!,
    licenceHashes: componentLicenceHashes(regionInput),
  });
  await report({ action: "pack-shard", shardIndex, shardCount: count, indexKey: INDEX_KEY, ...benchmark, generation: identity.generation, reconciliation });
}

async function aggregate(): Promise<void> {
  const count = Number(optional("--array-shards"));
  if (!Number.isInteger(count) || count < 1) throw new Error("--array-shards must be a positive integer");
  const { indexStore } = await sourceAndIndexStore();
  const index = await loadIndex(indexStore);
  const support = await loadSupportGeometry();
  const candidateTiles = await loadCandidateTileGeometry();
  verifyCandidateTileGeometry(candidateTiles.geometry, index.tiles);
  const borough = await loadBoroughBoundary();
  const regionInput = await loadV2LicenceInput();
  const identity = browserPackIdentityV2(NORMALIZATION_ID, GENERATION_SUFFIX);
  const reconciliation = await aggregateBrowserPack(r2StoreFromEnvironment(), index, identity, count, {
    borough: borough.geometry,
    boroughFile: borough.file,
    regionInput,
    repairGeometry: {
      supportGeometryHash: support.geometryHash,
      candidateTileGeometryHash: candidateTiles.geometryHash,
    },
  });
  await report({ action: "aggregate", indexKey: INDEX_KEY, generation: identity.generation, reconciliation });
}

/**
 * Promotion runs after aggregation: re-verify every generation object, then
 * move the mutable pointer last. `verifyOnly` performs the full verification
 * without writing. `expectedPreviousSha256` is the compare-and-swap guard
 * against concurrent promotion (`"absent"` when no pointer exists yet).
 */
export async function promoteGeneration(
  output: ObjectStore,
  identity: { generation: string },
  options: { verifyOnly: boolean; expectedPreviousSha256?: string },
  onReport: (value: unknown) => void | Promise<void>,
): Promise<void> {
  const { verifyOnly, expectedPreviousSha256: expectedPrevious } = options;
  if (!verifyOnly && !expectedPrevious) throw new Error("promotion requires --expected-previous-sha256 (or --verify-only)");
  const generation = identity.generation;
  const readVerified = async (key: string, expectedHash: string): Promise<Uint8Array> => {
    const metadata = await output.head(key);
    if (!metadata || metadata.bytes <= 0 || metadata.sha256 !== expectedHash)
      throw new Error(`promotion object metadata mismatch: ${key}`);
    const bytes = await output.read(key);
    if (sha256(bytes) !== expectedHash) throw new Error(`promotion object readback mismatch: ${key}`);
    return bytes;
  };
  // The root hash is not self-describing: resolve it from a metadata read,
  // then verify every referenced artifact against the parsed root.
  const rootMeta = await output.head(`generations/${generation}/generation.json`);
  if (!rootMeta?.sha256) throw new Error("promotion cannot resolve the generation root hash");
  const rootRaw = await output.read(`generations/${generation}/generation.json`);
  if (sha256(rootRaw) !== rootMeta.sha256) throw new Error("promotion generation root readback mismatch");
  const root = parseGenerationRoot(JSON.parse(new TextDecoder().decode(rootRaw)));
  if (root.generation !== generation) throw new Error("promotion generation mismatch");
  // Notices are an independently hash-pinned artifact, but their per-kind
  // licence bindings are also part of the tile identity contract. Load and
  // parse them before sampling so every sampled component can be checked
  // against the exact hashes admitted by the generation root.
  const noticesRef = root.artifacts.notices;
  const noticesKey = noticesRef.path.replace(/^\/_shadow\//, "");
  const noticesRaw = await readVerified(noticesKey, noticesRef.sha256);
  if (noticesRaw.byteLength !== noticesRef.bytes) throw new Error("promotion notices byte mismatch");
  const notices = parseGenerationNotices(
    JSON.parse(new TextDecoder().decode(noticesRaw)),
    { generation, bytesLength: noticesRaw.byteLength },
  );
  const noticeLicenceHashes: ComponentLicenceHashes = notices.licenceHashes;
  // Full pre-promotion verification: HEAD every manifest tile (fail closed on
  // the first bytes/sha256 mismatch), then decode+compose a deterministic
  // sample independently against the root identity. Tiles with stored roofs
  // below local ground (whole-feature foundations on steep real terrain)
  // cannot compose; their identities still verify and they join the anomaly
  // list instead of blocking promotion.
  const verifyManifest = async (bytes: Uint8Array) => {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      tiles?: Array<{ tile: string; key: string; sha256: string; bytes: number }>;
      generation?: string;
    };
    if (manifest.generation !== generation || manifest.tiles?.length !== root.tileCount)
      throw new Error("promotion manifest generation/tile-count mismatch");
    const tiles = manifest.tiles!;
    const concurrency = Math.min(16, Math.max(tiles.length, 1));
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const position = next++;
          if (position >= tiles.length) return;
          const entry = tiles[position];
          const metadata = await output.head(entry.key);
          if (!metadata || metadata.bytes !== entry.bytes || metadata.sha256 !== entry.sha256)
            throw new Error(`promotion tile metadata mismatch: ${entry.tile}`);
        }
      }),
    );
    const sample = tiles.filter((_, position) => position === 0 || position % 1024 === 0);
    const sampleAnomalies: Array<{ tile: string; reason: string }> = [];
    for (const entry of sample) {
      const tileBytes = await readVerified(entry.key, entry.sha256);
      const components = await decodeBrowserTileBundle(tileBytes);
      for (const component of components) {
        if (
          component.identity.generation !== generation ||
          component.identity.recipeHash !== root.identity.recipeHash ||
          component.identity.datumHash !== root.identity.datumHash ||
          component.identity.hierarchyHash !== root.identity.hierarchyHash ||
          component.identity.normalizerHash !== root.identity.normalizerHash ||
          component.identity.compositorHash !== root.identity.compositorHash ||
          component.identity.treeModelHash !== root.identity.treeModelHash ||
          component.identity.receiverHash !== root.identity.receiverHash
        )
          throw new Error(`promotion sample identity mismatch: ${entry.tile}`);
        if (component.identity.licenceHash !== noticeLicenceHashes[component.kind])
          throw new Error(`promotion sample licence identity mismatch: ${entry.tile}`);
      }
      try {
        composeTile(components, { reserve: () => true });
      } catch (error) {
        if (!(error instanceof Error) || !/roof below terrain/.test(error.message)) throw error;
        sampleAnomalies.push({ tile: entry.tile, reason: "roof-below-terrain" });
      }
    }
    return { tiles, sample, sampleAnomalies };
  };
  let manifestSample = {
    tiles: [] as Array<{ tile: string }>,
    sample: [] as Array<{ tile: string }>,
    sampleAnomalies: [] as Array<{ tile: string; reason: string }>,
  };
  for (const [name, ref] of Object.entries(root.artifacts) as Array<[string, { path: string; sha256: string; bytes: number }]>) {
    const key = ref.path.replace(/^\/_shadow\//, "");
    const bytes = await readVerified(key, ref.sha256);
    if (bytes.byteLength !== ref.bytes) throw new Error(`promotion artifact byte mismatch: ${key}`);
    if (name === "manifest") {
      manifestSample = await verifyManifest(bytes);
    }
  }
  await onReport({
    action: verifyOnly ? "promote-verify" : "promote",
    generation,
    generationSha256: rootMeta.sha256,
    verifiedTiles: manifestSample.tiles.length,
    sampledTiles: manifestSample.sample.map((entry) => entry.tile),
    sampleCount: manifestSample.sample.length,
    ...(manifestSample.sampleAnomalies.length ? { sampleAnomalies: manifestSample.sampleAnomalies } : {}),
  });
  if (verifyOnly) return;
  // Real compare-and-swap: hash the live bytes rather than requiring sha256
  // object metadata, because the legacy v1 pointer predates that metadata.
  // When metadata is present it remains an independent integrity check. The
  // pointer move itself carries the ETag returned by the original HEAD (or an
  // absence precondition), so an interleaved promotion still loses
  // server-side instead of last-writer-winning.
  const previousMeta = await output.head("current.json");
  let previousEtag: string | undefined;
  if (previousMeta) {
    const previousBytes = await output.read("current.json");
    const previousDigest = sha256(previousBytes);
    if (previousMeta.sha256 !== undefined && previousMeta.sha256 !== previousDigest)
      throw new Error("promotion refused: current.json sha256 metadata does not match its content");
    if (previousDigest !== expectedPrevious)
      throw new Error("promotion refused: current.json changed since --expected-previous-sha256 was recorded");
    previousEtag = previousMeta.etag;
    if (!previousEtag) throw new Error("promotion cannot resolve current.json etag");
  } else if (expectedPrevious !== "absent") {
    throw new Error("promotion refused: current.json is absent but --expected-previous-sha256 is not 'absent'");
  }
  const pointer = {
    version: 2 as const,
    dataset: "nyc-shadow" as const,
    generation,
    generationPath: `/_shadow/generations/${generation}/generation.json`,
    generationSha256: rootMeta.sha256,
    tilePathTemplate: root.tilePathTemplate,
    tileCount: root.tileCount,
  };
  const pointerBytes = new TextEncoder().encode(`${JSON.stringify(pointer)}\n`);
  try {
    if (previousMeta) {
      if (!previousEtag) throw new Error("promotion cannot resolve current.json etag");
      await output.writeConditional("current.json", pointerBytes, "application/json", { ifMatch: previousEtag });
    } else {
      await output.writeConditional("current.json", pointerBytes, "application/json", { ifNoneMatch: "*" });
    }
  } catch (error) {
    if (error instanceof Error && /promotion refused: concurrent promotion/.test(error.message)) throw error;
    if (isConditionalWriteConflict(error)) throw new Error("promotion refused: concurrent promotion on current.json");
    throw error;
  }
  const readback = await output.read("current.json");
  if (sha256(readback) !== sha256(pointerBytes)) throw new Error("promotion pointer readback mismatch");
  await onReport({ action: "promote", generation, generationSha256: rootMeta.sha256, previousSha256: expectedPrevious, pointer });
}

async function promote(): Promise<void> {
  await promoteGeneration(r2StoreFromEnvironment(), browserPackIdentityV2(NORMALIZATION_ID, GENERATION_SUFFIX), {
    verifyOnly: process.argv.includes("--verify-only"),
    expectedPreviousSha256: optional("--expected-previous-sha256"),
  }, report);
}

async function main(): Promise<void> {
  const actions = [process.argv.includes("--build-index"), process.argv.includes("--pack-shard"), process.argv.includes("--aggregate"), process.argv.includes("--promote")].filter(Boolean).length;
  if (actions !== 1) throw new Error("choose exactly one of --build-index, --pack-shard, --aggregate, or --promote");
  if (process.argv.includes("--build-index")) return buildIndex();
  if (process.argv.includes("--pack-shard")) return packShard();
  if (process.argv.includes("--aggregate")) return aggregate();
  return promote();
}

// Importable for tests (promoteGeneration) without side effects: the CLI runs
// only when invoked as the main script.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });
}

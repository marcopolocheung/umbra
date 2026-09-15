import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { candidateDescriptorKey, type CandidateDescriptor } from "./candidates";
import {
  NYC_FIVE_BOROUGH_TILE_COUNT,
  aggregateBrowserPack,
  benchmarkCandidatePack,
  browserPackIdentity,
  candidateTileIndex,
  contiguousShard,
  reconcileBrowserPackShard,
  type CandidateTileIndex,
  type PackedBrowserTile,
} from "./pack";
import { r2StoreFromEnvironment, S3Store } from "./storage";
import { sha256 } from "./util";

const NORMALIZATION_ID = "70e3507f16d472adf5475b614a60cb16";
const GENERATION_SUFFIX = "five-borough-v1";
const INDEX_KEY = `browser-pack/nyc-${NORMALIZATION_ID}-${GENERATION_SUFFIX}/candidate-index.json`;

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

async function buildIndex(): Promise<void> {
  const { source, indexStore } = await sourceAndIndexStore();
  const prefix = `normalized/${NORMALIZATION_ID}/tiles/`;
  const descriptorPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}18/(\\d+)/(\\d+)/descriptor\\.json$`);
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
  const tiles = contiguousShard(index.tiles, shardIndex, count);
  const descriptors = await Promise.all(tiles.map(async (tile) => {
    const key = candidateDescriptorKey(NORMALIZATION_ID, tile);
    const descriptor = JSON.parse(new TextDecoder().decode(await source.read(key))) as CandidateDescriptor;
    if (descriptor.normalizationId !== NORMALIZATION_ID || descriptor.tile !== tile) throw new Error(`candidate descriptor identity mismatch: ${tile}`);
    return descriptor;
  }));
  const identity = browserPackIdentity(NORMALIZATION_ID, GENERATION_SUFFIX);
  const r2 = r2StoreFromEnvironment();
  const entries: PackedBrowserTile[] = [];
  const benchmark = await benchmarkCandidatePack(source, descriptors, r2, 1, (entry) => entries.push(entry), identity);
  const reconciliation = await reconcileBrowserPackShard(r2, entries, identity, shardIndex, count);
  await report({ action: "pack-shard", shardIndex, shardCount: count, indexKey: INDEX_KEY, ...benchmark, generation: identity.generation, reconciliation });
}

async function aggregate(): Promise<void> {
  const count = Number(optional("--array-shards"));
  if (!Number.isInteger(count) || count < 1) throw new Error("--array-shards must be a positive integer");
  const { indexStore } = await sourceAndIndexStore();
  const index = await loadIndex(indexStore);
  const identity = browserPackIdentity(NORMALIZATION_ID, GENERATION_SUFFIX);
  const reconciliation = await aggregateBrowserPack(r2StoreFromEnvironment(), index, identity, count);
  await report({ action: "aggregate", indexKey: INDEX_KEY, generation: identity.generation, reconciliation });
}

async function main(): Promise<void> {
  const actions = [process.argv.includes("--build-index"), process.argv.includes("--pack-shard"), process.argv.includes("--aggregate")].filter(Boolean).length;
  if (actions !== 1) throw new Error("choose exactly one of --build-index, --pack-shard, or --aggregate");
  if (process.argv.includes("--build-index")) return buildIndex();
  if (process.argv.includes("--pack-shard")) return packShard();
  return aggregate();
}

main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });

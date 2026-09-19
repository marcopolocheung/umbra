/**
 * Publish a verified navigation generation to R2 (S3-compatible API) under
 * the `navigation/nyc/` prefix.
 *
 * Discipline, matching the transit pipeline: `publish --dry-run` verifies
 * locally and plans without any network access; `publish --execute` uploads
 * every immutable generation object first, re-downloads and verifies
 * representative objects from all five boroughs, reconciles the bucket
 * inventory against the local verifier, and only then promotes
 * `current.json` — strictly last. Prior generations are never deleted, so a
 * promotion is reversible with `publish <previous> --rollback`, which uploads
 * only the pointer.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_NAVIGATION_BUCKET, R2_PUBLIC_BASE (public origin for the report).
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  parseNavigationManifest,
  parseNavigationNotices,
  parseNavigationPointer,
  type GeoBounds,
  type NavigationManifest,
  type NavigationPointer,
} from "../../../app/lib/navigationData/shardContract";
import { BOROUGH_SAMPLES, CASTER_REACH_M, expandBounds, type BoroughSample } from "./boundary";
import { sha256Hex } from "./util";
import { verifyGeneration } from "./verify";

/** The publication prefix is part of the wire contract, not configuration. */
export const PREFIX = "navigation/nyc";
export const POINTER_KEY = `${PREFIX}/current.json`;
export const POINTER_CACHE_CONTROL = "public, max-age=60";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTENT_TYPE = "application/json";

/**
 * Store abstraction over the S3-compatible R2 API. Hermetic tests inject an
 * in-memory implementation instead of this network-backed one.
 */
export interface PublishStore {
  head(key: string): Promise<{ key: string; size: number; etag: string } | null>;
  put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<Array<{ key: string; size: number; etag: string }>>;
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function cleanEtag(etag: string | undefined): string {
  return (etag ?? "").replaceAll('"', "");
}

function s3NotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NotFound" || error.name === "NoSuchKey" || error.name === "404")
  );
}

class S3PublishStore implements PublishStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<{ key: string; size: number; etag: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (response.ContentLength === undefined || response.ETag === undefined) return null;
      return { key, size: response.ContentLength, etag: cleanEtag(response.ETag) };
    } catch (error) {
      if (s3NotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = response.Body;
      if (!body) return null;
      return await body.transformToByteArray();
    } catch (error) {
      if (s3NotFound(error)) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; etag: string }>> {
    const metas: Array<{ key: string; size: number; etag: string }> = [];
    let continuation: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuation,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key === undefined || object.Size === undefined || object.ETag === undefined)
          continue;
        metas.push({ key: object.Key, size: object.Size, etag: cleanEtag(object.ETag) });
      }
      continuation = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuation);
    return metas;
  }
}

function r2Store(bucket: string): S3PublishStore {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
  }
  return new S3PublishStore(
    new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    }),
    bucket,
  );
}

// ─── Publication plan ───────────────────────────────────────────────────────

export type PublishObjectKind = "manifest" | "notices" | "streetShard" | "buildingShard" | "pointer";

export interface PublishObject {
  kind: PublishObjectKind;
  /** Bucket key, including the `navigation/nyc/` prefix. */
  key: string;
  /** Absolute local file this key must equal byte-for-byte. */
  file: string;
  bytes: number;
  sha256: string;
  cacheControl: string;
}

export interface PublishPlan {
  generation: string;
  manifest: NavigationManifest;
  pointer: NavigationPointer;
  /** Immutable generation objects first; the pointer entry is always last. */
  objects: PublishObject[];
  /** Bytes of shards + notices — the verifier's `budgets.actual.totalBytes`. */
  payloadBytes: number;
}

function generationDirectory(generation: string): { directory: string; nested: string } {
  const root = process.env.NAVIGATION_PREP_ROOT;
  if (!root || !root.startsWith("/"))
    throw new Error("NAVIGATION_PREP_ROOT must be an absolute directory outside Git");
  return {
    directory: join(root, "normalized", generation),
    nested: join(root, "normalized", generation, "navigation", "nyc", generation),
  };
}

async function readExact(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(file));
}

/**
 * Builds the ordered object list from the published-form bytes on disk — not
 * from builder memory. The pointer (kind `pointer`) is always the final entry
 * of `objects`.
 */
export async function publishPlan(generation: string): Promise<PublishPlan> {
  const { directory, nested } = generationDirectory(generation);

  let pointerBytes: Uint8Array;
  try {
    pointerBytes = await readExact(join(directory, "pointer-candidate.json"));
  } catch {
    throw new Error(`generation ${generation} has no pointer-candidate.json; run build first`);
  }
  const pointer = parseNavigationPointer(JSON.parse(new TextDecoder().decode(pointerBytes)));
  if (pointer.generation !== generation)
    throw new Error(`pointer-candidate names ${pointer.generation}, not ${generation}`);
  if (pointer.manifestPath !== `${PREFIX}/${generation}/manifest.json`)
    throw new Error("pointer does not name this generation's manifest path");

  const manifestBytes = await readExact(join(nested, "manifest.json"));
  if (sha256Hex(manifestBytes) !== pointer.manifestSha256)
    throw new Error("manifest bytes disagree with the pointer digest");
  const manifest = parseNavigationManifest(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
    generation,
  );

  const noticesBytes = await readExact(join(nested, "notices.json"));
  if (sha256Hex(noticesBytes) !== manifest.noticesSha256)
    throw new Error("notices bytes disagree with the manifest digest");
  parseNavigationNotices(JSON.parse(new TextDecoder().decode(noticesBytes)), generation);

  const objects: PublishObject[] = [
    {
      kind: "manifest",
      key: `${PREFIX}/${generation}/manifest.json`,
      file: join(nested, "manifest.json"),
      bytes: manifestBytes.byteLength,
      sha256: sha256Hex(manifestBytes),
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    {
      kind: "notices",
      key: `${PREFIX}/${generation}/notices.json`,
      file: join(nested, "notices.json"),
      bytes: noticesBytes.byteLength,
      sha256: sha256Hex(noticesBytes),
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
  ];
  let payloadBytes = noticesBytes.byteLength;

  // Every manifest ref must map to exactly one local file, and every local
  // shard file must be claimed by exactly one ref: an unclaimed (raw,
  // intermediate, or stray) file must never be published.
  const localStreets = new Set(await readdir(join(nested, "streets")));
  const localBuildings = new Set(await readdir(join(nested, "buildings")));
  const addShards = async (
    refs: ReadonlyArray<{ key: string; bytes: number; sha256: string }>,
    kind: "streetShard" | "buildingShard",
    local: Set<string>,
  ): Promise<void> => {
    for (const ref of refs) {
      const fileName = ref.key.split("/")[1];
      if (!local.delete(fileName)) throw new Error(`manifest ref ${ref.key} has no local file`);
      const file = join(nested, ref.key);
      const bytes = await readExact(file);
      if (bytes.byteLength !== ref.bytes) throw new Error(`${ref.key}: byte count drifted`);
      if (sha256Hex(bytes) !== ref.sha256) throw new Error(`${ref.key}: digest drifted`);
      objects.push({
        kind,
        key: `${PREFIX}/${generation}/${ref.key}`,
        file,
        bytes: bytes.byteLength,
        sha256: ref.sha256,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
      payloadBytes += bytes.byteLength;
    }
  };
  await addShards(manifest.streetShards, "streetShard", localStreets);
  await addShards(manifest.buildingShards, "buildingShard", localBuildings);
  if (localStreets.size > 0)
    throw new Error(`unclaimed street files must not be published: ${[...localStreets].join(", ")}`);
  if (localBuildings.size > 0)
    throw new Error(`unclaimed building files must not be published: ${[...localBuildings].join(", ")}`);

  // Planned strictly last so the order itself enforces pointer-last
  // promotion, and promoted from these exact verified bytes.
  objects.push({
    kind: "pointer",
    key: POINTER_KEY,
    file: join(directory, "pointer-candidate.json"),
    bytes: pointerBytes.byteLength,
    sha256: sha256Hex(pointerBytes),
    cacheControl: POINTER_CACHE_CONTROL,
  });

  return { generation, manifest, pointer, objects, payloadBytes };
}

// ─── Representative borough specimens ───────────────────────────────────────

export type PublishSample = BoroughSample;

function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/**
 * Picks the verification specimens for one sample with the client's exact
 * selection semantics: streets by geometry intersection, buildings by
 * geometry intersection with the bbox padded by caster reach. Returns null
 * when the sample selects no shard — for a citywide generation every borough
 * sample must select at least one street and one building shard.
 */
export function specimenKeysForSample(
  manifest: NavigationManifest,
  sample: PublishSample,
): { streets: string[]; buildings: string[] } | null {
  const padded = expandBounds(sample.bbox, CASTER_REACH_M);
  const streets = manifest.streetShards
    .filter((ref) => boundsIntersect(ref.geometryBounds, sample.bbox))
    .map((ref) => ref.key);
  const buildings = manifest.buildingShards
    .filter((ref) => boundsIntersect(ref.geometryBounds, padded))
    .map((ref) => ref.key);
  if (streets.length === 0 || buildings.length === 0) return null;
  return { streets, buildings };
}

/** The retained per-borough samples; the cross-borough corridor is not one. */
export const BOROUGH_PUBLISH_SAMPLES: PublishSample[] = BOROUGH_SAMPLES.slice(0, 5);

// ─── Execute / rollback ─────────────────────────────────────────────────────

export interface PublishExecuteOptions {
  /** Test seam: hermetic suites inject an in-memory store, not the SDK. */
  store?: PublishStore;
  /** Test seam: small fixtures repoint the representative-sample set. */
  samples?: PublishSample[];
}

export interface PublishedSpecimen {
  borough: string;
  street: { key: string; bytes: number; sha256: string };
  building: { key: string; bytes: number; sha256: string };
}

export interface PublishReport {
  mode: "execute" | "rollback";
  at: string;
  generation: string;
  bucket: string;
  prefix: string;
  publicBase: string | null;
  manifestSha256: string;
  pointerSha256: string;
  /** SHA-256 of the pointer this publication replaced (rollback input). */
  previousPointerSha256: string | null;
  verifier: {
    objects: number;
    streetShards: number;
    buildingShards: number;
    totalBytes: number;
  };
  objects: {
    count: number;
    bytes: number;
    payloadBytes: number;
  };
  uploaded: string[];
  resumed: string[];
  specimens: PublishedSpecimen[];
  fetchedForVerification: string[];
  reconciled: {
    count: number;
    bytes: number;
  };
  previousPointer: { generation: string; manifestSha256: string } | null;
  rollbackCommand: string | null;
  rollbackTo: string | null;
}

function requiredBucket(): string {
  const bucket = process.env.R2_NAVIGATION_BUCKET;
  if (!bucket) throw new Error("R2_NAVIGATION_BUCKET must be set");
  return bucket;
}

/** Uploads one immutable object, resuming past an identical stored copy. */
async function uploadObject(
  store: PublishStore,
  object: PublishObject,
  uploaded: string[],
  resumed: string[],
): Promise<void> {
  const bytes = await readExact(object.file);
  const existing = await store.head(object.key);
  if (existing && existing.size === object.bytes && existing.etag === md5Hex(bytes)) {
    resumed.push(object.key);
    return;
  }
  await store.put(object.key, bytes, CONTENT_TYPE, object.cacheControl);
  const stored = await store.head(object.key);
  if (!stored || stored.size !== object.bytes || stored.etag !== md5Hex(bytes)) {
    throw new Error(`upload verification failed for ${object.key}`);
  }
  uploaded.push(object.key);
}

/** Re-downloads one key and proves stored bytes equal the local contract. */
async function verifyStoredObject(
  store: PublishStore,
  key: string,
  bytes: number,
  sha256: string,
): Promise<void> {
  const stored = await store.get(key);
  if (!stored) throw new Error(`${key}: missing after upload`);
  if (stored.byteLength !== bytes) throw new Error(`${key}: stored byte count drifted`);
  if (sha256Hex(stored) !== sha256) throw new Error(`${key}: stored digest drifted`);
}

async function reconcileInventory(
  store: PublishStore,
  plan: PublishPlan,
): Promise<PublishReport["reconciled"]> {
  const stored = await store.list(`${PREFIX}/${plan.generation}/`);
  const remaining = new Map(
    plan.objects
      .filter((object) => object.kind !== "pointer")
      .map((object) => [object.key, object]),
  );
  let count = 0;
  let bytes = 0;
  for (const meta of stored) {
    const object = remaining.get(meta.key);
    if (!object) {
      throw new Error(`bucket holds an unreferenced key: ${meta.key}`);
    }
    remaining.delete(meta.key);
    count += 1;
    bytes += meta.size;
    if (meta.size !== object.bytes) {
      throw new Error(`${meta.key}: stored size ${meta.size} != local ${object.bytes}`);
    }
    if (meta.etag !== md5Hex(await readExact(object.file))) {
      throw new Error(`${meta.key}: stored hash disagrees with the local object`);
    }
  }
  if (remaining.size > 0) {
    throw new Error(`bucket is missing published objects: ${[...remaining.keys()].join(", ")}`);
  }
  return { count, bytes };
}

async function readPreviousPointer(store: PublishStore): Promise<{
  previousPointer: PublishReport["previousPointer"];
  previousPointerSha256: string | null;
}> {
  const bytes = await store.get(POINTER_KEY);
  if (!bytes) return { previousPointer: null, previousPointerSha256: null };
  const previousPointerSha256 = sha256Hex(bytes);
  try {
    const pointer = parseNavigationPointer(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      previousPointer: {
        generation: pointer.generation,
        manifestSha256: pointer.manifestSha256,
      },
      previousPointerSha256,
    };
  } catch {
    return {
      previousPointer: { generation: "unparsable", manifestSha256: "unparsable" },
      previousPointerSha256,
    };
  }
}

/**
 * Executes the publication: immutable objects first (resumable after an
 * interruption), representative borough re-verification, inventory
 * reconciliation against the local verifier, pointer promotion strictly last.
 */
export async function publishExecute(
  generation: string | undefined,
  options: PublishExecuteOptions = {},
): Promise<PublishReport> {
  const bucket = requiredBucket();
  const store = options.store ?? r2Store(bucket);
  const samples = options.samples ?? BOROUGH_PUBLISH_SAMPLES;

  // The verifier re-reads only the final serialized bytes; publish may only
  // run on what it accepted.
  const verified = await verifyGeneration(generation);
  const plan = await publishPlan(verified.generation);

  const publishedGeneration = verified.generation;
  const shardObjects = plan.objects.filter(
    (object) => object.kind === "streetShard" || object.kind === "buildingShard",
  );
  if (shardObjects.length !== verified.streetShards + verified.buildingShards) {
    throw new Error("object plan does not match the verified shard count");
  }
  if (plan.payloadBytes !== verified.budgets.actual.totalBytes) {
    throw new Error(
      `plan payload ${plan.payloadBytes} disagrees with the verified total ${verified.budgets.actual.totalBytes}`,
    );
  }

  // Phase 1: every immutable object, resumable. Any failure aborts before
  // this run has touched the pointer.
  const uploaded: string[] = [];
  const resumed: string[] = [];
  for (const object of plan.objects) {
    if (object.kind === "pointer") break;
    await uploadObject(store, object, uploaded, resumed);
  }

  // Phase 2: prove the stored bytes answer the five boroughs. One street and
  // one building shard per sample are re-downloaded and their exact byte
  // counts and SHA-256 checked against the local contract.
  const specimens: PublishedSpecimen[] = [];
  const fetchedForVerification: string[] = [];
  for (const sample of samples) {
    const keys = specimenKeysForSample(plan.manifest, sample);
    if (!keys) {
      throw new Error(`borough sample ${sample.borough} selects no navigation shards; refusing to publish`);
    }
    const streetObject = plan.objects.find(
      (object) => object.key === `${PREFIX}/${plan.generation}/${keys.streets[0]}`,
    );
    const buildingObject = plan.objects.find(
      (object) => object.key === `${PREFIX}/${plan.generation}/${keys.buildings[0]}`,
    );
    if (!streetObject || !buildingObject) {
      throw new Error(`specimen missing from the plan for ${sample.borough}`);
    }
    await verifyStoredObject(store, streetObject.key, streetObject.bytes, streetObject.sha256);
    await verifyStoredObject(store, buildingObject.key, buildingObject.bytes, buildingObject.sha256);
    fetchedForVerification.push(streetObject.key, buildingObject.key);
    specimens.push({
      borough: sample.borough,
      street: { key: streetObject.key, bytes: streetObject.bytes, sha256: streetObject.sha256 },
      building: { key: buildingObject.key, bytes: buildingObject.bytes, sha256: buildingObject.sha256 },
    });
  }

  // Phase 3: reconcile object count, bytes, and hashes against the local
  // verifier before anything mutable is touched.
  const reconciled = await reconcileInventory(store, plan);

  // Phase 4: `current.json`, strictly last.
  const pointerObject = plan.objects[plan.objects.length - 1];
  if (pointerObject.kind !== "pointer") throw new Error("plan does not end in the pointer");
  const previous = await readPreviousPointer(store);
  const pointerBytes = await readExact(pointerObject.file);
  await store.put(pointerObject.key, pointerBytes, CONTENT_TYPE, POINTER_CACHE_CONTROL);
  await verifyStoredObject(store, pointerObject.key, pointerObject.bytes, pointerObject.sha256);
  uploaded.push(pointerObject.key);
  // Local record of exactly what was promoted.
  await writeFile(join(generationDirectory(publishedGeneration).directory, "current.json"), pointerBytes);

  return {
    mode: "execute",
    at: new Date().toISOString(),
    generation: publishedGeneration,
    bucket,
    prefix: PREFIX,
    publicBase: process.env.R2_PUBLIC_BASE ?? null,
    manifestSha256: plan.pointer.manifestSha256,
    pointerSha256: sha256Hex(pointerBytes),
    previousPointerSha256: previous.previousPointerSha256,
    verifier: {
      objects: verified.objects,
      streetShards: verified.streetShards,
      buildingShards: verified.buildingShards,
      totalBytes: verified.budgets.actual.totalBytes,
    },
    objects: {
      count: plan.objects.length,
      bytes: plan.objects.reduce((sum, object) => sum + object.bytes, 0),
      payloadBytes: plan.payloadBytes,
    },
    uploaded,
    resumed,
    specimens,
    fetchedForVerification,
    reconciled,
    previousPointer: previous.previousPointer,
    rollbackCommand:
      previous.previousPointer && previous.previousPointer.generation !== publishedGeneration
        ? `npm --prefix server/navigation-prep run publish -- --rollback ${previous.previousPointer.generation}`
        : null,
    rollbackTo: null,
  };
}

/**
 * Re-promotes a retained generation by uploading only its verified pointer.
 * Shards are never re-uploaded or deleted here: a rollback target must stay
 * fetchable, so its generation must still verify locally.
 */
export async function publishRollback(
  generation: string | undefined,
  options: PublishExecuteOptions = {},
): Promise<PublishReport> {
  const bucket = requiredBucket();
  const store = options.store ?? r2Store(bucket);
  const verified = await verifyGeneration(generation);
  const plan = await publishPlan(verified.generation);

  const pointerObject = plan.objects[plan.objects.length - 1];
  if (pointerObject.kind !== "pointer") throw new Error("plan does not end in the pointer");
  const previous = await readPreviousPointer(store);
  const pointerBytes = await readExact(pointerObject.file);
  await store.put(pointerObject.key, pointerBytes, CONTENT_TYPE, POINTER_CACHE_CONTROL);
  await verifyStoredObject(store, pointerObject.key, pointerObject.bytes, pointerObject.sha256);
  await writeFile(join(generationDirectory(verified.generation).directory, "current.json"), pointerBytes);

  return {
    mode: "rollback",
    at: new Date().toISOString(),
    generation: verified.generation,
    bucket,
    prefix: PREFIX,
    publicBase: process.env.R2_PUBLIC_BASE ?? null,
    manifestSha256: plan.pointer.manifestSha256,
    pointerSha256: sha256Hex(pointerBytes),
    previousPointerSha256: previous.previousPointerSha256,
    verifier: {
      objects: verified.objects,
      streetShards: verified.streetShards,
      buildingShards: verified.buildingShards,
      totalBytes: verified.budgets.actual.totalBytes,
    },
    objects: {
      count: plan.objects.length,
      bytes: plan.objects.reduce((sum, object) => sum + object.bytes, 0),
      payloadBytes: plan.payloadBytes,
    },
    uploaded: [pointerObject.key],
    resumed: [],
    specimens: [],
    fetchedForVerification: [],
    reconciled: { count: 0, bytes: 0 },
    previousPointer: previous.previousPointer,
    rollbackCommand: null,
    rollbackTo: verified.generation,
  };
}

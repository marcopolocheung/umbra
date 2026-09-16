/**
 * Publish a verified generation to R2 (S3-compatible) under
 * transit/nyc/<generation>/. Dry-run by default; --execute uploads the 9
 * objects (7 shards + manifest + current.json pointer) with immutable caching on shards and a
 * short cache on the manifest, then reports the public URLs.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_TRANSIT_BUCKET, R2_TRANSIT_PREFIX (default transit/nyc),
 * R2_PUBLIC_BASE (e.g. https://transit.example.com/nyc) for the report.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json, requireRoot, sha256 } from "./util";

interface ManifestRef {
  generation: string;
  shards: { key: string }[];
}

function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export interface PublishObject {
  key: string;
  bytes: number;
  cacheControl: string;
  /** Inline body (the current.json pointer); otherwise read from the generation dir. */
  body?: Uint8Array;
}

export async function publishPlan(generation: string): Promise<{
  generation: string;
  objects: PublishObject[];
}> {
  const root = requireRoot();
  const directory = join(root, "normalized", generation);
  const manifest = await json<ManifestRef>(join(directory, "manifest.json"));
  const objects: PublishObject[] = [];
  const prefix = process.env.R2_TRANSIT_PREFIX ?? "transit/nyc";
  for (const shard of manifest.shards) {
    const bytes = await readFile(join(directory, shard.key));
    objects.push({
      key: `${prefix}/${generation}/${shard.key}`,
      bytes: bytes.length,
      cacheControl: "public, max-age=31536000, immutable",
    });
  }
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifestKey = `${prefix}/${generation}/manifest.json`;
  objects.push({
    key: manifestKey,
    bytes: manifestBytes.length,
    cacheControl: "public, max-age=300",
  });
  // Stable pointer (mirrors the bucket-root current.json convention): the
  // Step-6 client reads this one well-known URL instead of a hardcoded
  // generation. Paths are bucket-relative; serving routes are Step 6's job.
  const pointer = {
    version: 1,
    dataset: "nyc-transit",
    generation,
    manifestPath: manifestKey,
    manifestSha256: sha256(new Uint8Array(manifestBytes)),
  };
  const pointerBytes = new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`);
  objects.push({
    key: `${prefix}/current.json`,
    bytes: pointerBytes.length,
    cacheControl: "public, max-age=300",
    body: pointerBytes,
  });
  // Local record of exactly what the pointer said.
  await writeFile(join(directory, "current.json"), pointerBytes);
  return { generation, objects };
}

export async function publishExecute(generation: string): Promise<{
  generation: string;
  uploaded: string[];
  publicBase: string | null;
}> {
  const bucket = process.env.R2_TRANSIT_BUCKET;
  if (!bucket) throw new Error("R2_TRANSIT_BUCKET must be set");
  const root = requireRoot();
  const directory = join(root, "normalized", generation);
  const plan = await publishPlan(generation);
  const client = r2Client();
  const uploaded: string[] = [];
  for (const object of plan.objects) {
    const body =
      object.body ?? (await readFile(join(directory, object.key.split("/").pop() as string)));
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: object.key,
        Body: body,
        ContentType: "application/json",
        CacheControl: object.cacheControl,
      }),
    );
    uploaded.push(object.key);
  }
  return { generation, uploaded, publicBase: process.env.R2_PUBLIC_BASE ?? null };
}

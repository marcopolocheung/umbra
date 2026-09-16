/**
 * Publish a verified generation to R2 (S3-compatible) under
 * transit/nyc/<generation>/. Dry-run by default; --execute uploads the 8
 * objects (7 shards + manifest) with immutable caching on shards and a
 * short cache on the manifest, then reports the public URLs.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_TRANSIT_BUCKET, R2_TRANSIT_PREFIX (default transit/nyc),
 * R2_PUBLIC_BASE (e.g. https://transit.example.com/nyc) for the report.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { json, requireRoot } from "./util";

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

export async function publishPlan(generation: string): Promise<{
  generation: string;
  objects: { key: string; bytes: number; cacheControl: string }[];
}> {
  const root = requireRoot();
  const directory = join(root, "normalized", generation);
  const manifest = await json<ManifestRef>(join(directory, "manifest.json"));
  const objects: { key: string; bytes: number; cacheControl: string }[] = [];
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
  objects.push({
    key: `${prefix}/${generation}/manifest.json`,
    bytes: manifestBytes.length,
    cacheControl: "public, max-age=300",
  });
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
    const file = object.key.split("/").pop() as string;
    const body = await readFile(join(directory, file));
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

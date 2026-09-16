import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** A deliberately small object-store contract.  Candidate publication depends on
 * the descriptor being written last; it never depends on directory rename
 * semantics (which S3 does not have). */
export interface ObjectStore {
  readonly kind: "filesystem" | "s3";
  read(key: string): Promise<Uint8Array>;
  /** Streams a remote object to a caller-owned local temporary path. */
  copyToFile(key: string, destination: string): Promise<void>;
  write(key: string, value: Uint8Array, contentType?: string): Promise<void>;
  head(key: string): Promise<{ bytes: number; sha256?: string } | undefined>;
}

function safeKey(key: string): string {
  const cleaned = normalize(key).replaceAll("\\", "/");
  if (!key || cleaned === ".." || cleaned.startsWith("../") || key.startsWith("/")) throw new Error(`unsafe object key ${key}`);
  return cleaned;
}

export class FilesystemStore implements ObjectStore {
  readonly kind = "filesystem" as const;
  constructor(readonly root: string) {}
  private path(key: string): string {
    const path = join(this.root, safeKey(key));
    if (relative(this.root, path).startsWith("..")) throw new Error(`unsafe object key ${key}`);
    return path;
  }
  async read(key: string): Promise<Uint8Array> { return new Uint8Array(await readFile(this.path(key))); }
  async copyToFile(key: string, destination: string): Promise<void> { await mkdir(dirname(destination), { recursive: true }); await copyFile(this.path(key), destination); }
  async write(key: string, value: Uint8Array): Promise<void> {
    const path = this.path(key); await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, value); await rename(temporary, path);
  }
  async head(key: string): Promise<{ bytes: number; sha256?: string } | undefined> {
    const path = this.path(key);
    try {
      const metadata = await stat(path); const hash = createHash("sha256");
      await new Promise<void>((resolve, reject) => { const stream = createReadStream(path); stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", resolve); });
      return { bytes: metadata.size, sha256: hash.digest("hex") };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}

export class S3Store implements ObjectStore {
  readonly kind = "s3" as const;
  constructor(readonly bucket: string, readonly prefix = "", readonly client = new S3Client({})) {
    if (!bucket) throw new Error("SHADE_PREP_S3_BUCKET is required for S3 storage");
  }
  private key(key: string): string { return [this.prefix.replace(/^\/+|\/+$/g, ""), safeKey(key)].filter(Boolean).join("/"); }
  async read(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
    if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
    return new Uint8Array(await result.Body.transformToByteArray());
  }
  async copyToFile(key: string, destination: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
    if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(result.Body as unknown as NodeJS.ReadableStream, createWriteStream(destination, { flags: "w" }));
  }
  async write(key: string, value: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const digest = createHash("sha256").update(value).digest("hex");
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: value, ContentType: contentType, Metadata: { sha256: digest } }));
  }
  async head(key: string): Promise<{ bytes: number; sha256?: string } | undefined> {
    try {
      const value = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return { bytes: Number(value.ContentLength ?? 0), sha256: value.Metadata?.sha256 };
    } catch (error) {
      const code = (error as { name?: string; $metadata?: { httpStatusCode?: number } }).name;
      if (code === "NotFound" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }
  /** List complete bucket keys below a logical prefix.  This is intentionally
   * only exposed on S3: the full-run index is built once, before the array
   * workers begin, so they never each enumerate the 1.1m candidate objects. */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.key(prefix),
        ContinuationToken: continuationToken,
      }));
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}

export function candidateStore(root: string): ObjectStore {
  if ((process.env.SHADE_PREP_STORAGE ?? "filesystem") === "s3") return new S3Store(process.env.SHADE_PREP_S3_BUCKET ?? "", process.env.SHADE_PREP_S3_PREFIX ?? "");
  return new FilesystemStore(root);
}

/** R2 exposes the S3 API. Credentials come only from the runtime environment
 * (normally an AWS Secrets Manager injection), never from source or a Batch
 * command line. The R2 endpoint requires the AWS SDK's `auto` region. */
export function r2StoreFromEnvironment(): S3Store {
  const bucket = process.env.SHADE_PACK_R2_BUCKET;
  const endpoint = process.env.SHADE_PACK_R2_ENDPOINT;
  const accessKeyId = process.env.SHADE_PACK_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SHADE_PACK_R2_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey)
    throw new Error("R2 output requires its bucket, endpoint, access key id, and secret access key");
  if (!/^https:\/\/[a-f0-9]{32}(?:\.[a-z]+)?\.r2\.cloudflarestorage\.com$/.test(endpoint))
    throw new Error("SHADE_PACK_R2_ENDPOINT must be an account-scoped HTTPS R2 endpoint");
  // Follow R2's AWS SDK v3 configuration exactly. Its account endpoint plus
  // bucket parameter selects the virtual-hosted S3 request shape.
  return new S3Store(bucket, "", new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } }));
}

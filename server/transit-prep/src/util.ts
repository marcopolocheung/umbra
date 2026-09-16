import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

/** Read lazily so tests can repoint TRANSIT_PREP_ROOT at temp dirs. */
export function requireRoot(): string {
  const dir = process.env.TRANSIT_PREP_ROOT;
  if (!dir || !dir.startsWith("/")) {
    throw new Error("TRANSIT_PREP_ROOT must be an absolute directory outside Git");
  }
  return dir;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export async function fileHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

export async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeJson(temporary, value);
  await rename(temporary, path);
}

export async function files(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
      ),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

export async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const path of await files(directory)) total += (await stat(path)).size;
  return total;
}

/** SHA-256 over "name:file-sha" lines for a fixed member list (receipts). */
export async function workTreeHash(workDir: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const name of [...files].sort()) {
    parts.push(`${name}:${sha256(await readFile(join(workDir, name)))}`);
  }
  return sha256(new TextEncoder().encode(parts.join("\n")));
}

export function rel(path: string): string {
  return relative(requireRoot(), path);
}

export function safeName(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function haversineMeters(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const r = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (latB - latA) * toRad;
  const dLon = (lonB - lonA) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * toRad) * Math.cos(latB * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

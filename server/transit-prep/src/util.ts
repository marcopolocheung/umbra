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

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Clamped projection of `p` onto the segment `a`-`b`, with the along-segment
 * fraction that located it.
 *
 * Equirectangular rather than spherical: over the tens of metres a shape
 * segment or an OSM way segment spans, the error is far below anything either
 * caller decides on, and a projection is only meaningful in a plane. The frame
 * is scaled at `a`, not at `p` — it belongs to the segment, so the same segment
 * answers every query in the same frame.
 *
 * `t` is what makes this more than a distance: linear referencing along a
 * polyline needs to know *where* on the segment the foot of the perpendicular
 * landed, not just how far away it was.
 */
export function projectOnSegment(
  p: LatLon,
  a: LatLon,
  b: LatLon,
): { point: LatLon; t: number; distM: number } {
  const scale = Math.cos((a.lat * Math.PI) / 180);
  const vx = b.lat - a.lat;
  const vy = (b.lon - a.lon) * scale;
  const wx = p.lat - a.lat;
  const wy = (p.lon - a.lon) * scale;
  const lengthSq = vx * vx + vy * vy;
  const raw = lengthSq === 0 ? 0 : (wx * vx + wy * vy) / lengthSq;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const point = { lat: a.lat + vx * t, lon: a.lon + (b.lon - a.lon) * t };
  return { point, t, distM: haversineMeters(p.lat, p.lon, point.lat, point.lon) };
}

/**
 * Distance from the first point to each point of a polyline, along it.
 *
 * `cum[i]` is the length of `points[0..i]`, so `cum[n-1]` is the whole line.
 * Built once per shape and reused: NYC shapes serve thousands of edges each.
 */
export function cumulativeMeters(points: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1] as LatLon;
    const curr = points[i] as LatLon;
    cum.push((cum[i - 1] as number) + haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon));
  }
  return cum;
}

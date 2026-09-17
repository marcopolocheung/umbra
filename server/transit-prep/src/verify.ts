/**
 * Verify a built generation: every shard re-reads, re-hashes against the
 * manifest, and passes structural checks (sorted ids, edge endpoints
 * resolve, headway routes resolve, shapes resolve to finite coords).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { json, requireRoot, sha256 } from "./util";

export interface ShardLike {
  kind?: string;
  stops: { id: string; lat?: number; lon?: number; changeSec?: number }[];
  edges: {
    from: string;
    to: string;
    route: string;
    medianSec: number;
    structure?: Record<string, number>;
  }[];
  routes: { id: string }[];
  headways: { route: string; hour: number }[];
  transfers?: { from: string; to: string; minSec: number }[];
}

interface ManifestLike {
  generation: string;
  createdAt?: string;
  shards: {
    key: string;
    bytes: number;
    sha256: string;
    bounds?: { south: number; west: number; north: number; east: number };
  }[];
}

/**
 * Newest generation by the manifest's own createdAt, not by directory name.
 * Generation ids end in a content hash, so names sort arbitrarily within a
 * day — and `publish` publishes whatever this returns.
 */
async function latestGeneration(normalized: string): Promise<string | null> {
  const dated: { name: string; createdAt: string }[] = [];
  for (const name of await readdir(normalized)) {
    if (name.startsWith(".")) continue;
    try {
      const manifest = await json<ManifestLike>(join(normalized, name, "manifest.json"));
      dated.push({ name, createdAt: manifest.createdAt ?? "" });
    } catch {
      // Not a generation directory (no readable manifest); ignore it.
    }
  }
  dated.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.name < b.name ? -1 : 1,
  );
  return dated.pop()?.name ?? null;
}

export async function verifyGeneration(generation?: string): Promise<{ generation: string; shards: number }> {
  const root = requireRoot();
  const normalized = join(root, "normalized");
  const name = generation ?? (await latestGeneration(normalized));
  if (!name) throw new Error("no generations to verify");
  const directory = join(normalized, name);
  const manifest = await json<ManifestLike>(join(directory, "manifest.json"));
  if (manifest.generation !== name) throw new Error(`manifest generation ${manifest.generation} != directory ${name}`);
  for (const shard of manifest.shards) {
    const bytes = await readFile(join(directory, shard.key));
    if (bytes.length !== shard.bytes) {
      throw new Error(`${shard.key}: size ${bytes.length} != manifest ${shard.bytes}`);
    }
    if (sha256(new Uint8Array(bytes)) !== shard.sha256) {
      throw new Error(`${shard.key}: hash mismatch`);
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as ShardLike;
    checkShard(shard.key, parsed);
    checkBounds(shard.key, parsed, shard.bounds);
  }
  return { generation: name, shards: manifest.shards.length };
}

/**
 * The manifest's extent must be the one the shard's stops actually describe.
 *
 * This is the only check on it: a client skips the download when `bounds` says
 * a shard cannot reach its bbox, so an extent that is merely plausible drops
 * transit for real New York routes and looks like the feature being switched
 * off, not like a bad build.
 */
export function checkBounds(
  key: string,
  shard: ShardLike,
  bounds: { south: number; west: number; north: number; east: number } | undefined,
): void {
  if (!bounds) throw new Error(`${key}: manifest publishes no bounds`);
  const lats = shard.stops.map((stop) => stop.lat ?? Number.NaN);
  const lons = shard.stops.map((stop) => stop.lon ?? Number.NaN);
  const expected = {
    south: Math.min(...lats),
    west: Math.min(...lons),
    north: Math.max(...lats),
    east: Math.max(...lons),
  };
  for (const [edge, value] of Object.entries(expected)) {
    if (!Number.isFinite(value) || bounds[edge as keyof typeof expected] !== value) {
      throw new Error(
        `${key}: bounds.${edge} is ${bounds[edge as keyof typeof expected]}, stops give ${value}`,
      );
    }
  }
}

export function checkShard(key: string, shard: ShardLike): void {
  const fail = (message: string): never => {
    throw new Error(`${key}: ${message}`);
  };
  const stopIds = new Set(shard.stops.map((stop) => stop.id));
  for (const stop of shard.stops) {
    // 0 is a legitimate cross-platform change; negative or fractional is not.
    if (stop.changeSec !== undefined && (!Number.isInteger(stop.changeSec) || stop.changeSec < 0)) {
      fail(`stop ${stop.id} has changeSec ${stop.changeSec}`);
    }
  }
  for (let i = 1; i < shard.stops.length; i += 1) {
    if ((shard.stops[i - 1] as { id: string }).id >= (shard.stops[i] as { id: string }).id) {
      fail("stops not strictly sorted by id");
    }
  }
  const routeIds = new Set(shard.routes.map((route) => route.id));
  for (const edge of shard.edges) {
    if (!stopIds.has(edge.from) || !stopIds.has(edge.to)) fail(`edge dangles ${edge.from}→${edge.to}`);
    if (!(edge.medianSec > 0)) fail(`edge non-positive time ${edge.from}→${edge.to}`);
    if (!routeIds.has(edge.route)) fail(`edge references unknown route ${edge.route}`);
  }
  const STRUCTURES = new Set(["underground", "elevated", "open_cut", "embankment", "at_grade"]);
  for (const edge of shard.edges) {
    if (!edge.structure) continue;
    // Shares of one segment: a sum past 1 means the join is describing more
    // than the segment it is attached to. 1.01 absorbs two-decimal rounding.
    let sum = 0;
    for (const [key, share] of Object.entries(edge.structure)) {
      if (!STRUCTURES.has(key)) fail(`edge ${edge.from}→${edge.to} has structure ${key}`);
      if (!(share > 0 && share <= 1)) fail(`edge ${edge.from}→${edge.to} share ${key}=${share}`);
      sum += share;
    }
    if (sum > 1.01) fail(`edge ${edge.from}→${edge.to} structure shares sum to ${sum}`);
  }
  for (const row of shard.headways) {
    if (!routeIds.has(row.route)) fail(`headway references unknown route ${row.route}`);
    // 24-27 are legal: a departure after midnight keeps the previous service
    // day's hour. Anything else means the hour stopped meaning what it says.
    if (!Number.isInteger(row.hour) || row.hour < 0 || row.hour > 27) {
      fail(`headway for ${row.route} has hour ${row.hour}, outside the 0-27 service day`);
    }
  }
  if (shard.kind === "bus-shard") {
    // A bus shard is scoped to the routes its own edges use. The subway shard is
    // not checked this way: its routes come from routes.txt and a route whose
    // edges were all dropped as sparse legitimately has none.
    const used = new Set(shard.edges.map((edge) => edge.route));
    for (const route of shard.routes) {
      if (!used.has(route.id)) fail(`route ${route.id} has no edge in this shard`);
    }
  }
  for (const transfer of shard.transfers ?? []) {
    if (!stopIds.has(transfer.from) || !stopIds.has(transfer.to)) {
      fail(`transfer dangles ${transfer.from}→${transfer.to}`);
    }
  }
}

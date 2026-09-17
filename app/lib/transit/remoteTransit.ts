/**
 * Fetches the published NYC transit dataset: pointer → manifest → shards.
 *
 * Every hop is verified against the digest the previous hop published, so a
 * shard is parsed only once its bytes are proven to be the ones
 * `server/transit-prep` built. Nothing here knows about routing — this module
 * turns a base URL into typed shards and stops.
 *
 * Absent `VITE_TRANSIT_BASE`, every entry point returns `null`: the feature is
 * off and callers fall back to whatever they did before.
 */

import {
  MAX_MANIFEST_BYTES,
  parseTransitManifest,
  parseTransitPointer,
  parseTransitShard,
  type GeoBounds,
  type TransitManifest,
  type TransitPointer,
  type TransitShard,
  type TransitShardRef,
} from "./shardContract";

export interface TransitDataset {
  generation: string;
  manifest: TransitManifest;
  /** Keyed by shard key (`subway.json`), holding only the shards asked for. */
  shards: Map<string, TransitShard>;
}

/** Which shards a caller wants. Bus is off until Track E's bus slice lands. */
export interface ShardSelection {
  subway?: boolean;
  bus?: boolean;
}

export const SUBWAY_SHARD_KEY = "subway.json";
const BUS_SHARD_PREFIX = "bus-";

function configuredBase(): string | undefined {
  const value = (import.meta.env.VITE_TRANSIT_BASE ?? "").trim().replace(/\/$/, "");
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_TRANSIT_BASE must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
    throw new Error("VITE_TRANSIT_BASE must be an HTTPS origin without a path");
  return url.origin;
}

/** `undefined` when the transit dataset is not configured for this build. */
export function transitApiBase(): string | undefined {
  return configuredBase();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches the tiny mutable pointer. `cache: "default"` on purpose: the pointer
 * ships `max-age=300`, and honouring that TTL keeps a route calculation from
 * paying a round trip for a document that changes when a generation is
 * promoted — minutes at the very best, usually days.
 */
export async function loadTransitPointer(signal?: AbortSignal): Promise<TransitPointer | null> {
  const base = configuredBase();
  if (!base) return null;
  const response = await fetch(`${base}/transit/nyc/current.json`, {
    signal,
    headers: { Accept: "application/json" },
    cache: "default",
  });
  if (!response.ok) throw new Error(`NYC transit pointer request failed (${response.status})`);
  return parseTransitPointer(await response.json());
}

/** Fetches the manifest and verifies its bytes against the pointer's digest. */
export async function loadTransitManifest(
  pointer: TransitPointer,
  signal?: AbortSignal,
): Promise<TransitManifest> {
  const base = configuredBase();
  if (!base) throw new Error("VITE_TRANSIT_BASE is not configured");
  const response = await fetch(`${base}/${pointer.manifestPath}`, {
    signal,
    headers: { Accept: "application/json" },
    cache: "default",
  });
  if (!response.ok) throw new Error(`NYC transit manifest request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new Error("NYC transit manifest exceeds its budget");
  if ((await sha256Hex(bytes)) !== pointer.manifestSha256)
    throw new Error("NYC transit manifest hash mismatch");
  return parseTransitManifest(JSON.parse(new TextDecoder().decode(bytes)), pointer.generation);
}

/**
 * Fetches one immutable shard, verifying both the byte count the manifest
 * promised and its digest before the JSON is parsed. A shard that is the right
 * length but the wrong bytes fails here, not three hops later in the router.
 */
export async function loadTransitShard(
  pointer: TransitPointer,
  ref: TransitShardRef,
  signal?: AbortSignal,
): Promise<TransitShard> {
  const base = configuredBase();
  if (!base) throw new Error("VITE_TRANSIT_BASE is not configured");
  const dir = pointer.manifestPath.slice(0, pointer.manifestPath.lastIndexOf("/"));
  const response = await fetch(`${base}/${dir}/${ref.key}`, {
    signal,
    headers: { Accept: "application/json" },
    // Shards are served `immutable` under a content-addressed generation.
    cache: "force-cache",
  });
  if (!response.ok)
    throw new Error(`NYC transit shard request failed (${ref.key}, ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.bytes)
    throw new Error(`NYC transit shard byte contract mismatch (${ref.key})`);
  if ((await sha256Hex(bytes)) !== ref.sha256)
    throw new Error(`NYC transit shard hash mismatch (${ref.key})`);
  return parseTransitShard(JSON.parse(new TextDecoder().decode(bytes)), ref);
}

/** Two rectangles overlap, touching edges included. */
function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/**
 * Picks shards by kind, then by extent where the manifest publishes one.
 *
 * Kind is the fallback, not the refinement: a ref without `bounds` is selected
 * exactly as it was before the field existed, because the manifest deployed in
 * production predates it and a missing extent says nothing about coverage.
 * Where bounds *are* published, a shard that cannot reach `bbox` is dropped
 * before it is fetched — which is the only way a user outside New York avoids
 * paying for a graph that is then discarded (#388).
 */
export function selectShardRefs(
  manifest: TransitManifest,
  selection: ShardSelection,
  bbox?: GeoBounds,
): TransitShardRef[] {
  return manifest.shards.filter((ref) => {
    const wanted = ref.key === SUBWAY_SHARD_KEY
      ? (selection.subway ?? false)
      : ref.key.startsWith(BUS_SHARD_PREFIX)
        ? (selection.bus ?? false)
        : false;
    if (!wanted) return false;
    if (!bbox || !ref.bounds) return true;
    return boundsIntersect(ref.bounds, bbox);
  });
}

let cached: TransitDataset | undefined;

/**
 * Loads the selected shards, reusing anything already held for the same
 * generation. A promoted generation drops the cache wholesale rather than
 * mixing shards across generations — stop ids are only meaningful within one.
 *
 * `bbox` narrows the selection to shards whose published extent reaches it, and
 * returns `null` without fetching any when none does. Omit it to select on kind
 * alone, as before.
 */
export async function loadTransitDataset(
  selection: ShardSelection,
  bbox?: GeoBounds,
  signal?: AbortSignal,
): Promise<TransitDataset | null> {
  const pointer = await loadTransitPointer(signal);
  if (!pointer) return null;

  if (cached && cached.generation !== pointer.generation) cached = undefined;
  const manifest = cached?.manifest ?? (await loadTransitManifest(pointer, signal));
  const refs = selectShardRefs(manifest, selection, bbox);
  if (refs.length === 0) return null;

  const shards = new Map(cached?.shards ?? []);
  const missing = refs.filter((ref) => !shards.has(ref.key));
  const loaded = await Promise.all(
    missing.map(async (ref) => [ref.key, await loadTransitShard(pointer, ref, signal)] as const),
  );
  for (const [key, shard] of loaded) shards.set(key, shard);

  cached = { generation: pointer.generation, manifest, shards };
  return {
    generation: pointer.generation,
    manifest,
    shards: new Map(refs.map((ref) => [ref.key, shards.get(ref.key)!])),
  };
}

/** Test seam: the module cache outlives a single route calculation by design. */
export function clearTransitCache(): void {
  cached = undefined;
}

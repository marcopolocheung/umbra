/**
 * Fetches the published NYC navigation dataset: pointer → manifest → shards.
 *
 * Every hop is verified against the digest the previous hop published, so a
 * shard is parsed only once its bytes are proven to be the ones
 * `server/navigation-prep` built. Nothing here knows about routing or shadow
 * sampling — this module turns a base URL into typed shards and stops. The
 * adapters that build `RoutingGraph` and `PrismSet` objects land in later
 * checkpoints and consume the snapshot and selection types below.
 *
 * Absent `VITE_NAVIGATION_BASE`, every entry point returns `null`: the feature
 * is off and callers fall back to whatever they did before, without a single
 * network request.
 */

import {
  estimateBuildingShardDecodedBytes,
  estimateStreetShardDecodedBytes,
  type NavigationPhases,
} from "./navigationPhases";
import {
  MAX_BUILDING_SHARD_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STREET_SHARD_BYTES,
  parseNavigationBuildingShard,
  parseNavigationManifest,
  parseNavigationPointer,
  parseNavigationStreetShard,
  type GeoBounds,
  type NavigationBuildingShard,
  type NavigationBuildingShardRef,
  type NavigationManifest,
  type NavigationPointer,
  type NavigationStreetShard,
  type NavigationStreetShardRef,
} from "./shardContract";

/** A route-scoped pin: one verified pointer plus its manifest, one generation. */
export interface NavigationSnapshot {
  generation: string;
  manifest: NavigationManifest;
  base: string;
}

/** Verified shards for one request, drawn from a single snapshot. */
export interface NavigationSelection {
  streets: Map<string, NavigationStreetShard>;
  buildings: Map<string, NavigationBuildingShard>;
}

export interface NavigationRequestOptions {
  /** Test seam: defaults to the global fetch. */
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Per-calculation phase collector (Checkpoint 6). Counts and durations
   * only — never coordinates. Absent means unmeasured.
   */
  report?: NavigationPhases;
}

export interface NavigationSelectionRequest extends NavigationRequestOptions {
  /**
   * How far beyond the requested bbox a building may stand and still be
   * selected as a shadow caster. Defaults to the same 400 m the shadow field
   * already pads its sampling queries with.
   */
  casterReachM?: number;
}

/** Mirrors the shadow field's query padding: casters outside it cannot reach in. */
export const DEFAULT_CASTER_REACH_M = 400;

/** The pointer is ~200 bytes of JSON; anything larger is not a pointer. */
const MAX_POINTER_BYTES = 8_192;

function configuredBase(): string | undefined {
  const value = (import.meta.env.VITE_NAVIGATION_BASE ?? "").trim().replace(/\/$/, "");
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_NAVIGATION_BASE must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
    throw new Error("VITE_NAVIGATION_BASE must be an HTTPS origin without a path");
  return url.origin;
}

/** `undefined` when the navigation dataset is not configured for this build. */
export function navigationApiBase(): string | undefined {
  return configuredBase();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

/**
 * Races a shared fetch against one waiter's signal without wiring the signal
 * into the fetch itself: a cancelled waiter rejects here while the shared
 * request continues for the callers that still need it.
 */
function withCallerSignal<T>(shared: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/** In-flight immutable fetches, keyed by URL. Entries are deleted on settle. */
const inflight = new Map<string, Promise<unknown>>();

function getOrFetch<T>(url: string, task: () => Promise<T>): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;
  const pending = task();
  inflight.set(url, pending);
  const cleanup = () => {
    if (inflight.get(url) === pending) inflight.delete(url);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

/**
 * Fetches the tiny mutable pointer. `cache: "default"` on purpose: the pointer
 * ships a short cache lifetime, and honouring that policy keeps a route
 * calculation from paying a round trip for a document that changes only when a
 * generation is promoted. Concurrent callers share one in-flight request.
 */
export async function loadNavigationPointer(
  options?: NavigationRequestOptions,
): Promise<NavigationPointer | null> {
  const base = configuredBase();
  if (!base) return null;
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const url = `${base}/navigation/nyc/current.json`;
  const report = options?.report;
  const shared = getOrFetch(url, async () => {
    const started = globalThis.performance?.now?.() ?? 0;
    try {
      const response = await fetchFn(url, {
        headers: { Accept: "application/json" },
        cache: "default",
      });
      if (!response.ok)
        throw new Error(`NYC navigation pointer request failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_POINTER_BYTES)
        throw new Error("NYC navigation pointer exceeds its budget");
      return parseNavigationPointer(decodeJson(bytes, "NYC navigation pointer"));
    } finally {
      if (report) report.pointerMs += (globalThis.performance?.now?.() ?? 0) - started;
    }
  });
  return withCallerSignal(shared, options?.signal);
}

/**
 * Fetches the manifest and verifies its exact bytes against the pointer's
 * digest before anything is parsed. Immutable under its generation path, so
 * `force-cache`: revalidation traffic buys nothing for content-addressed bytes.
 */
export async function loadNavigationManifest(
  pointer: NavigationPointer,
  options?: NavigationRequestOptions,
): Promise<NavigationManifest> {
  const base = configuredBase();
  if (!base) throw new Error("VITE_NAVIGATION_BASE is not configured");
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const url = `${base}/${pointer.manifestPath}`;
  const report = options?.report;
  const shared = getOrFetch(url, async () => {
    const started = globalThis.performance?.now?.() ?? 0;
    try {
      const response = await fetchFn(url, {
        headers: { Accept: "application/json" },
        cache: "force-cache",
      });
      if (!response.ok)
        throw new Error(`NYC navigation manifest request failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_MANIFEST_BYTES)
        throw new Error("NYC navigation manifest exceeds its budget");
      if ((await sha256Hex(bytes)) !== pointer.manifestSha256)
        throw new Error("NYC navigation manifest hash mismatch");
      return parseNavigationManifest(decodeJson(bytes, "NYC navigation manifest"), pointer.generation);
    } finally {
      if (report) report.manifestMs += (globalThis.performance?.now?.() ?? 0) - started;
    }
  });
  return withCallerSignal(shared, options?.signal);
}

function shardUrl(base: string, generation: string, key: string): string {
  // The contract's key patterns admit only `streets/<cell>.json` and
  // `buildings/<cell>.json`; the segment check below is the belt to those
  // suspenders, so a corrupt manifest can never steer a fetch outside the
  // generation directory.
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new Error("NYC navigation shard key is not a safe object path");
  return `${base}/navigation/nyc/${generation}/${key}`;
}

function boundsEqual(a: GeoBounds, b: GeoBounds): boolean {
  return a.south === b.south && a.west === b.west && a.north === b.north && a.east === b.east;
}

/**
 * Fetches one immutable street shard, verifying exact byte count, digest,
 * schema, generation, bounds, and counts before returning it. A shard that is
 * the right length but the wrong bytes fails here, not three hops later in
 * the router.
 */
export async function loadNavigationStreetShard(
  snapshot: NavigationSnapshot,
  ref: NavigationStreetShardRef,
  options?: NavigationRequestOptions,
): Promise<NavigationStreetShard> {
  if (!configuredBase()) throw new Error("VITE_NAVIGATION_BASE is not configured");
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const url = shardUrl(snapshot.base, snapshot.generation, ref.key);
  const report = options?.report;
  const shared = getOrFetch(url, async () => {
    const now = () => globalThis.performance?.now?.() ?? 0;
    const tTransfer = now();
    const response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      // Shards are served `immutable` under a content-addressed generation.
      cache: "force-cache",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (report) {
      report.streetTransferMs += now() - tTransfer;
      report.streetTransferBytes += bytes.byteLength;
    }
    if (!response.ok)
      throw new Error(`NYC navigation street shard request failed (${ref.key}, ${response.status})`);
    const tVerify = now();
    if (bytes.byteLength > MAX_STREET_SHARD_BYTES)
      throw new Error(`NYC navigation street shard exceeds its budget (${ref.key})`);
    if (bytes.byteLength !== ref.bytes)
      throw new Error(`NYC navigation street shard byte contract mismatch (${ref.key})`);
    if ((await sha256Hex(bytes)) !== ref.sha256)
      throw new Error(`NYC navigation street shard hash mismatch (${ref.key})`);
    if (report) report.streetVerifyMs += now() - tVerify;
    const tDecode = now();
    const shard = parseNavigationStreetShard(
      decodeJson(bytes, `NYC navigation street shard (${ref.key})`),
      ref,
      snapshot.generation,
    );
    // The digest already binds these bytes to this ref; the equality check
    // names the failure when a publisher files a shard under the wrong cell.
    if (!boundsEqual(shard.geometryBounds, ref.geometryBounds))
      throw new Error(`NYC navigation street shard bounds mismatch (${ref.key})`);
    if (!boundsEqual(shard.supportBounds, ref.supportBounds))
      throw new Error(`NYC navigation street shard support mismatch (${ref.key})`);
    if (report) {
      report.streetDecodeMs += now() - tDecode;
      report.streetShardsFetched += 1;
      report.streetRefNodes += ref.nodes;
      report.streetRefEdges += ref.edges;
      report.streetDecodedBytesEstimate += estimateStreetShardDecodedBytes(shard);
    }
    return shard;
  });
  return withCallerSignal(shared, options?.signal);
}

/** Same integrity chain as the street shards, for one building shard. */
export async function loadNavigationBuildingShard(
  snapshot: NavigationSnapshot,
  ref: NavigationBuildingShardRef,
  options?: NavigationRequestOptions,
): Promise<NavigationBuildingShard> {
  if (!configuredBase()) throw new Error("VITE_NAVIGATION_BASE is not configured");
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const url = shardUrl(snapshot.base, snapshot.generation, ref.key);
  const report = options?.report;
  const shared = getOrFetch(url, async () => {
    const now = () => globalThis.performance?.now?.() ?? 0;
    const tTransfer = now();
    const response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      cache: "force-cache",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (report) {
      report.buildingTransferMs += now() - tTransfer;
      report.buildingTransferBytes += bytes.byteLength;
    }
    if (!response.ok)
      throw new Error(`NYC navigation building shard request failed (${ref.key}, ${response.status})`);
    const tVerify = now();
    if (bytes.byteLength > MAX_BUILDING_SHARD_BYTES)
      throw new Error(`NYC navigation building shard exceeds its budget (${ref.key})`);
    if (bytes.byteLength !== ref.bytes)
      throw new Error(`NYC navigation building shard byte contract mismatch (${ref.key})`);
    if ((await sha256Hex(bytes)) !== ref.sha256)
      throw new Error(`NYC navigation building shard hash mismatch (${ref.key})`);
    if (report) report.buildingVerifyMs += now() - tVerify;
    const tDecode = now();
    const shard = parseNavigationBuildingShard(
      decodeJson(bytes, `NYC navigation building shard (${ref.key})`),
      ref,
      snapshot.generation,
    );
    if (!boundsEqual(shard.geometryBounds, ref.geometryBounds))
      throw new Error(`NYC navigation building shard bounds mismatch (${ref.key})`);
    if (!boundsEqual(shard.supportBounds, ref.supportBounds))
      throw new Error(`NYC navigation building shard support mismatch (${ref.key})`);
    if (report) {
      report.buildingDecodeMs += now() - tDecode;
      report.buildingShardsFetched += 1;
      report.buildingRefCount += ref.buildings;
      report.buildingDecodedBytesEstimate += estimateBuildingShardDecodedBytes(shard);
    }
    return shard;
  });
  return withCallerSignal(shared, options?.signal);
}

/**
 * Loads an already-selected set of street refs through one pinned snapshot,
 * reusing the generation decoded cache — the same serve/fetch semantics the
 * bbox loader applies.
 *
 * `fetchBestRoutingGraph` selects refs itself (primary bbox plus bounded
 * access zones), so it needs the selected-refs twin of `loadNavigationSelection`
 * rather than the bbox form: cached shards are served from memory, missing
 * ones fetch and verify, and a failure throws for the whole selection.
 */
export async function loadNavigationStreetShards(
  snapshot: NavigationSnapshot,
  refs: NavigationStreetShardRef[],
  options?: NavigationSelectionRequest,
): Promise<NavigationStreetShard[]> {
  const useCache = cached && cached.generation === snapshot.generation ? cached : undefined;
  const missing = refs.filter((ref) => !useCache?.streets.has(ref.key));

  const report = options?.report;
  if (report) {
    report.streetShardsServed += refs.length - missing.length;
    if (useCache) {
      for (const ref of refs) {
        const shard = useCache.streets.get(ref.key);
        if (shard) {
          report.streetRefNodes += ref.nodes;
          report.streetRefEdges += ref.edges;
          report.streetDecodedBytesEstimate += estimateStreetShardDecodedBytes(shard);
        }
      }
    }
  }

  const loaded = await Promise.all(
    missing.map(async (ref) => [ref.key, await loadNavigationStreetShard(snapshot, ref, options)] as const),
  );

  // Cache only into a cache that still belongs to this snapshot's generation.
  const target = cached && cached.generation === snapshot.generation ? cached : undefined;
  if (target) {
    for (const [key, shard] of loaded) target.streets.set(key, shard);
  }

  return refs.map((ref) => {
    const shard = target?.streets.get(ref.key);
    if (!shard)
      throw new Error(`NYC navigation street shard missing from verified selection (${ref.key})`);
    return shard;
  });
}

/**
 * Loads an already-selected set of building refs through one pinned snapshot,
 * reusing the generation decoded cache exactly like the streets path does.
 *
 * The static prism provider selects refs by caster reach itself (a padded
 * query the manifest selection does not describe), so it needs the
 * selected-refs twin of `loadNavigationSelection` rather than the bbox form:
 * cached shards are served from memory, missing ones fetch and verify, and
 * nothing partial publishes when one fails.
 */
export async function loadNavigationBuildingShards(
  snapshot: NavigationSnapshot,
  refs: NavigationBuildingShardRef[],
  options?: NavigationSelectionRequest,
): Promise<NavigationBuildingShard[]> {
  const useCache = cached && cached.generation === snapshot.generation ? cached : undefined;
  const missing = refs.filter((ref) => !useCache?.buildings.has(ref.key));

  const report = options?.report;
  if (report) {
    report.buildingShardsServed += refs.length - missing.length;
    if (useCache) {
      for (const ref of refs) {
        const shard = useCache.buildings.get(ref.key);
        if (shard) {
          report.buildingRefCount += ref.buildings;
          report.buildingDecodedBytesEstimate += estimateBuildingShardDecodedBytes(shard);
        }
      }
    }
  }

  const loaded = await Promise.all(
    missing.map(async (ref) => [ref.key, await loadNavigationBuildingShard(snapshot, ref, options)] as const),
  );

  // Cache only into a cache that still belongs to this snapshot's generation.
  const target = cached && cached.generation === snapshot.generation ? cached : undefined;
  if (target) {
    for (const [key, shard] of loaded) target.buildings.set(key, shard);
  }

  return refs.map((ref) => {
    const shard = target?.buildings.get(ref.key);
    if (!shard)
      throw new Error(`NYC navigation building shard missing from verified selection (${ref.key})`);
    return shard;
  });
}

/** Two rectangles overlap, touching edges included. */
function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function boundsContain(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  );
}

/** Pads a bbox by metres in every direction, clamped to valid lat/lon. */
function expandBounds(bbox: GeoBounds, meters: number): GeoBounds {
  const midLat = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
  const latPad = meters / 111_320;
  const lonPad = meters / (111_320 * Math.max(Math.cos(midLat), 0.2));
  return {
    south: Math.max(-90, bbox.south - latPad),
    west: Math.max(-180, bbox.west - lonPad),
    north: Math.min(90, bbox.north + latPad),
    east: Math.min(180, bbox.east + lonPad),
  };
}

export interface NavigationShardSelection {
  streets: NavigationStreetShardRef[];
  buildings: NavigationBuildingShardRef[];
}

/**
 * Picks shard refs for one request without fetching anything.
 *
 * Streets select by owner-cell geometry intersecting the requested bbox; seam
 * connectivity across cells is the producer's ghost-node job, so no halo is
 * added here. Buildings select by geometry intersecting the bbox expanded by
 * caster reach, because a footprint outside the route bbox can still cast onto
 * it. Touching counts as intersecting on both paths: a cell edge is a
 * boundary, not a gap.
 *
 * Returns `null` when the request falls outside the manifest's verified
 * support — "outside coverage", which the caller answers with its existing
 * fallback. A non-null selection with empty lists is the other case the
 * contract distinguishes: covered, and nothing published there.
 */
export function selectNavigationShards(
  manifest: NavigationManifest,
  bbox: GeoBounds,
  casterReachM: number = DEFAULT_CASTER_REACH_M,
): NavigationShardSelection | null {
  return selectNavigationShardsForBoxes(manifest, bbox, [], casterReachM);
}

/**
 * The bounded access zone around one trip endpoint for transit boarding and
 * alighting. A selected station can stand up to the transit candidate radius
 * from the endpoint, and its doors up to the entrance-match box beyond that,
 * so the zone is a point bbox expanded by that reach — never the rectangle
 * spanning every candidate station.
 */
export function zoneAround(lon: number, lat: number, radiusM: number): GeoBounds {
  return expandBounds({ south: lat, west: lon, north: lat, east: lon }, radiusM);
}

/**
 * Picks shard refs for a primary bbox plus bounded extra boxes — the transit
 * access zones around the trip endpoints. The primary bbox must be fully
 * covered or the whole selection declines (`null`, as above); extras are
 * best-effort, so a zone reaching past the support boundary adds the shards
 * it overlaps without failing the covered route. Every returned ref still
 * verifies before use, so the union is fully static or nothing.
 */
export function selectNavigationShardsForBoxes(
  manifest: NavigationManifest,
  primary: GeoBounds,
  extras: GeoBounds[],
  casterReachM: number = DEFAULT_CASTER_REACH_M,
): NavigationShardSelection | null {
  if (!boundsContain(manifest.supportBounds, primary)) return null;
  const boxes = [primary, ...extras];
  const reach = Number.isFinite(casterReachM) && casterReachM > 0 ? casterReachM : 0;
  const casterBoxes = boxes.map((box) => expandBounds(box, reach));
  return {
    streets: manifest.streetShards.filter((ref) =>
      boxes.some((box) => boundsIntersect(ref.geometryBounds, box)),
    ),
    buildings: manifest.buildingShards.filter((ref) =>
      casterBoxes.some((box) => boundsIntersect(ref.geometryBounds, box)),
    ),
  };
}

interface GenerationCache {
  generation: string;
  manifest: NavigationManifest;
  streets: Map<string, NavigationStreetShard>;
  buildings: Map<string, NavigationBuildingShard>;
}

let cached: GenerationCache | undefined;

/**
 * Acquires one route-scoped snapshot: the current pointer plus its verified
 * manifest, pinned to a single generation. Streets and buildings for a
 * calculation must both be loaded through the returned snapshot, so a pointer
 * promoted mid-calculation cannot mix generations inside one route.
 *
 * Returns `null` without any request when the dataset is not configured. A
 * promoted generation drops the decoded cache wholesale by replacing it —
 * single-assignment, so readers never see a half-rolled cache.
 */
export async function acquireNavigationSnapshot(
  options?: NavigationRequestOptions,
): Promise<NavigationSnapshot | null> {
  const base = configuredBase();
  if (!base) return null;
  if (options?.signal?.aborted) throw abortReason(options.signal);
  const pointer = await loadNavigationPointer(options);
  if (!pointer) return null;
  const report = options?.report;
  if (cached && cached.generation === pointer.generation) {
    if (report) report.snapshotGenerationCacheHit = true;
    return { generation: pointer.generation, manifest: cached.manifest, base };
  }
  const manifest = await loadNavigationManifest(pointer, options);
  cached = {
    generation: pointer.generation,
    manifest,
    streets: new Map(),
    buildings: new Map(),
  };
  return { generation: pointer.generation, manifest, base };
}

/**
 * Loads every selected shard through one pinned snapshot. Either the whole
 * selection verifies and is returned, or the request throws and nothing
 * partial is published: callers fall back for the whole request, never for
 * half of it. Returns `null` without fetching any shard when the bbox falls
 * outside the snapshot's verified support.
 */
export async function loadNavigationSelection(
  snapshot: NavigationSnapshot,
  bbox: GeoBounds,
  options?: NavigationSelectionRequest,
): Promise<NavigationSelection | null> {
  if (!configuredBase()) throw new Error("VITE_NAVIGATION_BASE is not configured");
  if (options?.signal?.aborted) throw abortReason(options.signal);
  const refs = selectNavigationShards(snapshot.manifest, bbox, options?.casterReachM);
  if (!refs) return null;

  const useCache = cached && cached.generation === snapshot.generation ? cached : undefined;
  const missingStreets = refs.streets.filter((ref) => !useCache?.streets.has(ref.key));
  const missingBuildings = refs.buildings.filter((ref) => !useCache?.buildings.has(ref.key));

  // Served-from-cache accounting happens here, where the selection is known;
  // fetched shards accrue their counts inside the loaders (report-aware).
  const report = options?.report;
  if (report) {
    report.streetShardsServed += refs.streets.length - missingStreets.length;
    report.buildingShardsServed += refs.buildings.length - missingBuildings.length;
    if (useCache) {
      for (const ref of refs.streets) {
        const shard = useCache.streets.get(ref.key);
        if (shard) {
          report.streetRefNodes += ref.nodes;
          report.streetRefEdges += ref.edges;
          report.streetDecodedBytesEstimate += estimateStreetShardDecodedBytes(shard);
        }
      }
      for (const ref of refs.buildings) {
        const shard = useCache.buildings.get(ref.key);
        if (shard) {
          report.buildingRefCount += ref.buildings;
          report.buildingDecodedBytesEstimate += estimateBuildingShardDecodedBytes(shard);
        }
      }
    }
  }

  // One shared fetch per shard: concurrent identical requests coalesce in
  // `getOrFetch`, and each waiter's abort races without touching the others.
  const [streets, buildings] = await Promise.all([
    Promise.all(
      missingStreets.map(async (ref) => [ref.key, await loadNavigationStreetShard(snapshot, ref, options)] as const),
    ),
    Promise.all(
      missingBuildings.map(
        async (ref) => [ref.key, await loadNavigationBuildingShard(snapshot, ref, options)] as const),
    ),
  ]);

  // Cache only into a cache that still belongs to this generation: a rollover
  // that landed mid-flight must not absorb shards from the old one.
  const target = cached && cached.generation === snapshot.generation ? cached : undefined;
  if (target) {
    for (const [key, shard] of streets) target.streets.set(key, shard);
    for (const [key, shard] of buildings) target.buildings.set(key, shard);
  }

  return {
    streets: collectShards(refs.streets, useCache?.streets, streets),
    buildings: collectShards(refs.buildings, useCache?.buildings, buildings),
  };
}

function collectShards<T>(
  refs: ReadonlyArray<{ key: string }>,
  cachedShards: Map<string, T> | undefined,
  loaded: ReadonlyArray<readonly [string, T]>,
): Map<string, T> {
  const merged = new Map(cachedShards);
  for (const [key, shard] of loaded) merged.set(key, shard);
  return new Map(
    refs.map((ref) => {
      const shard = merged.get(ref.key);
      if (!shard) throw new Error(`NYC navigation shard missing from verified selection (${ref.key})`);
      return [ref.key, shard] as const;
    }),
  );
}

/** Test seam: the decoded cache outlives a single route calculation by design. */
export function clearNavigationCache(): void {
  cached = undefined;
  inflight.clear();
}

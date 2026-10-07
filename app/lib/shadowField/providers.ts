/**
 * Live `PrismProvider`s — the two real sources behind `ShadowField`.
 *
 * A2 published the provider contract and shipped only `staticPrismProvider`, which
 * is enough for tests and for callers already holding geometry. These are the ones
 * the app uses: MapTiler vector tiles (fast, synchronous, viewport-scoped) and
 * Overpass (slower, async, works anywhere). Order them tiles-first, so the network
 * path runs only where the renderer has nothing loaded.
 *
 * The contract's one hard rule is what makes both of these honest: `prismsFor`
 * returns `null` when the provider cannot speak for an area, never an empty set.
 * A tile provider asked about a bbox off-screen has no buildings *and no knowledge*,
 * and reporting the first without the second is how a route ends up confidently
 * promising shadow that isn't there.
 *
 * A7 added a canopy provider over Overpass's tagged trees and A8d one over the
 * Meta/WRI height raster. Both obey the same rule, and the raster one is the reason
 * this file is no longer only about prisms.
 */

import {
  type BuildingFootprint,
  type CanopyFeature,
  fetchBuildingFootprintsAround,
  fetchCanopyAround,
} from "../overpass";
import type { CanopyTileStore } from "../canopyRaster/canopyTileStore";
import { sharedCanopyTileStore } from "../canopyRaster/sharedStore";
import {
  NYC_BOUNDS,
  type ShedPermit,
  type ShedPermitResult,
  fetchShedPermits,
} from "../../services/sidewalkSheds";
import type {
  BBox,
  CanopyProvider,
  CanopyRasterProvider,
  EdgeRef,
  PrismProvider,
  ShedProvider,
} from "./ShadowField";
import { bboxContains } from "./ShadowField";
import { prismsFromCanopy } from "./canopy";
import { shedPrismsFromPermits } from "./sheds";
import { type CanopyHeightField, createCanopyHeightField } from "./canopyRasterField";
import {
  type BuildingFeatureLike,
  type PrismSet,
  metersPerDegree,
  prismsFromFootprints,
  prismsFromTileFeatures,
} from "./geometry";

interface PendingLoad {
  controller: AbortController;
  promise: Promise<void>;
  settled: boolean;
  waiters: number;
}

function abortError(): Error {
  const error = new Error("Shadow provider load aborted");
  error.name = "AbortError";
  return error;
}

/** Join one shared request without giving any waiter ownership of it. */
function waitForPending(
  pending: PendingLoad,
  signal: AbortSignal | undefined,
  onOrphaned: () => void,
): Promise<void> {
  pending.waiters++;
  return new Promise<void>((resolve, reject) => {
    let active = true;
    const release = (aborted: boolean) => {
      if (!active) return;
      active = false;
      signal?.removeEventListener("abort", onAbort);
      pending.waiters--;
      if (aborted && pending.waiters === 0 && !pending.settled) onOrphaned();
    };
    const onAbort = () => {
      release(true);
      reject(abortError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.promise.then(
      () => {
        release(false);
        resolve();
      },
      (error) => {
        release(false);
        reject(error);
      },
    );
  });
}

// ─── Tiles ────────────────────────────────────────────────────────────────────

/** The slice of `maplibregl.Map` the tile provider needs. `Map` satisfies this structurally. */
export interface TileMapLike {
  getZoom(): number;
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  };
  querySourceFeatures(
    source: string,
    options: { sourceLayer: string }
  ): BuildingFeatureLike[];
}

/**
 * Below this zoom MapTiler stops serving individual building geometry, so a query
 * would return a thin, misleading subset. `LocalShadowAdapter` bails at the same
 * threshold and paints nothing.
 */
const MIN_BUILDING_ZOOM = 12;

/**
 * Above this zoom the tile source serves the building layer in full; below it, it
 * serves a decimated subset that gets thinner the further out you go.
 *
 * That gap is the dangerous one. `prismsFor` still returns a non-empty `PrismSet`,
 * so `confidenceFor`'s `dataFactor` — which only asks whether *any* prism came back
 * — sees buildings and docks nothing, and the field reports a confident, nearly
 * shadowless street. Measured in Chromium on the same Midtown route at the same time,
 * the reported shadow fell from 83% at z16.3 to 53% at z14 and 9% at z13 purely
 * because of what the tile layer contained.
 */
const COMPLETE_BUILDING_ZOOM = 15;

/**
 * What a decimated tile answer is worth, as a multiplier on the tile prior.
 *
 * Chosen to put the result under `LOW_CONFIDENCE` (0.8 × 0.5 = 0.4), i.e. "do not
 * route on this — ask the other source". That is a deliberate policy, not a measured
 * quantity: this repo has no corpus that can price partial building coverage, and the
 * agreement harness cannot supply one because it compares the field and the pixel
 * sampler over *identical* prisms. Like `SOURCE_BASE_CONFIDENCE`, it is a prior that
 * a real corpus should replace.
 */
const DECIMATED_COMPLETENESS = 0.5;

const TILE_SOURCE = "maptiler_planet";
const TILE_LAYER = "building";

/**
 * Prisms from whatever the renderer currently has loaded.
 *
 * Synchronous and free of network, but it can only answer for the current viewport —
 * `querySourceFeatures` sees loaded tiles, not the world. That viewport dependence is
 * the very thing Track A exists to remove from routing, so this provider goes first
 * for speed and the Overpass one behind it for reach.
 *
 * The query and the prism assembly are cached against the map's current view, because
 * sampling a route asks for the same bbox once per edge and `querySourceFeatures` plus
 * earcut is the expensive half of a shadow calculation.
 */
export function createTilePrismProvider(getMap: () => TileMapLike | null): PrismProvider {
  let cached: { key: string; set: PrismSet } | null = null;

  return {
    source: "tiles",

    completeness() {
      const map = getMap();
      if (!map) return 0;
      return map.getZoom() >= COMPLETE_BUILDING_ZOOM ? 1 : DECIMATED_COMPLETENESS;
    },

    prismsFor(bbox) {
      const map = getMap();
      if (!map) return null;

      const zoom = map.getZoom();
      if (zoom < MIN_BUILDING_ZOOM) return null;

      const bounds = map.getBounds();
      const loaded: BBox = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
      // Off-screen means "I don't know", not "no buildings".
      if (!bboxContains(loaded, bbox)) return null;

      const key = [
        zoom.toFixed(3),
        loaded.west.toFixed(6),
        loaded.south.toFixed(6),
        loaded.east.toFixed(6),
        loaded.north.toFixed(6),
      ].join(",");

      if (cached?.key === key) return cached.set;

      const set = prismsFromTileFeatures(
        map.querySourceFeatures(TILE_SOURCE, { sourceLayer: TILE_LAYER })
      );
      cached = { key, set };
      return set;
    },
  };
}

// ─── Overpass ─────────────────────────────────────────────────────────────────

/**
 * The largest area one Overpass call may be asked for, as a radius in metres.
 *
 * `fetchBuildingFootprintsAround` gives Overpass a 10 s query timeout and aborts at
 * 12 s; a city-scale bbox blows through both and returns nothing useful. Rather than
 * issue a request that will fail, the provider declines the bbox — which is what
 * `null` means — and the caller falls back. A route longer than this needs the bbox
 * split, which belongs with A5's worker rather than here.
 */
const MAX_FETCH_RADIUS_M = 1500;

/** How many fetched areas to keep. Small on purpose — each holds every prism in ~3 km². */
const CACHE_ENTRIES = 4;

interface CacheEntry {
  coverage: BBox;
  set: PrismSet;
}

/** The half-diagonal of a bbox in metres — the radius that covers all of it. */
export function bboxRadiusM(bbox: BBox): number {
  const { mPerLat, mPerLng } = metersPerDegree((bbox.south + bbox.north) / 2);
  const halfWidthM = ((bbox.east - bbox.west) * mPerLng) / 2;
  const halfHeightM = ((bbox.north - bbox.south) * mPerLat) / 2;
  return Math.sqrt(halfWidthM * halfWidthM + halfHeightM * halfHeightM);
}

function centreOf(bbox: BBox): [number, number] {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

/** The bbox `fetchBuildingFootprintsAround` actually covers for a centre and radius. */
function coverageFor(lng: number, lat: number, radiusM: number): BBox {
  const { mPerLat, mPerLng } = metersPerDegree(lat);
  return {
    west: lng - radiusM / mPerLng,
    east: lng + radiusM / mPerLng,
    south: lat - radiusM / mPerLat,
    north: lat + radiusM / mPerLat,
  };
}

/**
 * Prisms from Overpass, for areas the renderer never loaded.
 *
 * Viewport-independent and therefore the whole point of the track — but it is a
 * network call against a shared, rate-limited public service, so it only ever runs
 * from `ready()`. `prismsFor` is synchronous by contract and answers from the cache
 * or declines; it must never be the thing that decides to hit the network, or
 * sampling one route would fire a request per edge.
 */
export function createOverpassPrismProvider(opts?: {
  fetchFootprints?: (
    lng: number,
    lat: number,
    radiusM: number,
    signal?: AbortSignal
  ) => Promise<BuildingFootprint[]>;
  maxFetchRadiusM?: number;
}): PrismProvider {
  const fetchFootprints = opts?.fetchFootprints ?? fetchBuildingFootprintsAround;
  const maxRadiusM = opts?.maxFetchRadiusM ?? MAX_FETCH_RADIUS_M;
  const cache: CacheEntry[] = [];
  const inFlight = new Map<string, PendingLoad>();

  function lookup(bbox: BBox): PrismSet | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        // Most-recently-used to the front, so the small cache keeps what a route uses.
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry.set;
      }
    }
    return null;
  }

  return {
    source: "overpass",

    prismsFor(bbox) {
      return lookup(bbox);
    },

    async load(bbox, signal) {
      if (lookup(bbox)) return;
      if (signal?.aborted) throw abortError();

      // Pad the request past the requested bbox: a shadow is cast by buildings
      // *outside* the area it falls on, and a fetch that stops at the bbox edge
      // reports a sunlit street beside an unseen tower.
      const radiusM = bboxRadiusM(bbox) * 1.25;
      if (radiusM > maxRadiusM) return;

      const [lng, lat] = centreOf(bbox);
      const key = `${lng.toFixed(5)},${lat.toFixed(5)},${Math.round(radiusM)}`;

      const existing = inFlight.get(key);
      if (existing) {
        return waitForPending(existing, signal, () => {
          if (inFlight.get(key) === existing) inFlight.delete(key);
          existing.controller.abort();
        });
      }

      const pending: PendingLoad = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        settled: false,
        waiters: 0,
      };
      pending.promise = (async () => {
        try {
          const footprints = await fetchFootprints(
            lng,
            lat,
            radiusM,
            pending.controller.signal,
          );
          cache.unshift({
            coverage: coverageFor(lng, lat, radiusM),
            set: prismsFromFootprints(footprints),
          });
          if (cache.length > CACHE_ENTRIES) cache.length = CACHE_ENTRIES;
        } catch {
          // A failed fetch leaves nothing cached, so `prismsFor` keeps returning
          // null and the field reports confidence 0 — which is the honest answer
          // and the signal for the caller to fall back. Never cache the failure as
          // "no buildings here".
        } finally {
          pending.settled = true;
          if (inFlight.get(key) === pending) inFlight.delete(key);
        }
      })();

      inFlight.set(key, pending);
      return waitForPending(pending, signal, () => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
        pending.controller.abort();
      });
    },
  };
}

// ─── Canopy ───────────────────────────────────────────────────────────────────

/** Distinct months to keep prisms for per fetched area. Two straddle the leaf window. */
const MONTHS_CACHED = 4;

/**
 * Prisms for tagged tree canopy (A7).
 *
 * Shaped like the Overpass building provider and for the same reasons — a network
 * call against a shared, rate-limited public service, so `prismsFor` never triggers
 * one and `load()` is the only path to the wire. It is a *second* such call per
 * fetched area, which is why it reuses the same radius cap and the same
 * fetch-once-per-area cache rather than getting its own policy.
 *
 * The one shape difference is the date. A crown's geometry does not change with the
 * season but its opacity does, so `prismsFor` takes the moment and the built prisms are
 * memoized per month — all `crownOpacity` reads out of a date. That memo is load-bearing
 * beyond saving work: `ShadowField` keys its prepared casters on the prism array's
 * identity, so handing back a fresh array per query would miss that cache every time.
 */
export function createOverpassCanopyProvider(opts?: {
  fetchCanopy?: (
    lng: number,
    lat: number,
    radiusM: number,
    signal?: AbortSignal
  ) => Promise<CanopyFeature[]>;
  maxFetchRadiusM?: number;
}): CanopyProvider {
  const fetchCanopy = opts?.fetchCanopy ?? fetchCanopyAround;
  const maxRadiusM = opts?.maxFetchRadiusM ?? MAX_FETCH_RADIUS_M;

  interface CanopyEntry {
    coverage: BBox;
    features: CanopyFeature[];
    /** Prisms per leaf state — at most two, and only the ones actually asked for. */
    sets: Map<string, PrismSet>;
  }

  const cache: CanopyEntry[] = [];
  const inFlight = new Map<string, PendingLoad>();

  function lookup(bbox: BBox): CanopyEntry | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry;
      }
    }
    return null;
  }

  return {
    source: "canopy",

    prismsFor(bbox, when) {
      const entry = lookup(bbox);
      if (!entry) return null;

      // Keyed by month, because that is all `crownOpacity` reads out of the date. A
      // whole day's sweep hits one key, and so does every other day that month.
      const key = `${when.getUTCFullYear()}-${when.getUTCMonth()}`;
      const hit = entry.sets.get(key);
      if (hit) return hit;

      const set = prismsFromCanopy(entry.features, when);
      // Bounded like the entry cache above: a caller sweeping across seasons is not a
      // shipped path, and an unbounded map here would hold a prism array per month.
      if (entry.sets.size >= MONTHS_CACHED) {
        entry.sets.delete(entry.sets.keys().next().value as string);
      }
      entry.sets.set(key, set);
      return set;
    },

    async load(bbox, signal) {
      if (lookup(bbox)) return;
      if (signal?.aborted) throw abortError();

      // Padded exactly as the building provider pads: a crown outside the bbox still
      // casts into it, and a fetch that stops at the edge reports a sunlit pavement
      // under an unseen row of planes.
      const radiusM = bboxRadiusM(bbox) * 1.25;
      if (radiusM > maxRadiusM) return;

      const [lng, lat] = centreOf(bbox);
      const key = `${lng.toFixed(5)},${lat.toFixed(5)},${Math.round(radiusM)}`;

      const existing = inFlight.get(key);
      if (existing) {
        return waitForPending(existing, signal, () => {
          if (inFlight.get(key) === existing) inFlight.delete(key);
          existing.controller.abort();
        });
      }

      const pending: PendingLoad = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        settled: false,
        waiters: 0,
      };
      pending.promise = (async () => {
        try {
          const features = await fetchCanopy(
            lng,
            lat,
            radiusM,
            pending.controller.signal,
          );
          cache.unshift({
            coverage: coverageFor(lng, lat, radiusM),
            features,
            sets: new Map(),
          });
          if (cache.length > CACHE_ENTRIES) cache.length = CACHE_ENTRIES;
        } catch {
          // Same rule as the building provider: never cache a failure as "no trees
          // here". `prismsFor` keeps returning null, the field reports the building
          // answer alone, and nothing claims canopy was considered.
        } finally {
          pending.settled = true;
          if (inFlight.get(key) === pending) inFlight.delete(key);
        }
      })();

      inFlight.set(key, pending);
      return waitForPending(pending, signal, () => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
        pending.controller.abort();
      });
    },
  };
}

// ─── Canopy from the raster ───────────────────────────────────────────────────

/**
 * The largest area of interest the raster provider will ask the store for, as a
 * radius in metres.
 *
 * `CanopyTileStore.read` throws rather than degrading when an area of interest
 * exceeds its pixel guard, and a provider that fires a doomed read is worse than one
 * that declines: `null` is already the contract's word for "I cannot speak for this".
 * 4 km of half-diagonal is a ~5.7 km box, which at Singapore's 1.19 m ground pixel is
 * ~23 MP — inside the store's 32 MP guard, and larger than any corridor the route
 * graph will hand over.
 */
const MAX_RASTER_RADIUS_M = 4000;

/**
 * Fetched areas to keep. Each holds a decoded height field (~1–3 MB with its masks).
 *
 * `readyEdges` loads one area per 2 km sun cell, all at once, and sampling reads them
 * after; a long route spans up to ~15. Two evicted all but the last pair before they
 * were read, and those streets silently lost their canopy (#300).
 */
const RASTER_CACHE_ENTRIES = 16;

/**
 * How long `load()` will make a caller wait for a cold read, in milliseconds.
 *
 * `ShadowField.ready()` is awaited on the route-calculation path, beside the graph
 * fetch, so whatever it costs a route pays. A cold read of a route-sized area from
 * `source.coop` measured **0.9-1.9 s** across the three A3 corpus cities once
 * `geotiff.js` was given a block cache (#290) — it was 6-8.5 s without one — so the
 * raster ordinarily lands inside this budget and reaches the first route over an area
 * (`docs/notes/canopy-raster-shadow-field-2026-09-10.md`).
 *
 * The budget stays because the read is still a public research mirror over whatever
 * connection the user has, and the provider's largest area measured ~10 s even with
 * the cache. Past the budget `load()` resolves, the route calculates from whatever
 * else can speak for the area, and the fetch keeps running — the next query over that
 * area finds it cached and answers instantly. What this deliberately never does is let
 * a research mirror decide how long a route takes.
 */
const READY_BUDGET_MS = 2500;

interface RasterEntry {
  coverage: BBox;
  field: CanopyHeightField;
}

/**
 * Canopy from the Meta/WRI height raster (A8d).
 *
 * Shaped like the two Overpass providers — `fieldFor` is synchronous and answers from
 * the cache or declines, `load()` is the only path to the wire — for the same reason:
 * sampling one route asks for the same area once per edge, and a provider that fetched
 * from the synchronous path would fire a request per edge.
 *
 * What it hands back is a **height field**, not prisms. See `canopyRasterField.ts` for
 * why a route-sized patch of raster is marched rather than tessellated, and
 * `ShadowField` for where the building footprints are subtracted from it.
 *
 * The store is `sharedCanopyTileStore()` — the same instance A8f's map layer reads
 * through, so the corridor and the viewport dedupe against each other — built on
 * first use behind a dynamic import, so `geotiff.js` lands in its own chunk rather
 * than in the bundle every visitor downloads. A caller that supplies its own store —
 * every test does — never triggers it.
 */
export function createRasterCanopyProvider(opts?: {
  store?: CanopyTileStore;
  targetGroundRes?: number;
  maxRadiusM?: number;
  readyBudgetMs?: number;
}): CanopyRasterProvider {
  const maxRadiusM = opts?.maxRadiusM ?? MAX_RASTER_RADIUS_M;
  const readyBudgetMs = opts?.readyBudgetMs ?? READY_BUDGET_MS;
  const cache: RasterEntry[] = [];
  const inFlight = new Map<string, PendingLoad>();
  let store = opts?.store ?? null;

  async function storeFor(): Promise<CanopyTileStore> {
    if (!store) store = await sharedCanopyTileStore();
    return store;
  }

  function lookup(bbox: BBox): CanopyHeightField | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry.field;
      }
    }
    return null;
  }

  /** The read itself, which runs to completion however long `load()` waits. */
  function startRead(key: string, bbox: BBox): PendingLoad {
    const pending: PendingLoad = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      settled: false,
      waiters: 0,
    };
    pending.promise = (async () => {
      try {
        const patch = await (await storeFor()).read(
          [bbox.west, bbox.south, bbox.east, bbox.north],
          {
            targetGroundRes: opts?.targetGroundRes,
            priority: "route",
            signal: pending.controller.signal,
          },
        );
        cache.unshift({
          // The patch covers whole pixels, so it contains the area asked for rather
          // than equalling it — except at a tile edge, where the store clamps and
          // `bboxContains` will decline. That is the honest outcome.
          coverage: {
            west: patch.bbox[0],
            south: patch.bbox[1],
            east: patch.bbox[2],
            north: patch.bbox[3],
          },
          field: createCanopyHeightField(patch),
        });
        if (cache.length > RASTER_CACHE_ENTRIES) cache.length = RASTER_CACHE_ENTRIES;
      } catch {
        // Same rule as the two providers above: never cache a failure as "no canopy
        // here". `fieldFor` keeps returning null and nothing claims the raster was
        // consulted. Swallowing it here is also what keeps a read nobody is waiting
        // for any more from surfacing as an unhandled rejection.
      } finally {
        pending.settled = true;
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    })();

    inFlight.set(key, pending);
    return pending;
  }

  return {
    source: "canopy-raster",

    fieldFor(bbox) {
      return lookup(bbox);
    },

    async load(bbox, signal) {
      if (lookup(bbox)) return;
      if (signal?.aborted) throw abortError();
      if (bboxRadiusM(bbox) > maxRadiusM) return;

      // No padding, unlike the two Overpass providers. `ShadowField` already pads
      // every query by `QUERY_PAD_M`, and the march is capped at the same distance —
      // so the patch the caller asks for is exactly the patch the march can reach.
      const key = [bbox.west, bbox.south, bbox.east, bbox.north]
        .map((v) => v.toFixed(5))
        .join(",");

      const pending = inFlight.get(key) ?? startRead(key, bbox);
      const waiter = waitForPending(pending, signal, () => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
        pending.controller.abort();
      });

      // Bounded wait, unbounded read. The waiter deliberately remains registered
      // after this returns; a later route abort releases it, while an active route
      // lets the shared scheduler finish and populate the cache. See `READY_BUDGET_MS`.
      await raceDeadline(waiter, readyBudgetMs);
    },
  };
}

// ─── Sidewalk sheds ───────────────────────────────────────────────────────────

export interface NycShedProvider extends ShedProvider {
  /** The routing edges permits are snapped to. Until bound, `prismsFor` declines. */
  bindEdges(edges: EdgeRef[]): void;
  /**
   * The map rings of every shed placed against the bound edges — what the field used
   * for this calculation — one per permit even where cached areas overlap, since a
   * translucent fill drawn twice reads as a different colour. Empty before a
   * calculation has sampled anything.
   */
  drawnRings(): [number, number][][];
}

interface ShedEntry {
  coverage: BBox;
  permits: ShedPermit[];
  placed: { edges: EdgeRef[]; set: PrismSet; drawn: Map<string, [number, number][]> } | null;
}

function intersects(a: BBox, b: BBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

/** Upper bound on one permit request. Socrata measured 0.7–3.6 s cold. */
const SHED_FETCH_TIMEOUT_MS = 15000;

/**
 * Sidewalk-shed slabs from NYC DOB permits (issue #85).
 *
 * Shaped like the Overpass providers — `load()` is the only path to the wire — with one
 * extra input: a permit becomes a slab only once it is snapped to a routing edge, so
 * the provider holds the edges the route calculation binds (the `bindSnapshot`
 * pattern) and declines until it has both. Slabs are memoised on (permits, edges)
 * identity, so the field's prepared-caster cache hits across one calculation.
 *
 * Like the raster provider, the wait is bounded and the read is not: `signal` stops
 * `load()` waiting, while the fetch runs on and fills the cache, so a cold request
 * that misses one route's readiness budget serves the next calculation.
 *
 * An empty permit list inside NYC is a real answer — no sheds here. A failed fetch,
 * or a response `SHED_LIMIT` may have truncated, is not, and caches nothing.
 */
export function createShedProvider(opts?: {
  fetchPermits?: (bbox: BBox) => Promise<ShedPermitResult>;
}): NycShedProvider {
  const fetchPermits =
    opts?.fetchPermits ??
    ((bbox) => fetchShedPermits(bbox, { signal: AbortSignal.timeout(SHED_FETCH_TIMEOUT_MS) }));
  const cache: ShedEntry[] = [];
  const inFlight: Array<{ bbox: BBox; promise: Promise<void> }> = [];
  let edges: EdgeRef[] | null = null;

  function lookup(bbox: BBox): ShedEntry | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry;
      }
    }
    return null;
  }

  return {
    source: "shed",

    bindEdges(next) {
      edges = next;
    },

    prismsFor(bbox) {
      if (!edges) return null;
      const entry = lookup(bbox);
      if (!entry) return null;
      if (entry.placed?.edges !== edges) {
        const { set, drawn } = shedPrismsFromPermits(
          entry.permits.map(({ lng, lat, jobFilingNumber }) => ({ lng, lat, key: jobFilingNumber })),
          edges,
        );
        entry.placed = { edges, set, drawn: new Map(drawn.map(({ key, ring }) => [key, ring])) };
      }
      return entry.placed.set;
    },

    drawnRings() {
      if (!edges) return [];
      const byPermit = new Map<string, [number, number][]>();
      for (const entry of cache) {
        if (entry.placed?.edges !== edges) continue;
        for (const [key, ring] of entry.placed.drawn) byPermit.set(key, ring);
      }
      return [...byPermit.values()];
    },

    async load(bbox, signal) {
      if (lookup(bbox)) return;
      if (signal?.aborted) return;
      if (!intersects(NYC_BOUNDS, bbox)) return;

      // A wider request already on the wire answers this one too.
      let pending = inFlight.find((entry) => bboxContains(entry.bbox, bbox));
      if (!pending) {
        const entry = { bbox, promise: Promise.resolve() };
        entry.promise = fetchPermits(bbox)
          .then((result) => {
            if (!result.complete) return;
            cache.unshift({ coverage: result.coverage, permits: result.permits, placed: null });
            if (cache.length > CACHE_ENTRIES) cache.length = CACHE_ENTRIES;
          })
          .catch(() => {
            // Never cache a failure as "no sheds here": `prismsFor` keeps declining.
          })
          .finally(() => {
            inFlight.splice(inFlight.indexOf(entry), 1);
          });
        inFlight.push(entry);
        pending = entry;
      }
      await untilAborted(pending.promise, signal);
    },
  };
}

/** `promise`, or `signal` aborting — whichever is first, with the listener removed either way. */
function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, done);
  });
}

/**
 * `promise`, or `ms` elapsing — whichever is first, with the timer cleared either way.
 *
 * A bare `Promise.race` against a `setTimeout` would leave a live timer behind on
 * every read that beats the deadline, and `load()` runs once per route calculation.
 */
function raceDeadline(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}

/**
 * Active NYC sidewalk-shed permits (issue #85).
 *
 * A sidewalk shed is a ~3 m temporary roof over the sidewalk — near-total shade and
 * near-total rain shelter on exactly the pavement people walk. NYC DOB publishes every
 * permit daily through Socrata (CORS `*`, no key). The source is DOB NOW
 * (`rbx6-tga4`), not the legacy BIS set (`ipu4-2q9a`) the issue named: BIS holds almost
 * no current sheds and its expiration dates are free text.
 *
 * A shed counts as standing iff DOB NOW holds an issued, unexpired Sidewalk Shed permit
 * for it. That over-counts early removals and under-counts lapsed permits still
 * standing, and the set is always *today's* whatever date the user is planning for.
 */

import type { BBox } from "../lib/shadowField/ShadowField";

const SHED_PERMITS_URL = "https://data.cityofnewyork.us/resource/rbx6-tga4.json";

/** DOB republishes daily, so a day-old answer is as fresh as the source. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Rows per request. A response this long may be truncated, so it is not trusted. */
export const SHED_LIMIT = 10000;

/** The five boroughs, padded slightly. Outside this the dataset has nothing to say. */
export const NYC_BOUNDS: BBox = { west: -74.27, south: 40.47, east: -73.68, north: 40.93 };

/** Requests snap outward to this grid (~1.1 km) so nearby routes share one fetch. */
const SNAP_DEG = 0.01;

export interface ShedPermit {
  jobFilingNumber: string;
  lng: number;
  lat: number;
  /** Socrata floating timestamp, e.g. `2026-11-18T00:00:00.000`. */
  expiresAt: string;
}

export interface ShedPermitResult {
  permits: ShedPermit[];
  /** The area the query actually asked for — contains the requested bbox. */
  coverage: BBox;
  /** False when the response hit `SHED_LIMIT` and may be missing rows. */
  complete: boolean;
}

interface ShedPermitRow {
  job_filing_number?: string;
  latitude?: string;
  longitude?: string;
  expired_date?: string;
}

/** Today's date in New York as `YYYY-MM-DD` — DOB's own calendar, not the viewer's. */
export function todayInNewYork(now: number | Date = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The SoQL query for active shed permits inside a bbox.
 *
 * The dataset has no point column, so the bbox is two `between`s on the numeric
 * latitude/longitude columns rather than `within_box`.
 */
export function shedPermitQuery(bbox: BBox, today: string): URLSearchParams {
  return new URLSearchParams({
    $select: "job_filing_number,latitude,longitude,expired_date",
    $where: [
      "work_type='Sidewalk Shed'",
      "permit_status='Permit Issued'",
      `expired_date > '${today}'`,
      "latitude IS NOT NULL",
      `latitude between ${bbox.south} and ${bbox.north}`,
      `longitude between ${bbox.west} and ${bbox.east}`,
    ].join(" AND "),
    $limit: String(SHED_LIMIT),
  });
}

/**
 * Rows → permits: unexpired, geocoded, one per job.
 *
 * The server already filters, but the rows are re-checked so a stale cache or a
 * changed upstream filter cannot slip an expired shed in. A job renewed under the
 * same filing number appears once per permit; it keeps the latest expiry.
 */
export function parseShedPermits(rows: ShedPermitRow[], today: string): ShedPermit[] {
  const byJob = new Map<string, ShedPermit>();
  for (const row of rows) {
    const job = row.job_filing_number;
    const expiresAt = row.expired_date;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    // By calendar day: a permit that lapses today is not counted for today.
    if (!job || !expiresAt || expiresAt.slice(0, 10) <= today) continue;
    if (row.latitude == null || row.longitude == null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;
    const existing = byJob.get(job);
    if (existing && existing.expiresAt >= expiresAt) continue;
    byJob.set(job, { jobFilingNumber: job, lng, lat, expiresAt });
  }
  return [...byJob.values()];
}

function snappedOut(bbox: BBox): BBox {
  const round = (v: number) => Number(v.toFixed(2));
  return {
    west: round(Math.floor(bbox.west / SNAP_DEG) * SNAP_DEG),
    south: round(Math.floor(bbox.south / SNAP_DEG) * SNAP_DEG),
    east: round(Math.ceil(bbox.east / SNAP_DEG) * SNAP_DEG),
    north: round(Math.ceil(bbox.north / SNAP_DEG) * SNAP_DEG),
  };
}

interface CacheEntry {
  fetchedAtMs: number;
  result: Promise<ShedPermitResult>;
}

const cache = new Map<string, CacheEntry>();

/** Drops every cached response. Exists for tests; nothing in the app calls it. */
export function clearShedPermitCache(): void {
  cache.clear();
}

/**
 * Active shed permits covering `bbox` — one request per snapped area per day.
 *
 * A rejected fetch is evicted rather than memoized, so one failed request does not
 * leave an area permanently shedless.
 */
export function fetchShedPermits(
  bbox: BBox,
  opts: { signal?: AbortSignal; now?: number } = {}
): Promise<ShedPermitResult> {
  const now = opts.now ?? Date.now();
  const today = todayInNewYork(now);
  const coverage = snappedOut(bbox);
  const key = `${today}|${coverage.west},${coverage.south},${coverage.east},${coverage.north}`;
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.result;

  const result = fetch(`${SHED_PERMITS_URL}?${shedPermitQuery(coverage, today)}`, {
    signal: opts.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`NYC Open Data HTTP ${res.status}`);
      const rows = (await res.json()) as ShedPermitRow[];
      return {
        permits: parseShedPermits(rows, today),
        coverage,
        complete: rows.length < SHED_LIMIT,
      };
    })
    .catch((err) => {
      // Only evict this attempt — a later one may have already replaced it.
      if (cache.get(key)?.result === result) cache.delete(key);
      throw err;
    });

  cache.set(key, { fetchedAtMs: now, result });
  return result;
}

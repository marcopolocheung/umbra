export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  /** [south, north, west, east] as strings. Nominatim omits it for some results. */
  boundingbox?: [string, string, string, string];
  /** The OSM key and value the result matched (`amenity`/`library`, `highway`/`residential`). */
  class?: string;
  type?: string;
}

// Requests go through a same-origin proxy, never directly to
// nominatim.openstreetmap.org. The OSMF usage policy requires every request to
// identify itself with a `User-Agent`, and that is a forbidden header name —
// browsers drop it from fetch() silently, so only a server can send it. In dev
// that is Vite's /__nominatim proxy; in production the Vercel function at
// /api/nominatim. See vite.config.ts and api/nominatim.js.
//
// The same policy forbids autocomplete, so nothing here may be called from a
// keystroke handler; callers search on an explicit submit.
const NOMINATIM_BASE = import.meta.env.DEV ? "/__nominatim" : "/api/nominatim";

function nominatimUrl(endpoint: "search" | "reverse", params: Record<string, string>): string {
  return `${NOMINATIM_BASE}?${new URLSearchParams({ endpoint, ...params }).toString()}`;
}

// Nominatim usage policy: max 1 request per second.
// A simple FIFO queue ensures forward + reverse geocode calls never exceed this.
const THROTTLE_MS = 1050; // slightly over 1 s to be safe
let lastMs = 0;
const pending: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (timer !== null) return;
  const fn = pending.shift();
  if (!fn) return;
  const wait = Math.max(0, lastMs + THROTTLE_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    lastMs = Date.now();
    fn();
    if (pending.length > 0) flush();
  }, wait);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.push(() => task().then(resolve, reject));
    flush();
  });
}

// Simple LRU caches for geocode results
const CACHE_MAX = 50;
const forwardCache = new Map<string, NominatimResult[]>();
const reverseCache = new Map<string, string | null>();

function evictOldest(cache: Map<string, unknown>) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value!;
    cache.delete(first);
  }
}

export function geocodeForward(query: string): Promise<NominatimResult[]> {
  const key = query.trim().toLowerCase();
  if (forwardCache.has(key)) return Promise.resolve(forwardCache.get(key)!);

  return enqueue(async () => {
    // Check again after throttle wait — another call may have populated it
    if (forwardCache.has(key)) return forwardCache.get(key)!;
    const url = nominatimUrl("search", { q: query, limit: "5", addressdetails: "1" });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const data = await res.json() as NominatimResult[];
    evictOldest(forwardCache);
    forwardCache.set(key, data);
    return data;
  });
}

/**
 * Search for matches to `query` biased to a bounding box around (lat, lng).
 * Uses Nominatim's `viewbox` + `bounded=1` so e.g. "parks" returns parks IN
 * that area rather than arbitrary administrative areas worldwide. This is the
 * agent's "find POIs near here" primitive (Nominatim is a geocoder, not a true
 * POI index, but viewbox-bounded search is good enough for area discovery).
 */
export function geocodeNear(
  query: string,
  lat: number,
  lng: number,
  radiusDeg = 0.15
): Promise<NominatimResult[]> {
  return enqueue(async () => {
    const left = lng - radiusDeg;
    const right = lng + radiusDeg;
    const top = lat + radiusDeg;
    const bottom = lat - radiusDeg;
    const url = nominatimUrl("search", {
      q: query,
      limit: "8",
      addressdetails: "1",
      viewbox: `${left},${top},${right},${bottom}`,
      bounded: "1",
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    return (await res.json()) as NominatimResult[];
  });
}

/** Result of reverse geocode with address coordinates (Nominatim's representative point). */
export interface ReverseGeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
}

const reverseWithCoordsCache = new Map<string, ReverseGeocodeResult | null>();

/** Reverse geocode a point; returns first two comma segments of display_name, or null on failure. */
export function geocodeReverse(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return Promise.resolve(reverseCache.get(key)!);

  return enqueue(async () => {
    if (reverseCache.has(key)) return reverseCache.get(key)!;
    const url = nominatimUrl("reverse", { lat: String(lat), lon: String(lng), zoom: "18" });
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.display_name) return null;
    const parts: string[] = (data.display_name as string).split(",");
    const result = parts.slice(0, 2).map((p) => p.trim()).join(", ");
    evictOldest(reverseCache);
    reverseCache.set(key, result);
    return result;
  });
}

/**
 * Reverse geocode a point; returns display name (first two comma segments) and the
 * coordinates returned by Nominatim (address representative point), or null on failure.
 * Uses same throttle and a separate LRU cache.
 */
export function geocodeReverseWithCoords(
  lat: number,
  lng: number
): Promise<ReverseGeocodeResult | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseWithCoordsCache.has(key)) {
    return Promise.resolve(reverseWithCoordsCache.get(key)!);
  }

  return enqueue(async () => {
    if (reverseWithCoordsCache.has(key)) return reverseWithCoordsCache.get(key)!;
    const url = nominatimUrl("reverse", { lat: String(lat), lon: String(lng), zoom: "18" });
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { display_name?: string; lat?: string; lon?: string };
    if (!data.display_name || data.lat == null || data.lon == null) return null;
    const parts: string[] = data.display_name.split(",");
    const displayName = parts.slice(0, 2).map((p) => p.trim()).join(", ");
    const result: ReverseGeocodeResult = {
      displayName,
      lat: parseFloat(data.lat),
      lng: parseFloat(data.lon),
    };
    evictOldest(reverseWithCoordsCache);
    reverseWithCoordsCache.set(key, result);
    return result;
  });
}

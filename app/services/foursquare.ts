import "../lib/storageMigration";
const FSQ_DEBUG = true;

export interface FoursquarePlaceInfo {
  name: string;
  address?: string | null;
  category?: string | null;
  hours?: string | null;
  rating?: number | null;
  description?: string | null;
  phone?: string | null;
  website?: string | null;
  photo?: string | null;
  /** Foursquare place identifier from the Places API (aka fsq_id). */
  fsqId?: string | null;
}

function logFoursquareRequest(
  stage: string,
  url: string,
  init: RequestInit,
  attempt: number
) {
  if (!FSQ_DEBUG) return;

  const headers = (init.headers ?? {}) as Record<string, string>;

  const safeHeaders = {
    ...headers,
    Authorization: headers?.Authorization
      ? `Bearer ***${headers.Authorization.slice(-6)}`
      : undefined,
  };

  console.group(`Foursquare ${stage} request`);
  console.log("Attempt:", attempt);
  console.log("URL:", url);
  console.log("Method:", init.method ?? "GET");
  console.log("Headers:", safeHeaders);
  console.log("Signal:", !!init.signal);
  console.groupEnd();
}

function logFoursquareResponse(
  url: string,
  response: Response,
  attempt: number
) {
  if (!FSQ_DEBUG) return;

  // In tests we often stub `fetch()` with plain objects that don't implement
  // the full Response interface (e.g. `headers.get`). Be defensive.
  const h = (response as unknown as { headers?: { get?: (k: string) => string | null } }).headers;
  const getHeader = (k: string) => h?.get?.(k) ?? null;

  console.group(`Foursquare response`);
  console.log("URL:", url);
  console.log("Attempt:", attempt);
  console.log("Status:", response.status);
  console.log(
    "RateLimit:",
    getHeader("X-RateLimit-Limit"),
    getHeader("X-RateLimit-Remaining")
  );
  console.log("Retry-After:", getHeader("Retry-After"));
  console.groupEnd();
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 0
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {

    logFoursquareRequest("API", url, init, attempt);

    const response = await fetch(url, init);

    logFoursquareResponse(url, response, attempt);

    if (response.status !== 429) return response;

    lastResponse = response;

    const retryAfter = response.headers.get("Retry-After");

    const delayMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : 1000 * 2 ** attempt;

    if (FSQ_DEBUG) {
      console.warn("⚠️ Foursquare 429 rate limit");
      console.log("Retrying after", delayMs, "ms");
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  return lastResponse!;
}

/**
 * Normalize a Vite-provided API key.
 *
 * Some `.env` setups accidentally include surrounding quotes, which then become
 * part of the value and cause `401 Unauthorized`.
 */
function normalizeApiKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip a SINGLE pair of matching surrounding quotes.
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" || first === '"') && last === first && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Quick address sanitizer for lookups.
 *
 * Reverse geocoders / OSM labels can occasionally include internal IDs like
 * `... , 1_33051`. Foursquare doesn't understand these and it hurts search.
 */
export function sanitizeFoursquareAddress(address: string): string {
  return address
    .trim()
    // Remove OSM-style internal suffixes like "1_33051" or "Hello_123".
    // We keep the leading token ("1") and strip the underscore + digits.
    .replace(/_\d+/g, "")
    .trim();
}
// Support splitting load across multiple Foursquare API keys.
//
// Note: the Search -> Details flow is sequential because Details needs the
// `fsq_id` from Search. But by using separate keys we can avoid concentrating
// both calls on the same rate limit bucket.
/**
 * The browser only ever holds a Places key in **dev**.
 *
 * Dev goes through Vite's `/__fsq` proxy, which injects nothing, so the request
 * has to carry its own credential. Production goes through `api/fsq.js`, which
 * holds `FSQ_API_KEY` server-side and injects it — so the browser sends none.
 *
 * The `import.meta.env.DEV` guard is load-bearing, not cosmetic: Vite replaces it
 * with `false` in a production build and folds the branch away, so the key string
 * never enters the bundle. Reading `VITE_FOURSQUARE_API_KEY` unconditionally here
 * would inline it whether or not anything used it. See #218.
 */
const DEFAULT_SEARCH_API_KEY = import.meta.env.DEV
  ? normalizeApiKey(import.meta.env.VITE_FOURSQUARE_API_KEY)
  : null;
const DEFAULT_DETAILS_API_KEY = DEFAULT_SEARCH_API_KEY;

/** True where the browser must supply its own credential — dev only. */
const CLIENT_KEY_REQUIRED = import.meta.env.DEV;

/**
 * Bearer header, or nothing at all in production.
 *
 * An absent key is not an error outside dev: `api/fsq.js` supplies it. Sending
 * `Authorization: Bearer null` instead would fail upstream *and* re-add the header
 * to the proxy's CORS allowlist.
 */
function authHeader(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// The Places API is not CORS-enabled for browser use from arbitrary origins.
// In dev, we route through Vite's proxy (see `vite.config.ts`).
// In production, we route through a Vercel serverless proxy at /api/fsq.
const FSQ_BASE_URL = import.meta.env.DEV ? "/__fsq" : "/api/fsq";

function keySignature(key: string | null): string {
  if (!key) return "";
  return `${key.length}:${key[0]}:${key[key.length - 1]}`;
}

function currentKeySignature(): string {
  return `${keySignature(DEFAULT_SEARCH_API_KEY)}|${keySignature(DEFAULT_DETAILS_API_KEY)}`;
}

// We intentionally keep our request fields minimal.
// If the API changes field naming, we also defensive-parse in the mapper.
const FIELDS = [
  "name",
  "location",
  "categories",
  "hours",
  "rating",
  "description",
  "photos",
  "tel",
  "website",
].join(",");

// ---------------------------------------------------------------------------
// Module-scoped caching
// ---------------------------------------------------------------------------

// General cache for address->info and other lookups.
const placeCache = new Map<string, FoursquarePlaceInfo | null>();

// Per-fsq_id details cache (FEATURE.md).
// Store with a timestamp so we can expire stale entries.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const placeDetailsCache = new Map<
  string,
  { data: FoursquarePlaceInfo | null; timestamp: number }
>();

// In-flight request de-dupe maps.
const inFlight = new Map<string, Promise<FoursquarePlaceInfo | null>>();
const inflightRequests = new Map<string, Promise<FoursquarePlaceInfo | null>>();

type FoursquareApiStatus = "unknown" | "ok" | "missing_key" | "unauthorized" | "forbidden" | "error";

let apiStatus: FoursquareApiStatus = "unknown";

// When we hit API rate limiting (429), temporarily back off across *all* calls.
// This prevents repeated clicks from hammering the API while limited.
let rateLimitedUntilMs: number | null = null;

function isRateLimited(): boolean {
  return rateLimitedUntilMs !== null && Date.now() < rateLimitedUntilMs;
}

function setRateLimitedFromResponse(res: Response) {
  const retryAfter = res.headers.get("Retry-After");
  // If missing or unparsable, pick a conservative short cooldown.
  const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : 30;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
  rateLimitedUntilMs = Date.now() + safeSeconds * 1000;
}

// If the key is rejected once, stop making further requests in this session to
// avoid repeated 401 console noise on every marker click.
let authBlocked = false;

const AUTH_BLOCK_KEY = "umbra:foursquareAuthBlocked";
const AUTH_BLOCK_TTL_MS = 5 * 60 * 1000; // don't permanently suppress retries

function getSessionStorage(): Storage | null {
  // Guard for SSR / tests.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

/**
 * Back-compat: older versions stored just "1".
 * New format stores the key signature so we can auto-unblock when the key changes.
 */
function normalizeStoredAuthBlock() {
  const ss = getSessionStorage();
  if (!ss) return;

  const raw = ss.getItem(AUTH_BLOCK_KEY);
  if (!raw) return;

  // Legacy value: treat as stale and clear so a fixed key can retry.
  if (raw === "1") {
    ss.removeItem(AUTH_BLOCK_KEY);
    return;
  }

  // New value: { sig: string, ts: number }
  try {
    const parsed = JSON.parse(raw) as { sig?: string };
    const sig = parsed?.sig;
    if (!sig) {
      ss.removeItem(AUTH_BLOCK_KEY);
      return;
    }
    // If the current key differs, unblock automatically.
    if (sig !== currentKeySignature()) {
      ss.removeItem(AUTH_BLOCK_KEY);
    }
  } catch {
    ss.removeItem(AUTH_BLOCK_KEY);
  }
}

// Run once on module load.
try { normalizeStoredAuthBlock(); } catch { /* Storage may be unavailable. */ }

function isAuthBlocked(): boolean {
  if (authBlocked) return true;

  const ss = getSessionStorage();
  if (!ss) return false;
  const raw = ss.getItem(AUTH_BLOCK_KEY);
  if (!raw) return false;

  if (raw === "1") return true; // should no longer happen; kept for safety

  try {
    const parsed = JSON.parse(raw) as { sig?: string; ts?: number };
    if (parsed?.sig !== currentKeySignature()) return false;

    // TTL: allow retry after some time (e.g., key propagation window).
    if (typeof parsed?.ts === "number") {
      if (Date.now() - parsed.ts > AUTH_BLOCK_TTL_MS) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setAuthBlocked() {
  authBlocked = true;
  const ss = getSessionStorage();
  if (!ss) return;
  try {
    ss.setItem(
      AUTH_BLOCK_KEY,
      JSON.stringify({ sig: currentKeySignature(), ts: Date.now() })
    );
  } catch {
    // ignore
  }
}

export function clearFoursquareAuthBlocked() {
  authBlocked = false;
  const ss = getSessionStorage();
  if (!ss) return;
  try {
    ss.removeItem(AUTH_BLOCK_KEY);
  } catch {
    // ignore
  }
}

export function getFoursquareApiStatus(): FoursquareApiStatus {
  return apiStatus;
}

export function isFoursquareRateLimited(): boolean {
  return isRateLimited();
}

function mapToFoursquarePlaceInfo(place: any, fsqId?: string | null): FoursquarePlaceInfo {
  const addressFormatted =
    place?.location?.formatted_address ??
    place?.location?.address ??
    place?.location?.formattedAddress ??
    null;

  return {
    name: place?.name ?? "Unknown Place",
    address: addressFormatted,
    category: place?.categories?.[0]?.name ?? null,
    hours: place?.hours?.display ?? place?.hours?.displayText ?? null,
    rating: typeof place?.rating === "number" ? place.rating : null,
    description: place?.description ?? null,
    phone: place?.tel ?? place?.phone ?? null,
    website: place?.website ?? null,
    photo: place?.photos?.[0]
      ? `${place.photos[0].prefix}300x300${place.photos[0].suffix}`
      : null,
    fsqId: fsqId ?? place?.fsq_id ?? place?.fsqId ?? null,
  };
}

/**
 * Fetch full place details for a known fsq_id.
 *
 * Endpoint:
 *   GET https://places-api.foursquare.com/places/{fsq_place_id}
 */
export async function getPlaceDetails(
  fsqId: string,
  opts?: { signal?: AbortSignal; apiKey?: string }
): Promise<FoursquarePlaceInfo | null> {
  const safeId = (fsqId ?? "").trim();
  if (!safeId) return null;

  // 1) Cache hit (with TTL)
  const cached = placeDetailsCache.get(safeId);
  if (cached) {
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;
    // Expired: treat as cache miss.
    placeDetailsCache.delete(safeId);
  }

  // 2) In-flight de-dupe
  const existing = inflightRequests.get(safeId);
  if (existing) return existing;

  // 3) Cache miss → fetch
  const promise: Promise<FoursquarePlaceInfo | null> = (async () => {
    if (isRateLimited()) return null;
    if (isAuthBlocked()) return null;

    // If the caller supplies `opts.apiKey`, use it for tests/explicit overrides.
    const apiKey = normalizeApiKey(opts?.apiKey) ?? DEFAULT_DETAILS_API_KEY;
    if (CLIENT_KEY_REQUIRED && !apiKey) {
      apiStatus = "missing_key";
      const result = null;
      placeDetailsCache.set(safeId, { data: result, timestamp: Date.now() });
      return result;
    }

    const url = `${FSQ_BASE_URL}/places/${encodeURIComponent(
      safeId
    )}?fields=${encodeURIComponent(FIELDS)}`;

    try {
      const response = await fetchWithRetry(url, {
        headers: {
          Accept: "application/json",
          // The Places API expects Bearer auth. In production `api/fsq.js`
          // injects it; in dev the Vite proxy forwards what we send here.
          ...authHeader(apiKey),
          "X-Places-Api-Version": "2025-06-17",
        },
        signal: opts?.signal,
      });

      if (response.status === 429) {
        apiStatus = "error";
        setRateLimitedFromResponse(response);
        return null;
      }

      if (response.status === 410) return null;

      if (response.status === 401) {
        apiStatus = "unauthorized";
        setAuthBlocked();
        return null;
      }

      if (response.status === 403) {
        apiStatus = "forbidden";
        setAuthBlocked();
        return null;
      }

      if (!response.ok) {
        apiStatus = "error";
        return null;
      }

      apiStatus = "ok";

      // Place Details returns a single object (not wrapped in `results`).
      const data = (await response.json()) as any;
      return mapToFoursquarePlaceInfo(data, safeId);
    } catch (err) {
      console.error("Foursquare place details fetch failed:", err);
      return null;
    }
  })()
    .then((data) => {
      placeDetailsCache.set(safeId, { data, timestamp: Date.now() });
      inflightRequests.delete(safeId);
      return data;
    })
    .catch((err) => {
      inflightRequests.delete(safeId);
      throw err;
    });

  inflightRequests.set(safeId, promise);
  return promise;
}

export interface FoursquareSuggestion extends FoursquarePlaceInfo {
  lat: number;
  lng: number;
  /** Metres from the anchor the suggestion was searched around. */
  distanceM?: number;
}

// Typeahead cache, keyed by query + rounded anchor, with a short TTL — the same
// keystroke sequence re-fires as the dropdown reopens, and the polite-request
// rule says the second keystroke sequence should not re-spend the quota.
const SUGGEST_TTL_MS = 5 * 60 * 1000;
const suggestCache = new Map<string, { data: FoursquareSuggestion[]; timestamp: number }>();

/**
 * Foursquare-backed typeahead for the manual search bar.
 *
 * This is the ONLY autocomplete path in the app, and it exists because the OSMF
 * policy forbids autocomplete against Nominatim — so every keystroke-driven
 * request must go here, never to `geocodeForward`. Anchored on the map center
 * (`ll` is required) and ranked distance-first client-side, so the dropdown
 * answers "near where I'm looking". Returns [] on any failure — suggestions
 * degrade silently; the explicit Nominatim submit is the fallback.
 */
export async function suggestPlaces(
  query: string,
  ll: [number, number],
  opts?: { signal?: AbortSignal; apiKey?: string; limit?: number; radiusM?: number }
): Promise<FoursquareSuggestion[]> {
  const q = query.trim();
  if (!q) return [];
  if (isRateLimited()) return [];
  if (isAuthBlocked()) return [];

  const limit = opts?.limit ?? 6;
  const radiusM = opts?.radiusM ?? 3000;
  const cacheKey = `${q.toLowerCase()}|${ll[0].toFixed(3)},${ll[1].toFixed(3)}|${radiusM}`;
  const cached = suggestCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.timestamp < SUGGEST_TTL_MS) return cached.data;
    suggestCache.delete(cacheKey);
  }

  // Search fields stay minimal — the row shows name/category/hours/rating/photo;
  // anything richer belongs to Place Details.
  const searchFields = ["name", "location", "categories", "hours", "rating", "photos"].join(",");
  const url =
    `${FSQ_BASE_URL}/places/search?query=${encodeURIComponent(q)}` +
    `&ll=${ll[1]},${ll[0]}&radius=${radiusM}&limit=${limit}` +
    `&fields=${encodeURIComponent(searchFields)}`;

  try {
    const response = await fetchWithRetry(url, {
      headers: {
        Accept: "application/json",
        ...authHeader(normalizeApiKey(opts?.apiKey) ?? DEFAULT_SEARCH_API_KEY),
        "X-Places-Api-Version": "2025-06-17",
      },
      signal: opts?.signal,
    });

    if (response.status === 429) {
      apiStatus = "error";
      setRateLimitedFromResponse(response);
      return [];
    }
    if (response.status === 401) {
      apiStatus = "unauthorized";
      setAuthBlocked();
      return [];
    }
    if (response.status === 403) {
      apiStatus = "forbidden";
      setAuthBlocked();
      return [];
    }
    if (!response.ok) {
      apiStatus = "error";
      return [];
    }
    apiStatus = "ok";

    const data = (await response.json()) as { results?: unknown[] };
    const suggestions: FoursquareSuggestion[] = (data.results ?? [])
      .map((raw) => {
        const place = (raw ?? {}) as Record<string, unknown>;
        const lat =
          typeof place.latitude === "number" ? place.latitude : (place.location as any)?.lat;
        const lng =
          typeof place.longitude === "number" ? place.longitude : (place.location as any)?.lng;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        const info = mapToFoursquarePlaceInfo(place, place.fsq_id as string | undefined);
        return { ...info, lat, lng } as FoursquareSuggestion;
      })
      .filter((s): s is FoursquareSuggestion => s !== null)
      .sort((a, b) => haversine(ll, [a.lng, a.lat]) - haversine(ll, [b.lng, b.lat]))
      .map((s) => ({ ...s, distanceM: Math.round(haversine(ll, [s.lng, s.lat])) }));

    suggestCache.set(cacheKey, { data: suggestions, timestamp: Date.now() });
    return suggestions;
  } catch {
    // Aborted requests (the user kept typing) and network failures both land
    // here; an empty suggestion list is the honest degradation.
    return [];
  }
}

function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Fetch rich place info from Foursquare with a two-step lookup:
 *
 * 1) Place Search -> extract `fsq_place_id`
 * 2) Place Details -> map into `FoursquarePlaceInfo`
 */
export async function getPlaceInfoFromAddress(
  address: string,
  lat: number,
  lng: number,
  opts?: { signal?: AbortSignal; apiKey?: string }
): Promise<FoursquarePlaceInfo | null> {
  const key = sanitizeFoursquareAddress(address);
  if (!key) return null;
  if (placeCache.has(key)) return placeCache.get(key) ?? null;

  if (inFlight.has(key)) return inFlight.get(key)!;

  if (isRateLimited()) return null;
  if (isAuthBlocked()) return null;

  const promise = _fetchPlaceInfoFromAddress(key, lat, lng, opts).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise; 
  }
  
  async function _fetchPlaceInfoFromAddress(
  key: string,
  lat: number,
  lng: number,
  opts?: { signal?: AbortSignal; apiKey?: string }
): Promise<FoursquarePlaceInfo | null> {
  const overrideKey = normalizeApiKey(opts?.apiKey);
  const searchApiKey = overrideKey ?? DEFAULT_SEARCH_API_KEY;
  const detailsApiKey = overrideKey ?? DEFAULT_DETAILS_API_KEY;
  if (isRateLimited()) return null;
  if (isAuthBlocked()) return null;
  if (CLIENT_KEY_REQUIRED && (!searchApiKey || !detailsApiKey)) {
    // No API key configured (or not exposed by Vite). Cache null to prevent
    // repeated attempts per session.
    apiStatus = "missing_key";
    placeCache.set(key, null);
    return null;
  }

  // Optional debug aid for local development.
  // (Helps catch accidental quotes in `.env.local` values.)
  // Disabled by default to avoid console noise.

  const searchUrl = `${FSQ_BASE_URL}/places/search?query=${encodeURIComponent(
    key
  )}&ll=${lat},${lng}&limit=1`;

  if (FSQ_DEBUG) {
    console.log("Foursquare SEARCH", {
      address: key,
      lat,
      lng,
      url: searchUrl
    });
  }

  const searchResponse = await fetchWithRetry(searchUrl, {
    headers: {
      Accept: "application/json",
      ...authHeader(searchApiKey),
      "X-Places-Api-Version": "2025-06-17",
    },
    signal: opts?.signal,
  });

  if (searchResponse.status === 429) {
    apiStatus = "error";
    setRateLimitedFromResponse(searchResponse);
    return null;
  }

  if (searchResponse.status === 410) {
    placeCache.set(key, null);
    return null;
  }
  if (searchResponse.status === 401) {
    apiStatus = "unauthorized";
    setAuthBlocked();
    return null;
  }
  if (searchResponse.status === 403) {
    apiStatus = "forbidden";
    setAuthBlocked();
    return null;
  }

  if (!searchResponse.ok) {
    apiStatus = "error";
    return null;
  }

  const searchData = (await searchResponse.json()) as { results?: unknown[] };
  const searchResult = (searchData as any)?.results?.[0];
  // New Places API search uses `fsq_id`.
  // Keep fsq_place_id as a fallback for older mocks / back-compat.
  const fsqId: string | null =
    searchResult?.fsq_id ??
    searchResult?.fsq_place_id ??
    searchResult?.fsqPlaceId ??
    null;

  if (!fsqId) {
    placeCache.set(key, null);
    return null;
  }

  const detailsUrl = `${FSQ_BASE_URL}/places/${encodeURIComponent(
    fsqId
  )}?fields=${encodeURIComponent(FIELDS)}`;

  if (FSQ_DEBUG) {
    console.log("Foursquare DETAILS", {
      fsqId,
      url: detailsUrl
    });
  }

  const detailsResponse = await fetchWithRetry(detailsUrl, {
    headers: {
      Accept: "application/json",
      ...authHeader(detailsApiKey),
      "X-Places-Api-Version": "2025-06-17",
    },
    signal: opts?.signal,
  });

  if (detailsResponse.status === 429) {
    apiStatus = "error";
    setRateLimitedFromResponse(detailsResponse);
    return null;
  }

  if (detailsResponse.status === 410) {
    placeCache.set(key, null);
    return null;
  }
  if (detailsResponse.status === 401) {
    apiStatus = "unauthorized";
    setAuthBlocked();
    return null;
  }
  if (detailsResponse.status === 403) {
    apiStatus = "forbidden";
    setAuthBlocked();
    return null;
  }
  if (!detailsResponse.ok) {
    apiStatus = "error";
    return null;
  }

  apiStatus = "ok";

  // Place Details returns a single object (not wrapped in `results`).
  const place = (await detailsResponse.json()) as any;
  const result: FoursquarePlaceInfo = mapToFoursquarePlaceInfo(place, fsqId);

  placeCache.set(key, result);
  return result;
}

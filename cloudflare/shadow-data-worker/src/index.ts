// A generation suffix distinguishes a complete/reconciled city-wide pack from a small
// smoke pack that used the same source normalization.  The allow-list stays
// narrow: only tiled bundles, the final immutable manifest, the generation
// root, and the compact coverage/bounds/notices artifacts are public.
const generationPattern = "nyc-[a-f0-9]{32}(?:-[a-z0-9-]{1,48})?";
const immutableAsset = new RegExp(
  `^generations\/${generationPattern}\/(?:tiles\/18-\\d+-\\d+\\.smb|manifest\\.json|generation\\.json|coverage\\.json|bounds\\.json|notices\\.json)$`,
);
const generationAsset = new RegExp(`^generations\/(${generationPattern})\/(.+)$`);
const currentPointer = "current.json";
// Compact artifacts and the generation root they hang under exist only for
// generations published with a root marker. Manifests and tiles of explicitly
// grandfathered (pre-root) generations stay servable for rollback.
const rootGatedFiles = new Set(["generation.json", "coverage.json", "bounds.json", "notices.json"]);

// ─── NYC navigation delivery ──────────────────────────────────────────────
//
// The navigation dataset shares this origin but lives in its own private
// bucket and has none of _shadow's marker/legacy gating: its integrity chain
// is pointer → manifest → shards, verified client-side, and the producer
// promotes current.json only after every immutable object reconciles. The
// same generator/cell grammar the shardContract parser accepts is pinned:
// nyc-<date>-<12 hex> / manifest|notices / streets|buildings/<cell>.json.
const navigationGenerationPattern = "nyc-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{12}";
const navigationShardKey = "(?:streets|buildings)/[a-z0-9-]{1,64}\\.json";
const navigationPointerKey = "navigation/nyc/current.json";
const navigationAsset = new RegExp(
  `^navigation\\/nyc\\/(?:current\\.json|${navigationGenerationPattern}\\/(?:manifest\\.json|notices\\.json|${navigationShardKey}))$`,
);

/** Mutable pointers are short-cached; every generation object is not. */
function cacheControlFor(key: string): string {
  if (key === currentPointer || key === navigationPointerKey) return "public, max-age=60";
  return "public, max-age=31536000, immutable";
}

/** Navigation keys resolve against their own bucket, shadow keys against SHADOW_TILES. */
function bucketFor(key: string, env: Env): R2Bucket {
  return key.startsWith("navigation/nyc/") ? env.NAVIGATION_DATA : env.SHADOW_TILES;
}

function cors(request: Request, env: Env): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("Origin") === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  }
  return headers;
}

function legacyGenerations(env: Env): Set<string> {
  return new Set(
    (env.LEGACY_GENERATIONS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function requestedKey(url: URL): string | undefined {
  // The buckets are private. This is an allow-list rather than an R2 proxy:
  // it never permits list, arbitrary prefixes, or raw candidate objects.
  if (url.pathname.startsWith("/_shadow/")) {
    const path = url.pathname.replace(/^\/_shadow\//, "");
    if (path === currentPointer || immutableAsset.test(path)) return path;
    return undefined;
  }
  const path = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  if (path === navigationPointerKey) return path;
  if (navigationAsset.test(path)) return path;
  return undefined;
}

/** Pathname-only guard: no query string, no dots in keys, no prefix games. */
export function navigationRequestedKey(url: URL): string | undefined {
  const key = requestedKey(url);
  if (!key || !key.startsWith("navigation/nyc/")) return undefined;
  return key;
}

/**
 * Pure half of publication gating, unit-tested without workerd: everything
 * except a grandfathered manifest/tile needs its generation's published root
 * marker. v1 smoke generations verify through the R2 API directly and never
 * need Worker serving; only legacy-listed generations serve marker-free.
 * Navigation keys never match `generationAsset` and therefore pass through
 * ungated — they are allowed only if `requestedKey` allowed them.
 */
export function generationNeedsMarker(
  generation: string,
  file: string,
  legacy: ReadonlySet<string>,
): boolean {
  if (file === "generation.json") return false;
  if (!rootGatedFiles.has(file) && legacy.has(generation)) return false;
  return true;
}

/**
 * An unpromoted generation prefix is not retrievable merely for existing:
 * every generation asset except a grandfathered manifest/tile requires that
 * generation's published root marker. `generation.json` is its own marker.
 */
async function generationAllowed(env: Env, key: string): Promise<boolean> {
  const match = generationAsset.exec(key);
  if (!match) return true;
  const [, generation, file] = match;
  if (!generationNeedsMarker(generation, file, legacyGenerations(env))) return true;
  return (await env.SHADOW_TILES.head(`generations/${generation}/generation.json`)) !== null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers });
    const key = requestedKey(new URL(request.url));
    if (!key) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    if (!(await generationAllowed(env, key)))
      return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    const bucket = bucketFor(key, env);
    // HEAD must not pull the object body; it only proves existence + ETag.
    if (request.method === "HEAD") {
      const meta = await bucket.head(key);
      if (!meta) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
      headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/octet-stream");
      headers.set("ETag", meta.httpEtag);
      headers.set("Cache-Control", cacheControlFor(key));
      return new Response(null, { headers });
    }
    const object = await bucket.get(key);
    // Do not cache a miss: R2 can become immediately consistent after an
    // upload, while an intermediary-cached 404 would hide the new object.
    if (!object) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/octet-stream");
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", cacheControlFor(key));
    return new Response(object.body, { headers });
  },
} satisfies ExportedHandler<Env>;

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
  // The bucket is private.  This is an allow-list rather than an R2 proxy: it
  // never permits list, arbitrary prefixes, or raw candidate objects.
  const path = url.pathname.replace(/^\/_shadow\//, "");
  if (path === currentPointer || immutableAsset.test(path)) return path;
  return undefined;
}

/**
 * Pure half of publication gating, unit-tested without workerd: everything
 * except a grandfathered manifest/tile needs its generation's published root
 * marker. v1 smoke generations verify through the R2 API directly and never
 * need Worker serving; only legacy-listed generations serve marker-free.
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
    // HEAD must not pull the object body; it only proves existence + ETag.
    if (request.method === "HEAD") {
      const meta = await env.SHADOW_TILES.head(key);
      if (!meta) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
      headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/octet-stream");
      headers.set("ETag", meta.httpEtag);
      headers.set("Cache-Control", key === currentPointer ? "public, max-age=60" : "public, max-age=31536000, immutable");
      return new Response(null, { headers });
    }
    const object = await env.SHADOW_TILES.get(key);
    // Do not cache a miss: R2 can become immediately consistent after an
    // upload, while an intermediary-cached 404 would hide the new object.
    if (!object) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/octet-stream");
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", key === currentPointer ? "public, max-age=60" : "public, max-age=31536000, immutable");
    return new Response(object.body, { headers });
  },
} satisfies ExportedHandler<Env>;

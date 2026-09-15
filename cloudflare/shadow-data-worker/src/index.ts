const immutableAsset = /^generations\/nyc-[a-f0-9]{32}\/(?:tiles\/18-\d+-\d+\.smb|manifest\.json)$/;
const currentPointer = "current.json";

function cors(request: Request, env: Env): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("Origin") === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  }
  return headers;
}

function requestedKey(url: URL): string | undefined {
  // The bucket is private.  This is an allow-list rather than an R2 proxy: it
  // never permits list, arbitrary prefixes, or raw candidate objects.
  const path = url.pathname.replace(/^\/_shadow\//, "");
  if (path === currentPointer || immutableAsset.test(path)) return path;
  return undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers });
    const key = requestedKey(new URL(request.url));
    if (!key) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    const object = await env.SHADOW_TILES.get(key);
    // Do not cache a miss: R2 can become immediately consistent after an
    // upload, while an intermediary-cached 404 would hide the new object.
    if (!object) return new Response("Not found", { status: 404, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": "no-store" }) });
    headers.set("Content-Type", key.endsWith(".json") ? "application/json" : "application/octet-stream");
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", key === currentPointer ? "public, max-age=60" : "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};

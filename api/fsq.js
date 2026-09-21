/**
 * Vercel serverless proxy for Foursquare Places API.
 *
 * Routes the app's small allowlist of /api/fsq/* requests to
 * https://places-api.foursquare.com/*, while rejecting unrelated Foursquare
 * endpoints so this function cannot be used as a general-purpose relay.
 * Forwards rate-limit response headers back so client backoff logic works.
 *
 * This proxy **holds the credential**. It used to relay whatever `Authorization`
 * the browser sent, which meant the key had to reach the browser to begin with —
 * inlined into the bundle by Vite and readable from devtools. Foursquare service
 * keys support no origin or referrer restriction, so there was nothing to blunt
 * that. `FSQ_API_KEY` is now server-only (no `VITE_` prefix, so it is never
 * inlined) and is injected here; the browser sends no credential at all. Origin
 * is still enforced by `FSQ_ALLOWED_ORIGINS`. Same shape as `api/agent.js`.
 *
 * In dev there is no serverless runtime: the client calls Foursquare through the
 * Vite `/__fsq` proxy, which injects nothing, so a dev-only
 * `VITE_FOURSQUARE_API_KEY` is still read there. See #218.
 */
const RATE_LIMIT_PER_MIN = Number(process.env.FSQ_RATE_LIMIT_PER_MIN || 60);
const recentRequestsByIp = new Map();

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function allowedOrigins() {
  const configured = splitCsv(process.env.FSQ_ALLOWED_ORIGINS);
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  return new Set([
    "https://shademapnav.vercel.app",
    ...(vercelUrl ? [vercelUrl] : []),
    ...configured,
  ]);
}

/**
 * The server-held Places credential. Absent is a misconfiguration, not a fallback.
 *
 * Strips one pair of surrounding quotes, mirroring `normalizeApiKey` in
 * `app/services/foursquare.ts`. That client-side helper exists because this
 * repo's `.env` values are written quoted, and a key carried into a `Bearer`
 * header with its quotes attached fails upstream as `401` — which reads as an
 * expired or invalid key rather than a copy-paste artefact. The value is set by
 * hand in the Vercel dashboard, so the same paste is easy to make here; the two
 * readers should tolerate the same input.
 */
function foursquareApiKey() {
  const trimmed = process.env.FSQ_API_KEY ? String(process.env.FSQ_API_KEY).trim() : "";
  if (!trimmed) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" || first === '"') && last === first && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function header(req, name) {
  const headers = req.headers || {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function requestIp(req) {
  const forwarded = header(req, "x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(req) {
  if (!Number.isFinite(RATE_LIMIT_PER_MIN) || RATE_LIMIT_PER_MIN <= 0) return false;
  const now = Date.now();
  const cutoff = now - 60_000;
  const ip = requestIp(req);
  const recent = (recentRequestsByIp.get(ip) || []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    recentRequestsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  recentRequestsByIp.set(ip, recent);
  return false;
}

function originFromUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestSourceAllowed(req) {
  const origin = originFromUrl(header(req, "origin"));
  const referer = originFromUrl(header(req, "referer") ?? header(req, "referrer"));
  const source = origin ?? referer;
  if (!source) return false;
  return allowedOrigins().has(source);
}

function hasOnlySearchParams(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function allowedUpstreamPath(reqUrl) {
  const url = new URL(reqUrl, "https://shademapnav.vercel.app");
  const upstreamPath = url.pathname.replace(/^\/api\/fsq/, "") || "/";
  const upstream = new URL(upstreamPath + url.search, "https://places-api.foursquare.com");

  if (upstream.pathname === "/places/search") {
    // `fields` and `radius` back the search bar's Foursquare typeahead (rich
    // rows, distance-bounded); the Place-Details lookup sends neither.
    if (!hasOnlySearchParams(upstream, new Set(["query", "ll", "limit", "fields", "radius"])))
      return null;
    if (!upstream.searchParams.get("query") || !upstream.searchParams.get("ll")) return null;
    return upstream;
  }

  if (/^\/places\/[^/]+$/.test(upstream.pathname)) {
    if (!hasOnlySearchParams(upstream, new Set(["fields"]))) return null;
    return upstream;
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    if (!requestSourceAllowed(req)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", originFromUrl(header(req, "origin")) || "");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    // No Authorization: the browser sends no credential; this proxy injects it.
    res.setHeader("Access-Control-Allow-Headers", "X-Places-Api-Version, Accept");
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requestSourceAllowed(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (isRateLimited(req)) {
    res.status(429).json({ error: "Too many Foursquare requests. Try again shortly." });
    return;
  }

  const upstream = allowedUpstreamPath(req.url);
  if (!upstream) {
    res.status(404).json({ error: "Foursquare path is not allowed" });
    return;
  }

  const apiKey = foursquareApiKey();
  if (!apiKey) {
    // Loud, and 500 rather than 401: the caller did nothing wrong, the deploy is
    // missing FSQ_API_KEY. A silent fall back to a browser-supplied key would put
    // the credential back in the bundle, which is the whole thing this prevents.
    console.error("FSQ_API_KEY is not set, so the Foursquare proxy cannot authenticate.");
    res.status(500).json({ error: "Foursquare proxy is not configured" });
    return;
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const apiVersion = header(req, "x-places-api-version");
  if (apiVersion) {
    headers["X-Places-Api-Version"] = apiVersion;
  }

  try {
    const response = await fetch(upstream.toString(), {
      method: "GET",
      headers,
    });

    // Forward rate-limit headers for client-side backoff.
    const forwardHeaders = [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "Retry-After",
      "Content-Type",
    ];
    for (const h of forwardHeaders) {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    res.status(response.status);
    const body = await response.text();
    res.send(body);
  } catch (err) {
    console.error("Foursquare proxy error:", err);
    res.status(502).json({ error: "Upstream request failed" });
  }
}

/**
 * The checks every serverless proxy runs before it forwards anything: is the
 * caller this app, and is one IP asking too often. Shared so the proxies cannot
 * drift apart — `api/agent.js` once allowed a request with no Origin while
 * `api/fsq.js` refused it.
 *
 * Neither check is a security boundary on its own (a script can forge Origin,
 * and the per-IP window lives in one warm instance), but together they turn
 * away the casual scripted caller that would otherwise spend a free quota or a
 * volunteer service's goodwill under this app's name.
 */

export function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function header(req, name) {
  const headers = req.headers || {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

export function requestIp(req) {
  const forwarded = header(req, "x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/** The production site, this deployment's own URL, and any extra origins in `process.env[envName]`. */
function allowedOrigins(envName) {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  return new Set([
    "https://shademapnav.vercel.app",
    ...(vercelUrl ? [vercelUrl] : []),
    ...splitCsv(process.env[envName]),
  ]);
}

export function originFromUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** True when Origin (or, failing that, Referer) names an allowed site. Naming none is a refusal. */
export function requestSourceAllowed(req, envName) {
  const origin = originFromUrl(header(req, "origin"));
  const referer = originFromUrl(header(req, "referer") ?? header(req, "referrer"));
  const source = origin ?? referer;
  if (!source) return false;
  return allowedOrigins(envName).has(source);
}

/** A per-IP sliding one-minute window; `process.env[envName]` overrides the limit, 0 disables it. */
export function createRateLimiter(envName, defaultPerMin) {
  const limit = Number(process.env[envName] || defaultPerMin);
  const recentRequestsByIp = new Map();
  return function isRateLimited(req) {
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const now = Date.now();
    const cutoff = now - 60_000;
    const ip = requestIp(req);
    const recent = (recentRequestsByIp.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      recentRequestsByIp.set(ip, recent);
      return true;
    }
    recent.push(now);
    recentRequestsByIp.set(ip, recent);
    return false;
  };
}

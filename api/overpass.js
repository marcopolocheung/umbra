/**
 * Vercel serverless entry point for the shared Overpass proxy.
 *
 * The implementation also powers Vite's /__overpass middleware so local and
 * deployed routing use the same endpoint pool, retry budgets, `User-Agent`,
 * body limits, and cancellation behavior.
 *
 * Only the deployed entry checks who is asking. The proxy forwards query text
 * under this app's `User-Agent` to volunteer-run mirrors, so an open one lends
 * that name to anyone's heavy query — and a block on the name breaks routing
 * for every user. The dev middleware skips the check: its caller is localhost.
 */
import { handleOverpassRequest } from "../server/overpassProxy.js";
import { createRateLimiter, requestSourceAllowed } from "../server/proxyGuard.js";

const isRateLimited = createRateLimiter("OVERPASS_RATE_LIMIT_PER_MIN", 60);

export default async function handler(req, res) {
  if (req.method === "POST") {
    if (!requestSourceAllowed(req, "OVERPASS_ALLOWED_ORIGINS")) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (isRateLimited(req)) {
      res.status(429).json({ error: "Too many map data requests. Try again shortly." });
      return;
    }
  }
  // Non-POST methods fall through to the shared handler's 405.
  return handleOverpassRequest(req, res);
}

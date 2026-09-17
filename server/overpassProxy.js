export const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 26_000;
const DEFAULT_MAX_BODY_BYTES = 100_000;
const RETRY_AFTER_SECONDS = "30";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function endpointUrl(value) {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("unsupported Overpass endpoint protocol");
  }
  if (url.pathname === "/") url.pathname = "/api/interpreter";
  return url;
}

export function configuredOverpassEndpoints(env = process.env) {
  const configured = env.OVERPASS_ENDPOINTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const values = configured?.length ? configured : DEFAULT_OVERPASS_ENDPOINTS;
  const endpoints = [];

  for (const value of values) {
    try {
      const url = endpointUrl(value);
      endpoints.push({ label: url.hostname, url: url.toString() });
    } catch {
      // A bad optional override must not take the proxy down. If every configured
      // value is invalid, the known-safe defaults below remain available.
    }
  }

  if (endpoints.length > 0) return endpoints;
  return DEFAULT_OVERPASS_ENDPOINTS.map((value) => {
    const url = endpointUrl(value);
    return { label: url.hostname, url: url.toString() };
  });
}

export function isRetryableOverpassStatus(status) {
  return status === 429 || status >= 500;
}

function selectedHeaders(headers) {
  const selected = {};
  for (const name of ["Content-Type", "Retry-After"]) {
    const value = headers?.get?.(name);
    if (value) selected[name] = value;
  }
  return selected;
}

/**
 * The 503 carries why the pool gave up, one entry per attempt.
 *
 * Without it this is only answerable from server logs, inside their retention
 * window, for a failure that is transient and hard to reproduce on purpose —
 * and the two causes it distinguishes (`retryable_http` means rate limiting,
 * `attempt_timeout` means the query is too slow for the budget) have opposite
 * fixes. It carries the same fields as the log line and, like the log line,
 * never the query or any coordinate.
 */
function unavailableResponse(attempts = []) {
  return {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": RETRY_AFTER_SECONDS,
    },
    body: JSON.stringify({
      error: "Map data service temporarily unavailable",
      attempts,
    }),
  };
}

function abortError() {
  const error = new Error("The downstream Overpass request was abandoned");
  error.name = "AbortError";
  return error;
}

function logAttempt(logger, details, attempts) {
  logger.info?.("Overpass upstream attempt", details);
  attempts?.push(details);
}

/**
 * Execute one Overpass request against the ordered provider pool.
 *
 * This is shared by the Vercel handler and Vite middleware. It intentionally
 * accepts only the encoded body and never includes it (or an error object that
 * might contain it) in logs.
 */
export async function requestOverpass(body, options = {}) {
  const env = options.env ?? process.env;
  const attempts = [];
  const endpoints = options.endpoints ?? configuredOverpassEndpoints(env);
  const attemptTimeoutMs = positiveNumber(
    options.attemptTimeoutMs,
    DEFAULT_ATTEMPT_TIMEOUT_MS
  );
  const totalTimeoutMs = positiveNumber(
    options.totalTimeoutMs,
    DEFAULT_TOTAL_TIMEOUT_MS
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + totalTimeoutMs;

  for (let index = 0; index < endpoints.length; index++) {
    if (options.signal?.aborted) throw abortError();

    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) break;

    const endpoint = endpoints[index];
    const attempt = index + 1;
    const attemptStartedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const onDownstreamAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onDownstreamAbort, { once: true });
    const timeoutMs = Math.min(attemptTimeoutMs, remainingMs);
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Umbra/1.0 (+https://shademapnav.vercel.app)",
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await response.text();
      const retryable = isRetryableOverpassStatus(response.status);
      logAttempt(logger, {
        endpoint: endpoint.label,
        attempt,
        durationMs: Math.max(0, Math.round(now() - attemptStartedAt)),
        status: response.status,
        failureClass: retryable
          ? "retryable_http"
          : response.status >= 200 && response.status < 300
            ? "success"
            : "forwarded_http",
      }, attempts);

      if (!retryable) {
        return {
          status: response.status,
          headers: selectedHeaders(response.headers),
          body: responseBody,
        };
      }
    } catch {
      if (options.signal?.aborted) {
        logAttempt(logger, {
          endpoint: endpoint.label,
          attempt,
          durationMs: Math.max(0, Math.round(now() - attemptStartedAt)),
          failureClass: "downstream_abort",
        }, attempts);
        throw abortError();
      }

      const totalExpired = now() >= deadlineAt;
      logAttempt(logger, {
        endpoint: endpoint.label,
        attempt,
        durationMs: Math.max(0, Math.round(now() - attemptStartedAt)),
        failureClass: timedOut
          ? totalExpired
            ? "total_timeout"
            : "attempt_timeout"
          : "network",
      }, attempts);
      if (totalExpired) break;
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onDownstreamAbort);
    }
  }

  return unavailableResponse(attempts);
}

function maxBodyBytes(env) {
  return positiveNumber(env.OVERPASS_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
}

function bodyTooLargeError() {
  const error = new Error("Overpass request is too large");
  error.statusCode = 413;
  return error;
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        reject(bodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function requestBody(req, limit) {
  let body;
  if (Buffer.isBuffer(req.body)) {
    body = req.body.toString("utf8");
  } else if (typeof req.body === "string") {
    body = req.body;
  } else if (req.body && typeof req.body === "object") {
    body = new URLSearchParams(req.body).toString();
  } else {
    body = await readRawBody(req, limit);
  }
  if (Buffer.byteLength(body, "utf8") > limit) throw bodyTooLargeError();
  return body;
}

function setStatus(res, status) {
  if (typeof res.status === "function") res.status(status);
  else res.statusCode = status;
}

function sendText(res, body) {
  if (typeof res.send === "function") res.send(body);
  else res.end(body);
}

function sendJson(res, status, body) {
  setStatus(res, status);
  if (typeof res.json === "function") {
    res.json(body);
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Node request/response handler used in production and by Vite. */
export async function handleOverpassRequest(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const env = process.env;
  const limit = maxBodyBytes(env);
  const contentLength = Number(req.headers?.["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    sendJson(res, 413, { error: "Overpass request is too large" });
    return;
  }

  let body;
  try {
    body = await requestBody(req, limit);
  } catch (error) {
    const status = error?.statusCode === 413 ? 413 : 400;
    sendJson(res, status, {
      error:
        status === 413
          ? "Overpass request is too large"
          : "Could not read Overpass request",
    });
    return;
  }

  const downstream = new AbortController();
  const abandon = () => downstream.abort();
  const abandonOnClose = () => {
    if (!res.writableEnded) abandon();
  };
  req.once?.("aborted", abandon);
  res.once?.("close", abandonOnClose);

  try {
    const response = await requestOverpass(body, { signal: downstream.signal });
    if (downstream.signal.aborted) return;
    setStatus(res, response.status);
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    sendText(res, response.body);
  } catch (error) {
    if (!downstream.signal.aborted && error?.name !== "AbortError") {
      sendJson(res, 503, {
        error: "Map data service temporarily unavailable",
      });
    }
  } finally {
    req.off?.("aborted", abandon);
    res.off?.("close", abandonOnClose);
  }
}

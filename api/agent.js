/**
 * Vercel serverless proxy for the agent's LLM provider (Google Gemini, free tier).
 *
 * Keeps the API key(s) off the client. The browser builds an OpenAI
 * chat-completions request and POSTs { provider: "gemini", payload }; we inject
 * a key and forward to Gemini's OpenAI-compatible endpoint, returning the JSON
 * verbatim. (All wire-format translation happens client-side in
 * app/lib/agent/llmClient.ts; this proxy validates, injects a key, forwards.)
 *
 * Multiple keys: set GEMINI_API_KEY to a comma-separated list, and/or add
 * GEMINI_API_KEY_1..9 — each key brings its own free quota. Requests round-robin
 * across the pool and fail over to the next key on 429/5xx, or 401/403.
 *
 * In dev there's no serverless runtime: the client calls Gemini through the
 * Vite `/__gemini` proxy instead. Free key: https://aistudio.google.com/apikey
 */

import { createRateLimiter, requestSourceAllowed, splitCsv } from "../server/proxyGuard.js";

/** Collect a deduped key pool from `GEMINI_API_KEY` (may be comma-separated) + `_1..9`. */
function collectKeys() {
  const out = [];
  const push = (v) => {
    if (!v) return;
    for (const part of String(v).split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  };
  push(process.env.GEMINI_API_KEY);
  for (let i = 1; i <= 9; i++) push(process.env[`GEMINI_API_KEY_${i}`]);
  return [...new Set(out)];
}

// Round-robin cursor (persists within a warm serverless instance).
let rr = 0;

const DEFAULT_ALLOWED_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const MAX_PAYLOAD_BYTES = Number(process.env.AGENT_MAX_PAYLOAD_BYTES || 250_000);
const isRateLimited = createRateLimiter("AGENT_RATE_LIMIT_PER_MIN", 20);

function allowedModels() {
  return new Set([
    ...DEFAULT_ALLOWED_MODELS,
    ...splitCsv(process.env.GEMINI_ALLOWED_MODELS),
  ]);
}

function payloadByteLength(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "payload must be an object";
  }
  if (!allowedModels().has(payload.model)) {
    return "model is not allowed";
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return "payload.messages must be a non-empty array";
  }
  if (payloadByteLength(payload) > MAX_PAYLOAD_BYTES) {
    return "payload is too large";
  }
  return null;
}

/**
 * Try `makeReq(key)` across the pool: round-robin start, fail over on 429 / 5xx
 * and on 401 / 403 — a dead key must not end the request while another works.
 * Returns the first acceptable Response, or the last one if all keys failed.
 */
async function forwardWithRotation(keys, makeReq) {
  const start = rr++ % keys.length;
  let last = null;
  for (let i = 0; i < keys.length; i++) {
    const res = await makeReq(keys[(start + i) % keys.length]);
    if (![401, 403, 429].includes(res.status) && res.status < 500) return res;
    last = res;
  }
  return last;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requestSourceAllowed(req, "AGENT_ALLOWED_ORIGINS")) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (isRateLimited(req)) {
    res.status(429).json({ error: "Too many agent requests. Try again shortly." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }
  body = body || {};

  if (body.provider && body.provider !== "gemini") {
    res.status(400).json({ error: "Unsupported provider" });
    return;
  }

  const payload = body.payload || {};
  const validationError = validatePayload(payload);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const keys = collectKeys();
    if (keys.length === 0) {
      res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
      return;
    }

    const makeReq = (key) =>
      fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });

    const upstream = await forwardWithRotation(keys, makeReq);
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    console.error("Agent proxy error:", err);
    res.status(502).json({ error: "Upstream LLM request failed" });
  }
}

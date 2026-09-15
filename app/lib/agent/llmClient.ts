/**
 * LLM client for the Umbra Assistant — Google Gemini (free tier), through its
 * OpenAI-compatible chat-completions endpoint.
 *
 * Supply several AI Studio keys as a comma-separated list in VITE_GEMINI_API_KEY
 * to pool the free per-key quota; requests round-robin across the pool and fail
 * over to the next key on a 429 / 5xx, or on a 401 / 403 from a dead key.
 *
 * Wire format: the agent loop speaks one neutral IR (the `LlmContent`/`LlmPart`
 * shape below — function calls/responses as parts). We translate that to/from
 * the OpenAI chat-completions shape here, so the loop never sees provider quirks.
 * Two of Gemini's live here: its endpoint rejects `seed`, and Gemini 3 attaches a
 * thought signature to every tool call that must come back verbatim on the next
 * request, or the second step of a tool turn fails.
 *
 * Transport:
 *  - DEV: called through the Vite dev proxy `/__gemini` (sidesteps CORS).
 *    Keys come from `VITE_GEMINI_API_KEY` and are dev-only.
 *  - PROD: goes through the serverless proxy `/api/agent`, which holds the
 *    server-only `GEMINI_API_KEY` and forwards upstream. See api/agent.js.
 *
 * Per-role model: the loop does its tool-use research with the "research" model,
 * then writes the final answer with the "response" model
 * (VITE_GEMINI_RESEARCH_MODEL / VITE_GEMINI_RESPONSE_MODEL). Both share the one
 * key pool.
 */
import type { ContentProvenance } from "./authority";

export interface LlmPart {
  text?: string;
  /** C10 source label preserved by the neutral transcript IR. */
  provenance?: ContentProvenance;
  /**
   * `extra` is provider data that must be echoed back with this call on the
   * next request — Gemini 3's thought signature. Opaque to the loop.
   */
  functionCall?: { name: string; args: Record<string, unknown>; extra?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface LlmContent {
  role: "user" | "model";
  parts: LlmPart[];
}

export interface LlmFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  contents: LlmContent[];
  tools?: { functionDeclarations: LlmFunctionDeclaration[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
}

export interface LlmResponse {
  candidates?: { content: LlmContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message: string };
}

export type ModelRole = "research" | "response";

// Two lite models, one per role: the live eval grounded 25/25 on this pair with
// a 5 s median write call — gemini-3.6-flash took 29 s — and a separate write
// model keeps the tool-free write prompt that carries the pin list.
const DEFAULT_MODEL: Record<ModelRole, string> = {
  research: "gemini-3.5-flash-lite",
  response: "gemini-3.1-flash-lite",
};

function modelForRole(role: ModelRole): string {
  const m =
    role === "research"
      ? (import.meta.env.VITE_GEMINI_RESEARCH_MODEL as string | undefined)
      : (import.meta.env.VITE_GEMINI_RESPONSE_MODEL as string | undefined);
  const base = import.meta.env.VITE_GEMINI_MODEL as string | undefined;
  return m?.trim() || base?.trim() || DEFAULT_MODEL[role];
}

function normalizeKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const f = t[0];
  const l = t[t.length - 1];
  if ((f === "'" || f === '"') && l === f && t.length >= 2) return t.slice(1, -1);
  return t;
}

/**
 * Collect a deduped key pool. Each var may itself be a comma-separated list, so
 * `VITE_GEMINI_API_KEY="k1,k2"` and/or numbered `VITE_GEMINI_API_KEY_1/_2/_3`
 * both work. (Vite only statically replaces literal `import.meta.env.X`, so the
 * numbered vars are referenced by name, not dynamically indexed.)
 */
function splitKeys(...vals: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of vals) {
    if (!v) continue;
    for (const part of String(v).split(",")) {
      const k = normalizeKey(part);
      if (k) out.push(k);
    }
  }
  return Array.from(new Set(out));
}

function geminiKeys(): string[] {
  return splitKeys(
    import.meta.env.VITE_GEMINI_API_KEY as string | undefined,
    import.meta.env.VITE_GEMINI_API_KEY_1 as string | undefined,
    import.meta.env.VITE_GEMINI_API_KEY_2 as string | undefined,
    import.meta.env.VITE_GEMINI_API_KEY_3 as string | undefined,
  );
}

/**
 * True when research and response resolve to the same model. Then the separate
 * write call is pure waste — the research model's own final answer is fine — so
 * the agent loop skips it. (Keys are one shared pool, so only the model matters.)
 */
export function rolesShareConfig(): boolean {
  return modelForRole("research") === modelForRole("response");
}

// Round-robin start index per role, so sequential calls spread across the pool
// instead of always hammering the first key.
const rrIndex: Record<string, number> = {};
function rrStart(tag: string, len: number): number {
  const safeLen = Math.max(1, len);
  const i = (rrIndex[tag] ?? 0) % safeLen;
  rrIndex[tag] = (i + 1) % safeLen;
  return i;
}

/**
 * Run the request across the key pool: round-robin start, then fail over to the
 * next key on 429 / 5xx, or 401 / 403 (a revoked or invalid key must not end the
 * turn while another key would work). Returns the first acceptable Response, or
 * the last one if every key failed (so the caller still surfaces a real error).
 */
const FAIL_OVER = new Set([401, 403, 429]);

async function fetchAcrossKeys(
  tag: string,
  keys: string[],
  makeReq: (key: string) => Promise<Response>,
): Promise<Response> {
  const start = rrStart(tag, keys.length);
  let last: Response | null = null;
  for (let i = 0; i < keys.length; i++) {
    const res = await makeReq(keys[(start + i) % keys.length]);
    if (!FAIL_OVER.has(res.status) && res.status < 500) return res;
    last = res;
  }
  return last!;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long to wait before retrying a 429, from the Retry-After header or the
 * provider's error message ("try again in 6.085s").
 */
async function parseRetryMs(res: Response): Promise<number | null> {
  const h = res.headers.get("retry-after");
  if (h) {
    const s = parseFloat(h);
    if (Number.isFinite(s)) return Math.ceil(s * 1000);
  }
  try {
    const txt = await res.clone().text();
    const m =
      txt.match(/(?:try again|retry)(?:\s+in)?\s*([\d.]+)\s*s/i) ||
      txt.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000);
  } catch {
    /* ignore */
  }
  return null;
}

/** Waits before retrying a 503: Gemini's "high demand" is model-wide, so another key won't help. */
const OVERLOAD_BACKOFF_MS = [2000, 6000];

/**
 * Run `doFetch`, and on a 429 (rate limit) wait the suggested delay and retry,
 * so a transient TPM/RPM cap becomes a short pause instead of a failed turn; a
 * 503 (overload) gets a short fixed backoff. In the first live eval on Gemini,
 * 34 of 183 requests were 503s and three turns died on them.
 * Caps the wait so we never hang the UI on an unrecoverable limit.
 */
async function withRateLimitRetry(
  doFetch: () => Promise<Response>,
  maxRetries = 2,
): Promise<Response> {
  let res = await doFetch();
  for (
    let attempt = 0;
    attempt < maxRetries && (res.status === 429 || res.status === 503);
    attempt++
  ) {
    const waitMs = res.status === 503 ? OVERLOAD_BACKOFF_MS[attempt] : await parseRetryMs(res);
    if (waitMs == null || waitMs > 15000) break; // unknown / too long → give up
    await delay(waitMs + 250);
    res = await doFetch();
  }
  return res;
}

export class AgentConfigError extends Error {}

// ---------------------------------------------------------------------------
// OpenAI chat-completions translation (Gemini's compatible endpoint speaks it)
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini: `{ google: { thought_signature } }`, echoed back verbatim. */
  extra_content?: Record<string, unknown>;
}
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/** Neutral IR request → OpenAI chat-completions body. */
function toOpenAIBody(req: LlmRequest, model: string): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];

  const sys = req.systemInstruction?.parts
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (sys) messages.push({ role: "system", content: sys });

  // Tool calls need stable ids; assign deterministically while walking history.
  // functionResponses (one user turn) follow the model turn that emitted the
  // matching functionCalls, in order.
  let callSeq = 0;
  let pendingCallIds: string[] = [];

  for (const content of req.contents) {
    if (content.role === "model") {
      const text = content.parts
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      const fcs = content.parts.filter((p) => p.functionCall);
      const msg: OpenAIMessage = { role: "assistant", content: text || null };
      if (fcs.length > 0) {
        pendingCallIds = [];
        msg.tool_calls = fcs.map((p) => {
          const id = `call_${callSeq++}`;
          pendingCallIds.push(id);
          return {
            id,
            type: "function" as const,
            function: {
              name: p.functionCall!.name,
              arguments: JSON.stringify(p.functionCall!.args ?? {}),
            },
            ...(p.functionCall!.extra ? { extra_content: p.functionCall!.extra } : {}),
          };
        });
      }
      messages.push(msg);
    } else {
      // user turn: may carry plain text and/or functionResponse parts
      const frs = content.parts.filter((p) => p.functionResponse);
      if (frs.length > 0) {
        frs.forEach((p, i) => {
          messages.push({
            role: "tool",
            tool_call_id: pendingCallIds[i] ?? `call_${callSeq++}`,
            content: JSON.stringify(p.functionResponse!.response ?? {}),
          });
        });
        pendingCallIds = [];
      }
      const text = content.parts
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (text) messages.push({ role: "user", content: text });
    }
  }

  const tools = req.tools?.[0]?.functionDeclarations.map((d) => ({
    type: "function" as const,
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));

  const temperature =
    typeof req.generationConfig?.temperature === "number" ? req.generationConfig.temperature : 0;

  // Determinism: temperature 0 + top_p 1. No `seed` — Gemini's endpoint
  // rejects the whole request if one is present.
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    top_p: 1,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    // One tool call at a time is far more reliable; parallel calls are a common
    // source of malformed-tool-call 400s.
    body.parallel_tool_calls = false;
  }
  return body;
}

interface OpenAIResponse {
  choices?: { message: OpenAIMessage; finish_reason?: string }[];
  error?: { message?: string; code?: string; failed_generation?: string };
}

/** Returned when the model emits a tool call the parser can't accept. */
function isMalformedToolCall(data: OpenAIResponse | undefined): boolean {
  const e = data?.error;
  if (!e) return false;
  if (e.code === "tool_use_failed") return true;
  return !!e.message && /failed to call a function|failed_generation/i.test(e.message);
}

/** Scan from the `{` at `start` and return the balanced JSON object substring. */
function sliceBalancedJson(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Some models emit tool calls as plain text instead of structured tool_calls —
 * e.g. `<function=search_places>{"query":"parks"}</function>` or
 * `<tool_call>{"name":...,"arguments":{...}}</tool_call>`. Salvage those so the
 * agent executes them instead of leaking the raw syntax into the chat.
 */
function extractTextToolCalls(text: string): { name: string; args: Record<string, unknown> }[] {
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  // <function=NAME> ... {json}  (closing tag optional)
  const reFn = /<function\s*=\s*([a-zA-Z_]\w*)\s*>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard /g exec-iteration idiom; the assignment IS the loop advance
  while ((m = reFn.exec(text))) {
    const braceStart = text.indexOf("{", m.index);
    if (braceStart === -1) continue;
    const json = sliceBalancedJson(text, braceStart);
    if (!json) continue;
    try {
      calls.push({ name: m[1], args: JSON.parse(json) as Record<string, unknown> });
    } catch {
      /* ignore unparseable */
    }
  }

  // <tool_call>{"name":..., "arguments"|"parameters":{...}}</tool_call>
  const reTc = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard /g exec-iteration idiom; the assignment IS the loop advance
  while ((m = reTc.exec(text))) {
    try {
      const o = JSON.parse(m[1]) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (o.name) {
        calls.push({
          name: o.name,
          args: (o.arguments ?? o.parameters ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return calls;
}

/** Remove any leftover tool-call markup so it's never shown to the user. */
function stripToolSyntax(text: string): string {
  return text
    .replace(/<\/?function[^>]*>/g, "")
    .replace(/<\/?tool_call>/g, "")
    .trim();
}

/** OpenAI chat-completions response → neutral IR. */
function fromOpenAI(data: OpenAIResponse): LlmResponse {
  const msg = data.choices?.[0]?.message;
  if (!msg) return { candidates: [] };
  const parts: LlmPart[] = [];
  const structured = msg.tool_calls ?? [];
  const text = msg.content ?? "";

  if (structured.length > 0) {
    if (text.trim()) parts.push({ text });
    for (const tc of structured) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      parts.push({
        functionCall: {
          name: tc.function.name,
          args,
          ...(tc.extra_content ? { extra: tc.extra_content } : {}),
        },
      });
    }
  } else {
    // No structured calls — recover any text-embedded ones.
    const recovered = extractTextToolCalls(text);
    if (recovered.length > 0) {
      for (const c of recovered) parts.push({ functionCall: { name: c.name, args: c.args } });
    } else {
      const clean = stripToolSyntax(text);
      if (clean) parts.push({ text: clean });
    }
  }

  return {
    candidates: [
      { content: { role: "model", parts }, finishReason: data.choices?.[0]?.finish_reason },
    ],
  };
}

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

export async function callModel(
  req: LlmRequest,
  role: ModelRole = "research",
): Promise<LlmResponse> {
  const body = toOpenAIBody(req, modelForRole(role));

  const doFetch = (): Promise<Response> => {
    if (import.meta.env.DEV) {
      const keys = geminiKeys();
      if (keys.length === 0) {
        throw new AgentConfigError(
          "Missing VITE_GEMINI_API_KEY. Get a free key at " +
            "https://aistudio.google.com/apikey and add it to .env. You can list " +
            "several (comma-separated) to pool the free per-key quota.",
        );
      }
      // Dev: route through the Vite proxy (vite.config.ts → /__gemini) for CORS.
      return fetchAcrossKeys(`gemini:${role}`, keys, (key) =>
        fetch("/__gemini/v1beta/openai/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        }),
      );
    }
    return fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini", role, payload: body }),
    });
  };

  let res = await withRateLimitRetry(doFetch);
  let data = (await res.json().catch(() => ({}))) as OpenAIResponse;

  // Malformed-tool-call 400s are a transient generation glitch — retry a couple
  // times before surfacing them.
  for (let attempt = 0; attempt < 2 && !res.ok && isMalformedToolCall(data); attempt++) {
    await delay(400);
    res = await withRateLimitRetry(doFetch);
    data = (await res.json().catch(() => ({}))) as OpenAIResponse;
  }

  if (!res.ok) {
    throw new Error(data?.error?.message ?? `LLM request failed (HTTP ${res.status})`);
  }
  if (data.error) throw new Error(data.error.message ?? "LLM error");
  return fromOpenAI(data);
}

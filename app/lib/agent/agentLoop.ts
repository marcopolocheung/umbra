/**
 * The agentic loop: a code-orchestrated tool-use cycle on top of a single
 * stateless model endpoint (Gemini, free tier).
 *
 *   user text → model → (function calls?) → execute tools → feed results back
 *             → model → ... → final text answer
 *
 * History is the Gemini `contents` array, threaded across turns so the
 * conversation (and the agent's earlier tool observations) persist.
 */
import {
  callModel,
  rolesShareConfig,
  type LlmContent,
  type LlmPart,
} from "./llmClient";
import {
  executeTool,
  parsePins,
  toolDeclarations,
  type AgentContext,
  type AssistantPin,
} from "./tools";
import { validateRoutePlanTerminalResult, type RoutePlanTerminalResult } from "../routePlanJob";

const SYSTEM_PROMPT = `You are the Umbra Assistant in a sun/shadow mapping app. You ONLY plan a day or outing around shadow and sun comfort: shadowed walks, where to sit or eat out of the sun at a given hour, and shadow-aware routes. If asked anything else, reply in one sentence that you only help plan around shadow, and stop. Do not answer off-topic questions.

The current map context (center, local time, whether the user's location is known) is given to you below — use it directly; do NOT ask for it.

Procedure (follow in order):
1. If locationKnown is false: if the user said "here"/"near me", call locate_user; otherwise ask which area they mean. Never invent a location.
2. If the user gave a time of day (e.g. "afternoon"), call set_time to that hour. Shadows depend on time.
3. Find stops with search_places (anchor to lat/lng or a 'near' name), or geocode_place for named places. You have up to four searches: if one comes back empty, reformulate with a different kind of stop or a different anchor — a first guess at a vague request often misses, and the retry is the call that finds the answer. Never repeat an identical call.
4. Only if the user asked how shaded the spots are, call check_shadow ONCE with every spot in points — it returns real building-shadow 0..1 per spot.
5. Call plot_points with the FULL ordered list of stops (numbered pins, map auto-framed). This ends your research: if the user asked for a walk or route, one through the pins is drawn for you.

Rules: never repeat an identical call; stay in the user's area; sequence stops by time of day (shadow moves with the sun); keep answers short and concrete; in your final answer, name only places you plotted.`;

// The happy path needs about five tool-emitting turns (locate_user, set_time,
// search_places, plot_points, plan_shadowed_route). A lower cap strands the loop
// before plot_points runs — so no pins ever reach the map.
const MAX_STEPS = 8;

/** Tools whose result depends only on their arguments (and, for shadow, the set time). */
const CACHEABLE = new Set(["geocode_place", "search_places", "check_shadow"]);

const REPEAT_NOTE = "You already made this exact call; this is its earlier result. Do not repeat it — move on.";
const EMPTY_SEARCH_NOTE =
  "No matches for that query. Try again with a different kind of stop or a different anchor — do not repeat this exact call.";

// Four searches admit a vague first guess plus reformulations, and still bound
// the worst case well under MAX_STEPS. What stops a spiral is the identical-call
// dedupe above (an exact repeat is answered, not re-run), never one empty
// result: live, the first guess at a vague query often misses, and the
// reformulation is the turn's most valuable call. Past the cap the loop stops
// offering search at all.
const MAX_SEARCHES = 4;
const SEARCH_CAP_NOTE = "The search limit for this turn is reached, so this one was not run. Use the places already found, or tell the user what wasn't found.";

/** The most pins one answer puts on the map. */
const MAX_PINS = 8;

// System prompt for the final write call. The write call has NO tools, so it
// must NOT reuse the research procedure (which orders the model to "call X"):
// a reasoning model handed those instructions with no tools available narrates
// the calls it can't make (raw `{"name":...}` JSON) into the answer. This prompt
// keeps the topic guardrail but tells it to synthesize only, never tool-call.
const WRITE_SYSTEM_PROMPT = `You are the Umbra Assistant in a sun/shadow mapping app. Using ONLY the information already gathered earlier in this conversation, write the final answer: a short, concrete shadow-aware itinerary with specific local times. Name only the places listed below as pinned on the map — never a place that isn't pinned, even if it came up earlier or you know it — and don't explain this rule or remark on what is or isn't pinned. Do NOT call, mention, narrate, or emit any tools, function calls, or JSON. If little was gathered, give the best brief shadow advice you can from what is available. Stay on shadow/sun comfort only.`;

export interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
}

export interface RunAgentOptions {
  history: LlmContent[];
  /** Pins already on the map from earlier turns. */
  pins?: AssistantPin[];
  userText: string;
  ctx: AgentContext;
  /** Called when the agent decides to invoke a tool (for UI activity display). */
  onToolEvent?: (e: ToolEvent) => void;
  /** Results of cacheable tools, kept across turns by the caller. */
  cache?: Map<string, Record<string, unknown>>;
}

export interface RunAgentResult {
  /** Final natural-language answer. */
  text: string;
  /** Updated history to thread into the next turn. */
  history: LlmContent[];
}

function extractText(content: LlmContent | undefined): string {
  if (!content) return "";
  return content.parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function pinKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function collectPointCandidates(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  candidates: AssistantPin[]
): void {
  const add = (lat: unknown, lng: unknown, label?: unknown) => {
    const nLat = num(lat);
    const nLng = num(lng);
    if (nLat == null || nLng == null) return;
    const key = pinKey(nLat, nLng);
    if (candidates.some((p) => pinKey(p.lat, p.lng) === key)) return;
    candidates.push({ lat: nLat, lng: nLng, label: str(label) });
  };

  if (toolName === "check_shadow") {
    add(args.lat, args.lng);
    for (const p of parsePins(args.points)) add(p.lat, p.lng, p.label);
    return;
  }

  if (toolName === "plan_shadowed_route") {
    add(args.fromLat, args.fromLng, args.fromLabel);
    for (const stop of parsePins(args.via)) add(stop.lat, stop.lng, stop.label);
    add(args.toLat, args.toLng, args.toLabel);
    return;
  }

  // Every hit is kept, not just the first eight: one past the pin cap is still
  // a place the answer can name, and reconcilePins needs its coordinates.
  if (toolName === "geocode_place" || toolName === "search_places") {
    const results = Array.isArray(result.results) ? result.results : [];
    for (const item of results) {
      const o = (item ?? {}) as Record<string, unknown>;
      add(o.lat, o.lng, o.name);
    }
  }
}

/** "Bryant Park, Midtown" → "Bryant Park": tools label places with two segments, answers use one. */
function primaryName(label: string | undefined): string {
  return label?.split(",")[0].trim() ?? "";
}

function asRouteTerminalResult(result: Record<string, unknown>): RoutePlanTerminalResult | null {
  return validateRoutePlanTerminalResult(result);
}

function malformedRouteTerminalResult(result: Record<string, unknown>): RoutePlanTerminalResult {
  return {
    requestId: typeof result.requestId === "string" ? result.requestId : "invalid-route-result",
    inputVersion: typeof result.inputVersion === "number" && Number.isSafeInteger(result.inputVersion) ? result.inputVersion : 0,
    planRevision: typeof result.planRevision === "number" && Number.isSafeInteger(result.planRevision) ? result.planRevision : 0,
    actionId: typeof result.actionId === "string" && result.actionId ? result.actionId : "invalid-action",
    retry: typeof result.retry === "number" && Number.isSafeInteger(result.retry) ? result.retry : 0,
    idempotencyKey: typeof result.idempotencyKey === "string" && result.idempotencyKey ? result.idempotencyKey : "invalid-idempotency-key",
    status: "error",
    message: "The route pipeline returned an invalid terminal result.",
  };
}

function routeTerminalText(result: RoutePlanTerminalResult): string {
  switch (result.status) {
    case "partial": {
      const legs = result.unroutableLegs
        .map((leg) => `leg ${leg.failedLeg} of ${leg.totalLegs}`)
        .join(", ");
      return `I could only make a partial route: ${legs} could not be routed. The completed legs remain visible on the map.`;
    }
    case "no_plan_found":
      return `I couldn't find a walkable route for those stops. ${result.message}`;
    case "cancelled":
      return "The route calculation was cancelled, so there is no completed route to describe.";
    case "error":
      return `I couldn't complete the route calculation: ${result.message}`;
    case "completed":
      return "";
  }
}

/** Whether the answer names this place as a whole name, so "Park 1" is not found in "Park 12". */
function namesPlace(answer: string, label: string | undefined): boolean {
  const name = primaryName(label).toLowerCase();
  // A name needs letters: "350, Fifth Avenue" must not match "a 350 m walk".
  if (!/\p{L}{3}/u.test(name)) return false;
  const text = answer.toLowerCase();
  // A manual boundary scan, not a lookbehind — Safari before 16.4 throws on those.
  const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + name.length])) return true;
  }
  return false;
}

/** Within ~30 m: one place, however differently a tool and the model rounded or labelled it. */
function samePlace(a: AssistantPin, b: AssistantPin): boolean {
  return Math.abs(a.lat - b.lat) < 0.0003 && Math.abs(a.lng - b.lng) < 0.0003;
}

function plottedPointSummary(pins: AssistantPin[]): string {
  return pins
    .map((p, i) => {
      const label = p.label ? `${p.label} ` : "";
      return `${i + 1}. ${label}(${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`;
    })
    .join("; ");
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { ctx, onToolEvent, cache = new Map() } = opts;
  // This turn's successful results by call, so a repeat is answered, not re-run.
  const turnResults = new Map<string, Record<string, unknown>>();
  let searches = 0;
  const searchClosed = () => searches >= MAX_SEARCHES;
  const contents: LlmContent[] = [
    ...opts.history,
    { role: "user", parts: [{ text: opts.userText }] },
  ];

  // Deterministic pre-injection: the map center / local time / location-known
  // status is plain app state, so we read it directly instead of spending an LLM
  // round-trip on a get_current_context tool call. Fetched fresh each turn and
  // appended to the system prompt (not the persisted history, so it never goes
  // stale across turns). get_current_context is read-only — no side effects.
  let ctxSnapshot: Record<string, unknown> = {};
  try {
    ctxSnapshot = await executeTool("get_current_context", {}, ctx);
  } catch {
    /* map not ready — fall through with empty context */
  }
  const ctxLine = `\n\nLive map context (already fetched — do NOT ask for it): ${JSON.stringify(
    ctxSnapshot
  )}`;

  // When research/response resolve to the same model, a separate write call is
  // wasted tokens — the research model's own final answer is the answer.
  const separateWrite = !rolesShareConfig();
  const pointCandidates: AssistantPin[] = [];
  /** What the map shows: earlier turns' pins until this turn plots. */
  let mapPins: AssistantPin[] = opts.pins ?? [];
  let plottedThisTurn = false;

  const plot = async (pins: AssistantPin[]): Promise<void> => {
    onToolEvent?.({ name: "plot_points", args: { points: pins } });
    try {
      const result = await executeTool("plot_points", { points: pins }, ctx);
      if (!result.error) {
        mapPins = pins;
        plottedThisTurn = true;
      }
    } catch {
      /* the answer's pin line reports whatever did land */
    }
  };

  const plotFallbackPoints = async (): Promise<void> => {
    if (plottedThisTurn || pointCandidates.length === 0) return;
    await plot(pointCandidates.slice(0, MAX_PINS));
  };

  // A user who asked for a route gets one: live, the model spent its steps
  // searching and never routed (#59), so the loop routes through the pins itself.
  let routedThisTurn = false;
  let terminalRouteResult: RoutePlanTerminalResult | null = null;
  const routeFallback = async (): Promise<void> => {
    if (routedThisTurn || mapPins.length < 2 || !/\b(route|walk)/i.test(opts.userText)) return;
    const from = mapPins[0];
    const to = mapPins[mapPins.length - 1];
    const args = {
      fromLat: from.lat,
      fromLng: from.lng,
      fromLabel: from.label,
      toLat: to.lat,
      toLng: to.lng,
      toLabel: to.label,
      via: mapPins.slice(1, -1),
    };
    onToolEvent?.({ name: "plan_shadowed_route", args });
    try {
      const result = await executeTool("plan_shadowed_route", args, ctx);
      terminalRouteResult = asRouteTerminalResult(result) ?? malformedRouteTerminalResult(result);
      routedThisTurn = terminalRouteResult.status === "completed" || terminalRouteResult.status === "partial";
    } catch {
      terminalRouteResult = malformedRouteTerminalResult({});
    }
  };

  // The write prompt's rule, enforced in code: a place a tool returned that the
  // answer names but the map doesn't show is pinned now. A place no tool
  // returned has no coordinates, so against pure invention the prompt is all
  // there is.
  const reconcilePins = async (answer: string): Promise<void> => {
    const sameName = (a: AssistantPin, b: AssistantPin) =>
      !!a.label && primaryName(a.label).toLowerCase() === primaryName(b.label).toLowerCase();
    const missing: AssistantPin[] = [];
    for (const c of pointCandidates) {
      if (!namesPlace(answer, c.label)) continue;
      const onMap = mapPins.some((p) => samePlace(c, p) || sameName(c, p));
      if (!onMap && !missing.some((m) => sameName(c, m))) missing.push(c);
    }
    if (missing.length === 0) return;
    // A pin is mentioned if its label is, or if a named place sits under it.
    const mentioned = (p: AssistantPin) =>
      namesPlace(answer, p.label) ||
      pointCandidates.some((c) => samePlace(c, p) && namesPlace(answer, c.label));
    // Make room under the cap by dropping, last first, pins the answer never mentions.
    const keep = [...mapPins];
    for (let i = keep.length - 1; i >= 0 && keep.length + missing.length > MAX_PINS; i--) {
      if (!mentioned(keep[i])) keep.splice(i, 1);
    }
    await plot([...keep, ...missing].slice(0, MAX_PINS));
  };

  // --- Research phase: tool-use loop on the "research" model. ---
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await callModel(
      {
        contents,
        tools: [
          {
            functionDeclarations: searchClosed()
              ? toolDeclarations.filter((t) => t.name !== "search_places")
              : toolDeclarations,
          },
        ],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT + ctxLine }] },
        generationConfig: { temperature: 0 },
      },
      "research"
    );

    const candidate = res.candidates?.[0]?.content;
    if (!candidate) {
      const blocked = res.promptFeedback?.blockReason;
      if (blocked) return { text: `I couldn't respond to that (${blocked}).`, history: contents };
      break; // nothing came back — fall through to the write phase
    }

    const calls = candidate.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      // Done researching.
      await plotFallbackPoints();
      await routeFallback();
      if (terminalRouteResult && terminalRouteResult.status !== "completed") {
        return { text: routeTerminalText(terminalRouteResult), history: contents };
      }
      // Same config for both roles → research model's answer IS the answer, and
      // returning it saves a full-context write call (TPD savings). So does a
      // turn that called no tool at all — a refusal, or a question back to the
      // user: there is nothing gathered for the write call to ground, and
      // rewriting it turned "which area?" into generic advice in the live eval.
      if (!separateWrite || step === 0) {
        contents.push({ role: candidate.role ?? "model", parts: candidate.parts });
        const text = extractText(candidate) || "(no reply)";
        await reconcilePins(text);
        return { text, history: contents };
      }
      // Roles differ → discard this draft; the response model writes below.
      break;
    }

    // Persist the tool-call turn, execute the calls, feed results back.
    contents.push({ role: candidate.role ?? "model", parts: candidate.parts });
    const responseParts: LlmPart[] = [];
    for (const part of calls) {
      const fc = part.functionCall!;
      let args = fc.args ?? {};
      // The model's own plot obeys the pin cap too, and a bare pin sitting on a
      // place a tool returned takes that place's name — Gemini plotted twelve
      // unlabelled pins in the live eval, so the answer named places no pin did.
      if (fc.name === "plot_points") {
        const points = parsePins(args.points)
          .slice(0, MAX_PINS)
          .map((p) =>
            p.label ? p : { ...p, label: pointCandidates.find((c) => c.label && samePlace(c, p))?.label }
          );
        args = { ...args, points };
      }
      // A shadow check without a time reads the set time, so that is part of its key.
      const key = `${fc.name}${JSON.stringify(args)}${fc.name === "check_shadow" ? ctx.dateRef.current.getTime() : ""}`;
      // An unanchored search reads the moving map, so it is only a repeat within the turn.
      const cacheable =
        CACHEABLE.has(fc.name) && !(fc.name === "search_places" && args.lat == null && args.near == null);
      let result: Record<string, unknown>;
      const earlier = turnResults.get(key);
      if (earlier) {
        result = { ...earlier, note: REPEAT_NOTE };
      } else if (fc.name === "search_places" && searchClosed()) {
        result = { results: [], note: SEARCH_CAP_NOTE };
      } else if (cacheable && cache.has(key)) {
        result = cache.get(key)!;
        if (fc.name === "search_places") searches++;
      } else {
        if (fc.name === "search_places") searches++;
        onToolEvent?.({ name: fc.name, args });
        try {
          result = await executeTool(fc.name, args, ctx);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "Tool failed." };
        }
        // An empty search depends on the query wording and the map viewport, so
        // it is never reused across turns — a miss now must not veto a retry
        // later. (The per-turn dedupe above still answers an identical repeat.)
        const emptySearchResult =
          fc.name === "search_places" &&
          Array.isArray(result.results) &&
          result.results.length === 0;
        if (!result.error && cacheable && !emptySearchResult) cache.set(key, result);
      }
      if (!result.error) turnResults.set(key, result);
      if (
        fc.name === "search_places" &&
        Array.isArray(result.results) &&
        result.results.length === 0 &&
        !searchClosed()
      ) {
        result = { ...result, note: EMPTY_SEARCH_NOTE };
      }
      if (fc.name === "plot_points" && !result.error) {
        mapPins = parsePins(args.points);
        plottedThisTurn = true;
      }
      if (fc.name === "plan_shadowed_route") {
        terminalRouteResult = asRouteTerminalResult(result) ?? malformedRouteTerminalResult(result);
        routedThisTurn = terminalRouteResult.status === "completed" || terminalRouteResult.status === "partial";
      }
      collectPointCandidates(fc.name, args, result, pointCandidates);
      responseParts.push({ functionResponse: { name: fc.name, response: result } });
    }
    contents.push({ role: "user", parts: responseParts });
    // The model's plot is its last research step — asking it again only buys a
    // draft the write call discards. The loop routes, if asked, below.
    if (plottedThisTurn) break;
  }

  await plotFallbackPoints();
  await routeFallback();

  // The terminal result is already in the function-response history. Avoid a
  // write-model paraphrase for non-success outcomes: no provider prose can turn
  // cancellation, failure, or an unroutable leg into a claimed completed route.
  if (terminalRouteResult && terminalRouteResult.status !== "completed") {
    return { text: routeTerminalText(terminalRouteResult), history: contents };
  }

  // Always state what the map shows — including pins the model placed itself,
  // which is the list the write prompt tells it to stay inside.
  const pinnedLine = mapPins.length
    ? `\n\nMap state guarantee: these pins are on the map, and they are the only places you may name: ${plottedPointSummary(mapPins)}.${
        routedThisTurn ? " A shadow-aware walking route through them completed on the map." : ""
      }`
    : "\n\nNothing is pinned on the map, so name no specific place.";

  // --- Write phase: final answer on the "response" model, no tools. ---
  const finalRes = await callModel(
    {
      contents,
      systemInstruction: { parts: [{ text: WRITE_SYSTEM_PROMPT + ctxLine + pinnedLine }] },
      generationConfig: { temperature: 0 },
    },
    "response"
  );

  const finalCandidate = finalRes.candidates?.[0]?.content;
  if (!finalCandidate) {
    const blocked = finalRes.promptFeedback?.blockReason;
    return {
      text: blocked
        ? `I couldn't respond to that (${blocked}).`
        : "I didn't get a response from the model. Try rephrasing.",
      history: contents,
    };
  }

  // Offered no tools, a model can still answer with a tool call and no text
  // (seen live). Keep only the prose — an unanswered call in history breaks the
  // next request — and if there is none, say plainly what the map shows.
  const text =
    extractText(finalCandidate) ||
    (mapPins.length
      ? `I didn't get a written plan back, but these are on the map: ${mapPins
          .map((p) => p.label ?? "an unnamed stop")
          .join(", ")}. Ask again and I'll pick up from here.`
      : "I didn't get a written answer back. Try asking again.");
  contents.push({ role: "model", parts: [{ text }] });
  await reconcilePins(text);
  return { text, history: contents };
}

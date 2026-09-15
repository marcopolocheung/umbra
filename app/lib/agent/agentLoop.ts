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
import { callModel, rolesShareConfig, type LlmContent, type LlmPart } from "./llmClient";
import {
  executeTool,
  parsePins,
  toolDeclarations,
  type AgentContext,
  type AssistantPin,
} from "./tools";
import { validateRoutePlanTerminalResult, type RoutePlanTerminalResult } from "../routePlanJob";
import {
  claimSupportMetrics,
  noticeLabel,
  receiptLabel,
  unknownLabel,
  validateToolResultEnvelope,
  verifyAnswer,
  type AgentToolName,
  type MapObject,
  type ToolResultEnvelope,
  type ClaimSupportMetrics,
  type VerifiedAnswer,
  type VerifiedAnswerBlock,
} from "./receipts";
import {
  authorizeToolCall,
  candidateIdentities,
  boundUntrustedPayload,
  currentTurnTerms,
  isContentProvenance,
  toolErrorText,
  type AuthorityAuditEvent,
  type FieldSourceCategory,
} from "./authority";

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

const REPEAT_NOTE =
  "You already made this exact call; this is its earlier result. Do not repeat it — move on.";
const EMPTY_SEARCH_NOTE =
  "No matches for that query. Try again with a different kind of stop or a different anchor — do not repeat this exact call.";

// Four searches admit a vague first guess plus reformulations, and still bound
// the worst case well under MAX_STEPS. What stops a spiral is the identical-call
// dedupe above (an exact repeat is answered, not re-run), never one empty
// result: live, the first guess at a vague query often misses, and the
// reformulation is the turn's most valuable call. Past the cap the loop stops
// offering search at all.
const MAX_SEARCHES = 4;
const SEARCH_CAP_NOTE =
  "The search limit for this turn is reached, so this one was not run. Use the places already found, or tell the user what wasn't found.";

/** The most pins one answer puts on the map. */
const MAX_PINS = 8;

// System prompt for the final write call. The write call has NO tools, so it
// must NOT reuse the research procedure (which orders the model to "call X"):
// a reasoning model handed those instructions with no tools available narrates
// the calls it can't make (raw `{"name":...}` JSON) into the answer. This prompt
// keeps the topic guardrail but tells it to synthesize only, never tool-call.
const WRITE_SYSTEM_PROMPT = `You are the Umbra Assistant in a sun/shadow mapping app. Return JSON only, never markdown. The JSON must be {"blocks":[{"kind":"text","text":"non-factual connective language only"},{"kind":"claim","claimId":"..."},{"kind":"unknown","claimKind":"accessibility","text":"Accessibility is unknown."}],"receipts":[...]}. Every named place, percentage, time, route-status, or accessibility statement MUST be represented by a claim or unknown block; text blocks may not contain facts. Each receipt must cite exactly one resultId from the supplied evidence, and must match that result's tool kind. For a place include kind, subject, value {lat,lng}, supportingResultIds and mapObjectId. For shadow include value {fraction}, coordinates and atLocalTime. For time include value {localTime}. For a route include value {status}, requestId, actionId, planRevision and mapObjectId. Accessibility has no verification tool: say unknown. Do not call or mention tools.`;

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
  /** C10 structured, content-free authority decisions for application audit sinks. */
  onAuthorityEvent?: (event: AuthorityAuditEvent) => void;
  /** Results of cacheable tools, kept across turns by the caller. */
  cache?: Map<string, ToolResultEnvelope>;
  /** Session evidence graph, intentionally separate from the Gemini transcript. */
  evidence?: ToolResultEnvelope[];
  /** Deterministic seams for receipt tests; defaults never use wall-clock randomness. */
  resultIdFactory?: (input: { toolName: AgentToolName; sequence: number }) => string;
  now?: () => string;
}

export interface RunAgentResult {
  /** Final natural-language answer. */
  text: string;
  /** Updated history to thread into the next turn. */
  history: LlmContent[];
  answer: VerifiedAnswer;
  evidence: ToolResultEnvelope[];
  metrics: ClaimSupportMetrics;
  authorityEvents: AuthorityAuditEvent[];
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
  candidates: AssistantPin[],
  resultId?: string,
): void {
  const add = (lat: unknown, lng: unknown, label?: unknown, candidateId?: unknown) => {
    const nLat = num(lat);
    const nLng = num(lng);
    if (nLat == null || nLng == null) return;
    const key = pinKey(nLat, nLng);
    if (candidates.some((p) => pinKey(p.lat, p.lng) === key)) return;
    candidates.push({ lat: nLat, lng: nLng, label: str(label), candidateId: str(candidateId) });
  };

  // A successful shadow observation is application-generated evidence for the
  // queried point. Failed/provider-error text never contributes a candidate.
  if (toolName === "check_shadow" && !result.error) {
    add(
      args.lat,
      args.lng,
      undefined,
      resultId ? `shadow-candidate:${resultId}:single` : undefined,
    );
    for (const [index, p] of parsePins(args.points).entries()) {
      add(
        p.lat,
        p.lng,
        p.label,
        p.candidateId ?? (resultId ? `shadow-candidate:${resultId}:${index}` : undefined),
      );
    }
    return;
  }

  if (toolName === "plan_shadowed_route") {
    add(args.fromLat, args.fromLng, args.fromLabel, args.fromCandidateId);
    for (const stop of parsePins(args.via)) add(stop.lat, stop.lng, stop.label, stop.candidateId);
    add(args.toLat, args.toLng, args.toLabel, args.toCandidateId);
    return;
  }

  // Every hit is kept, not just the first eight: one past the pin cap is still
  // a place the answer can name, and reconcilePins needs its coordinates.
  if (toolName === "geocode_place" || toolName === "search_places") {
    const results = Array.isArray(result.results) ? result.results : [];
    for (const [index, item] of results.entries()) {
      const o = (item ?? {}) as Record<string, unknown>;
      add(o.lat, o.lng, o.name, resultId ? `candidate:${resultId}:${index}` : undefined);
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
    inputVersion:
      typeof result.inputVersion === "number" && Number.isSafeInteger(result.inputVersion)
        ? result.inputVersion
        : 0,
    planRevision:
      typeof result.planRevision === "number" && Number.isSafeInteger(result.planRevision)
        ? result.planRevision
        : 0,
    actionId:
      typeof result.actionId === "string" && result.actionId ? result.actionId : "invalid-action",
    retry:
      typeof result.retry === "number" && Number.isSafeInteger(result.retry) ? result.retry : 0,
    idempotencyKey:
      typeof result.idempotencyKey === "string" && result.idempotencyKey
        ? result.idempotencyKey
        : "invalid-idempotency-key",
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

function routeObjectId(result: RoutePlanTerminalResult): string {
  return `route:${result.requestId}:${result.actionId}:${result.planRevision}`;
}

function parseModelAnswer(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    /* Gemini occasionally fences JSON despite the prompt. */
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (!fenced) return null;
  try {
    return JSON.parse(fenced);
  } catch {
    return null;
  }
}

/** Honest deterministic fallback when the model's structured response is malformed. */
function evidenceProposal(
  evidence: ToolResultEnvelope[],
  mapObjects: MapObject[],
  wantsAccessibility: boolean,
): unknown {
  const receipts: Record<string, unknown>[] = [];
  let index = 0;
  const push = (receipt: Record<string, unknown>) => {
    const claimId = `evidence-${++index}`;
    receipts.push({ claimId, ...receipt });
  };
  for (const envelope of evidence) {
    const payload = envelope.payload;
    if (envelope.toolName === "geocode_place" || envelope.toolName === "search_places") {
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const raw of results) {
        const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (
          typeof item.lat !== "number" ||
          typeof item.lng !== "number" ||
          typeof item.name !== "string"
        )
          continue;
        const lat = item.lat;
        const lng = item.lng;
        const name = item.name;
        const pin = mapObjects.find(
          (object) =>
            object.kind === "pin" &&
            object.lat != null &&
            object.lng != null &&
            Math.abs(object.lat - lat) < 0.0003 &&
            Math.abs(object.lng - lng) < 0.0003,
        );
        if (pin)
          push({
            kind: "place",
            subject: name,
            value: { lat, lng },
            mapObjectId: pin.id,
            supportingResultIds: [envelope.resultId],
          });
      }
    } else if (envelope.toolName === "check_shadow") {
      const values = Array.isArray(payload.results) ? payload.results : [payload];
      for (const raw of values) {
        const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (
          typeof item.lat !== "number" ||
          typeof item.lng !== "number" ||
          typeof item.shadowFraction !== "number" ||
          typeof item.atLocalTime !== "string"
        )
          continue;
        push({
          kind: "shadow",
          subject: typeof item.label === "string" ? item.label : "checked location",
          value: { fraction: item.shadowFraction },
          coordinates: { lat: item.lat, lng: item.lng },
          atLocalTime: item.atLocalTime,
          supportingResultIds: [envelope.resultId],
        });
      }
    } else if (envelope.toolName === "set_time" && typeof payload.newLocalTime === "string") {
      push({
        kind: "time",
        subject: "simulation time",
        value: { localTime: payload.newLocalTime },
        supportingResultIds: [envelope.resultId],
      });
    } else if (envelope.toolName === "plan_shadowed_route") {
      const terminal = validateRoutePlanTerminalResult(payload);
      if (terminal?.status === "completed" || terminal?.status === "partial") {
        push({
          kind: "route",
          subject: "route",
          value: { status: terminal.status },
          supportingResultIds: [envelope.resultId],
          requestId: terminal.requestId,
          actionId: terminal.actionId,
          planRevision: terminal.planRevision,
          mapObjectId: routeObjectId(terminal),
        });
      }
    }
  }
  if (wantsAccessibility) {
    receipts.push({
      claimId: `evidence-${++index}`,
      kind: "accessibility",
      subject: "accessibility",
      value: "unknown",
      supportingResultIds: [],
    });
  }
  return { receipts };
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { ctx, onToolEvent, cache = new Map() } = opts;
  const authorityEvents: AuthorityAuditEvent[] = [];
  const audit = (event: AuthorityAuditEvent) => {
    authorityEvents.push(event);
    opts.onAuthorityEvent?.(event);
  };
  // Persisted history, C5 evidence and cache entries are transcript boundaries.
  // Missing provenance is a rejection, rather than a compatibility guess.
  const malformedBoundary =
    opts.history.some((content) =>
      content.parts.some((part) => !isContentProvenance(part.provenance)),
    ) ||
    (opts.evidence ?? []).some((entry) => !validateToolResultEnvelope(entry)) ||
    [...cache.values()].some((entry) => !validateToolResultEnvelope(entry));
  if (malformedBoundary) {
    const event: AuthorityAuditEvent = {
      tool: "transcript",
      fieldSourceCategories: [],
      decision: "rejected",
      reasonCode: "missing_or_malformed_provenance",
    };
    audit(event);
    const answer: VerifiedAnswer = {
      blocks: [
        { kind: "notice", code: "unverified", detail: "Transcript provenance was rejected." },
      ],
      receipts: [],
      rejectedProseCount: 0,
      danglingClaimBlocks: 0,
      duplicateClaimProposals: 0,
    };
    const evidence = opts.evidence ?? [];
    return {
      text: noticeLabel(answer.blocks[0] as Extract<VerifiedAnswerBlock, { kind: "notice" }>),
      history: opts.history,
      answer,
      evidence,
      metrics: claimSupportMetrics(answer, { evidence, mapObjects: ctx.getMapObjects() }),
      authorityEvents,
    };
  }
  // A persisted current-turn label must never become authority on a later
  // invocation. Model output likewise becomes prior-assistant data. Tool
  // response provenance stays attached to its provider/application boundary.
  const priorHistory: LlmContent[] = opts.history.map((content) => ({
    ...content,
    parts: content.parts.map((part) => {
      const category = part.provenance?.category;
      const priorCategory =
        category === "current_user_intent"
          ? "prior_user_content"
          : content.role === "model" && category === "model_generated"
            ? "prior_assistant_content"
            : category;
      return priorCategory
        ? { ...part, provenance: { category: priorCategory, bounded: true } }
        : part;
    }),
  }));
  // This turn's successful results by call, so a repeat is answered, not re-run.
  const turnResults = new Map<string, ToolResultEnvelope>();
  const evidence = [...(opts.evidence ?? [])];
  let resultSequence = evidence.length;
  const now = opts.now ?? (() => ctx.dateRef.current.toISOString());
  const observe = (
    name: AgentToolName,
    args: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): ToolResultEnvelope => {
    const enriched =
      name === "check_shadow" && !Array.isArray(payload.results)
        ? { ...payload, lat: payload.lat ?? args.lat, lng: payload.lng ?? args.lng }
        : payload;
    const terminal =
      name === "plan_shadowed_route" ? validateRoutePlanTerminalResult(enriched) : null;
    const sequence = ++resultSequence;
    const category: FieldSourceCategory =
      typeof enriched.error === "string"
        ? "tool_provider_error"
        : name === "geocode_place" || name === "search_places"
          ? "provider_controlled"
          : "application_state";
    const sanitized =
      category === "provider_controlled"
        ? boundUntrustedPayload(enriched)
        : category === "tool_provider_error"
          ? boundUntrustedPayload(enriched, "tool_provider_error")
          : { value: enriched, fieldProvenance: {} };
    const boundedPayload = sanitized.value as Record<string, unknown>;
    if (typeof boundedPayload.error === "string")
      boundedPayload.error = toolErrorText(boundedPayload.error);
    const envelope: ToolResultEnvelope = {
      resultId: opts.resultIdFactory?.({ toolName: name, sequence }) ?? `result-${sequence}`,
      toolName: name,
      producedAt: now(),
      sourceVersion:
        typeof enriched.sourceVersion === "string" ? enriched.sourceVersion : undefined,
      requestId: terminal?.requestId,
      actionId: terminal?.actionId,
      planRevision: terminal?.planRevision,
      provenance: { category, bounded: true },
      fieldProvenance: sanitized.fieldProvenance,
      payload: boundedPayload,
    };
    if (!validateToolResultEnvelope(envelope))
      Object.assign(envelope, {
        provenance: { category: "tool_provider_error" as const, bounded: true as const },
        fieldProvenance: {
          "payload.error": { category: "tool_provider_error" as const, bounded: true as const },
        },
        payload: { error: "The tool returned an invalid evidence payload." },
      });
    evidence.push(envelope);
    if (name === "check_shadow") {
      const values = Array.isArray(enriched.results) ? enriched.results : [enriched];
      ctx.registerMapObjects(
        values.flatMap((raw) => {
          const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return typeof item.lat === "number" && typeof item.lng === "number"
            ? [
                {
                  id: `shadow:${envelope.resultId}:${item.lat.toFixed(5)}:${item.lng.toFixed(5)}`,
                  kind: "shadow" as const,
                  lat: item.lat,
                  lng: item.lng,
                  label: typeof item.label === "string" ? item.label : undefined,
                },
              ]
            : [];
        }),
      );
    }
    return envelope;
  };
  const modelResult = (envelope: ToolResultEnvelope, reused = false): Record<string, unknown> => ({
    ...envelope.payload,
    _receipt: { resultId: envelope.resultId, producedAt: envelope.producedAt, reused },
    // Deliberately visible to the model and retained when replayed. This is a
    // label, not a prompt-only defense: authorization reads envelope provenance.
    _provenance: {
      category: envelope.provenance.category,
      fields: envelope.fieldProvenance,
      authority: "none",
      dataOnly: true,
    },
  });
  let searches = 0;
  const searchClosed = () => searches >= MAX_SEARCHES;
  const contents: LlmContent[] = [
    ...priorHistory,
    {
      role: "user",
      parts: [
        {
          text: opts.userText.slice(0, 2000),
          provenance: { category: "current_user_intent", bounded: true },
        },
      ],
    },
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
    ctxSnapshot,
  )}`;

  // When research/response resolve to the same model, a separate write call is
  // wasted tokens — the research model's own final answer is the answer.
  const separateWrite = !rolesShareConfig();
  const pointCandidates: AssistantPin[] = [];
  /** What the map shows: earlier turns' pins until this turn plots. */
  let mapPins: AssistantPin[] = opts.pins ?? [];
  let plottedThisTurn = false;
  const authorityState = () => ({
    currentUserText: opts.userText,
    candidates: [
      ...evidence.flatMap((entry) => candidateIdentities(entry.resultId, entry.payload)),
      ...mapPins.map((pin, index) => ({
        id: pin.candidateId ?? pin.objectId ?? `map-pin:${index}`,
        lat: pin.lat,
        lng: pin.lng,
      })),
      ...pointCandidates.flatMap((pin) =>
        pin.candidateId ? [{ id: pin.candidateId, lat: pin.lat, lng: pin.lng }] : [],
      ),
    ],
  });
  const attachExactCandidateIds = (tool: string, rawArgs: Record<string, unknown>) => {
    const candidates = authorityState().candidates;
    const idFor = (lat: unknown, lng: unknown) =>
      candidates.find((candidate) => candidate.lat === lat && candidate.lng === lng)?.id;
    if (tool === "plot_points" && Array.isArray(rawArgs.points)) {
      return {
        ...rawArgs,
        points: rawArgs.points.map((raw) => {
          const point = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return { ...point, candidateId: point.candidateId ?? idFor(point.lat, point.lng) };
        }),
      };
    }
    if (tool === "check_shadow") {
      const pointWithId = (raw: unknown) => {
        const point = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        return { ...point, candidateId: point.candidateId ?? idFor(point.lat, point.lng) };
      };
      return Array.isArray(rawArgs.points)
        ? { ...rawArgs, points: rawArgs.points.map(pointWithId) }
        : {
            ...rawArgs,
            candidateId: rawArgs.candidateId ?? idFor(rawArgs.lat, rawArgs.lng),
          };
    }
    if (tool === "search_places" && (rawArgs.lat != null || rawArgs.lng != null)) {
      return {
        ...rawArgs,
        nearCandidateId: rawArgs.nearCandidateId ?? idFor(rawArgs.lat, rawArgs.lng),
      };
    }
    if (tool === "plan_shadowed_route") {
      return {
        ...rawArgs,
        fromCandidateId: rawArgs.fromCandidateId ?? idFor(rawArgs.fromLat, rawArgs.fromLng),
        toCandidateId: rawArgs.toCandidateId ?? idFor(rawArgs.toLat, rawArgs.toLng),
        via: Array.isArray(rawArgs.via)
          ? rawArgs.via.map((raw) => {
              const point = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
              return { ...point, candidateId: point.candidateId ?? idFor(point.lat, point.lng) };
            })
          : rawArgs.via,
      };
    }
    return rawArgs;
  };
  const sourceCategoriesForCall = (
    tool: string,
    args: Record<string, unknown>,
  ): FieldSourceCategory[] => {
    // A function call is always a model proposal.  The additional category is
    // only attached after deterministic validation identifies the authority
    // source for its sensitive fields; the proposal itself never grants it.
    if (tool === "set_time" || tool === "locate_user")
      return ["model_generated", "current_user_intent"];
    if (tool === "plot_points" || tool === "plan_shadowed_route")
      return ["model_generated", "current_user_intent", "application_state"];
    if (tool === "check_shadow")
      return ["model_generated", "current_user_intent", "application_state"];
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const userTerms = currentTurnTerms(opts.userText);
    const queryTerms = query.match(/[a-z]{3,}/g) ?? [];
    const userGrounds = (word: string) =>
      userTerms.positive.has(word) ||
      [...userTerms.positive].some(
        (userWord) =>
          userWord.startsWith(word.slice(0, 4)) || word.startsWith(userWord.slice(0, 4)),
      );
    const userExcludes = (word: string) =>
      userTerms.negative.has(word) ||
      [...userTerms.negative].some(
        (userWord) =>
          userWord.startsWith(word.slice(0, 4)) || word.startsWith(userWord.slice(0, 4)),
      );
    // The model may choose only a small, application-defined search taxonomy
    // for a broad current-turn outing request.  Free-form query terms remain
    // model-generated unless they are words the user supplied this turn.
    const applicationSearchTerms = new Set([
      "park",
      "parks",
      "plaza",
      "plazas",
      "cafe",
      "cafes",
      "coffee",
      "shadow",
      "shadowed",
      "shade",
      "shaded",
      "sun",
      "sunny",
      "bench",
      "benches",
      "fountain",
      "fountains",
      "kiosk",
      "kiosks",
      "somewhere",
    ]);
    // Every term must be either from this user turn or this small application
    // taxonomy. One safe-looking overlap cannot launder an added directive.
    const queryIsCurrentTurnBound =
      queryTerms.length > 0 &&
      queryTerms.every(
        (word) => !userExcludes(word) && (userGrounds(word) || applicationSearchTerms.has(word)),
      );
    return queryIsCurrentTurnBound
      ? ["model_generated", "current_user_intent"]
      : ["model_generated"];
  };

  const plot = async (pins: AssistantPin[]): Promise<void> => {
    const args = { points: pins };
    const authorization = authorizeToolCall(authorityState(), "plot_points", args, [
      "application_state",
    ]);
    audit(authorization.event);
    if (!authorization.execution) return;
    onToolEvent?.({ name: "plot_points", args });
    try {
      const raw = await executeTool("plot_points", args, ctx, authorization.execution);
      const result = observe("plot_points", args, raw);
      if (!result.payload.error) {
        mapPins = pins;
        // Keep the application-owned pin registry in sync even when an
        // alternate tool executor (such as the deterministic harness) does
        // not itself update map state.
        ctx.setPins(pins);
        plottedThisTurn = true;
      }
    } catch (error) {
      observe("plot_points", args, {
        error: error instanceof Error ? error.message : "Tool failed.",
      });
    }
  };

  const finalize = (modelText: string, proposed?: unknown): RunAgentResult => {
    const mapObjects = ctx.getMapObjects();
    const answer = verifyAnswer(
      proposed ??
        evidenceProposal(
          evidence,
          mapObjects,
          /\b(accessib|wheelchair|step[- ]free)/i.test(opts.userText),
        ),
      { evidence, mapObjects, currentPlanRevision: ctx.getCurrentPlanRevision(), now: now() },
    );
    const text =
      answer.blocks
        .map((block) => {
          if (block.kind === "unknown") return unknownLabel(block.claimKind);
          if (block.kind === "notice") return noticeLabel(block);
          const receipt = answer.receipts.find((candidate) => candidate.claimId === block.claimId);
          return receipt ? receiptLabel(receipt) : "";
        })
        .filter(Boolean)
        .join("\n") || modelText;
    return {
      text,
      history: contents,
      answer,
      evidence,
      metrics: claimSupportMetrics(answer, { evidence, mapObjects }),
      authorityEvents,
    };
  };
  const finalizeNotice = (
    code: Extract<VerifiedAnswerBlock, { kind: "notice" }>["code"],
    detail?: string,
  ): RunAgentResult => {
    const notice: Extract<VerifiedAnswerBlock, { kind: "notice" }> = {
      kind: "notice",
      code,
      detail,
    };
    const answer: VerifiedAnswer = {
      blocks: [notice],
      receipts: [],
      rejectedProseCount: 0,
      danglingClaimBlocks: 0,
      duplicateClaimProposals: 0,
    };
    const mapObjects = ctx.getMapObjects();
    return {
      text: noticeLabel(notice),
      history: contents,
      answer,
      evidence,
      metrics: claimSupportMetrics(answer, { evidence, mapObjects }),
      authorityEvents,
    };
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
      fromCandidateId: from.candidateId,
      fromLabel: from.label,
      toLat: to.lat,
      toLng: to.lng,
      toCandidateId: to.candidateId,
      toLabel: to.label,
      via: mapPins.slice(1, -1),
    };
    const authorization = authorizeToolCall(authorityState(), "plan_shadowed_route", args, [
      "application_state",
    ]);
    audit(authorization.event);
    if (!authorization.execution) return;
    onToolEvent?.({ name: "plan_shadowed_route", args });
    try {
      const raw = await executeTool("plan_shadowed_route", args, ctx, authorization.execution);
      const result = observe("plan_shadowed_route", args, raw);
      terminalRouteResult =
        asRouteTerminalResult(result.payload) ?? malformedRouteTerminalResult(result.payload);
      routedThisTurn =
        terminalRouteResult.status === "completed" || terminalRouteResult.status === "partial";
    } catch (error) {
      observe("plan_shadowed_route", args, {
        error: error instanceof Error ? error.message : "Tool failed.",
      });
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
      "research",
    );

    const candidate = res.candidates?.[0]?.content;
    if (!candidate) {
      const blocked = res.promptFeedback?.blockReason;
      if (blocked) return finalizeNotice("blocked", blocked);
      break; // nothing came back — fall through to the write phase
    }
    // Provider output is never allowed to self-assert a trusted source label.
    const taggedCandidate: LlmContent = {
      role: candidate.role,
      parts: candidate.parts.map((part) => ({
        ...part,
        provenance: { category: "model_generated", bounded: true },
      })),
    };

    const calls = taggedCandidate.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      // Done researching.
      await plotFallbackPoints();
      await routeFallback();
      if (terminalRouteResult && terminalRouteResult.status !== "completed") {
        return finalizeNotice("route_terminal", routeTerminalText(terminalRouteResult));
      }
      // Same config for both roles → research model's answer IS the answer, and
      // returning it saves a full-context write call (TPD savings). So does a
      // turn that called no tool at all — a refusal, or a question back to the
      // user: there is nothing gathered for the write call to ground, and
      // rewriting it turned "which area?" into generic advice in the live eval.
      if (!separateWrite || step === 0) {
        contents.push(taggedCandidate);
        const text = extractText(taggedCandidate) || "(no reply)";
        await reconcilePins(text);
        if (step === 0 && evidence.length === 0)
          return finalizeNotice(ctxSnapshot.locationKnown === false ? "clarification" : "refusal");
        return finalize(text, parseModelAnswer(text));
      }
      // Roles differ → discard this draft; the response model writes below.
      break;
    }

    // Persist the tool-call turn, execute the calls, feed results back.
    contents.push(taggedCandidate);
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
            p.label
              ? p
              : { ...p, label: pointCandidates.find((c) => c.label && samePlace(c, p))?.label },
          );
        args = { ...args, points };
      }
      args = attachExactCandidateIds(fc.name, args);
      const authorization = authorizeToolCall(
        authorityState(),
        fc.name,
        args,
        sourceCategoriesForCall(fc.name, args),
      );
      audit(authorization.event);
      // A shadow check without a time reads the set time, so that is part of its key.
      const key = `${fc.name}${JSON.stringify(args)}${fc.name === "check_shadow" ? ctx.dateRef.current.getTime() : ""}`;
      // An unanchored search reads the moving map, so it is only a repeat within the turn.
      const cacheable =
        CACHEABLE.has(fc.name) &&
        !(fc.name === "search_places" && args.lat == null && args.near == null);
      let envelope: ToolResultEnvelope | undefined;
      let result: Record<string, unknown>;
      const earlier = authorization.allowed ? turnResults.get(key) : undefined;
      if (!authorization.allowed) {
        result = { error: "Tool call rejected by application authority policy." };
      } else if (earlier) {
        envelope = earlier;
        result = { ...modelResult(envelope, true), note: REPEAT_NOTE };
      } else if (fc.name === "search_places" && searchClosed()) {
        result = { results: [], note: SEARCH_CAP_NOTE };
      } else if (cacheable && cache.has(key)) {
        envelope = cache.get(key)!;
        result = modelResult(envelope!, true);
        if (fc.name === "search_places") searches++;
      } else {
        if (fc.name === "search_places") searches++;
        onToolEvent?.({ name: fc.name, args });
        try {
          result = await executeTool(fc.name, args, ctx, authorization.execution);
        } catch (err) {
          result = { error: toolErrorText(err instanceof Error ? err.message : "Tool failed.") };
        }
        envelope = observe(fc.name as AgentToolName, args, result);
        // The transcript consumes the canonical bounded envelope, never the
        // raw executor object (including on future provider integrations).
        result = envelope.payload;
        // An empty search depends on the query wording and the map viewport, so
        // it is never reused across turns — a miss now must not veto a retry
        // later. (The per-turn dedupe above still answers an identical repeat.)
        const emptySearchResult =
          fc.name === "search_places" &&
          Array.isArray(result.results) &&
          result.results.length === 0;
        if (!result.error && cacheable && !emptySearchResult) cache.set(key, envelope);
      }
      if (envelope && !result.error) turnResults.set(key, envelope);
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
        routedThisTurn =
          terminalRouteResult.status === "completed" || terminalRouteResult.status === "partial";
      }
      collectPointCandidates(fc.name, args, result, pointCandidates, envelope?.resultId);
      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: envelope
            ? {
                ...result,
                _receipt: {
                  resultId: envelope.resultId,
                  producedAt: envelope.producedAt,
                  reused: earlier != null || (cacheable && cache.get(key) === envelope),
                },
                _provenance: {
                  category: envelope.provenance.category,
                  fields: envelope.fieldProvenance,
                  authority: "none",
                  dataOnly: true,
                },
              }
            : result,
        },
        provenance: {
          category: envelope?.provenance?.category ?? "tool_provider_error",
          bounded: true,
        },
      });
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
    return finalizeNotice("route_terminal", routeTerminalText(terminalRouteResult));
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
    "response",
  );

  const finalCandidate = finalRes.candidates?.[0]?.content;
  if (!finalCandidate) {
    const blocked = finalRes.promptFeedback?.blockReason;
    return blocked ? finalizeNotice("blocked", blocked) : finalizeNotice("unverified");
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
  contents.push({
    role: "model",
    parts: [{ text, provenance: { category: "model_generated", bounded: true } }],
  });
  await reconcilePins(text);
  return finalize(text, parseModelAnswer(text));
}

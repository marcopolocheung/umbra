/**
 * C10 transcript provenance and tool-authority boundary.
 *
 * This is intentionally a small, application-owned policy module.  It does
 * not try to detect hostile wording: a source category, a bounded value and a
 * deterministic capability check decide whether a value may affect state.
 */
import { parseTime } from "../../hooks/useShadowTime";

export const MAX_TRANSCRIPT_TEXT = 2_000;
export const MAX_PROVIDER_TEXT = 160;
export const MAX_TOOL_ERROR_TEXT = 240;

export type FieldSourceCategory =
  | "current_user_intent"
  | "application_state"
  | "model_generated"
  | "provider_controlled"
  | "prior_assistant_content"
  | "prior_user_content"
  | "image_ocr_content"
  | "image_exif_content"
  | "tool_provider_error";

export interface ProvenanceSchemaEntry {
  category: FieldSourceCategory;
  trusted: boolean;
  mayGrantToolAuthority: boolean;
  description: string;
}

/** Machine-readable policy; docs describe it, code consumes its categories. */
export const TRANSCRIPT_PROVENANCE_SCHEMA: readonly ProvenanceSchemaEntry[] = [
  {
    category: "current_user_intent",
    trusted: true,
    mayGrantToolAuthority: true,
    description: "Raw current-turn user request only.",
  },
  {
    category: "application_state",
    trusted: true,
    mayGrantToolAuthority: false,
    description: "Application-owned state and identities; validation is still required.",
  },
  {
    category: "model_generated",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Model proposals, including function arguments.",
  },
  {
    category: "provider_controlled",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Place/provider strings and values, retained as data.",
  },
  {
    category: "prior_assistant_content",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Earlier assistant output.",
  },
  {
    category: "prior_user_content",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Earlier user text; it is not current-turn authority.",
  },
  {
    category: "image_ocr_content",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Future OCR fixture content.",
  },
  {
    category: "image_exif_content",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Future EXIF fixture content.",
  },
  {
    category: "tool_provider_error",
    trusted: false,
    mayGrantToolAuthority: false,
    description: "Provider or tool error text.",
  },
] as const;

export interface ContentProvenance {
  category: FieldSourceCategory;
  bounded: true;
}

export type FieldProvenance = Record<string, ContentProvenance>;

export function boundedText(value: unknown, maximum = MAX_TRANSCRIPT_TEXT): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function printable(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

export function providerText(value: unknown): string {
  return printable(boundedText(value, MAX_PROVIDER_TEXT)).trim();
}

export function toolErrorText(value: unknown): string {
  return printable(boundedText(value, MAX_TOOL_ERROR_TEXT)).trim();
}

function categoryForProviderField(key: string): FieldSourceCategory {
  const normalized = key.toLowerCase();
  if (normalized.includes("ocr")) return "image_ocr_content";
  if (normalized.includes("exif")) return "image_exif_content";
  return "provider_controlled";
}

/**
 * Bounds provider-shaped payloads before they can join a model transcript,
 * cache, replay record, or receipt. It is shape-preserving data sanitation,
 * not a phrase blacklist: every string remains data regardless of wording.
 */
export function boundUntrustedPayload(
  value: unknown,
  category: FieldSourceCategory = "provider_controlled",
  fieldProvenance: FieldProvenance = {},
  path = "payload",
): { value: unknown; fieldProvenance: FieldProvenance } {
  if (typeof value === "string") {
    fieldProvenance[path] = { category, bounded: true };
    return { value: providerText(value), fieldProvenance };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map(
        (item, index) =>
          boundUntrustedPayload(item, category, fieldProvenance, `${path}[${index}]`).value,
      ),
      fieldProvenance,
    };
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const fieldCategory = categoryForProviderField(key);
      // OCR/EXIF are future provider payload types. A tool-error envelope is
      // one untrusted source regardless of arbitrary key names in its payload.
      const nextCategory =
        category === "provider_controlled" && fieldCategory !== "provider_controlled"
          ? fieldCategory
          : category;
      output[key] = boundUntrustedPayload(
        item,
        nextCategory,
        fieldProvenance,
        `${path}.${key}`,
      ).value;
    }
    return { value: output, fieldProvenance };
  }
  return { value, fieldProvenance };
}

export function isContentProvenance(value: unknown): value is ContentProvenance {
  return (
    !!value &&
    typeof value === "object" &&
    TRANSCRIPT_PROVENANCE_SCHEMA.some(
      (entry) => entry.category === (value as ContentProvenance).category,
    ) &&
    (value as ContentProvenance).bounded === true
  );
}

export type AuthorityDecision = "accepted" | "rejected";
export type AuthorityReasonCode =
  | "read_only_tool"
  | "current_user_intent_validated"
  | "unknown_tool"
  | "missing_current_user_intent"
  | "sensitive_argument_not_application_candidate"
  | "invalid_numeric_or_geographic_bounds"
  | "invalid_time_bounds"
  | "time_not_requested_by_current_user"
  | "missing_or_malformed_provenance"
  | "untrusted_argument_provenance"
  | "route_terminal_contract_invalid";

export interface AuthorityAuditEvent {
  tool: string;
  fieldSourceCategories: FieldSourceCategory[];
  decision: AuthorityDecision;
  reasonCode: AuthorityReasonCode;
}

export interface CandidateIdentity {
  id: string;
  lat: number;
  lng: number;
}

export interface AuthorityState {
  currentUserText: string;
  candidates: CandidateIdentity[];
}

export interface ToolAuthorization {
  event: AuthorityAuditEvent;
  /** Read calls receive this only after the same deterministic policy check. */
  allowed: boolean;
  /** Opaque runtime capability; only a successful local decision receives one. */
  execution?: object;
}

interface ExecutionCapability {
  tool: string;
  canonicalArgs: string;
  used: boolean;
}
const executionCapabilities = new WeakMap<object, ExecutionCapability>();
const MUTATION_TOOLS = new Set(["locate_user", "set_time", "plot_points", "plan_shadowed_route"]);
const KNOWN_TOOLS = new Set([
  "locate_user",
  "geocode_place",
  "search_places",
  "check_shadow",
  "set_time",
  "plot_points",
  "plan_shadowed_route",
]);

function geo(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    Math.abs(lng) <= 180
  );
}

function isNegatedAt(text: string, index: number): boolean {
  // Parse the local clause rather than scanning arbitrary nearby keywords.
  // A contrast marker starts a new instruction within the same sentence.
  const clauseStart = Math.max(
    text.lastIndexOf(".", index),
    text.lastIndexOf("!", index),
    text.lastIndexOf("?", index),
    text.lastIndexOf(";", index),
    text.lastIndexOf("\n", index),
  );
  let prefix = text.slice(clauseStart + 1, index);
  const contrast = /\b(?:but|however|instead|rather)\b/gi;
  let afterContrast = -1;
  while (true) {
    const match = contrast.exec(prefix);
    if (!match) break;
    afterContrast = match.index + match[0].length;
  }
  if (afterContrast >= 0) prefix = prefix.slice(afterContrast);
  return /\b(?:no|not|never|without|don't|do not|dont)\b/i.test(prefix);
}

function positiveMatches(text: string, expression: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(expression.source, `${expression.flags}g`))].filter(
    (match) => !isNegatedAt(text, match.index ?? 0),
  );
}

function hasPositivePhrase(text: string, expression: RegExp): boolean {
  return positiveMatches(text, expression).length > 0;
}

function requested(state: AuthorityState, tool: string): boolean {
  const text = state.currentUserText.toLowerCase();
  if (!text) return false;
  if (tool === "locate_user")
    return hasPositivePhrase(text, /\b(near me|here|my location|locate me)\b/i);
  if (tool === "set_time")
    return hasPositivePhrase(
      text,
      /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(morning|afternoon|evening|tonight|noon)\b/i,
    );
  if (tool === "plan_shadowed_route")
    return hasPositivePhrase(text, /\b(route|walk|walking|directions)\b/i);
  // Plotting is presentation for a current, in-domain place/outing request,
  // never a generic side effect of an arbitrary chat message.
  return hasPositivePhrase(
    text,
    /\b(shadow\w*|sun\w*|shade\w*|park|cafe|coffee|sit|eat|place|stop|route|walk|directions|show|plan|where)\b/i,
  );
}

function requestedTimeMinutes(text: string): number | null {
  const explicit = positiveMatches(text, /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i)[0]?.[0];
  if (explicit) return parseTime(explicit);
  if (hasPositivePhrase(text, /\bnoon\b/i)) return 12 * 60;
  if (hasPositivePhrase(text, /\bmorning\b/i)) return 9 * 60;
  if (hasPositivePhrase(text, /\bafternoon\b/i)) return 15 * 60;
  if (hasPositivePhrase(text, /\bevening\b/i)) return 18 * 60;
  if (hasPositivePhrase(text, /\btonight\b/i)) return 20 * 60;
  return null;
}

export function currentTurnTerms(text: string): {
  positive: Set<string>;
  negative: Set<string>;
} {
  const positive = new Set<string>();
  const negative = new Set<string>();
  for (const match of text.matchAll(/\b[a-z0-9]{3,}\b/gi)) {
    const term = match[0].toLowerCase();
    (isNegatedAt(text, match.index ?? 0) ? negative : positive).add(term);
  }
  return { positive, negative };
}

function termMatches(term: string, values: Set<string>): boolean {
  return (
    values.has(term) ||
    [...values].some(
      (value) => value.startsWith(term.slice(0, 4)) || term.startsWith(value.slice(0, 4)),
    )
  );
}

function currentUserSuppliedPhrase(text: string, value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalize = (input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const requested = normalize(value);
  const terms = requested.match(/[a-z0-9]{3,}/g) ?? [];
  const current = currentTurnTerms(text);
  return (
    requested.length > 0 &&
    normalize(text).includes(requested) &&
    terms.length > 0 &&
    terms.every(
      (term) => termMatches(term, current.positive) && !termMatches(term, current.negative),
    )
  );
}

function candidateFor(
  state: AuthorityState,
  candidateId: unknown,
  lat: unknown,
  lng: unknown,
): boolean {
  return (
    geo(lat, lng) &&
    state.candidates.some(
      (candidate) => candidate.id === candidateId && candidate.lat === lat && candidate.lng === lng,
    )
  );
}

function coordinatesAreCandidates(
  state: AuthorityState,
  args: Record<string, unknown>,
  tool: string,
): boolean {
  // Coordinate mutations always need an exact app-owned candidate identity.
  if (tool === "plot_points") {
    const points = args.points;
    if (
      !Array.isArray(points) ||
      points.length === 0 ||
      !points.every((point) => {
        const item = point && typeof point === "object" ? (point as Record<string, unknown>) : {};
        return geo(item.lat, item.lng);
      })
    )
      return false;
    return points.every((point) => {
      const item = point && typeof point === "object" ? (point as Record<string, unknown>) : {};
      return candidateFor(state, item.candidateId, item.lat, item.lng);
    });
  }
  if (tool === "plan_shadowed_route") {
    if (
      !candidateFor(state, args.fromCandidateId, args.fromLat, args.fromLng) ||
      !candidateFor(state, args.toCandidateId, args.toLat, args.toLng)
    )
      return false;
    return (
      !Array.isArray(args.via) ||
      args.via.every((point) => {
        const item = point && typeof point === "object" ? (point as Record<string, unknown>) : {};
        return candidateFor(state, item.candidateId, item.lat, item.lng);
      })
    );
  }
  return true;
}

/** Deterministically creates application-owned identities after validating provider candidates. */
export function candidateIdentities(
  resultId: string,
  payload: Record<string, unknown>,
): CandidateIdentity[] {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.flatMap((raw, index) => {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return geo(item.lat, item.lng)
      ? [{ id: `candidate:${resultId}:${index}`, lat: item.lat as number, lng: item.lng as number }]
      : [];
  });
}

export function authorizeToolCall(
  state: AuthorityState,
  tool: string,
  args: Record<string, unknown>,
  sourceCategories: FieldSourceCategory[] = ["model_generated"],
): ToolAuthorization {
  const reject = (reasonCode: AuthorityReasonCode): ToolAuthorization => ({
    event: {
      tool,
      fieldSourceCategories: [...new Set(sourceCategories)].sort(),
      decision: "rejected",
      reasonCode,
    },
    allowed: false,
  });
  if (
    sourceCategories.some((category) =>
      [
        "provider_controlled",
        "prior_assistant_content",
        "prior_user_content",
        "image_ocr_content",
        "image_exif_content",
        "tool_provider_error",
      ].includes(category),
    )
  )
    return reject("untrusted_argument_provenance");
  if (!KNOWN_TOOLS.has(tool)) return reject("unknown_tool");
  if (!MUTATION_TOOLS.has(tool)) {
    // Reads can expose provider data or spend a constrained provider budget.
    // They still require a positive, current-turn request; a model proposal
    // (including one influenced by transcript data) cannot initiate one alone.
    if (!sourceCategories.includes("current_user_intent"))
      return reject("missing_current_user_intent");
    if (!requested(state, "plot_points")) return reject("missing_current_user_intent");
    if (tool === "check_shadow") {
      const points = Array.isArray(args.points)
        ? args.points
        : [{ lat: args.lat, lng: args.lng, candidateId: args.candidateId }];
      if (
        !points.length ||
        !points.every((raw) => {
          const point = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          return candidateFor(state, point.candidateId, point.lat, point.lng);
        })
      )
        return reject("sensitive_argument_not_application_candidate");
      if (args.time != null) {
        if (typeof args.time !== "string" || parseTime(args.time) == null)
          return reject("invalid_time_bounds");
        if (parseTime(args.time) !== requestedTimeMinutes(state.currentUserText))
          return reject("time_not_requested_by_current_user");
      }
    }
    if (tool === "search_places") {
      const hasCoordinateAnchor = args.lat != null || args.lng != null;
      if (hasCoordinateAnchor && !candidateFor(state, args.nearCandidateId, args.lat, args.lng))
        return reject("sensitive_argument_not_application_candidate");
      if (args.near != null && !currentUserSuppliedPhrase(state.currentUserText, args.near))
        return reject("missing_current_user_intent");
    }
    return {
      event: {
        tool,
        fieldSourceCategories: [...new Set(sourceCategories)].sort(),
        decision: "accepted",
        reasonCode: "read_only_tool",
      },
      allowed: true,
    };
  }
  if (!requested(state, tool)) return reject("missing_current_user_intent");
  if (tool === "set_time") {
    if (typeof args.time !== "string" || parseTime(args.time) == null)
      return reject("invalid_time_bounds");
    if (parseTime(args.time) !== requestedTimeMinutes(state.currentUserText))
      return reject("time_not_requested_by_current_user");
  }
  if (
    (tool === "plot_points" || tool === "plan_shadowed_route") &&
    !coordinatesAreCandidates(state, args, tool)
  ) {
    return reject("sensitive_argument_not_application_candidate");
  }
  if (
    tool === "plan_shadowed_route" &&
    (!geo(args.fromLat, args.fromLng) || !geo(args.toLat, args.toLng))
  ) {
    return reject("invalid_numeric_or_geographic_bounds");
  }
  const execution = {};
  executionCapabilities.set(execution, { tool, canonicalArgs: JSON.stringify(args), used: false });
  return {
    event: {
      tool,
      fieldSourceCategories: [...new Set(sourceCategories)].sort(),
      decision: "accepted",
      reasonCode: "current_user_intent_validated",
    },
    allowed: true,
    execution,
  };
}

export function hasExecutionAuthority(
  tool: string,
  args: Record<string, unknown>,
  capability: unknown,
): boolean {
  if (!MUTATION_TOOLS.has(tool) || typeof capability !== "object" || capability === null)
    return false;
  const record = executionCapabilities.get(capability);
  if (
    !record ||
    record.used ||
    record.tool !== tool ||
    record.canonicalArgs !== JSON.stringify(args)
  )
    return false;
  record.used = true;
  return true;
}

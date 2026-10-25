import {
  isShadeWindowPayload,
  matchesShadeFraction,
  shadeWindowObjectId,
  shadeClockLabel,
  SHADE_UNAVAILABLE_LABELS,
} from "./shadeWindows";
import type {
  ShadeWindowPayload,
  ShadeUnavailableReason,
} from "../navigationData/shadeSpotsSource";
import type { ShadeSpotSample, ShadeSpotWindow } from "../navigationData/shadeSpots";
import { validateRoutePlanTerminalResult, type RoutePlanTerminalResult } from "../routePlanJob";
import type { FeasibilityCertificate, FeasibilityStatus } from "../reach/feasibility";
import {
  isContentProvenance,
  providerText,
  toolErrorText,
  type FieldProvenance,
  type FieldSourceCategory,
} from "./authority";

/** The public tools which can produce evidence. `get_current_context` is ambient state, not evidence. */
export type AgentToolName =
  | "locate_user"
  | "geocode_place"
  | "search_places"
  | "check_shadow"
  | "find_shade_spots"
  | "set_time"
  | "plot_points"
  | "plan_shadowed_route"
  | "check_sun_budget";

export interface ToolResultEnvelope<TPayload = Record<string, unknown>> {
  resultId: string;
  toolName: AgentToolName;
  /** ISO instant supplied by the loop clock; tests inject it. */
  producedAt: string;
  sourceVersion?: string;
  requestId?: string;
  actionId?: string;
  planRevision?: number;
  /** C10 provenance survives cache/replay/receipt storage. */
  provenance: { category: FieldSourceCategory; bounded: true };
  /** Per-field source category, especially for future OCR and EXIF data. */
  fieldProvenance: FieldProvenance;
  payload: TPayload;
}

export interface PlaceToolPayload {
  results: Array<{ name: string; lat: number; lng: number; distanceM?: number }>;
  note?: string;
}
export interface ShadowToolPayload {
  shadowFraction?: number;
  atLocalTime?: string;
  source?: string;
  lat?: number;
  lng?: number;
  results?: Array<{
    label?: string;
    lat: number;
    lng: number;
    shadowFraction?: number;
    atLocalTime?: string;
    source?: string;
  }>;
}
export interface TimeToolPayload {
  ok: boolean;
  newLocalTime: string;
}
export interface PlotToolPayload {
  ok: boolean;
  plotted: number;
  note?: string;
}
export type ToolPayloadByName = {
  locate_user: { lat: number; lng: number; note?: string };
  geocode_place: PlaceToolPayload;
  search_places: PlaceToolPayload;
  check_shadow: ShadowToolPayload;
  find_shade_spots: ShadeWindowPayload;
  set_time: TimeToolPayload;
  plot_points: PlotToolPayload;
  plan_shadowed_route: RoutePlanTerminalResult;
  check_sun_budget: FeasibilityCertificate;
};
export type TypedToolResultEnvelope<N extends AgentToolName> = ToolResultEnvelope<
  ToolPayloadByName[N]
> & { toolName: N };

/** Runtime boundary for stored/reused evidence; provider-shaped data is never trusted by its TS type alone. */
export function validateToolResultEnvelope(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !asString(value.resultId) ||
    !asString(value.toolName) ||
    !asString(value.producedAt) ||
    !isContentProvenance(value.provenance) ||
    !isFieldProvenance(value.fieldProvenance) ||
    !isRecord(value.payload)
  )
    return false;
  if (!isAgentToolName(value.toolName)) return false;
  if (
    !hasBoundedUntrustedPayload(
      value as {
        provenance: { category: FieldSourceCategory };
        fieldProvenance: FieldProvenance;
        payload: Record<string, unknown>;
      },
    )
  )
    return false;
  if (typeof value.payload.error === "string") return true;
  switch (value.toolName) {
    case "geocode_place":
    case "search_places":
      return Array.isArray(value.payload.results);
    case "find_shade_spots":
      return (
        value.provenance.category === "application_state" &&
        isShadeWindowPayload(value.payload) &&
        (value.payload.status !== "ok" || value.sourceVersion === value.payload.sourceVersion)
      );
    case "check_shadow":
      return (
        Array.isArray(value.payload.results) ||
        (asNumber(value.payload.lat) != null &&
          asNumber(value.payload.lng) != null &&
          asNumber(value.payload.shadowFraction) != null)
      );
    case "set_time":
      return value.payload.ok === true && !!asString(value.payload.newLocalTime);
    case "plot_points":
      return value.payload.ok === true;
    case "plan_shadowed_route": {
      const terminal = validateRoutePlanTerminalResult(value.payload);
      return (
        terminal !== null &&
        (value.requestId == null || value.requestId === terminal.requestId) &&
        (value.actionId == null || value.actionId === terminal.actionId) &&
        (value.planRevision == null || value.planRevision === terminal.planRevision)
      );
    }
    case "locate_user":
      return asNumber(value.payload.lat) != null && asNumber(value.payload.lng) != null;
    case "check_sun_budget":
      return (
        value.provenance.category === "application_state" &&
        FEASIBILITY_STATUSES.includes(value.payload.status as FeasibilityStatus) &&
        isRecord(value.payload.question) &&
        asNumber(value.payload.inputVersion) != null
      );
    default:
      return false;
  }
}

function isFieldProvenance(value: unknown): value is FieldProvenance {
  return isRecord(value) && Object.values(value).every((entry) => isContentProvenance(entry));
}

function payloadStrings(value: unknown, path = "payload"): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value))
    return value.flatMap((item, index) => payloadStrings(item, `${path}[${index}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => payloadStrings(item, `${path}.${key}`));
}

function hasBoundedUntrustedPayload(value: {
  provenance: { category: FieldSourceCategory };
  fieldProvenance: FieldProvenance;
  payload: Record<string, unknown>;
}): boolean {
  if (
    value.provenance.category !== "provider_controlled" &&
    value.provenance.category !== "tool_provider_error"
  )
    return true;
  const expectedText =
    value.provenance.category === "tool_provider_error" ? toolErrorText : providerText;
  const allowedCategories =
    value.provenance.category === "tool_provider_error"
      ? new Set<FieldSourceCategory>(["tool_provider_error"])
      : new Set<FieldSourceCategory>([
          "provider_controlled",
          "image_ocr_content",
          "image_exif_content",
        ]);
  return payloadStrings(value.payload).every(([path, text]) => {
    const field = value.fieldProvenance[path];
    return (
      field != null &&
      field.bounded === true &&
      allowedCategories.has(field.category) &&
      text === expectedText(text)
    );
  });
}

function isAgentToolName(value: unknown): value is AgentToolName {
  return [
    "locate_user",
    "geocode_place",
    "search_places",
    "check_shadow",
    "find_shade_spots",
    "set_time",
    "plot_points",
    "plan_shadowed_route",
    "check_sun_budget",
  ].includes(value as AgentToolName);
}

const FEASIBILITY_STATUSES: FeasibilityStatus[] = ["feasible", "infeasible", "unknown", "cancelled", "superseded", "uncovered"];

export type ClaimKind = "place" | "shadow" | "shade_window" | "time" | "route" | "accessibility" | "feasibility";
export type ClaimVerificationStatus = "verified" | "unknown" | "rejected";
export type ClaimRejectionReason =
  | "missing_result"
  | "wrong_tool_kind"
  | "missing_map_object"
  | "subject_mismatch"
  | "time_mismatch"
  | "stale_evidence"
  | "contradictory_route_status"
  | "stale_plan_revision"
  | "unsupported_accessibility_evidence"
  | "contradictory_feasibility"
  | "malformed_claim";

export interface EvidenceDetails {
  source?: string;
  sourceVersion?: string;
  observedAt: string;
  confidence: number | "unknown";
  evidenceAgeMs?: number;
}

interface ClaimBase<K extends ClaimKind, V> extends EvidenceDetails {
  claimId: string;
  kind: K;
  subject: string;
  value: V;
  supportingResultIds: string[];
  verification: ClaimVerificationStatus;
  rejectionReason?: ClaimRejectionReason;
}

export interface PlaceClaimReceipt extends ClaimBase<"place", { lat: number; lng: number }> {
  mapObjectId: string;
}

export interface ShadowClaimReceipt
  extends ClaimBase<"shadow", { fraction: number; unit: "fraction" }> {
  coordinates: { lat: number; lng: number };
  atLocalTime: string;
  mapObjectId?: string;
}

export interface TimeClaimReceipt
  extends ClaimBase<"time", { localTime: string; unit: "local-time" }> {}

export interface RouteClaimReceipt
  extends ClaimBase<
    "route",
    {
      status: "completed" | "partial";
      /** Objective used by the application-owned route calculation. */
      objective?: "sun" | "rain";
    }
  > {
  requestId: string;
  actionId: string;
  planRevision: number;
  mapObjectId: string;
  /** Present only for a partial result and points at the C4 terminal detail. */
  unroutableLeg?: { failedLeg: number; totalLegs: number };
}

export interface AccessibilityClaimReceipt extends ClaimBase<"accessibility", "unknown"> {}

/** H6: the answer to "is this outing possible?", worded from the certificate alone. */
export interface FeasibilityClaimReceipt extends ClaimBase<"feasibility", { status: FeasibilityStatus }> {
  certificate: FeasibilityCertificate;
}

export interface ShadeWindowClaimReceipt
  extends ClaimBase<"shade_window", { meanShade: number; hours: ShadeSpotSample[] }> {
  similarity?: {
    reference: import("../navigationData/shadeSpots").ShadeSpot;
    annualSquaredDistance: number;
    sampleCount: number;
    model: string;
    approximate: true;
  };
  candidateId: string;
  requestedDate: string;
  requestedWindow: ShadeSpotWindow;
  effectiveWindow: ShadeSpotWindow;
  mode: "shade" | "sun";
  basis?: { representativeDate: string; zone: string; slotMinutes: number };
  coordinates: { lat: number; lng: number };
  mapObjectId?: string;
  reasons?: string[];
}

export type ClaimReceipt =
  | PlaceClaimReceipt
  | ShadowClaimReceipt
  | ShadeWindowClaimReceipt
  | TimeClaimReceipt
  | RouteClaimReceipt
  | AccessibilityClaimReceipt
  | FeasibilityClaimReceipt;

export type VerifiedAnswerBlock =
  | { kind: "claim"; claimId: string }
  | { kind: "unknown"; claimKind: ClaimKind; reason?: ShadeUnavailableReason }
  | {
      kind: "notice";
      code:
        | "refusal"
        | "clarification"
        | "blocked"
        | "unverified"
        | "route_terminal"
        | "shade_route_time"
        | "shade_partial"
        | "shade_alternatives";
      detail?: string;
    };

export interface VerifiedAnswer {
  blocks: VerifiedAnswerBlock[];
  receipts: ClaimReceipt[];
  /** Count of model-supplied free-text blocks discarded before presentation. */
  rejectedProseCount: number;
  danglingClaimBlocks: number;
  duplicateClaimProposals: number;
}

/** Separate measures: place-to-pin agreement is not a proxy for complete grounding. */
export interface ClaimKindSupportMetrics {
  proposed: number;
  supported: number;
  rejected: number;
  unknown: number;
  supportRate: number;
}
export interface ClaimSupportMetrics {
  place: ClaimKindSupportMetrics;
  shadow: ClaimKindSupportMetrics;
  shade_window: ClaimKindSupportMetrics;
  time: ClaimKindSupportMetrics;
  route: ClaimKindSupportMetrics;
  accessibility: ClaimKindSupportMetrics;
  feasibility: ClaimKindSupportMetrics;
  unsupportedClaimEscapes: number;
  rejectedUnsupportedProse: number;
  danglingClaimProposals: number;
  duplicateClaimProposals: number;
}

export function claimSupportMetrics(
  answer: VerifiedAnswer,
  _options: Pick<VerifyAnswerOptions, "evidence" | "mapObjects">,
): ClaimSupportMetrics {
  const measure = (kind: ClaimKind): ClaimKindSupportMetrics => {
    const receipts = answer.receipts.filter((receipt) => receipt.kind === kind);
    const supported = receipts.filter((receipt) => receipt.verification === "verified").length;
    const rejected = receipts.filter((receipt) => receipt.verification === "rejected").length;
    const unknown = receipts.filter((receipt) => receipt.verification === "unknown").length;
    return {
      proposed: receipts.length,
      supported,
      rejected,
      unknown,
      supportRate: receipts.length ? supported / receipts.length : 0,
    };
  };
  return {
    place: measure("place"),
    shadow: measure("shadow"),
    shade_window: measure("shade_window"),
    time: measure("time"),
    route: measure("route"),
    accessibility: measure("accessibility"),
    feasibility: measure("feasibility"),
    // All model text blocks are discarded before rendering, so an escape is impossible by construction.
    unsupportedClaimEscapes: 0,
    rejectedUnsupportedProse: answer.rejectedProseCount,
    danglingClaimProposals: answer.danglingClaimBlocks,
    duplicateClaimProposals: answer.duplicateClaimProposals,
  };
}

export interface MapObject {
  id: string;
  kind: "pin" | "route" | "shadow" | "shade_window";
  lat?: number;
  lng?: number;
  label?: string;
}

interface LooseReceipt {
  claimId?: unknown;
  kind?: unknown;
  subject?: unknown;
  value?: unknown;
  supportingResultIds?: unknown;
  mapObjectId?: unknown;
  atLocalTime?: unknown;
  requestId?: unknown;
  actionId?: unknown;
  planRevision?: unknown;
  objective?: unknown;
  candidateId?: unknown;
  requestedDate?: unknown;
  requestedWindow?: unknown;
  likeCandidateId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const coordsMatch = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.abs(a.lat - b.lat) < 0.0003 && Math.abs(a.lng - b.lng) < 0.0003;
const normal = (text: string) => text.trim().toLocaleLowerCase();

function resultCoords(payload: Record<string, unknown>): { lat: number; lng: number }[] {
  const values = Array.isArray(payload.results) ? payload.results : [payload];
  return values.flatMap((value) => {
    const item = isRecord(value) ? value : {};
    const lat = asNumber(item.lat);
    const lng = asNumber(item.lng);
    return lat == null || lng == null ? [] : [{ lat, lng }];
  });
}

function matchingPlace(
  payload: Record<string, unknown>,
  coordinate: { lat: number; lng: number },
): { name: string; lat: number; lng: number } | null {
  const values = Array.isArray(payload.results) ? payload.results : [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const name = asString(value.name);
    const lat = asNumber(value.lat);
    const lng = asNumber(value.lng);
    if (name && lat != null && lng != null && coordsMatch({ lat, lng }, coordinate))
      return { name, lat, lng };
  }
  return null;
}

function findShadow(
  envelope: ToolResultEnvelope,
  coordinates: { lat: number; lng: number },
): Record<string, unknown> | null {
  if (envelope.toolName !== "check_shadow" || !isRecord(envelope.payload)) return null;
  const values = Array.isArray(envelope.payload.results)
    ? envelope.payload.results
    : [envelope.payload];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const lat = asNumber(value.lat);
    const lng = asNumber(value.lng);
    // Single-point results deliberately inherit the tool-call coordinates only when
    // the envelope is constructed by the loop (which adds them to payload).
    if (lat != null && lng != null && coordsMatch({ lat, lng }, coordinates)) return value;
  }
  return null;
}

function routeMapObjectId(result: RoutePlanTerminalResult): string {
  return `route:${result.requestId}:${result.actionId}:${result.planRevision}`;
}

function receiptId(
  kind: ClaimKind,
  subject: string,
  envelope: ToolResultEnvelope | undefined,
  index: number,
): string {
  const identity = `${kind}:${envelope?.resultId ?? "missing"}:${normal(subject) || index}`;
  return `claim-${identity.replace(/[^a-z0-9:_-]/gi, "-")}`;
}

function resultIds(value: LooseReceipt): string[] {
  return Array.isArray(value.supportingResultIds)
    ? value.supportingResultIds.flatMap((id) => (asString(id) ? [asString(id)!] : []))
    : [];
}

function base(
  value: LooseReceipt,
  index: number,
  kind: ClaimKind,
  envelope: ToolResultEnvelope | undefined,
  verification: ClaimVerificationStatus,
  reason?: ClaimRejectionReason,
) {
  return {
    claimId: receiptId(kind, asString(value.subject) ?? "unknown", envelope, index),
    kind,
    subject: asString(value.subject) ?? "unknown",
    supportingResultIds: resultIds(value),
    verification,
    rejectionReason: reason,
    observedAt: envelope?.producedAt ?? "unknown",
    source: isRecord(envelope?.payload) ? asString(envelope.payload.source) : undefined,
    sourceVersion: envelope?.sourceVersion,
    confidence: "unknown" as const,
  };
}

export interface VerifyAnswerOptions {
  evidence: ToolResultEnvelope[];
  mapObjects: MapObject[];
  currentPlanRevision: number;
  now: string;
  /** Tests use this seam to demonstrate that compatibility checks have teeth. */
  allowIncompatibleEvidence?: boolean;
  /** Only this turn can add new unavailable notices; re-verification preserves existing ones. */
  currentShadeResultIds?: string[];
}

/**
 * The model's JSON is a proposal, never authority. This converts it to canonical
 * receipts and strips any block that could make a factual claim outside a receipt.
 */
export function verifyAnswer(proposed: unknown, options: VerifyAnswerOptions): VerifiedAnswer {
  const parsed = isRecord(proposed) ? proposed : {};
  const proposedReceipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
  const evidence = new Map(options.evidence.map((result) => [result.resultId, result]));
  const receipts: ClaimReceipt[] = [];

  proposedReceipts.forEach((raw, index) => {
    const value: LooseReceipt = isRecord(raw) ? raw : {};
    const kind = asString(value.kind) as ClaimKind | undefined;
    const supporting = resultIds(value);
    const envelope = supporting.length === 1 ? evidence.get(supporting[0]) : undefined;
    const malformed = !kind || supporting.length !== 1 || !envelope;
    const reject = (claimKind: ClaimKind, reason: ClaimRejectionReason): ClaimReceipt => {
      const common = base(value, index, claimKind, envelope, "rejected", reason);
      if (claimKind === "accessibility")
        return { ...common, kind: "accessibility", value: "unknown" };
      if (claimKind === "place")
        return {
          ...common,
          kind: "place",
          value: { lat: 0, lng: 0 },
          mapObjectId: asString(value.mapObjectId) ?? "unknown",
        };
      if (claimKind === "shadow")
        return {
          ...common,
          kind: "shadow",
          value: { fraction: 0, unit: "fraction" },
          coordinates: { lat: 0, lng: 0 },
          atLocalTime: "unknown",
        };
      if (claimKind === "shade_window")
        return {
          ...common,
          kind: "shade_window",
          candidateId: asString(value.candidateId) ?? "unknown",
          requestedDate: "unknown",
          requestedWindow: { fromMinutes: 0, toMinutes: 0 },
          effectiveWindow: { fromMinutes: 0, toMinutes: 0 },
          mode: "shade",
          value: { meanShade: 0, hours: [] },
          coordinates: { lat: 0, lng: 0 },
        };
      if (claimKind === "time")
        return { ...common, kind: "time", value: { localTime: "unknown", unit: "local-time" } };
      if (claimKind === "feasibility")
        return {
          ...common,
          kind: "feasibility",
          value: { status: "unknown" },
          certificate: { status: "unknown", question: { start: [0, 0], target: [0, 0], sunMin: 0, timeMin: 0, stayMin: 0, departure: "" }, inputVersion: -1, modelVersion: "none" },
        };
      return {
        ...common,
        kind: "route",
        value: { status: "partial" },
        requestId: "unknown",
        actionId: "unknown",
        planRevision: -1,
        mapObjectId: "unknown",
      };
    };
    if (
      !kind ||
      !["place", "shadow", "shade_window", "time", "route", "accessibility", "feasibility"].includes(kind)
    ) {
      // An unknown kind supports nothing; it must not render as an accessibility claim.
      return;
    }
    if (kind === "accessibility") {
      // C5 has no accessibility observation tool. It can only make that absence legible.
      const common = base({ ...value, subject: "accessibility" }, index, kind, envelope, "unknown");
      receipts.push({ ...common, kind, value: "unknown", supportingResultIds: [] });
      return;
    }
    if (malformed) {
      receipts.push(reject(kind, "missing_result"));
      return;
    }
    if (kind === "feasibility") {
      if (envelope!.toolName !== "check_sun_budget") {
        receipts.push(reject(kind, "wrong_tool_kind"));
        return;
      }
      const certificate = envelope!.payload as unknown as FeasibilityCertificate;
      // Superseded: only the newest outing question may be answered.
      const newest = options.evidence
        .filter((e) => e.toolName === "check_sun_budget")
        .reduce((a, b) => ((asNumber(b.payload.inputVersion) ?? -1) > (asNumber(a.payload.inputVersion) ?? -1) ? b : a));
      if (newest.resultId !== envelope!.resultId) {
        receipts.push(reject(kind, "stale_evidence"));
        return;
      }
      const claimed = isRecord(value.value) ? asString(value.value.status) : undefined;
      if (claimed !== certificate.status) {
        receipts.push(reject(kind, "contradictory_feasibility"));
        return;
      }
      receipts.push({
        ...base({ ...value, subject: "outing" }, index, kind, envelope, "verified"),
        subject: "outing",
        kind,
        value: { status: certificate.status },
        certificate,
      });
      return;
    }
    if (kind === "place") {
      if (envelope!.toolName !== "geocode_place" && envelope!.toolName !== "search_places") {
        receipts.push(reject(kind, "wrong_tool_kind"));
        return;
      }
      const val = isRecord(value.value) ? value.value : {};
      const lat = asNumber(val.lat);
      const lng = asNumber(val.lng);
      const coordinate =
        lat != null && lng != null ? { lat, lng } : resultCoords(envelope!.payload)[0];
      const resultMatch = coordinate && matchingPlace(envelope!.payload, coordinate);
      const mapObject =
        coordinate &&
        options.mapObjects.find(
          (object) =>
            object.kind === "pin" &&
            object.lat != null &&
            object.lng != null &&
            coordsMatch({ lat: object.lat, lng: object.lng }, coordinate),
        );
      if (!coordinate || !resultMatch || !mapObject) {
        receipts.push(reject(kind, !mapObject ? "missing_map_object" : "subject_mismatch"));
        return;
      }
      // The provider result establishes identity; a pin's display label may never relabel it.
      const canonicalValue = { lat: resultMatch.lat, lng: resultMatch.lng };
      const common = base(
        { ...value, subject: resultMatch.name },
        index,
        kind,
        envelope,
        "verified",
      );
      receipts.push({
        ...common,
        kind,
        subject: resultMatch.name,
        value: canonicalValue,
        mapObjectId: mapObject.id,
      });
      return;
    }
    if (kind === "shadow") {
      if (envelope!.toolName !== "check_shadow" && !options.allowIncompatibleEvidence) {
        receipts.push(reject(kind, "wrong_tool_kind"));
        return;
      }
      const input = isRecord(value.value) ? value.value : {};
      const coords = isRecord(value.value) ? value.value : {};
      const lat = asNumber(coords.lat) ?? asNumber((value as Record<string, unknown>).lat);
      const lng = asNumber(coords.lng) ?? asNumber((value as Record<string, unknown>).lng);
      // Accept the explicit coordinates field preferred by the public receipt type.
      const possibleCoordinateField = (value as Record<string, unknown>).coordinates;
      const coordinateField = isRecord(possibleCoordinateField) ? possibleCoordinateField : {};
      const coordinateLat = asNumber(coordinateField.lat) ?? lat;
      const coordinateLng = asNumber(coordinateField.lng) ?? lng;
      if (coordinateLat == null || coordinateLng == null) {
        receipts.push(reject(kind, "subject_mismatch"));
        return;
      }
      const coordinate = { lat: coordinateLat, lng: coordinateLng };
      const observation = findShadow(envelope!, coordinate);
      const fraction = asNumber(input.fraction);
      const atLocalTime = asString(value.atLocalTime);
      const ageMs = Date.parse(options.now) - Date.parse(envelope!.producedAt);
      if (Number.isFinite(ageMs) && ageMs > 15 * 60 * 1000) {
        receipts.push(reject(kind, "stale_evidence"));
        return;
      }
      if (
        !observation ||
        fraction == null ||
        fraction < 0 ||
        fraction > 1 ||
        fraction !== asNumber(observation.shadowFraction) ||
        !atLocalTime ||
        atLocalTime !== asString(observation.atLocalTime)
      ) {
        receipts.push(reject(kind, observation ? "time_mismatch" : "subject_mismatch"));
        return;
      }
      const canonicalSubject = asString(observation.label) ?? "checked location";
      const mapObjectId = `shadow:${envelope!.resultId}:${coordinate.lat.toFixed(5)}:${coordinate.lng.toFixed(5)}`;
      if (
        !options.mapObjects.some((object) => object.kind === "shadow" && object.id === mapObjectId)
      ) {
        receipts.push(reject(kind, "missing_map_object"));
        return;
      }
      receipts.push({
        ...base({ ...value, subject: canonicalSubject }, index, kind, envelope, "verified"),
        kind,
        subject: canonicalSubject,
        value: { fraction, unit: "fraction" },
        coordinates: coordinate,
        atLocalTime,
        mapObjectId,
        confidence: "unknown",
      });
      return;
    }
    if (kind === "shade_window") {
      if (envelope!.toolName !== "find_shade_spots" || !validateToolResultEnvelope(envelope)) {
        receipts.push(reject(kind, "wrong_tool_kind"));
        return;
      }
      const payload = envelope!.payload;
      if (!isShadeWindowPayload(payload) || payload.status !== "ok") {
        receipts.push(reject(kind, "missing_result"));
        return;
      }
      const candidate = payload.results.find((spot) => spot.candidateId === value.candidateId);
      if (!candidate) {
        receipts.push(reject(kind, "subject_mismatch"));
        return;
      }
      const requested = isRecord(value.requestedWindow) ? value.requestedWindow : {};
      if (
        value.requestedDate !== payload.requestedDate ||
        requested.fromMinutes !== payload.requestedWindow.fromMinutes ||
        requested.toMinutes !== payload.requestedWindow.toMinutes
      ) {
        receipts.push(reject(kind, "time_mismatch"));
        return;
      }
      const input = isRecord(value.value) ? value.value : {};
      if (
        !matchesShadeFraction(input.meanShade, candidate.meanShade) ||
        (input.hours != null &&
          (!Array.isArray(input.hours) ||
            !input.hours.every((raw) => {
              if (!isRecord(raw)) return false;
              const actual = candidate.hours.find(
                (h) => h.slot === raw.slot && h.minutes === raw.minutes,
              );
              return !!actual && matchesShadeFraction(raw.shade, actual.shade);
            })))
      ) {
        receipts.push(reject(kind, "malformed_claim"));
        return;
      }
      if (
        (input.annualSquaredDistance !== undefined &&
          input.annualSquaredDistance !==
            payload.similarity?.squaredDistances[candidate.candidateId]) ||
        (value.likeCandidateId !== undefined &&
          value.likeCandidateId !== payload.similarity?.reference.candidateId)
      ) {
        receipts.push(reject(kind, "malformed_claim"));
        return;
      }
      const mapObjectId = shadeWindowObjectId(envelope!.resultId, candidate.candidateId);
      if (
        !options.mapObjects.some(
          (object) =>
            object.kind === "shade_window" &&
            object.id === mapObjectId &&
            object.lat === candidate.lat &&
            object.lng === candidate.lng,
        )
      ) {
        receipts.push(reject(kind, "missing_map_object"));
        return;
      }
      const common = base(
        { ...value, subject: candidate.label },
        index,
        kind,
        envelope,
        "verified",
      );
      receipts.push({
        ...common,
        claimId: `claim-shade_window:${envelope!.resultId}:${candidate.candidateId}`,
        kind,
        subject: candidate.label,
        candidateId: candidate.candidateId,
        requestedDate: payload.requestedDate,
        requestedWindow: payload.requestedWindow,
        effectiveWindow: candidate.effectiveWindow,
        basis: payload.basis,
        mode: payload.mode,
        ...(payload.similarity
          ? {
              similarity: {
                reference: payload.similarity.reference,
                annualSquaredDistance: payload.similarity.squaredDistances[candidate.candidateId],
                sampleCount: payload.similarity.sampleCount,
                model: payload.similarity.model,
                approximate: true as const,
              },
            }
          : {}),
        value: { meanShade: candidate.meanShade, hours: candidate.hours },
        coordinates: { lat: candidate.lat, lng: candidate.lng },
        mapObjectId,
        reasons: payload.reasons,
      });
      return;
    }
    if (kind === "time") {
      if (envelope!.toolName !== "set_time") {
        receipts.push(reject(kind, "wrong_tool_kind"));
        return;
      }
      // `producedAt` is simulated map time and may legitimately move backward.
      // Evidence array order is the execution order (cache reuse retains its entry).
      const latestTime = [...options.evidence]
        .reverse()
        .find((candidate) => candidate.toolName === "set_time");
      if (latestTime && latestTime.resultId !== envelope!.resultId) {
        receipts.push(reject(kind, "stale_evidence"));
        return;
      }
      const requested = isRecord(value.value) ? asString(value.value.localTime) : undefined;
      const actual = isRecord(envelope!.payload)
        ? asString(envelope!.payload.newLocalTime)
        : undefined;
      if (!requested || !actual || requested !== actual) {
        receipts.push(reject(kind, "subject_mismatch"));
        return;
      }
      receipts.push({
        ...base({ ...value, subject: "simulation time" }, index, kind, envelope, "verified"),
        subject: "simulation time",
        kind,
        value: { localTime: actual, unit: "local-time" },
      });
      return;
    }
    if (envelope!.toolName !== "plan_shadowed_route") {
      receipts.push(reject(kind, "wrong_tool_kind"));
      return;
    }
    const terminal = envelope!.payload as RoutePlanTerminalResult;
    const desired = isRecord(value.value) ? asString(value.value.status) : undefined;
    const requestedObjective = isRecord(value.value) ? asString(value.value.objective) : undefined;
    if ((desired !== "completed" && desired !== "partial") || terminal.status !== desired) {
      receipts.push(reject(kind, "contradictory_route_status"));
      return;
    }
    if (
      requestedObjective != null &&
      ((requestedObjective !== "sun" && requestedObjective !== "rain") ||
        requestedObjective !== terminal.objective)
    ) {
      receipts.push(reject(kind, "subject_mismatch"));
      return;
    }
    if (terminal.planRevision !== options.currentPlanRevision) {
      receipts.push(reject(kind, "stale_plan_revision"));
      return;
    }
    if (desired === "completed" && terminal.status !== "completed") {
      receipts.push(reject(kind, "contradictory_route_status"));
      return;
    }
    const mapObjectId = routeMapObjectId(terminal);
    if (
      !options.mapObjects.some((object) => object.kind === "route" && object.id === mapObjectId)
    ) {
      receipts.push(reject(kind, "missing_map_object"));
      return;
    }
    const partial = terminal.status === "partial" ? terminal.unroutableLegs[0] : undefined;
    receipts.push({
      ...base({ ...value, subject: "route" }, index, kind, envelope, "verified"),
      subject: "route",
      kind,
      value: { status: desired, ...(terminal.objective ? { objective: terminal.objective } : {}) },
      requestId: terminal.requestId,
      actionId: terminal.actionId,
      planRevision: terminal.planRevision,
      mapObjectId,
      unroutableLeg: partial
        ? { failedLeg: partial.failedLeg, totalLegs: partial.totalLegs }
        : undefined,
    });
  });

  // Model blocks are never presentation input. Canonical block order and wording
  // are deterministic, so invented names and paraphrased facts cannot escape.
  const sourceBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  const rejectedProseCount = sourceBlocks.filter(
    (block) => isRecord(block) && (block.kind === "text" || block.kind === "unknown"),
  ).length;
  const proposedIds = new Set(
    proposedReceipts
      .flatMap((raw) => (isRecord(raw) ? [asString(raw.claimId)] : []))
      .filter((id): id is string => !!id),
  );
  const danglingClaimBlocks = sourceBlocks.filter(
    (block) =>
      isRecord(block) &&
      block.kind === "claim" &&
      (!asString(block.claimId) || !proposedIds.has(asString(block.claimId)!)),
  ).length;
  const unique = new Map<string, ClaimReceipt>();
  let duplicateClaimProposals = 0;
  for (const receipt of receipts) {
    const existing = unique.get(receipt.claimId);
    if (!existing) {
      unique.set(receipt.claimId, receipt);
      continue;
    }
    // Identical canonical identity is one claim, not two metrics/UI entries.
    if (JSON.stringify(existing) === JSON.stringify(receipt)) {
      duplicateClaimProposals++;
      continue;
    }
    let suffix = 2;
    while (unique.has(`${receipt.claimId}-${suffix}`)) suffix++;
    receipt.claimId = `${receipt.claimId}-${suffix}`;
    unique.set(receipt.claimId, receipt);
  }
  const canonicalReceipts = [...unique.values()];
  const nowMs = Date.parse(options.now);
  for (const receipt of canonicalReceipts) {
    const observedMs = Date.parse(receipt.observedAt);
    if (Number.isFinite(nowMs) && Number.isFinite(observedMs))
      receipt.evidenceAgeMs = Math.max(0, nowMs - observedMs);
  }
  const blocks: VerifiedAnswerBlock[] = canonicalReceipts.map((receipt) =>
    receipt.verification === "verified"
      ? { kind: "claim", claimId: receipt.claimId }
      : { kind: "unknown", claimKind: receipt.kind },
  );
  const currentShadeIds = new Set(options.currentShadeResultIds ?? []);
  for (const envelope of options.evidence) {
    if (
      envelope.toolName !== "find_shade_spots" ||
      !currentShadeIds.has(envelope.resultId) ||
      !validateToolResultEnvelope(envelope)
    )
      continue;
    const payload = envelope.payload;
    if (!isShadeWindowPayload(payload)) continue;
    if (
      payload.status === "unavailable" &&
      !blocks.some(
        (block) =>
          block.kind === "unknown" &&
          block.claimKind === "shade_window" &&
          block.reason === payload.reason,
      )
    )
      blocks.push({ kind: "unknown", claimKind: "shade_window", reason: payload.reason });
    else if (
      payload.status === "ok" &&
      payload.reasons.includes("incomplete-data") &&
      !blocks.some((block) => block.kind === "notice" && block.code === "shade_partial")
    )
      blocks.push({ kind: "notice", code: "shade_partial" });
  }
  if (blocks.length === 0) blocks.push({ kind: "notice", code: "unverified" });
  return {
    blocks,
    receipts: canonicalReceipts,
    rejectedProseCount,
    danglingClaimBlocks,
    duplicateClaimProposals,
  };
}

/** A narrow tripwire: factual language only belongs in canonical claim/unknown blocks. */
export function unsupportedProseReasons(
  text: string,
  _options: Pick<VerifyAnswerOptions, "evidence" | "mapObjects">,
): string[] {
  return text.trim() ? ["free_text_not_rendered"] : [];
}

export function unknownLabel(kind: ClaimKind, reason?: ShadeUnavailableReason): string {
  if (kind === "shade_window")
    return reason ? SHADE_UNAVAILABLE_LABELS[reason] : "Shade window — unverified";
  return kind === "accessibility"
    ? "Accessibility — unknown"
    : `${kind[0].toUpperCase()}${kind.slice(1)} — unverified`;
}

export function noticeLabel(block: Extract<VerifiedAnswerBlock, { kind: "notice" }>): string {
  switch (block.code) {
    case "refusal":
      return "I only help plan a day around shadow and sun.";
    case "clarification":
      return "Which city or neighbourhood should I plan around?";
    case "blocked":
      return `I couldn't respond to that${block.detail ? ` (${block.detail})` : ""}.`;
    case "route_terminal":
      return block.detail ?? "The route result is not currently verified.";
    case "shade_route_time":
      return "Set the map to the departure date and time you want, then request the route.";
    case "shade_alternatives":
      return "These sidewalks are alternatives. Choose one destination before asking for a route.";
    case "shade_partial":
      return "Only sidewalks with complete available data were ranked; coverage is incomplete.";
    case "unverified":
      return "I could not verify a specific result.";
  }
}

export function receiptLabel(receipt: ClaimReceipt): string {
  if (receipt.verification !== "verified")
    return `${receipt.kind === "accessibility" ? "Accessibility" : receipt.subject} — ${receipt.verification === "unknown" ? "unknown" : "unverified"}`;
  switch (receipt.kind) {
    case "place":
      return `${receipt.subject} — located`;
    case "shadow":
      return `${Math.round(receipt.value.fraction * 100)}% shadow at ${receipt.atLocalTime} — checked`;
    case "shade_window": {
      const fraction =
        receipt.mode === "sun" ? 1 - receipt.value.meanShade : receipt.value.meanShade;
      return `${receipt.subject}${receipt.similarity ? " — similar annual shade pattern" : ""} — ${Math.round(fraction * 100)}% modelled ${receipt.mode}, ${shadeClockLabel(receipt.effectiveWindow.fromMinutes)}–${shadeClockLabel(receipt.effectiveWindow.toMinutes)} on ${receipt.requestedDate}`;
    }
    case "time":
      return `${receipt.value.localTime} — set`;
    case "route":
      return receipt.value.status === "completed"
        ? `Route completed — plan revision ${receipt.planRevision}`
        : `Route partial — plan revision ${receipt.planRevision}`;
    case "accessibility":
      return "Accessibility — unknown";
    case "feasibility":
      return feasibilityLabel(receipt.certificate);
  }
}

/** The certificate in words. Never "no" for unknown; the binding budget for infeasible. */
export function feasibilityLabel(c: FeasibilityCertificate): string {
  const q = c.question;
  const outing = `${q.timeMin} min there and back${q.stayMin > 0 ? ` with a ${q.stayMin}-min stop` : ""} on ≤ ${q.sunMin} min of sun`;
  switch (c.status) {
    case "feasible": {
      const sun = c.ledger ? Math.ceil(c.ledger.sun.usedSec! / 60) : null;
      const home = c.ledger ? Math.ceil(c.ledger.time.usedSec! / 60) : null;
      return `Possible: ${outing} — a walk found does it in ${home} min with ${sun} min of sun`;
    }
    case "infeasible": {
      const binds = c.ledger?.sun.binding ? "the sun budget" : "the time budget";
      return `Not possible: no walk does ${outing} — ${binds} is what rules it out`;
    }
    case "unknown":
      return `Not confirmed either way: ${outing} — the search stopped before it could tell`;
    case "uncovered":
      return "Can't check: the target is outside NYC's shade data";
    case "cancelled":
    case "superseded":
      return "No answer: a newer question replaced this one";
  }
}

export function receiptDetail(receipt: ClaimReceipt): string {
  if (receipt.kind === "shade_window" && receipt.verification === "verified")
    return "Estimated from the NYC shade model.";
  // observedAt is the *simulated map date* in UTC (agentLoop's loop clock), so
  // rendering it as a wall-clock time would be a time-zone claim the receipt
  // cannot back up — the source and the evidence age carry the provenance.
  const status =
    receipt.verification === "verified"
      ? `Checked by ${receipt.source ?? "application tool"}${receipt.sourceVersion ? ` (version ${receipt.sourceVersion})` : ""}.`
      : receipt.rejectionReason
        ? `Not verified: ${receipt.rejectionReason.replaceAll("_", " ")}.`
        : "Not verified by the available tools.";
  const age =
    receipt.evidenceAgeMs == null
      ? "unknown"
      : receipt.evidenceAgeMs < 60_000
        ? "under one minute"
        : `${Math.floor(receipt.evidenceAgeMs / 60_000)} minutes`;
  return `${status} Evidence age: ${age}. Confidence: ${receipt.confidence === "unknown" ? "unknown" : `${Math.round(receipt.confidence * 100)}%`}. Evidence id: ${receipt.supportingResultIds.join(", ") || "none"}.`;
}

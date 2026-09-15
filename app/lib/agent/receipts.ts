import type { RoutePlanTerminalResult } from "../routePlanJob";

/** The public tools which can produce evidence. `get_current_context` is ambient state, not evidence. */
export type AgentToolName =
  | "locate_user"
  | "geocode_place"
  | "search_places"
  | "check_shadow"
  | "set_time"
  | "plot_points"
  | "plan_shadowed_route";

export interface ToolResultEnvelope<TPayload = Record<string, unknown>> {
  resultId: string;
  toolName: AgentToolName;
  /** ISO instant supplied by the loop clock; tests inject it. */
  producedAt: string;
  sourceVersion?: string;
  requestId?: string;
  actionId?: string;
  planRevision?: number;
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
  results?: Array<{ label?: string; lat: number; lng: number; shadowFraction?: number; atLocalTime?: string; source?: string }>;
}
export interface TimeToolPayload { ok: boolean; newLocalTime: string; }
export interface PlotToolPayload { ok: boolean; plotted: number; note?: string; }
export type ToolPayloadByName = {
  locate_user: { lat: number; lng: number; note?: string };
  geocode_place: PlaceToolPayload;
  search_places: PlaceToolPayload;
  check_shadow: ShadowToolPayload;
  set_time: TimeToolPayload;
  plot_points: PlotToolPayload;
  plan_shadowed_route: RoutePlanTerminalResult;
};
export type TypedToolResultEnvelope<N extends AgentToolName> = ToolResultEnvelope<ToolPayloadByName[N]> & { toolName: N };

export type ClaimKind = "place" | "shadow" | "time" | "route" | "accessibility";
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
  | "malformed_claim";

export interface EvidenceDetails {
  source?: string;
  sourceVersion?: string;
  observedAt: string;
  confidence: number | "unknown";
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

export interface ShadowClaimReceipt extends ClaimBase<"shadow", { fraction: number; unit: "fraction" }> {
  coordinates: { lat: number; lng: number };
  atLocalTime: string;
  mapObjectId?: string;
}

export interface TimeClaimReceipt extends ClaimBase<"time", { localTime: string; unit: "local-time" }> {}

export interface RouteClaimReceipt extends ClaimBase<"route", { status: "completed" | "partial" }> {
  requestId: string;
  actionId: string;
  planRevision: number;
  mapObjectId: string;
  /** Present only for a partial result and points at the C4 terminal detail. */
  unroutableLeg?: { failedLeg: number; totalLegs: number };
}

export interface AccessibilityClaimReceipt extends ClaimBase<"accessibility", "unknown"> {
}

export type ClaimReceipt =
  | PlaceClaimReceipt
  | ShadowClaimReceipt
  | TimeClaimReceipt
  | RouteClaimReceipt
  | AccessibilityClaimReceipt;

export type VerifiedAnswerBlock =
  | { kind: "text"; text: string }
  | { kind: "claim"; claimId: string }
  | { kind: "unknown"; text: string; claimKind: ClaimKind };

export interface VerifiedAnswer {
  blocks: VerifiedAnswerBlock[];
  receipts: ClaimReceipt[];
}

/** Separate measures: place-to-pin agreement is not a proxy for complete grounding. */
export interface ClaimSupportMetrics {
  placeSupport: number;
  shadowSupport: number;
  temporalSupport: number;
  routeSupport: number;
  accessibilitySupport: number;
  unsupportedClaimEscapes: number;
}

export function claimSupportMetrics(answer: VerifiedAnswer, options: Pick<VerifyAnswerOptions, "evidence" | "mapObjects">): ClaimSupportMetrics {
  const supported = (kind: ClaimKind) => answer.receipts.filter((receipt) => receipt.kind === kind && receipt.verification === "verified").length;
  const escapes = answer.blocks.flatMap((block) => block.kind === "text" ? unsupportedProseReasons(block.text, options) : []).length;
  return {
    placeSupport: supported("place"), shadowSupport: supported("shadow"), temporalSupport: supported("time"),
    routeSupport: supported("route"), accessibilitySupport: supported("accessibility"), unsupportedClaimEscapes: escapes,
  };
}

export interface MapObject {
  id: string;
  kind: "pin" | "route";
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

function findShadow(
  envelope: ToolResultEnvelope,
  coordinates: { lat: number; lng: number },
): Record<string, unknown> | null {
  if (envelope.toolName !== "check_shadow" || !isRecord(envelope.payload)) return null;
  const values = Array.isArray(envelope.payload.results) ? envelope.payload.results : [envelope.payload];
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

function receiptId(value: LooseReceipt, index: number): string {
  return asString(value.claimId) ?? `claim-${index + 1}`;
}

function resultIds(value: LooseReceipt): string[] {
  return Array.isArray(value.supportingResultIds)
    ? value.supportingResultIds.flatMap((id) => asString(id) ? [asString(id)!] : [])
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
    claimId: receiptId(value, index), kind, subject: asString(value.subject) ?? "unknown",
    supportingResultIds: resultIds(value), verification, rejectionReason: reason,
    observedAt: envelope?.producedAt ?? "unknown", source: isRecord(envelope?.payload) ? asString(envelope.payload.source) : undefined,
    sourceVersion: envelope?.sourceVersion, confidence: "unknown" as const,
  };
}

export interface VerifyAnswerOptions {
  evidence: ToolResultEnvelope[];
  mapObjects: MapObject[];
  currentPlanRevision: number;
  now: string;
  /** Tests use this seam to demonstrate that compatibility checks have teeth. */
  allowIncompatibleEvidence?: boolean;
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
      if (claimKind === "accessibility") return { ...common, kind: "accessibility", value: "unknown" };
      if (claimKind === "place") return { ...common, kind: "place", value: { lat: 0, lng: 0 }, mapObjectId: asString(value.mapObjectId) ?? "unknown" };
      if (claimKind === "shadow") return { ...common, kind: "shadow", value: { fraction: 0, unit: "fraction" }, coordinates: { lat: 0, lng: 0 }, atLocalTime: "unknown" };
      if (claimKind === "time") return { ...common, kind: "time", value: { localTime: "unknown", unit: "local-time" } };
      return { ...common, kind: "route", value: { status: "partial" }, requestId: "unknown", actionId: "unknown", planRevision: -1, mapObjectId: "unknown" };
    };
    if (!kind || !["place", "shadow", "time", "route", "accessibility"].includes(kind)) {
      receipts.push(reject("accessibility", "malformed_claim")); return;
    }
    if (kind === "accessibility") {
      // C5 has no accessibility observation tool. It can only make that absence legible.
      const common = base(value, index, kind, envelope, "unknown");
      receipts.push({ ...common, kind, value: "unknown", supportingResultIds: [] }); return;
    }
    if (malformed) { receipts.push(reject(kind, "missing_result")); return; }
    if (kind === "place") {
      if (envelope!.toolName !== "geocode_place" && envelope!.toolName !== "search_places") {
        receipts.push(reject(kind, "wrong_tool_kind")); return;
      }
      const val = isRecord(value.value) ? value.value : {};
      const lat = asNumber(val.lat); const lng = asNumber(val.lng);
      const coordinate = lat != null && lng != null ? { lat, lng } : resultCoords(envelope!.payload)[0];
      const subject = asString(value.subject) ?? "unknown";
      const resultMatch = resultCoords(envelope!.payload).some((point) => coordinate && coordsMatch(point, coordinate));
      const mapObject = coordinate && options.mapObjects.find((object) => object.kind === "pin" && object.lat != null && object.lng != null && coordsMatch({ lat: object.lat, lng: object.lng }, coordinate));
      if (!coordinate || !resultMatch || !mapObject || (mapObject.label && normal(subject) !== normal(mapObject.label) && !normal(mapObject.label).startsWith(normal(subject)))) {
        receipts.push(reject(kind, !mapObject ? "missing_map_object" : "subject_mismatch")); return;
      }
      receipts.push({ ...base(value, index, kind, envelope, "verified"), kind, subject: mapObject.label ?? subject, value: coordinate, mapObjectId: mapObject.id }); return;
    }
    if (kind === "shadow") {
      if (envelope!.toolName !== "check_shadow" && !options.allowIncompatibleEvidence) { receipts.push(reject(kind, "wrong_tool_kind")); return; }
      const input = isRecord(value.value) ? value.value : {};
      const coords = isRecord(value.value) ? value.value : {};
      const lat = asNumber(coords.lat) ?? asNumber((value as Record<string, unknown>).lat);
      const lng = asNumber(coords.lng) ?? asNumber((value as Record<string, unknown>).lng);
      // Accept the explicit coordinates field preferred by the public receipt type.
      const possibleCoordinateField = (value as Record<string, unknown>).coordinates;
      const coordinateField = isRecord(possibleCoordinateField) ? possibleCoordinateField : {};
      const coordinateLat = asNumber(coordinateField.lat) ?? lat;
      const coordinateLng = asNumber(coordinateField.lng) ?? lng;
      if (coordinateLat == null || coordinateLng == null) { receipts.push(reject(kind, "subject_mismatch")); return; }
      const coordinate = { lat: coordinateLat, lng: coordinateLng };
      const observation = findShadow(envelope!, coordinate);
      const fraction = asNumber(input.fraction);
      const atLocalTime = asString(value.atLocalTime);
      const ageMs = Date.parse(options.now) - Date.parse(envelope!.producedAt);
      if (Number.isFinite(ageMs) && ageMs > 15 * 60 * 1000) { receipts.push(reject(kind, "stale_evidence")); return; }
      if (!observation || fraction == null || fraction < 0 || fraction > 1 || fraction !== asNumber(observation.shadowFraction) || !atLocalTime || atLocalTime !== asString(observation.atLocalTime)) {
        receipts.push(reject(kind, observation ? "time_mismatch" : "subject_mismatch")); return;
      }
      receipts.push({ ...base(value, index, kind, envelope, "verified"), kind, value: { fraction, unit: "fraction" }, coordinates: coordinate, atLocalTime, confidence: "unknown" }); return;
    }
    if (kind === "time") {
      if (envelope!.toolName !== "set_time") { receipts.push(reject(kind, "wrong_tool_kind")); return; }
      const requested = isRecord(value.value) ? asString(value.value.localTime) : undefined;
      const actual = isRecord(envelope!.payload) ? asString(envelope!.payload.newLocalTime) : undefined;
      if (!requested || !actual || requested !== actual) { receipts.push(reject(kind, "subject_mismatch")); return; }
      receipts.push({ ...base(value, index, kind, envelope, "verified"), kind, value: { localTime: actual, unit: "local-time" } }); return;
    }
    if (envelope!.toolName !== "plan_shadowed_route") { receipts.push(reject(kind, "wrong_tool_kind")); return; }
    const terminal = envelope!.payload as RoutePlanTerminalResult;
    const desired = isRecord(value.value) ? asString(value.value.status) : undefined;
    if ((desired !== "completed" && desired !== "partial") || terminal.status !== desired) { receipts.push(reject(kind, "contradictory_route_status")); return; }
    if (terminal.planRevision !== options.currentPlanRevision) { receipts.push(reject(kind, "stale_plan_revision")); return; }
    if (desired === "completed" && terminal.status !== "completed") { receipts.push(reject(kind, "contradictory_route_status")); return; }
    const mapObjectId = routeMapObjectId(terminal);
    if (!options.mapObjects.some((object) => object.kind === "route" && object.id === mapObjectId)) { receipts.push(reject(kind, "missing_map_object")); return; }
    const partial = terminal.status === "partial" ? terminal.unroutableLegs[0] : undefined;
    receipts.push({ ...base(value, index, kind, envelope, "verified"), kind, value: { status: desired }, requestId: terminal.requestId, actionId: terminal.actionId, planRevision: terminal.planRevision, mapObjectId, unroutableLeg: partial ? { failedLeg: partial.failedLeg, totalLegs: partial.totalLegs } : undefined });
  });

  const blocks: VerifiedAnswerBlock[] = [];
  const sourceBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  for (const raw of sourceBlocks) {
    if (!isRecord(raw)) continue;
    const rawClaimId = asString(raw.claimId);
    if (raw.kind === "claim" && rawClaimId && receipts.some((receipt) => receipt.claimId === rawClaimId && receipt.verification === "verified")) blocks.push({ kind: "claim", claimId: rawClaimId });
    if (raw.kind === "unknown" && asString(raw.text) && ["place", "shadow", "time", "route", "accessibility"].includes(String(raw.claimKind))) blocks.push({ kind: "unknown", text: asString(raw.text)!, claimKind: raw.claimKind as ClaimKind });
    if (raw.kind === "text" && asString(raw.text) && unsupportedProseReasons(asString(raw.text)!, options).length === 0) blocks.push({ kind: "text", text: asString(raw.text)! });
  }
  // Fail closed: malformed model output gets a canonical, evidence-derived answer.
  if (blocks.length === 0) {
    for (const receipt of receipts) blocks.push(receipt.verification === "verified" ? { kind: "claim", claimId: receipt.claimId } : { kind: "unknown", claimKind: receipt.kind, text: `${receipt.kind} is unverified.` });
    if (blocks.length === 0) blocks.push({ kind: "unknown", claimKind: "place", text: "I could not verify a specific result." });
  }
  return { blocks, receipts };
}

/** A narrow tripwire: factual language only belongs in canonical claim/unknown blocks. */
export function unsupportedProseReasons(text: string, options: Pick<VerifyAnswerOptions, "evidence" | "mapObjects">): string[] {
  const reasons: string[] = [];
  if (options.mapObjects.some((object) => object.label && new RegExp(`(^|[^\\p{L}\\p{N}])${object.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text))) reasons.push("named_place_outside_claim");
  if (/\b\d+(?:\.\d+)?\s*%\s*(?:shadow|shade)?\b|\b(?:shadow|shade)\s*\d+(?:\.\d+)?\s*%/i.test(text)) reasons.push("shadow_number_outside_claim");
  if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(text)) reasons.push("time_outside_claim");
  if (/\b(route|walk)\b[^.]{0,30}\b(completed|ready|finished)\b|\b(completed|ready)\b[^.]{0,30}\b(route|walk)\b/i.test(text)) reasons.push("route_status_outside_claim");
  if (/\b(accessib(?:le|ility)|wheelchair|step[- ]free)\b/i.test(text)) reasons.push("accessibility_outside_claim");
  return reasons;
}

export function receiptLabel(receipt: ClaimReceipt): string {
  if (receipt.verification !== "verified") return `${receipt.kind === "accessibility" ? "Accessibility" : receipt.subject} — ${receipt.verification === "unknown" ? "unknown" : "unverified"}`;
  switch (receipt.kind) {
    case "place": return `${receipt.subject} — located`;
    case "shadow": return `${Math.round(receipt.value.fraction * 100)}% shadow at ${receipt.atLocalTime} — checked`;
    case "time": return `${receipt.value.localTime} — set`;
    case "route": return receipt.value.status === "completed" ? `Route completed — plan revision ${receipt.planRevision}` : `Route partial — plan revision ${receipt.planRevision}`;
    case "accessibility": return "Accessibility — unknown";
  }
}

export function receiptDetail(receipt: ClaimReceipt): string {
  const status = receipt.verification === "verified" ? `Checked by ${receipt.source ?? "application tool"} at ${receipt.observedAt}.` : receipt.rejectionReason ? `Not verified: ${receipt.rejectionReason.replaceAll("_", " ")}.` : "Not verified by the available tools.";
  return `${status} Confidence: ${receipt.confidence === "unknown" ? "unknown" : `${Math.round(receipt.confidence * 100)}%`}.`;
}

import { validateRoutePlanTerminalResult, type RoutePlanTerminalResult } from "../routePlanJob";
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
  set_time: TimeToolPayload;
  plot_points: PlotToolPayload;
  plan_shadowed_route: RoutePlanTerminalResult;
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
    "set_time",
    "plot_points",
    "plan_shadowed_route",
  ].includes(value as AgentToolName);
}

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

export interface RouteClaimReceipt extends ClaimBase<"route", {
  status: "completed" | "partial";
  /** Objective used by the application-owned route calculation. */
  objective?: "sun" | "rain";
}> {
  requestId: string;
  actionId: string;
  planRevision: number;
  mapObjectId: string;
  /** Present only for a partial result and points at the C4 terminal detail. */
  unroutableLeg?: { failedLeg: number; totalLegs: number };
}

export interface AccessibilityClaimReceipt extends ClaimBase<"accessibility", "unknown"> {}

export type ClaimReceipt =
  | PlaceClaimReceipt
  | ShadowClaimReceipt
  | TimeClaimReceipt
  | RouteClaimReceipt
  | AccessibilityClaimReceipt;

export type VerifiedAnswerBlock =
  | { kind: "claim"; claimId: string }
  | { kind: "unknown"; claimKind: ClaimKind }
  | {
      kind: "notice";
      code: "refusal" | "clarification" | "blocked" | "unverified" | "route_terminal";
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
  time: ClaimKindSupportMetrics;
  route: ClaimKindSupportMetrics;
  accessibility: ClaimKindSupportMetrics;
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
    time: measure("time"),
    route: measure("route"),
    accessibility: measure("accessibility"),
    // All model text blocks are discarded before rendering, so an escape is impossible by construction.
    unsupportedClaimEscapes: 0,
    rejectedUnsupportedProse: answer.rejectedProseCount,
    danglingClaimProposals: answer.danglingClaimBlocks,
    duplicateClaimProposals: answer.duplicateClaimProposals,
  };
}

export interface MapObject {
  id: string;
  kind: "pin" | "route" | "shadow";
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
      if (claimKind === "time")
        return { ...common, kind: "time", value: { localTime: "unknown", unit: "local-time" } };
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
    if (!kind || !["place", "shadow", "time", "route", "accessibility"].includes(kind)) {
      receipts.push(reject("accessibility", "malformed_claim"));
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
      (requestedObjective !== "sun" && requestedObjective !== "rain" || requestedObjective !== terminal.objective)
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

export function unknownLabel(kind: ClaimKind): string {
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
    case "time":
      return `${receipt.value.localTime} — set`;
    case "route":
      return receipt.value.status === "completed"
        ? `Route completed — plan revision ${receipt.planRevision}`
        : `Route partial — plan revision ${receipt.planRevision}`;
    case "accessibility":
      return "Accessibility — unknown";
  }
}

export function receiptDetail(receipt: ClaimReceipt): string {
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

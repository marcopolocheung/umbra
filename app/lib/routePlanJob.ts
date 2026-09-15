import type { PartialRouteInfo } from "./partialRoute";
import type { ShadowProvenance } from "./shadowProvenance";

export interface RoutePlan {
  from: [number, number];
  to: [number, number];
  via: [number, number][];
  fromLabel: string;
  toLabel: string;
}

/** A mutation request crossing the agent/routing boundary. */
export interface RoutePlanRequest {
  requestId: string;
  /** Monotonic request sequence, retained for traceability in terminal results. */
  inputVersion: number;
  /** Actual route-plan revision in application state this job may commit. */
  planRevision: number;
  /** One user/agent action. A later identical route is a new action. */
  actionId: string;
  /** Retry ordinal within `actionId`; the first attempt is zero. */
  retry: number;
  /** Deduplicates only this action attempt while it is in flight. */
  idempotencyKey: string;
  plan: RoutePlan;
}

export interface RoutePlanMetrics {
  label: string;
  distanceM: number;
  shadowCoverage: number;
  totalTimeSec?: number;
}

interface TerminalBase {
  [key: string]: unknown;
  requestId: string;
  inputVersion: number;
  planRevision: number;
  actionId: string;
  retry: number;
  idempotencyKey: string;
}

export interface CompletedRoutePlan extends TerminalBase {
  status: "completed";
  metrics: RoutePlanMetrics[];
  shadowProvenance: ShadowProvenance | null;
}

export interface PartialRoutePlan extends TerminalBase {
  status: "partial";
  metrics: RoutePlanMetrics[];
  shadowProvenance: ShadowProvenance | null;
  /** Each unreachable leg is retained instead of being hidden behind a partial line. */
  unroutableLegs: PartialRouteInfo[];
}

export interface NoPlanFoundRoutePlan extends TerminalBase {
  status: "no_plan_found";
  message: string;
}

export interface CancelledRoutePlan extends TerminalBase {
  status: "cancelled";
  reason: "cancelled" | "superseded";
}

export interface ErrorRoutePlan extends TerminalBase {
  status: "error";
  message: string;
}

export type RoutePlanTerminalResult =
  | CompletedRoutePlan
  | PartialRoutePlan
  | NoPlanFoundRoutePlan
  | CancelledRoutePlan
  | ErrorRoutePlan;

export type RoutePlanOutcome =
  | Omit<CompletedRoutePlan, keyof TerminalBase>
  | Omit<PartialRoutePlan, keyof TerminalBase>
  | Omit<NoPlanFoundRoutePlan, keyof TerminalBase>
  | Omit<CancelledRoutePlan, keyof TerminalBase>
  | Omit<ErrorRoutePlan, keyof TerminalBase>;

export function terminalResult(
  request: RoutePlanRequest,
  outcome: RoutePlanOutcome,
): RoutePlanTerminalResult {
  const result = { ...requestIdentity(request), ...outcome };
  return validateRoutePlanTerminalResult(result, request) ?? invalidTerminalResult(request);
}

export function requestIdentity(request: RoutePlanRequest): TerminalBase {
  return {
    requestId: request.requestId,
    inputVersion: request.inputVersion,
    planRevision: request.planRevision,
    actionId: request.actionId,
    retry: request.retry,
    idempotencyKey: request.idempotencyKey,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validMetrics(value: unknown): value is RoutePlanMetrics[] {
  return Array.isArray(value) && value.length > 0 && value.every((metric) =>
    record(metric) && nonEmptyString(metric.label) && finiteNonNegative(metric.distanceM) &&
    finiteUnit(metric.shadowCoverage) &&
    (metric.totalTimeSec == null || finiteNonNegative(metric.totalTimeSec))
  );
}
function validPartialLegs(value: unknown): value is PartialRouteInfo[] {
  return Array.isArray(value) && value.length > 0 && value.every((leg) =>
    record(leg) && nonNegativeInteger(leg.completedLegs) &&
    nonNegativeInteger(leg.failedLeg) && nonNegativeInteger(leg.totalLegs) &&
    leg.completedLegs < leg.failedLeg && leg.failedLeg <= leg.totalLegs
  );
}
const SHADOW_SOURCES = new Set(["tiles", "overpass", "canopy", "mixed", "canvas", "none"]);
function validShadowProvenance(value: unknown): value is ShadowProvenance | null {
  if (value === null) return true;
  if (!record(value) || !record(value.bySource) || !SHADOW_SOURCES.has(value.dominant as string)) return false;
  if (!finiteUnit(value.sampledFraction) || !finiteUnit(value.minConfidence) || !finiteUnit(value.meanConfidence)) return false;
  return Object.entries(value.bySource).every(([source, share]) => SHADOW_SOURCES.has(source) && finiteUnit(share));
}

/** Parse untrusted async boundary data before it can authorize a route claim. */
export function validateRoutePlanTerminalResult(
  value: unknown,
  expected?: RoutePlanRequest,
): RoutePlanTerminalResult | null {
  if (!record(value) || !nonEmptyString(value.requestId) || !nonNegativeInteger(value.inputVersion) ||
    !nonNegativeInteger(value.planRevision) || !nonEmptyString(value.actionId) ||
    !nonNegativeInteger(value.retry) || !nonEmptyString(value.idempotencyKey)) return null;
  if (expected && (value.requestId !== expected.requestId || value.inputVersion !== expected.inputVersion ||
    value.planRevision !== expected.planRevision || value.actionId !== expected.actionId ||
    value.retry !== expected.retry || value.idempotencyKey !== expected.idempotencyKey)) return null;
  switch (value.status) {
    case "completed":
      return validMetrics(value.metrics) && validShadowProvenance(value.shadowProvenance) ? value as RoutePlanTerminalResult : null;
    case "partial":
      return validMetrics(value.metrics) && validShadowProvenance(value.shadowProvenance) && validPartialLegs(value.unroutableLegs)
        ? value as RoutePlanTerminalResult : null;
    case "no_plan_found":
    case "error":
      return nonEmptyString(value.message) ? value as RoutePlanTerminalResult : null;
    case "cancelled":
      return value.reason === "cancelled" || value.reason === "superseded" ? value as RoutePlanTerminalResult : null;
    default:
      return null;
  }
}

/** Return a known terminal error instead of allowing malformed output to succeed. */
export function invalidTerminalResult(request: RoutePlanRequest): ErrorRoutePlan {
  return { ...requestIdentity(request), status: "error", message: "The route pipeline returned an invalid terminal result." };
}

/**
 * Owns only job lifecycle rules. The runner remains the navigation pipeline,
 * which is the only layer allowed to calculate or commit routes.
 */
export class RoutePlanJobCoordinator {
  private latestPlanRevision = 0;
  private readonly inFlightByIdempotencyKey = new Map<string, { request: RoutePlanRequest; promise: Promise<RoutePlanTerminalResult> }>();
  private active: { request: RoutePlanRequest; controller: AbortController } | null = null;

  /** Called when application route-plan state changes independently of a job. */
  advancePlanRevision(revision: number): void {
    if (!nonNegativeInteger(revision) || revision <= this.latestPlanRevision) return;
    this.latestPlanRevision = revision;
    if (this.active && this.active.request.planRevision < revision) this.active.controller.abort("superseded");
  }

  submit(
    request: RoutePlanRequest,
    run: (request: RoutePlanRequest, signal: AbortSignal) => Promise<RoutePlanOutcome>,
  ): Promise<RoutePlanTerminalResult> {
    const duplicate = this.inFlightByIdempotencyKey.get(request.idempotencyKey);
    if (duplicate) {
      if (duplicate.request.actionId === request.actionId && duplicate.request.retry === request.retry &&
        duplicate.request.requestId === request.requestId && duplicate.request.planRevision === request.planRevision) return duplicate.promise;
      return Promise.resolve(terminalResult(request, { status: "error", message: "An idempotency key cannot identify two route action attempts." }));
    }

    if (request.planRevision < this.latestPlanRevision) {
      return Promise.resolve(terminalResult(request, { status: "cancelled", reason: "superseded" }));
    }

    this.advancePlanRevision(request.planRevision);
    this.active?.controller.abort();
    const controller = new AbortController();
    this.active = { request, controller };

    let result!: Promise<RoutePlanTerminalResult>;
    result = run(request, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) {
          return terminalResult(request, {
            status: "cancelled",
            reason: controller.signal.reason === "cancelled" ? "cancelled" : "superseded",
          });
        }
        if (request.planRevision !== this.latestPlanRevision) {
          return terminalResult(request, { status: "cancelled", reason: "superseded" });
        }
        return terminalResult(request, outcome);
      })
      .catch((error) =>
        terminalResult(request, {
          status: "error",
          message: error instanceof Error ? error.message : "Routing failed.",
        }),
      )
      .finally(() => {
        if (this.active?.request.requestId === request.requestId) this.active = null;
        if (this.inFlightByIdempotencyKey.get(request.idempotencyKey)?.promise === result) {
          this.inFlightByIdempotencyKey.delete(request.idempotencyKey);
        }
      });
    this.inFlightByIdempotencyKey.set(request.idempotencyKey, { request, promise: result });
    return result;
  }

  cancel(requestId: string): boolean {
    if (this.active?.request.requestId !== requestId) return false;
    this.active.controller.abort("cancelled");
    return true;
  }
}

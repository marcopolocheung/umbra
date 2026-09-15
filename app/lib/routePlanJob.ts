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
  /** Monotonic within this client session; identifies the input this job may update. */
  inputVersion: number;
  /** Replaying the same intent must return the original job, not mutate again. */
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
  return { ...requestIdentity(request), ...outcome } as RoutePlanTerminalResult;
}

export function requestIdentity(request: RoutePlanRequest): TerminalBase {
  return {
    requestId: request.requestId,
    inputVersion: request.inputVersion,
    idempotencyKey: request.idempotencyKey,
  };
}

/**
 * Owns only job lifecycle rules. The runner remains the navigation pipeline,
 * which is the only layer allowed to calculate or commit routes.
 */
export class RoutePlanJobCoordinator {
  private latestInputVersion = 0;
  private readonly byIdempotencyKey = new Map<string, Promise<RoutePlanTerminalResult>>();
  private active: { request: RoutePlanRequest; controller: AbortController } | null = null;

  submit(
    request: RoutePlanRequest,
    run: (request: RoutePlanRequest, signal: AbortSignal) => Promise<RoutePlanOutcome>,
  ): Promise<RoutePlanTerminalResult> {
    const duplicate = this.byIdempotencyKey.get(request.idempotencyKey);
    if (duplicate) return duplicate;

    if (request.inputVersion < this.latestInputVersion) {
      const stale = Promise.resolve(
        terminalResult(request, { status: "cancelled", reason: "superseded" }),
      );
      this.byIdempotencyKey.set(request.idempotencyKey, stale);
      return stale;
    }

    this.latestInputVersion = request.inputVersion;
    this.active?.controller.abort();
    const controller = new AbortController();
    this.active = { request, controller };

    const result = run(request, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) {
          return terminalResult(request, {
            status: "cancelled",
            reason: controller.signal.reason === "cancelled" ? "cancelled" : "superseded",
          });
        }
        if (request.inputVersion !== this.latestInputVersion) {
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
      });
    this.byIdempotencyKey.set(request.idempotencyKey, result);
    return result;
  }

  cancel(requestId: string): boolean {
    if (this.active?.request.requestId !== requestId) return false;
    this.active.controller.abort("cancelled");
    return true;
  }
}

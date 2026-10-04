export interface RouteCalculationProgress {
  message: string;
  current?: number;
  total?: number;
}

export function routeProgressPercent(progress: RouteCalculationProgress): number | null {
  const { current, total } = progress;
  if (
    current == null ||
    total == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.min(100, (current / total) * 100));
}

export function routeProgressCount(progress: RouteCalculationProgress): string | null {
  const { current, total } = progress;
  if (
    current == null ||
    total == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return `${Math.max(0, Math.min(total, current))}/${total}`;
}

/**
 * How long a per-edge loop may run before it yields to the browser (#266).
 * Yielding every N edges instead cost ~4 ms per `setTimeout(0)` (the nested-timer
 * clamp) — ~3 s of pure waiting across a long route's ~670 yields. 50 ms keeps
 * progress and cancellation responsive while yielding a few dozen times at most.
 */
export const YIELD_INTERVAL_MS = 50;

/** Yield after the last item, or once `YIELD_INTERVAL_MS` has passed since the last yield. */
export function shouldYield(done: number, total: number, nowMs: number, lastYieldMs: number): boolean {
  return done === total || nowMs - lastYieldMs >= YIELD_INTERVAL_MS;
}

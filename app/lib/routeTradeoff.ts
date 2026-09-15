import type { RouteOption } from "./routing";
import { getTravelModePolicy } from "./travelMode";

/** Speed a route's durations are reported at — its own mode, else walking. */
function speedOf(route: RouteOption): number {
  return getTravelModePolicy(route.travelMode ?? "walk").speedMps;
}

function travelSeconds(route: RouteOption): number {
  return route.totalTimeSec ?? route.distanceM / speedOf(route);
}

function directSunMeters(route: RouteOption): number {
  return Math.max(0, route.distanceM * (1 - route.shadowCoverage));
}

/**
 * The trip split into sunlit and shadowed minutes at walking pace.
 *
 * Shadowed minutes are not idle time for a UV model — see `app/lib/heat/dose.ts` —
 * so both halves are reported rather than only the exposed one.
 */
export function routeExposureMinutes(route: RouteOption): {
  sunMinutes: number;
  shadowMinutes: number;
} {
  const speedMps = speedOf(route);
  const sunM = directSunMeters(route);
  return {
    sunMinutes: sunM / speedMps / 60,
    shadowMinutes: Math.max(0, route.distanceM - sunM) / speedMps / 60,
  };
}

function formatDeltaMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes <= 0) return "same time";
  return `+${minutes} min`;
}

export function routeTradeoffLine(route: RouteOption, baseline: RouteOption): string {
  if (route === baseline) {
    return `Shortest baseline, ${Math.round(route.shadowCoverage * 100)}% shadow`;
  }

  const timeDeltaSec = Math.max(0, travelSeconds(route) - travelSeconds(baseline));
  const baselineSun = directSunMeters(baseline);
  const routeSun = directSunMeters(route);
  const sunDeltaPct = baselineSun > 0
    ? Math.round(((routeSun - baselineSun) / baselineSun) * 100)
    : 0;

  const sunLabel =
    sunDeltaPct < 0
      ? `${sunDeltaPct}% sun exposure`
      : sunDeltaPct > 0
        ? `+${sunDeltaPct}% sun exposure`
        : "same sun exposure";

  return `${formatDeltaMinutes(timeDeltaSec)}, ${sunLabel}`;
}

export function shortestRoute(routes: RouteOption[]): RouteOption | null {
  if (routes.length === 0) return null;
  return routes.reduce((best, route) =>
    travelSeconds(route) < travelSeconds(best) ? route : best
  );
}

function formatSunMinutes(meters: number, speedMps: number): string {
  const minutes = meters / speedMps / 60;
  if (minutes < 1) return "under a minute";
  return `${Math.round(minutes)} min`;
}

/**
 * Direct sun as a duration, plus the longest unbroken run of it.
 *
 * A percentage hides the comparison it is meant to serve: 70% shadow over 30 minutes
 * leaves 9 minutes in the sun, 60% over 20 minutes leaves 8. Minutes are the unit the
 * choice is actually made in, and the longest stretch is what a walker feels — one
 * unbroken crossing is worse than the same total split across six short gaps.
 *
 * Both figures are walking-speed conversions of sampled distance, so the stretch
 * clause is omitted for sketch and transit routes, whose shadow was never sampled
 * per edge and whose `longestContinuousSunM` is a placeholder rather than a zero.
 */
export function routeExposureLine(route: RouteOption): string {
  const speedMps = speedOf(route);
  const total = `${formatSunMinutes(directSunMeters(route), speedMps)} in sun`;
  if (route.longestContinuousSunM <= 0) return total;
  return `${total} · longest stretch ${formatSunMinutes(route.longestContinuousSunM, speedMps)}`;
}

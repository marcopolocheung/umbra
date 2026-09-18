import type { RouteLeg, RouteOption } from "./routing";
import { MIN_WAIT_COVERAGE } from "./transitWaitExposure";
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

function transitLegOf(route: RouteOption): RouteLeg | undefined {
  return route.legs?.find((leg) => leg.type === "transit");
}

export interface OutdoorExposure {
  /** Seconds walking, plus seconds waiting at a stop the app samples. */
  outdoorSec: number;
  /** Share of the *measured* outdoor seconds in shadow, 0–1. */
  shadow: number;
  /** Share of `outdoorSec` that was measured. Never read a low one as shade. */
  coverage: number;
}

/**
 * A transit trip's time in the open, and how much of it is shadowed.
 *
 * Seconds, not metres: a rider standing at a stop covers no distance and still
 * takes the sun, and `dose()` was always a function of minutes — distance was
 * only how a walk's minutes were obtained. A bus stop's sampled shadow is the
 * same kind of measurement as a walking leg's, so the two share one sum.
 *
 * The ride is not in here: it is behind glass or underground, and the card
 * states its track fact in words instead. Nor is a subway platform wait, which
 * #423 leaves unmodelled. See docs/notes/transit-headline-exposure.md.
 */
export function transitOutdoorExposure(legs: RouteLeg[]): OutdoorExposure {
  const walkMps = getTravelModePolicy("walk").speedMps;
  let outdoorSec = 0;
  let knownSec = 0;
  let shadowSec = 0;
  for (const leg of legs) {
    if (leg.type === "walk") {
      const sec = (leg.distanceM ?? 0) / walkMps;
      outdoorSec += sec;
      if (leg.shadowCoverage == null) continue;
      knownSec += sec;
      shadowSec += sec * leg.shadowCoverage;
    } else if (leg.waitExposure && leg.waitSec) {
      outdoorSec += leg.waitSec;
      // Absent shadow is unknown, not shaded: the seconds stay in the
      // denominator and add nothing to what is known (#393).
      const { shadow, coverage } = leg.waitExposure;
      if (shadow == null) continue;
      knownSec += leg.waitSec * coverage;
      shadowSec += leg.waitSec * coverage * shadow;
    }
  }
  return {
    outdoorSec,
    shadow: knownSec > 0 ? shadowSec / knownSec : 0,
    coverage: outdoorSec > 0 ? knownSec / outdoorSec : 0,
  };
}

/**
 * The trip split into sunlit and shadowed minutes at the route's own mode speed.
 *
 * Shadowed minutes are not idle time for a UV model — see `app/lib/heat/dose.ts` —
 * so both halves are reported rather than only the exposed one.
 *
 * A transit trip counts its time outdoors instead (`transitOutdoorExposure`),
 * and is `null` when too little of that is measured to stand for the trip —
 * the same floor as the wait's own, for the same reason.
 */
export function routeExposureMinutes(route: RouteOption): {
  sunMinutes: number;
  shadowMinutes: number;
} | null {
  if (route.legs && transitLegOf(route)) {
    const { outdoorSec, shadow, coverage } = transitOutdoorExposure(route.legs);
    if (coverage < MIN_WAIT_COVERAGE) return null;
    return {
      sunMinutes: (outdoorSec * (1 - shadow)) / 60,
      shadowMinutes: (outdoorSec * shadow) / 60,
    };
  }
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
    return `Shortest baseline, ${routeShadowLabel(route)}`;
  }

  const timeDeltaSec = Math.max(0, travelSeconds(route) - travelSeconds(baseline));
  // Minutes, not metres, so a transit wait counts; for two routes at one speed
  // the ratio is the same either way.
  const baselineSun = routeExposureMinutes(baseline)?.sunMinutes;
  const routeSun = routeExposureMinutes(route)?.sunMinutes;
  if (baselineSun == null || routeSun == null) {
    return `${formatDeltaMinutes(timeDeltaSec)}, sun exposure unknown`;
  }
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

/**
 * The headline shadow figure, worded for what it covers.
 *
 * On a transit card a bare "N% shadow" beside a twenty-minute ride reads as a
 * claim about the ride, so it says it is about the time on foot — or that it
 * is unknown, rather than quoting a sliver of it.
 */
export function routeShadowLabel(route: RouteOption): string {
  const pct = Math.round(route.shadowCoverage * 100);
  if (!transitLegOf(route)) return `${pct}% shadow`;
  if (!routeExposureMinutes(route)) return "shadow unknown";
  return `${pct}% shadow on foot`;
}

/**
 * What a transit trip's sun figures leave out, in words beside them.
 *
 * The ride is never counted, and a wait only where the stop is sampled — a
 * subway platform is not. Saying so is what stops an omission reading as shade.
 */
export function routeExposureScope(route: RouteOption): string | null {
  const transit = transitLegOf(route);
  if (!transit) return null;
  return transit.waitExposure && transit.waitSec
    ? "Counts the walk and the wait at the stop, not the ride."
    : "Counts the walk, not the wait or the ride.";
}

function formatSunMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  return `${Math.round(minutes)} min`;
}

/**
 * Direct sun as a duration, plus the longest unbroken run of it.
 *
 * A percentage hides the comparison it is meant to serve: 70% shadow over 30 minutes
 * leaves 9 minutes in the sun, 60% over 20 minutes leaves 8. Minutes are the unit the
 * choice is actually made in, and the longest stretch is what a traveller feels — one
 * unbroken crossing is worse than the same total split across six short gaps.
 *
 * Both figures are mode-speed conversions of sampled distance, so the stretch
 * clause is omitted for sketch and transit routes, whose shadow was never sampled
 * per edge and whose `longestContinuousSunM` is a placeholder rather than a zero.
 */
export function routeExposureLine(route: RouteOption): string {
  const exposure = routeExposureMinutes(route);
  if (!exposure) return "time in sun unknown";
  const total = `${formatSunMinutes(exposure.sunMinutes)} in sun`;
  if (route.longestContinuousSunM <= 0) return total;
  return `${total} · longest stretch ${formatSunMinutes(route.longestContinuousSunM / speedOf(route) / 60)}`;
}

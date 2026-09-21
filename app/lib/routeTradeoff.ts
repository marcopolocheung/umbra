import type { RouteLeg, RouteOption } from "./routing";
import { computeExposureMetrics, type ExposureMetrics } from "./exposureMetrics";
import { getTravelModePolicy } from "./travelMode";
import { rainTradeoffLine } from "./routeRain";

/** Speed a route's durations are reported at — its own mode, else walking. */
function speedOf(route: RouteOption): number {
  return getTravelModePolicy(route.travelMode ?? "walk").speedMps;
}

const walkMps = getTravelModePolicy("walk").speedMps;

function travelSeconds(route: RouteOption): number {
  return route.totalTimeSec ?? route.distanceM / speedOf(route);
}

function directSunMeters(route: RouteOption): number {
  if (route.objective === "rain") {
    const exposure = route.exposure;
    if (exposure) return exposure.exposedDistanceM;
    return route.distanceM * (1 - (route.dryCoverage ?? 0));
  }
  return Math.max(0, route.distanceM * (1 - route.shadowCoverage));
}

function transitLegOf(route: RouteOption): RouteLeg | undefined {
  return route.legs?.find((leg) => leg.type === "transit");
}

export interface OutdoorExposure {
  /** Seconds walking, plus seconds waiting at a stop the app samples. */
  outdoorSec: number;
  /** Share of the answered outdoor seconds in shadow, 0–1. */
  shadow: number;
  /**
   * False when some of `outdoorSec` has no answer — a sampled stop whose sun
   * the field could not give. `shadow` then describes only the rest, and must
   * not be quoted as the trip's (#393).
   */
  known: boolean;
  /** Rain objective fields; absent on legacy sun calculations. */
  shelteredSec?: number;
  unknownSec?: number;
  objective?: "sun" | "rain";
}

/**
 * A transit trip's time in the open, and how much of it is shadowed.
 *
 * Seconds, not metres: a rider standing at a stop covers no distance and still
 * takes the sun, and `dose()` was always a function of minutes — distance was
 * only how a walk's minutes were obtained. A bus stop's sampled shadow is the
 * same kind of measurement as a walking leg's, so the two share one sum.
 *
 * All or nothing. An unanswered wait is not given the walk's shadow share: a
 * stop in full sun beside a shaded walk would then read as shade.
 *
 * The ride is not in here: it is behind glass or underground, and the card
 * states its track fact in words instead. Nor is a subway platform wait, which
 * #423 leaves unmodelled. See docs/notes/transit-headline-exposure.md.
 */
export function transitOutdoorExposure(legs: RouteLeg[], objective: "sun" | "rain" = "sun"): OutdoorExposure {
  const walkMps = getTravelModePolicy("walk").speedMps;
  let outdoorSec = 0;
  let answeredSec = 0;
  let shadowSec = 0;
  for (const leg of legs) {
    const sec =
      leg.type === "walk" ? (leg.distanceM ?? 0) / walkMps : leg.waitExposure ? (leg.waitSec ?? 0) : 0;
    const shadow = objective === "rain"
      ? leg.type === "walk"
        ? leg.shelterCoverage ?? leg.exposure?.shelteredDistancePct
        : leg.waitExposure?.shelter
      : leg.type === "walk" ? leg.shadowCoverage : leg.waitExposure?.shadow;
    outdoorSec += sec;
    if (shadow == null) continue;
    answeredSec += sec;
    shadowSec += sec * shadow;
  }
  const result: OutdoorExposure = {
    outdoorSec,
    shadow: answeredSec > 0 ? shadowSec / answeredSec : 0,
    known: answeredSec >= outdoorSec,
  };
  if (objective === "rain") {
    result.objective = "rain";
    result.shelteredSec = shadowSec;
    result.unknownSec = Math.max(0, outdoorSec - answeredSec);
  }
  return result;
}

export interface TransitRainExposure {
  /** Outdoor access, egress, transfers and surface waits. */
  outdoorSec: number;
  shelteredOutdoorSec: number;
  unknownOutdoorSec: number;
  /** Enclosed vehicle riding time covered by the explicit assumption. */
  shelteredRideSec: number;
  unknownRideSec: number;
  totalSec: number;
  wholeTripKnown: boolean;
}

/**
 * Rain accounting for a transit journey. Vehicle time is included only when a
 * leg explicitly opts into the enclosed-vehicle assumption; unmodelled platform
 * waits and unsupported vehicles remain unknown.
 */
export function transitRainExposure(legs: RouteLeg[]): TransitRainExposure {
  let outdoorSec = 0;
  let shelteredOutdoorSec = 0;
  let unknownOutdoorSec = 0;
  let shelteredRideSec = 0;
  let unknownRideSec = 0;
  let totalSec = 0;
  for (const leg of legs) {
    if (leg.type === "walk") {
      const sec = Math.max(0, leg.distanceM ?? 0) / walkMps;
      outdoorSec += sec;
      totalSec += sec;
      const protection = leg.shelterCoverage ?? leg.exposure?.shelteredDistancePct;
      if (protection == null) unknownOutdoorSec += sec;
      else shelteredOutdoorSec += sec * Math.max(0, Math.min(1, protection));
      continue;
    }
    const rideSec = Math.max(0, (leg.travelTimeSec ?? 0) - (leg.waitSec ?? 0));
    const waitSec = Math.max(0, leg.waitSec ?? 0);
    totalSec += rideSec + waitSec;
    if (leg.vehicleSheltered === true) shelteredRideSec += rideSec;
    else unknownRideSec += rideSec;
    if (waitSec > 0) {
      outdoorSec += waitSec;
      const protection = leg.waitExposure?.shelter;
      if (protection == null || (leg.waitExposure?.coverage ?? 0) < 0.6) unknownOutdoorSec += waitSec;
      else shelteredOutdoorSec += waitSec * Math.max(0, Math.min(1, protection));
    }
  }
  return {
    outdoorSec,
    shelteredOutdoorSec,
    unknownOutdoorSec,
    shelteredRideSec,
    unknownRideSec,
    totalSec,
    wholeTripKnown: unknownOutdoorSec <= 0 && unknownRideSec <= 0,
  };
}

/** Full duration-aware rain metrics for a transit result, including the ride. */
export function transitRainMetrics(
  legs: RouteLeg[],
  evaluatedContext?: import("./exposure").ResolvedExposureContext,
): ExposureMetrics {
  const segments = [] as Array<{
    distanceM: number;
    durationSec: number;
    protection?: number;
    confidence?: number;
    provenance?: string;
  }>;
  for (const leg of legs) {
    if (leg.type === "walk") {
      const distanceM = Math.max(0, leg.distanceM ?? 0);
      segments.push({
        distanceM,
        durationSec: distanceM / walkMps,
        protection: leg.shelterCoverage ?? leg.exposure?.shelteredDistancePct ?? undefined,
        confidence: leg.shelterCoverage == null
          ? 0
          : (leg.exposure?.unknownDistanceM ? 0 : 1),
        provenance: "geometry",
      });
      continue;
    }
    const waitSec = Math.max(0, leg.waitSec ?? 0);
    const rideSec = Math.max(0, (leg.travelTimeSec ?? 0) - waitSec);
    if (waitSec > 0) {
      segments.push({
        distanceM: 0,
        durationSec: waitSec,
        protection: leg.waitExposure?.shelter,
        confidence: leg.waitExposure?.shelter == null ? 0 : (leg.waitExposure.coverage ?? 0),
        provenance: "geometry",
      });
    }
    segments.push({
      distanceM: 0,
      durationSec: rideSec,
      protection: leg.vehicleSheltered === true ? 1 : undefined,
      confidence: leg.vehicleSheltered === true ? 1 : 0,
      provenance: leg.vehicleSheltered === true ? "vehicle-assumption" : "unknown",
    });
  }
  return computeExposureMetrics("rain", segments, evaluatedContext);
}

/**
 * The trip split into sunlit and shadowed minutes at the route's own mode speed.
 *
 * Shadowed minutes are not idle time for a UV model — see `app/lib/heat/dose.ts` —
 * so both halves are reported rather than only the exposed one.
 *
 * A transit trip counts its time outdoors instead (`transitOutdoorExposure`),
 * and is `null` when any of that time has no answer.
 */
export function routeExposureMinutes(route: RouteOption): {
  sunMinutes: number;
  shadowMinutes: number;
} | null {
  if (route.legs && transitLegOf(route)) {
    const objective = route.objective ?? "sun";
    if (objective === "rain") {
      const rain = transitRainExposure(route.legs);
      if (!rain.wholeTripKnown) return null;
      return {
        sunMinutes: Math.max(0, rain.totalSec - rain.shelteredOutdoorSec - rain.shelteredRideSec) / 60,
        shadowMinutes: (rain.shelteredOutdoorSec + rain.shelteredRideSec) / 60,
      };
    }
    const { outdoorSec, shadow, known } = transitOutdoorExposure(route.legs);
    if (!known) return null;
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

/**
 * The card's time verdict — total trip duration at the route's own mode speed
 * (`totalTimeSec` on a transit trip, else distance ÷ fixed mode pace).
 *
 * The same conversion `routeTradeoffLine` already makes; given the headline
 * spot it needs its own name. The pace it assumes is stated beside it
 * (`RouteCard`'s caption line), never left implicit.
 */
export function routeDurationLabel(route: RouteOption): string {
  const minutes = Math.max(1, Math.round(travelSeconds(route) / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

function formatDeltaMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes <= 0) return "same time";
  return `+${minutes} min`;
}

export function routeTradeoffLine(route: RouteOption, baseline: RouteOption): string {
  if (route.objective === "rain" || baseline.objective === "rain") {
    return rainTradeoffLine(route, baseline);
  }
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
  if (route.objective === "rain") {
    const protection = route.exposure?.shelteredDistancePct ?? route.dryCoverage;
    return protection == null ? "shelter unknown" : `${Math.round(protection * 100)}% sheltered`;
  }
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
    ? "walk and stop wait only; ride not counted"
    : "walk only; wait and ride not counted";
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
  if (!exposure) return route.objective === "rain" ? "rain exposure unknown" : "time in sun unknown";
  if (route.objective === "rain") {
    const total = `${formatSunMinutes(exposure.sunMinutes)} rain-exposed`;
    const stretchM = route.longestContinuousWetM ?? 0;
    if (stretchM <= 0) return total;
    return `${total} · longest stretch ${formatSunMinutes(stretchM / speedOf(route) / 60)}`;
  }
  const total = `${formatSunMinutes(exposure.sunMinutes)} in sun`;
  if (route.longestContinuousSunM <= 0) return total;
  return `${total} · longest stretch ${formatSunMinutes(route.longestContinuousSunM / speedOf(route) / 60)}`;
}

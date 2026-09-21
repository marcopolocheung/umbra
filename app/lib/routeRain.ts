/**
 * Rain-mode reporting for a walk route — the rain twin of `routeTradeoff.ts`.
 *
 * Rain exposure is reported as the unscaled time spent exposed to the assumed
 * rain. It is deliberately independent of precipitation intensity: this feature
 * models shelter geometry, not whether a storm occurs.
 */

import type { RouteOption } from "./routing";
import { getTravelModePolicy } from "./travelMode";

function speedOf(route: RouteOption): number {
  return getTravelModePolicy(route.travelMode ?? "walk").speedMps;
}

function travelSeconds(route: RouteOption): number {
  return route.totalTimeSec ?? route.distanceM / speedOf(route);
}

/** The share of route distance the shelter field did not block, 0–1. */
export function wetShare(route: RouteOption): number {
  if (route.exposure?.objective === "rain" && route.exposure.exposedDistanceM + route.exposure.shelteredDistanceM > 0) {
    return route.exposure.exposedDistanceM /
      (route.exposure.exposedDistanceM + route.exposure.shelteredDistanceM);
  }
  return Math.max(0, Math.min(1, 1 - (route.dryCoverage ?? 0)));
}

/** Unscaled minutes spent exposed to the assumed rain. */
export function rainWeightedMinutes(route: RouteOption, _legacyIntensity?: number): number {
  return (travelSeconds(route) / 60) * wetShare(route);
}

function formatMinutes(m: number): string {
  if (m < 1) return "under a minute";
  return `${Math.max(1, Math.round(m))} min`;
}

/**
 * One line for a card: unscaled exposure, plus the worst single
 * unbroken wet stretch when the route's shelter was sampled per edge.
 */
export function rainExposureLine(route: RouteOption, _legacyIntensity?: number): string {
  if (route.exposure?.objective === "rain" && route.exposure.unknownDurationSec > 0) {
    const known = route.exposure.exposedDurationSec / 60;
    return known > 0
      ? `${formatMinutes(known)} rain-exposed · some shelter unknown`
      : "rain exposure unknown";
  }
  const total = `${formatMinutes(rainWeightedMinutes(route))} rain-exposed`;
  const stretchM = route.longestContinuousWetM ?? 0;
  if (stretchM <= 0) return total;
  const stretchMin = stretchM / speedOf(route) / 60;
  return `${total} · longest stretch ${formatMinutes(stretchMin)}`;
}

/**
 * The selected-vs-baseline comparison: time added, and how wet exposure moved.
 *
 * Mirrors `routeTradeoffLine`: the first clause is what a detour costs, the second
 * what the detour is buying.
 */
export function rainTradeoffLine(route: RouteOption, baseline: RouteOption): string {
  const shelteredPct = route.exposure?.shelteredDistancePct ?? route.dryCoverage;
  if (route === baseline) {
    return shelteredPct == null
      ? "shelter unknown"
      : `${Math.round(shelteredPct * 100)}% sheltered`;
  }
  const timeDeltaSec = Math.max(0, travelSeconds(route) - travelSeconds(baseline));
  const baselineWet = baseline.distanceM * wetShare(baseline);
  const routeWet = route.distanceM * wetShare(route);
  const wetDeltaPct = baselineWet > 0
    ? Math.round(((routeWet - baselineWet) / baselineWet) * 100)
    : 0;
  const wetLabel =
    wetDeltaPct < 0
      ? `${wetDeltaPct}% wet exposure`
      : wetDeltaPct > 0
        ? `+${wetDeltaPct}% wet exposure`
        : "same wet exposure";
  const unknown = (route.exposure?.unknownDistanceM ?? 0) > 0 || (baseline.exposure?.unknownDistanceM ?? 0) > 0;
  return `${timeDeltaSec <= 0 ? "same time" : `+${Math.round(timeDeltaSec / 60)} min`}, ${unknown ? "shelter comparison partly unknown" : wetLabel}`;
}

/** The user-facing sheltered-distance percentage a rain card prints. */
export function rainDryPct(route: RouteOption): number {
  const exposure = route.exposure;
  if (exposure?.objective === "rain" && exposure.shelteredDistancePct != null) {
    return Math.round(exposure.shelteredDistancePct * 100);
  }
  return Math.round((route.dryCoverage ?? 0) * 100);
}

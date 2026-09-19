/**
 * Rain-mode reporting for a walk route — the rain twin of `routeTradeoff.ts`.
 *
 * Everything here is an *ordinal* exposure number: intensity comes from a 0–10
 * user slider, not a mm/h measurement, and the method note (`docs/notes/rain-model.md`)
 * is the only place that speaks in physical units. Weighting exposed minutes by
 * `intensity01` is a display scaling that never reorders routes — route choice is
 * decided by sheltered metres, and a uniform multiplier cannot change it.
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
  return Math.max(0, Math.min(1, 1 - (route.dryCoverage ?? 0)));
}

/**
 * Exposed minutes weighted by the intensity slider: 10 doubles nothing, 0 halves
 * everything — the number says "how much rain this trip is worth at this setting".
 */
export function rainWeightedMinutes(route: RouteOption, intensity: number): number {
  const intensity01 = Math.max(0, Math.min(1, intensity / 10));
  return (travelSeconds(route) / 60) * wetShare(route) * intensity01;
}

function formatMinutes(m: number): string {
  if (m < 1) return "under a minute";
  return `${Math.max(1, Math.round(m))} min`;
}

/**
 * One line for a card: exposure at the chosen intensity, plus the worst single
 * unbroken wet stretch when the route's shelter was sampled per edge.
 */
export function rainExposureLine(route: RouteOption, intensity: number): string {
  const total = `${formatMinutes(rainWeightedMinutes(route, intensity))} wet`;
  const stretchM = route.longestContinuousWetM ?? 0;
  if (stretchM <= 0) return total;
  const stretchMin = (stretchM / speedOf(route) / 60) * Math.max(0, Math.min(1, intensity / 10));
  return `${total} · longest stretch ${formatMinutes(stretchMin)}`;
}

/**
 * The selected-vs-baseline comparison: time added, and how wet exposure moved.
 *
 * Mirrors `routeTradeoffLine`: the first clause is what a detour costs, the second
 * what the detour is buying.
 */
export function rainTradeoffLine(route: RouteOption, baseline: RouteOption): string {
  if (route === baseline) {
    return `${Math.round((route.dryCoverage ?? 0) * 100)}% dry`;
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
  return `${timeDeltaSec <= 0 ? "same time" : `+${Math.round(timeDeltaSec / 60)} min`}, ${wetLabel}`;
}

/** The user-facing dry-coverage percentage a rain card prints. */
export function rainDryPct(route: RouteOption): number {
  return Math.round((route.dryCoverage ?? 0) * 100);
}

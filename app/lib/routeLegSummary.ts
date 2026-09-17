import type { RouteLeg } from "./routing";
import { getTravelModePolicy } from "./travelMode";
import type { TravelModeId } from "./travelMode";

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatMinutes(sec: number): string {
  return `${Math.max(1, Math.ceil(sec / 60))} min`;
}

/**
 * How much of a transit leg the sun figure is actually based on.
 *
 * `coverage` is the share of riding time the published per-segment structure
 * determined (#393). `undefined` means nothing was measured at all and the
 * number is `TRAIN_SUN_EXPOSURE[mode]` — a constant per *mode*, which prices
 * every subway line at 0.0 and so calls the elevated 7, J/M/Z and much of the
 * outer boroughs shaded when they are in full sun. Below this floor the ride is
 * mostly unseen and the honest thing is to report the coverage rather than a
 * percentage of it.
 */
const MIN_REPORTABLE_COVERAGE = 0.6;

function sunPercent(sunExposure: number): number {
  return Math.round(sunExposure * 100);
}

/**
 * The leg line's sun phrase, or `null` when there is nothing honest to say.
 *
 * Three cases, and they read differently on purpose:
 * - **measured, good coverage** — a percentage of the ride, stated plainly;
 * - **measured, thin coverage** — how much of the ride is known, not a figure
 *   derived from the sliver that is;
 * - **not measured** — the old per-mode assumption, still named as one.
 */
export function transitSunLabel(
  sunExposure: number | undefined,
  coverage?: number,
  aboveGroundShare?: number,
): string | null {
  if (sunExposure == null) return null;
  if (coverage == null) {
    // Unmeasured: the per-mode constant, named as the assumption it is.
    if (sunExposure < 0.05) return "assumed underground";
    if (sunExposure < 0.2) return "assumed mostly shadowed";
    return "assumed some sun";
  }
  if (coverage < MIN_REPORTABLE_COVERAGE) {
    return `track known for ${sunPercent(coverage)}% of the ride`;
  }
  const above = aboveGroundShare ?? 0;
  if (above < 0.05) return "underground";
  // The track fact, not the rider's dose: it is what a passenger can check by
  // looking out of the window, and it does not silently equate a seat on a
  // viaduct with standing on a pavement.
  return `${sunPercent(above)}% above ground`;
}

/** The same judgement, worded for a route card rather than a leg line. */
export function transitSunCardLabel(
  sunExposure: number | undefined,
  coverage?: number,
  aboveGroundShare?: number,
): string {
  if (sunExposure == null) return "Assumed underground";
  if (coverage == null) {
    if (sunExposure >= 0.2) return "Some sun exposure";
    if (sunExposure >= 0.05) return "Mostly shadowed";
    return "Assumed underground";
  }
  if (coverage < MIN_REPORTABLE_COVERAGE) return "Track mostly unknown";
  const above = aboveGroundShare ?? 0;
  if (above < 0.05) return "Underground";
  return `${sunPercent(above)}% above ground`;
}

/**
 * Why the label is what it is, for a tooltip. The measured wording is not a
 * caveat about modelling — it names the source and the sampling, because that
 * is what a reader needs to judge it.
 */
export function transitSunCaveat(coverage?: number): string {
  if (coverage == null) return TRANSIT_SUN_CAVEAT_ASSUMED;
  return `Track structure joined from OpenStreetMap and sampled along each stop-to-stop segment; ${sunPercent(coverage)}% of the ride is determined. Only a tunnel counts as enclosed — an open cut or an embankment is open to the sky. A rider behind glass takes about a quarter of a pedestrian\u2019s sun, so exposure is scaled accordingly.`;
}

/**
 * Which way the label reads, so the two cards cannot drift apart.
 *
 * `RouteCard` and `NavigationPanel` duplicated an identical threshold before
 * coverage existed, and adding a fourth state to one and not the other is the
 * same defect twice. The *judgement* lives here; each card keeps its own
 * palette, because one paints hex on a light surface and the other Tailwind
 * classes on a dark one.
 */
export type TransitSunTone = "enclosed" | "shaded" | "sunny" | "unknown";

export function transitSunTone(
  sunExposure: number | undefined,
  coverage?: number,
  aboveGroundShare?: number,
): TransitSunTone {
  if (sunExposure == null) return "enclosed";
  if (coverage != null && coverage < MIN_REPORTABLE_COVERAGE) return "unknown";
  // Measured: judge on the track fact, whose full 0-1 range the thresholds were
  // written for. The attenuated dose tops out at RAIL_VEHICLE_EXPOSURE and
  // would push every ride into "enclosed".
  const value = coverage != null ? (aboveGroundShare ?? 0) : sunExposure;
  if (value < 0.05) return "enclosed";
  if (value < 0.2) return "shaded";
  return "sunny";
}

/** Retained for the unmeasured case, which is still a model assumption. */
export const TRANSIT_SUN_CAVEAT_ASSUMED =
  "Estimated from the line's mode, not measured along this segment — elevated track is not modelled.";

export interface RouteLegSummary {
  title: string;
  detail: string;
}

export function routeLegSummary(
  leg: RouteLeg,
  index: number,
  travelMode: TravelModeId = "walk",
): RouteLegSummary {
  if (leg.type === "transit") {
    const line = leg.lineName || leg.line || "Transit";
    const stopCount = leg.stops ? Math.max(0, leg.stops.length - 1) : null;
    const parts = [
      leg.travelTimeSec != null ? formatMinutes(leg.travelTimeSec) : null,
      // Named rather than folded in silently: the quoted time now includes the
      // platform, and half a published median headway is an expectation for an
      // unsynchronised arrival, not a prediction of this train — hence the "~".
      leg.waitSec ? `incl. ~${formatMinutes(leg.waitSec)} wait` : null,
      stopCount != null ? `${stopCount} stop${stopCount === 1 ? "" : "s"}` : null,
      transitSunLabel(leg.sunExposure, leg.sunExposureCoverage, leg.aboveGroundShare),
    ].filter(Boolean);

    return {
      title: `Leg ${index + 1}: ${line}`,
      detail: parts.length > 0 ? parts.join(" - ") : "Transit segment",
    };
  }

  const parts = [
    leg.distanceM != null ? formatDist(leg.distanceM) : null,
    leg.shadowCoverage != null ? `${Math.round(leg.shadowCoverage * 100)}% shadow` : null,
  ].filter(Boolean);

  // `type` stays "walk" for active-travel legs (E6 generalizes it); the label
  // follows the route's mode policy so new modes never read as walking.
  const modeLabel = getTravelModePolicy(travelMode).label;
  if (parts.length > 0) {
    return {
      title: `Leg ${index + 1}: ${modeLabel}`,
      detail: parts.join(" - "),
    };
  }
  // No distance or shadow to report (e.g. an unsampled connector): fall back to
  // the mode's gerund — "Bike" + "ing" would read "Bikeing".
  const gerund = getTravelModePolicy(travelMode).gerund;
  const segment = `${gerund.charAt(0).toUpperCase()}${gerund.slice(1)} segment`;
  return {
    title: `Leg ${index + 1}: ${modeLabel}`,
    detail: segment,
  };
}

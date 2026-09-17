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
 * Why "assumed": a transit leg's `sunExposure` is `TRAIN_SUN_EXPOSURE[mode]`, a
 * constant per *mode*, not a measurement of the track this leg actually runs
 * on. Every subway line therefore prices at 0.0, and NYC's elevated lines — the
 * 7 through Queens, the J/M/Z, much of the outer boroughs — are in full sun.
 * Stating "underground" as fact is a claim the data cannot support; naming it as
 * a model assumption is what it is until exposure is a property of a segment
 * rather than a mode (#393).
 */
export function transitSunLabel(sunExposure: number | undefined): string | null {
  if (sunExposure == null) return null;
  if (sunExposure < 0.05) return "assumed underground";
  if (sunExposure < 0.2) return "mostly shadowed";
  return "some sun";
}

/** The same judgement, worded for a route card rather than a leg line. */
export function transitSunCardLabel(sunExposure: number | undefined): string {
  if (sunExposure != null && sunExposure >= 0.2) return "Some sun exposure";
  if (sunExposure != null && sunExposure >= 0.05) return "Mostly shadowed";
  return "Assumed underground";
}

/** Why that label is an assumption, for a tooltip. */
export const TRANSIT_SUN_CAVEAT =
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
      transitSunLabel(leg.sunExposure),
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

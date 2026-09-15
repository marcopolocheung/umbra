import type { RouteLeg } from "./routing";
import { getTravelModePolicy } from "./travelMode";
import type { TravelModeId } from "./travelMode";

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatMinutes(sec: number): string {
  return `${Math.max(1, Math.ceil(sec / 60))} min`;
}

function transitSunLabel(sunExposure: number | undefined): string | null {
  if (sunExposure == null) return null;
  if (sunExposure < 0.05) return "underground";
  if (sunExposure < 0.2) return "mostly shadowed";
  return "some sun";
}

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
  // follows the route's mode so bike legs don't read as walking.
  const modeLabel = travelMode === "bike" ? "Bike" : "Walk";
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

/**
 * What the rain mode claims about the selected route — the rain twin of
 * `RouteConditionsLine`, with the same one-badge-one-link honesty discipline.
 *
 * Renders the shelter figure only when the rain field priced this route. Missing
 * measurements remain unknown instead of being presented as exposed time.
 */

import { rainDirectionFromWind, windFromLabel } from "../lib/rain/direction";
import { rainExposureLine } from "../lib/routeRain";
import type { RouteOption } from "../lib/routing";

const METHOD_URL =
  "https://github.com/marcopolocheung/umbra/blob/main/docs/notes/rain-model.md";

interface RainRouteSummaryProps {
  route: RouteOption;
  /** Kept optional for saved-record compatibility; no intensity scaling occurs. */
  rainIntensity?: number;
  /** Wind the last rain calculation priced, or null when none was known. */
  wind?: { dirDeg: number | null; windMs: number | null } | null;
}

/**
 * One line the card can state about the wind the calculation actually used:
 * from-bearing, speed, and the resulting ray tilt. Absent wind means the
 * vertical (v0) ray priced the route — which the copy below already admits.
 */
function windLine(wind: RainRouteSummaryProps["wind"]): string | null {
  if (!wind || wind.dirDeg == null || wind.windMs == null) return null;
  const direction = rainDirectionFromWind(wind.dirDeg, wind.windMs);
  const kmh = Math.round(wind.windMs * 3.6);
  return `wind from ${windFromLabel(wind.dirDeg)} at ${kmh} km/h — shelter tilted ${Math.round(direction.altitudeDeg)}° from horizontal`;
}

export default function RainRouteSummary({ route, wind = null }: RainRouteSummaryProps) {
  if (route.objective !== "rain" && route.dryCoverage === undefined) return null;
  const windText = windLine(wind);
  const unknown = (route.exposure?.unknownDistanceM ?? 0) > 0 || (route.exposure?.unknownDurationSec ?? 0) > 0;
  const sheltered = route.exposure?.shelteredDistancePct ?? (route.dryCoverage ?? null);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-1.5">
        <span
          className="text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-full"
          style={{ background: "color-mix(in srgb, var(--color-ink) 14%, transparent)", color: "var(--color-ink-muted)" }}
        >
          Rain shelter
        </span>
        <span className="text-xs font-semibold" style={{ color: "var(--color-ink)" }}>
          {sheltered == null || unknown ? "Shelter unknown" : `${Math.round(sheltered * 100)}% sheltered`} · {rainExposureLine(route)}
        </span>
      </div>
      <div className="text-xs leading-snug" style={{ color: "var(--color-ink-muted)" }}>
        {windText ?? "Wind unavailable — shelter priced as vertical rain."} Rain is
        assumed; this figure describes shelter geometry rather than precipitation.
        {unknown ? " Some route time has no shelter measurement." : ""}
      </div>
      <a
        href={METHOD_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="How rain shelter is estimated (opens in a new tab)"
        className="inline-flex min-h-11 items-center self-start text-xs underline underline-offset-2"
        style={{ color: "var(--color-ink-muted)" }}
      >
        How this is estimated
      </a>
    </div>
  );
}

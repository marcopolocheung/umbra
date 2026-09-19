/**
 * What the rain mode claims about the selected route — the rain twin of
 * `RouteConditionsLine`, with the same one-badge-one-link honesty discipline.
 *
 * Renders nothing for routes the rain field never priced (sketch and transit
 * routes keep their sun cards). The figure is ordinal: "wet min" is exposed time
 * weighted by the intensity slider, and the method link is where that sentence
 * lives in full.
 */

import { rainDirectionFromWind, windFromLabel } from "../lib/rain/direction";
import { rainDryPct, rainExposureLine } from "../lib/routeRain";
import type { RouteOption } from "../lib/routing";

const METHOD_URL =
  "https://github.com/marcopolocheung/shademapnav/blob/main/docs/notes/rain-model.md";

interface RainRouteSummaryProps {
  route: RouteOption;
  /** 0–10 user intensity setting. */
  rainIntensity: number;
  /** Wind the last rain calculation priced, or null when none was known. */
  wind?: { dirDeg: number | null; windMs: number | null } | null;
}

/**
 * One line the card can state about the wind the calculation actually used:
 * from-bearing, speed, and the resulting ray tilt. Absent wind means the
 * vertical (v0) ray priced the route — which the copy below already admits.
 */
function windLine(wind: RainRouteSummaryProps["wind"]): string | null {
  if (!wind?.dirDeg || wind.windMs == null) return null;
  const direction = rainDirectionFromWind(wind.dirDeg, wind.windMs);
  const kmh = Math.round(wind.windMs * 3.6);
  return `wind from ${windFromLabel(wind.dirDeg)} at ${kmh} km/h — shelter tilted ${Math.round(direction.altitudeDeg)}° from horizontal`;
}

export default function RainRouteSummary({ route, rainIntensity, wind = null }: RainRouteSummaryProps) {
  if (route.dryCoverage === undefined) return null;
  const windText = windLine(wind);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-1.5">
        <span
          className="text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-full"
          style={{ background: "rgba(100,116,139,0.14)", color: "var(--md-on-surface-variant)" }}
        >
          Experimental
        </span>
        <span className="text-xs font-semibold" style={{ color: "var(--md-on-surface)" }}>
          {rainDryPct(route)}% covered · {rainExposureLine(route, rainIntensity)}
        </span>
      </div>
      <div className="text-xs leading-snug" style={{ color: "var(--md-on-surface-variant)" }}>
        {windText ?? "No wind forecast — shelter priced as vertical rain."} Wind is
        reported above street level and treated as a prior. Numbers are ordinal at your
        intensity setting.
      </div>
      <a
        href={METHOD_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="How rain shelter is estimated (opens in a new tab)"
        className="inline-flex min-h-11 items-center self-start text-xs underline underline-offset-2"
        style={{ color: "var(--md-on-surface-variant)" }}
      >
        How this is estimated
      </a>
    </div>
  );
}

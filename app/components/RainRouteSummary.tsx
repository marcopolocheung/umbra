/**
 * What the rain mode claims about the selected route — the rain twin of
 * `RouteConditionsLine`, with the same one-badge-one-link honesty discipline.
 *
 * Renders nothing for routes the rain field never priced (sketch and transit
 * routes keep their sun cards). The figure is ordinal: "wet min" is exposed time
 * weighted by the intensity slider, and the method link is where that sentence
 * lives in full.
 */

import { rainDryPct, rainExposureLine } from "../lib/routeRain";
import type { RouteOption } from "../lib/routing";

const METHOD_URL =
  "https://github.com/marcopolocheung/shademapnav/blob/main/docs/notes/rain-model.md";

interface RainRouteSummaryProps {
  route: RouteOption;
  /** 0–10 user intensity setting. */
  rainIntensity: number;
}

export default function RainRouteSummary({ route, rainIntensity }: RainRouteSummaryProps) {
  if (route.dryCoverage === undefined) return null;

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
        Rain shelter assumes vertical rain and says so where it is unsure. Numbers are
        ordinal at your intensity setting.
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

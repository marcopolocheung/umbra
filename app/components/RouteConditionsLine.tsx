import { dose } from "../lib/heat/dose";
import { heatBand, heatScore } from "../lib/heat/score";
import type { WeatherHour } from "../lib/heat/types";
import { routeExposureMinutes } from "../lib/routeTradeoff";
import type { RouteOption } from "../lib/routing";
import { getTravelModePolicy } from "../lib/travelMode";

const METHOD_URL =
  "https://github.com/marcopolocheung/shademapnav/blob/main/docs/notes/heat-model.md";

/** "under a minute", "5 min", "4–5 min" — one unit on the end, not two. */
export function formatMinuteRange(low: number, high: number): string {
  if (high < 1) return "under a minute";
  const lo = Math.round(low);
  const hi = Math.round(high);
  if (lo === hi) return `${hi} min`;
  // A low end that rounds to zero is still a real duration; "under 1–1 min" is not
  // a range, so the bound that survives is the one the reader can act on.
  if (lo < 1) return `up to ${hi} min`;
  return `${lo}–${hi} min`;
}

interface RouteConditionsLineProps {
  route: RouteOption;
  /** The shortest route, for comparison. Omitted when it is the selected one. */
  baselineRoute?: RouteOption;
  /** The forecast hour at the map's location, or null when none is available. */
  weather: WeatherHour | null;
}

/**
 * What the weather does to this trip: how hard it feels, and how much sun it costs.
 *
 * These are **two different questions** — an intensity and a dose — and they were
 * briefly two separate cards, which read as the app contradicting itself: "strong heat
 * stress" stacked above a benign "about 4–5 min of full sun", each with its own
 * `Experimental` badge and its own near-identical method link. One heading is what
 * makes them legible as two facets of one estimate rather than two verdicts.
 *
 * Ordering is not cosmetic. The heat score is computed per route and rendered
 * comparatively ("Heat 66 vs 71"), so it is the number that discriminates between the
 * options directly below; the dose describes the trip and barely differs between two
 * routes to the same place. The panel exists to help someone choose, so the figure that
 * moves with the choice leads.
 *
 * One badge, deliberately. The `Experimental` mark is here because these are
 * health-adjacent estimates, and a second copy forty pixels away is what turns the
 * first into page furniture.
 */
export default function RouteConditionsLine({
  route,
  baselineRoute,
  weather,
}: RouteConditionsLineProps) {
  const exposure = routeExposureMinutes(route);
  const selected = heatScore(exposure, weather);
  const baseline =
    baselineRoute && baselineRoute !== route ? heatScore(routeExposureMinutes(baselineRoute), weather) : null;

  // Null when the UV index is unknown: an absent forecast is not a safe trip.
  const uv = dose(exposure, weather?.uvIndex ?? null);

  const scored = selected.mode === "felt-temperature";
  const feltC = Math.round(selected.feltC ?? 0);
  const policy = getTravelModePolicy(route.travelMode ?? "walk");

  const headline = scored ? heatBand(selected.score) : `${selected.score}% of this ${policy.journeyNoun} is in sun`;

  // The heat model estimates felt temperature while walking (heat/score.ts) —
  // cycling airflow is unmodeled (#349) — so a bike route must not label the
  // number a cycling estimate. It states its basis instead.
  const feelsLike =
    policy.id === "walk"
      ? `feels about ${feltC} °C walking this`
      : `feels about ${feltC} °C on this ${policy.journeyNoun} (walking-pace estimate)`;

  // Three rungs, three sentences. The middle one exists because a dry-bulb estimate
  // and an apparent-temperature one otherwise render identically, and the difference
  // is humidity and wind being absent from the number entirely.
  const detail = !scored
    ? "no weather forecast — heat not scored"
    : selected.inputs.ambientIsApparent
      ? feelsLike
      : `about ${feltC} °C — air temperature only`;

  const secondary = scored
    ? `${baseline ? `Heat ${selected.score} vs ${baseline.score}` : `Heat ${selected.score}`} · ${detail}`
    : detail;

  return (
    // `aria-live="off"` overrides the polite region on the card above. The forecast
    // hour changes every ~1.5 s while the timeline is playing, and a live heat score
    // at that cadence is announcement spam rather than information.
    <div aria-live="off" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-1.5">
        <span
          className="text-[10px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-full"
          style={{ background: "rgba(100,116,139,0.14)", color: "var(--md-on-surface-variant)" }}
        >
          Experimental
        </span>
        {weather?.uvIndex != null && (
          <span
            className="text-[10px] uppercase tracking-widest font-bold"
            style={{ color: "var(--md-on-surface-variant)" }}
          >
            UV {weather.uvIndex.toFixed(1)}
          </span>
        )}
        <span className="text-xs font-semibold" style={{ color: "var(--md-on-surface)" }}>
          {headline}
        </span>
      </div>

      <div className="text-xs leading-snug" style={{ color: "var(--md-on-surface-variant)" }}>
        {secondary}
        {/* Sighted readers get the antecedent from the "Shortest baseline" line two
            rows up; a screen reader hears two bare numbers with no direction. */}
        {scored && (
          <span className="sr-only">
            {baseline
              ? " Higher is hotter; the second number is the shortest route."
              : " out of 100. Higher is hotter."}
          </span>
        )}
      </div>

      {uv && (
        <div className="text-xs leading-snug" style={{ color: "var(--md-on-surface-variant)" }}>
          About{" "}
          {formatMinuteRange(uv.fullSunEquivalentMinutes.low, uv.fullSunEquivalentMinutes.high)} of
          full sun ({uv.sed.low.toFixed(1)}–{uv.sed.high.toFixed(1)} SED) · shadow counts toward
          this — it blocks the direct beam, not the diffuse sky.
        </div>
      )}

      <a
        href={METHOD_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="How these estimates are calculated (opens in a new tab)"
        className="inline-flex min-h-11 items-center self-start text-xs underline underline-offset-2"
        style={{ color: "var(--md-on-surface-variant)" }}
      >
        How these are estimated
      </a>
    </div>
  );
}

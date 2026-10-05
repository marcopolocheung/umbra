import { useRef } from "react";
import type { HourlyExposure } from "../hooks/useHourlyExposure";

interface HourlyExposureStripProps {
  exposure: HourlyExposure;
  /** Map-local hour currently on the timeline, so the strip can mark it. */
  currentHour: number;
  onPickHour: (when: Date) => void;
}

/** The five-step ramp step (1–5) for a 0–1 share, by fifths. */
export function rampStep(share: number): number {
  return Math.min(5, Math.max(1, Math.floor(share * 5) + 1));
}

/** 12-hour numeral for a board key; the meridiem row says AM or PM. */
function hourKey(hour: number): string {
  return String(hour % 12 || 12);
}

/**
 * Shadow on this route, hour by hour — the "when should I go?" answer — as a
 * departures board: an ink header row, one ruled column per hour with a mono
 * key under a 2px ink rule, and the hour on the timeline as an ink ticket.
 *
 * Bars are drawn as *sun*, not shadow: the thing being avoided is the thing worth
 * seeing, and a short bar reading as a good hour matches how the rest of the app
 * talks about exposure. Each bar is a step of the sun (or rain) ramp by its share,
 * keylined in ink so a pale step still holds against the panel. Hours without a
 * reading (still sampling, or none came back) show a dash rather than a zero the
 * field never measured.
 *
 * Nothing is sampled until the header is tapped (see `useHourlyExposure`): each hour
 * is a building-shadow sweep on the main thread, and running the day unasked stalled
 * the map right after a route landed.
 */
export default function HourlyExposureStrip({
  exposure,
  currentHour,
  onPickHour,
}: HourlyExposureStripProps) {
  const { samples, readyCount, best, requested, request } = exposure;
  const hoursRef = useRef<HTMLFieldSetElement>(null);
  if (samples.length === 0) return null;
  const rain = samples[0].objective === "rain";
  const checking = requested && readyCount < samples.length;
  const anyUnsampled = requested && !checking && samples.some((sample) => sample.available === false);

  return (
    <div className="border-2" style={{ background: "var(--color-panel)", borderColor: "var(--color-ink)" }}>
      {/* One 44px header in both states, so the card does not jump when the hours
          arrive. Before the day is asked for, the whole header is the button —
          the app is used one-handed, outdoors. The status line is one live region
          that stays mounted, so "checking…" is announced when it appears. */}
      <div
        className="relative flex min-h-11 items-center justify-between gap-2 px-2 py-1"
        style={{ background: "var(--color-ink)", color: "var(--color-on-ink)", fontSize: "var(--text-caption)" }}
      >
        <span
          className="font-extrabold uppercase tracking-wider"
          style={{ fontFamily: "var(--font-label)" }}
        >
          {rain ? "Rain shelter by hour" : "Sun by hour"}
        </span>
        {!requested && (
          <button
            type="button"
            onClick={() => {
              request();
              // The button is about to go; hand focus to the hours it asked for.
              requestAnimationFrame(() => hoursRef.current?.focus());
            }}
            aria-label={rain ? "Check rain shelter on this route by hour" : "Check sun on this route by hour"}
            className="absolute inset-0 flex items-center justify-end px-2 font-extrabold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
            style={{ fontFamily: "var(--font-label)" }}
          >
            check the day <span aria-hidden="true">&nbsp;›</span>
          </button>
        )}
        <span aria-live="polite" className="min-w-0 text-right" style={{ fontFamily: "var(--font-mono)" }}>
          {checking
            ? "checking…"
            : requested && best
              ? rain ? `most sheltered around ${best.label}` : `most shadowed around ${best.label}`
              : null}
        </span>
      </div>

      {requested && (
      <fieldset
        ref={hoursRef}
        tabIndex={-1}
        className="m-0 grid border-0 px-1.5 pt-1.5 pb-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        style={{ gridTemplateColumns: `repeat(${samples.length}, minmax(0, 1fr))` }}
      >
        <legend className="sr-only">{rain ? "Rain shelter by hour" : "Sun exposure by hour"}</legend>
        {samples.map((sample, i) => {
          const ready = i < readyCount && sample.available !== false;
          const sunPct = Math.round(sample.sunExposure * 100);
          const shelterPct = Math.round(sample.shadowCoverage * 100);
          const share = rain ? sample.shadowCoverage : sample.sunExposure;
          const isNow = sample.hour === currentHour;
          const meridiem = sample.hour < 12 ? "AM" : "PM";
          const prevMeridiem = i > 0 ? (samples[i - 1].hour < 12 ? "AM" : "PM") : null;
          return (
            <button
              key={sample.date.getTime()}
              type="button"
              onClick={() => onPickHour(sample.date)}
              disabled={!ready}
              // The whole column is the target: 44px of bar plus the key, of which
              // only the bar is inked — the app is used one-handed, outdoors.
              className="flex min-w-0 flex-col items-stretch focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
              aria-label={
                ready
                  ? rain
                    ? `${sample.label}: ${shelterPct}% sheltered. Set the timeline to ${sample.label}.`
                    : `${sample.label}: ${sunPct}% in sun. Set the timeline to ${sample.label}.`
                  : `${sample.label}: unavailable for recommendation`
              }
              aria-current={isNow ? "time" : undefined}
              title={ready ? `${sample.label} · ${rain ? `${shelterPct}% sheltered` : `${sunPct}% sun`}` : sample.label}
            >
              <span
                className="flex h-11 items-end justify-center border-b-2 px-0.5"
                style={{ borderColor: "var(--color-ink)" }}
              >
                {ready ? (
                  <span
                    data-testid="hour-bar"
                    className="w-full transition-[height] duration-200 motion-reduce:transition-none"
                    style={{
                      // A fully shadowed hour still gets a sliver, so the bar reads as a
                      // measurement rather than a gap in the data.
                      height: `${Math.max(6, share * 100)}%`,
                      // Step tokens run light→darker by day and darker→light at night,
                      // so the larger share is always the higher-contrast fill.
                      background: `var(--color-${rain ? "rain" : "sun"}-step-${rampStep(share)})`,
                      borderStyle: "solid",
                      borderWidth: "1px 1px 0",
                      borderColor: "var(--color-ink)",
                    }}
                  />
                ) : (
                  <span aria-hidden="true" style={{ color: "var(--color-ink-muted)", fontFamily: "var(--font-mono)" }}>
                    –
                  </span>
                )}
              </span>
              <span
                className="mt-0.5 text-center tabular-nums leading-tight"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-caption)",
                  background: isNow ? "var(--color-ink)" : undefined,
                  color: isNow ? "var(--color-on-ink)" : "var(--color-ink)",
                }}
              >
                {hourKey(sample.hour)}
              </span>
              <span
                aria-hidden="true"
                className="text-center leading-tight"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}
              >
                {meridiem !== prevMeridiem ? meridiem : "\u00a0"}
              </span>
            </button>
          );
        })}
      </fieldset>
      )}

      {anyUnsampled && (
        <div className="px-2 pb-1" style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
          <span aria-hidden="true">– </span>no reading
        </div>
      )}
    </div>
  );
}

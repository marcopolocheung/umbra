import type { HourlyExposure } from "../hooks/useHourlyExposure";

interface HourlyExposureStripProps {
  exposure: HourlyExposure;
  /** Map-local hour currently on the timeline, so the strip can mark it. */
  currentHour: number;
  onPickHour: (when: Date) => void;
}

const RAMP = ["light", "bright", "base", "dark", "darker"] as const;

/** The five-step ramp entry for a 0–1 share: fifths, light to darker. */
export function rampStep(share: number): (typeof RAMP)[number] {
  return RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(share * RAMP.length)))];
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
 * keylined in ink so a pale step still holds against the panel. Hours not yet or
 * never sampled show a dash rather than a zero the field never measured.
 */
export default function HourlyExposureStrip({
  exposure,
  currentHour,
  onPickHour,
}: HourlyExposureStripProps) {
  const { samples, readyCount, best } = exposure;
  if (samples.length === 0) return null;
  const rain = samples[0].objective === "rain";
  const checking = readyCount < samples.length;
  const anyUnsampled = !checking && samples.some((sample) => sample.available === false);

  return (
    <div className="border-2" style={{ background: "var(--color-panel)", borderColor: "var(--color-ink)" }}>
      <div
        className="flex items-baseline justify-between gap-2 px-2 py-1"
        style={{ background: "var(--color-ink)", color: "var(--color-on-ink)", fontSize: "var(--text-caption)" }}
      >
        <span
          className="shrink-0 font-extrabold uppercase tracking-wider"
          style={{ fontFamily: "var(--font-label)" }}
        >
          {rain ? "Rain shelter by hour" : "Sun by hour"}
        </span>
        <span aria-live="polite" className="text-right" style={{ fontFamily: "var(--font-mono)" }}>
          {checking
            ? "checking…"
            : best
              ? rain ? `most sheltered around ${best.label}` : `most shadowed around ${best.label}`
              : null}
        </span>
      </div>

      <fieldset
        className="m-0 grid border-0 px-1.5 pt-1.5 pb-1"
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
              className="flex min-w-0 flex-col items-stretch"
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
                      background: `var(--color-${rain ? "rain" : "sun"}-${rampStep(share)})`,
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

      {anyUnsampled && (
        <div className="px-2 pb-1" style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
          – not sampled
        </div>
      )}
    </div>
  );
}

import type { HourlyExposure } from "../hooks/useHourlyExposure";

interface HourlyExposureStripProps {
  exposure: HourlyExposure;
  /** Map-local hour currently on the timeline, so the strip can mark it. */
  currentHour: number;
  onPickHour: (when: Date) => void;
}

/**
 * Shadow on this route, hour by hour — the "when should I go?" answer.
 *
 * Bars are drawn as *sun*, not shadow: the thing being avoided is the thing worth
 * seeing, and a short bar reading as a good hour matches how the rest of the app
 * talks about exposure. Hours still being sampled stay blank rather than showing
 * a zero the field never measured.
 */
export default function HourlyExposureStrip({
  exposure,
  currentHour,
  onPickHour,
}: HourlyExposureStripProps) {
  const { samples, readyCount, best } = exposure;
  if (samples.length === 0) return null;

  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-level-2"
      style={{ background: "var(--color-raised)", borderColor: "var(--color-hairline)" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div
          className="text-[10px] uppercase tracking-widest font-bold"
          style={{ color: "var(--color-ink-muted)" }}
        >
          Sun by hour
        </div>
        <div className="text-[10px]" aria-live="polite" style={{ color: "var(--color-ink-muted)" }}>
          {readyCount < samples.length
            ? "checking…"
            : best
              ? `most shadowed around ${best.label}`
              : null}
        </div>
      </div>

      <fieldset className="mt-1.5 flex items-end gap-1 border-0 p-0 m-0">
        <legend className="sr-only">Sun exposure by hour</legend>
        {samples.map((sample, i) => {
          const ready = i < readyCount;
          const sunPct = Math.round(sample.sunExposure * 100);
          const isNow = sample.hour === currentHour;
          return (
            <button
              key={sample.date.getTime()}
              type="button"
              onClick={() => onPickHour(sample.date)}
              disabled={!ready}
              // 44px of touch target, of which only the bar is inked — the app is
              // used one-handed, outdoors, and a 12px bar is not a tap target.
              className="group relative flex h-11 flex-1 items-end justify-center"
              aria-label={
                ready
                  ? `${sample.label}: ${sunPct}% in sun. Set the timeline to ${sample.label}.`
                  : `${sample.label}: not sampled yet`
              }
              aria-current={isNow ? "time" : undefined}
              title={ready ? `${sample.label} · ${sunPct}% sun` : sample.label}
            >
              <span
                className="w-full rounded-sm transition-[height] duration-200 motion-reduce:transition-none"
                style={{
                  // A fully shadowed hour still gets a sliver, so the bar reads as a
                  // measurement rather than a gap in the data.
                  height: ready ? `${Math.max(6, sample.sunExposure * 100)}%` : "6%",
                  background: ready
                    ? isNow
                      ? "var(--color-sun)"
                      : "var(--color-sun-mid)"
                    : "color-mix(in srgb, var(--color-ink) 18%, transparent)",
                }}
              />
            </button>
          );
        })}
      </fieldset>

      <div className="mt-1 flex justify-between text-[9px]" style={{ color: "var(--color-ink-muted)" }}>
        <span>{samples[0].label}</span>
        <span>{samples[samples.length - 1].label}</span>
      </div>
    </div>
  );
}

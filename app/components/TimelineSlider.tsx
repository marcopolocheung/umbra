import { useRef, useEffect, useCallback, useMemo, memo } from "react";
import { toMapLocal } from "../lib/timezone";
import { sunriseSunset } from "../lib/sunTimes";
import { altitudeAt, nightSpans, SUN_PATH_STEP_MIN, sunAltitudeTrace } from "../lib/sunPath";

interface Props {
  minutes: number; // 0–1439
  onChange: (minutes: number) => void;
  date?: Date;           // used for sunrise/sunset calculation
  latDeg?: number;       // map center latitude
  lngDeg?: number;       // map center longitude
  utcOffsetMin?: number; // map location's UTC offset (positive = ahead of UTC); defaults to browser's offset
}

// ---------------------------------------------------------------------------
// Sunrise / sunset
// ---------------------------------------------------------------------------

/**
 * Sunrise and sunset as minutes after map-local midnight, for the day/night
 * bands and their markers.
 *
 * The solar model is `app/lib/sunTimes.ts` — the same one the shadow layer uses.
 * This used to be a private copy of that orbital math carrying a flat `+ 12`
 * minute constant, which put the New York solstice marker at 5:40 AM against a
 * real 5:26 (issue 225).
 */
function sunriseSunsetMinutes(
  date: Date,
  latDeg: number,
  lngDeg: number,
  utcOffsetMin: number
): { riseMin: number; setMin: number } | null {
  const t = sunriseSunset(date, latDeg, lngDeg);
  if (!t) return null; // polar day or polar night
  const asMinutes = (d: Date) => {
    const { hours, minutes } = toMapLocal(d, utcOffsetMin);
    return hours * 60 + minutes;
  };
  return { riseMin: asMinutes(t.sunrise), setMin: asMinutes(t.sunset) };
}

const PX_PER_MIN = 2;
// Exponential velocity decay: 0.009 /ms ≈ velocity halves every ~77 ms.
// Halving FRICTION from 0.018 doubles the total inertia distance.
const FRICTION = 0.009;

function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function fmtMin(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Timetable ruler geometry (R6a). Ticks stand on a 2px ink rule; hour labels
// sit under it, so the needle — which stops at the rule — never covers one. The
// band above the rule is the sun-path diagram: 0° on the rule, 90° near the top.
const RULER_H = 44;
const RULE_Y = 28;
const RULE_W = 2;
const LABEL_Y = RULE_Y + RULE_W + 2;
const PX_PER_DEG = (RULE_Y - 4) / 90;

// Static tick data — computed once at module load, never changes
const TICKS = (() => {
  const out: { x: number; h: number; label?: string }[] = [];
  for (let m = 0; m <= 1440; m += 5) {
    const min = m % 60;
    const hr = Math.floor(m / 60);
    const isHour = min === 0;
    const isQuarter = !isHour && min % 15 === 0;
    out.push({
      x: m * PX_PER_MIN,
      h: isHour ? 10 : isQuarter ? 6 : 3,
      label: isHour && hr < 24 ? hourLabel(hr) : undefined,
    });
  }
  return out;
})();

const TOTAL_PX = 1440 * PX_PER_MIN;

// The tick ruler changes at module load and never again (U4/Doherty): memoised
// so the per-frame re-render during a drag — which exists to move the sun dot —
// never rebuilds 289 tick subtrees.
const Ruler = memo(function Ruler() {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: RULE_Y,
          height: RULE_W,
          backgroundColor: "var(--color-ink)",
        }}
      />
      {TICKS.map(({ x, h, label }) => (
        <div key={x} style={{ position: "absolute", left: x, top: 0, bottom: 0 }}>
          <div
            style={{
              position: "absolute",
              top: RULE_Y - h,
              left: 0,
              width: label ? 2 : 1,
              height: h,
              backgroundColor: label ? "var(--color-ink)" : "var(--color-ink-muted)",
            }}
          />
          {label && (
            <span
              style={{
                position: "absolute",
                top: LABEL_Y,
                left: 1,
                transform: "translateX(-50%)",
                whiteSpace: "nowrap",
                fontSize: 11,
                lineHeight: 1,
                color: "var(--color-ink)",
                fontFamily: "var(--font-mono)",
                userSelect: "none",
                pointerEvents: "none",
              }}
            >
              {label}
            </span>
          )}
        </div>
      ))}
    </>
  );
});

/** A sunrise/sunset time, printed on the night side of the horizon crossing. */
function SunEventLabel({ minutes, side, text }: { minutes: number; side: "left" | "right"; text: string }) {
  return (
    <span
      style={{
        position: "absolute",
        top: 2,
        ...(side === "left"
          ? { right: TOTAL_PX - minutes * PX_PER_MIN + 4 }
          : { left: minutes * PX_PER_MIN + 4 }),
        whiteSpace: "nowrap",
        fontSize: 11,
        lineHeight: 1,
        color: "var(--color-sun)",
        fontFamily: "var(--font-mono)",
        userSelect: "none",
        pointerEvents: "none",
      }}
    >
      {text}
    </span>
  );
}

const TimelineSlider = memo(function TimelineSlider({ minutes, onChange, date, latDeg, lngDeg, utcOffsetMin: utcOffsetMinProp }: Props) {
  const effectiveOffset = utcOffsetMinProp ?? (date ? -date.getTimezoneOffset() : 0);
  const sunRiseSet =
    date !== undefined && latDeg !== undefined && lngDeg !== undefined
      ? sunriseSunsetMinutes(date, latDeg, lngDeg, effectiveOffset)
      : null;
  const sunriseMin = sunRiseSet?.riseMin;
  const sunsetMin  = sunRiseSet?.setMin;
  // Re-sampled per map-local day and place, never per drag frame.
  const local = date ? toMapLocal(date, effectiveOffset) : null;
  const dayKey = local ? `${local.year}-${local.month}-${local.day}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dayKey stands in for date
  const trace = useMemo(
    () =>
      date && latDeg !== undefined && lngDeg !== undefined
        ? sunAltitudeTrace(date, latDeg, lngDeg, effectiveOffset)
        : null,
    [dayKey, latDeg, lngDeg, effectiveOffset],
  );
  const nights = useMemo(() => (trace ? nightSpans(trace) : []), [trace]);
  const sunPathPoints = useMemo(
    () =>
      trace
        ?.map((alt, i) => `${i * SUN_PATH_STEP_MIN * PX_PER_MIN},${RULE_Y - Math.max(0, alt) * PX_PER_DEG}`)
        .join(" "),
    [trace],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const isDragging = useRef(false);
  const lastX = useRef(0);
  const lastMoveTime = useRef(0);
  // EMA-smoothed velocity in px/ms; positive = dragging left (time advances)
  const lastVelocity = useRef(0);
  // fracMin accumulates fractional minutes so sub-pixel drags are never lost
  const fracMin = useRef(minutes);
  // curMin mirrors the `minutes` prop — always current via render-time assignment
  const curMin = useRef(minutes);
  curMin.current = minutes;

  const inertiaFrame = useRef<number | null>(null);
  // Throttle: only call onChange at most every ~16 ms (≈60 fps) to avoid
  // overwhelming React with rapid state updates during drag/inertia.
  const lastOnChangeMs = useRef(0);

  const getTranslateX = useCallback((m: number): number => {
    const half = (containerRef.current?.clientWidth ?? 0) / 2;
    return half - m * PX_PER_MIN;
  }, []);

  const applyTranslate = useCallback(
    (m: number) => {
      if (contentRef.current)
        contentRef.current.style.transform = `translateX(${getTranslateX(m)}px)`;
    },
    [getTranslateX]
  );

  const cancelInertia = useCallback(() => {
    if (inertiaFrame.current !== null) {
      cancelAnimationFrame(inertiaFrame.current);
      inertiaFrame.current = null;
    }
  }, []);

  const startInertia = useCallback(
    (v0: number) => {
      cancelInertia();
      let velocity = v0; // px/ms
      let lastTime = performance.now();

      const tick = (now: number) => {
        // Cap dt so a tab-switch freeze doesn't teleport the timeline
        const dt = Math.min(now - lastTime, 64);
        lastTime = now;

        velocity *= Math.exp(-FRICTION * dt);
        if (Math.abs(velocity) < 0.04) {
          inertiaFrame.current = null;
          return;
        }

        const next = fracMin.current - (velocity * dt) / PX_PER_MIN;
        if (next <= 0 || next >= 1439) {
          fracMin.current = Math.max(0, Math.min(1439, next));
          applyTranslate(fracMin.current);
          onChange(Math.round(fracMin.current));
          inertiaFrame.current = null;
          return;
        }

        fracMin.current = next;
        applyTranslate(next);
        if (now - lastOnChangeMs.current >= 30) {
          lastOnChangeMs.current = now;
          onChange(Math.round(next));
        }
        inertiaFrame.current = requestAnimationFrame(tick);
      };

      inertiaFrame.current = requestAnimationFrame(tick);
    },
    [applyTranslate, cancelInertia, onChange]
  );

  // Mount: set initial position + keep in sync when container resizes
  useEffect(() => {
    applyTranslate(curMin.current);
    const ro = new ResizeObserver(() => applyTranslate(curMin.current));
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [applyTranslate]);

  // External value changes (play animation) — skip while drag or inertia owns the position
  useEffect(() => {
    if (!isDragging.current && inertiaFrame.current === null)
      applyTranslate(minutes);
  }, [minutes, applyTranslate]);

  // Cleanup on unmount
  useEffect(() => () => cancelInertia(), [cancelInertia]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      cancelInertia();
      isDragging.current = true;
      fracMin.current = curMin.current;
      lastX.current = e.clientX;
      lastMoveTime.current = performance.now();
      lastVelocity.current = 0;
      lastOnChangeMs.current = 0; // ensure first move fires immediately
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [cancelInertia]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      const now = performance.now();
      const dt = now - lastMoveTime.current;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      // EMA: 70% new sample, 30% history — reduces single-frame noise
      if (dt > 0 && dt < 150)
        lastVelocity.current = lastVelocity.current * 0.3 + (dx / dt) * 0.7;
      lastMoveTime.current = now;

      fracMin.current = Math.max(0, Math.min(1439, fracMin.current - dx / PX_PER_MIN));
      applyTranslate(fracMin.current);
      if (now - lastOnChangeMs.current >= 30) {
        lastOnChangeMs.current = now;
        onChange(Math.round(fracMin.current));
      }
    },
    [applyTranslate, onChange]
  );

  const onPointerUp = useCallback(() => {
    isDragging.current = false;
    // Always flush the final drag position to React state
    lastOnChangeMs.current = 0;
    onChange(Math.round(fracMin.current));
    const stale = performance.now() - lastMoveTime.current;
    // Only launch inertia if the pointer was still moving when released
    if (stale < 80 && Math.abs(lastVelocity.current) > 0.08)
      startInertia(lastVelocity.current);
  }, [onChange, startInertia]);

  const altitude = trace ? altitudeAt(trace, minutes) : 0;
  const sunDot = altitude > 0 ? { x: minutes * PX_PER_MIN, y: RULE_Y - altitude * PX_PER_DEG } : null;
  // Orange is the sun (D1): the needle is sun-signal while the sun is up at the
  // selected time and plain ink once it is down.
  const needleColor = sunDot ? "var(--color-sun-signal)" : "var(--color-ink)";

  return (
    <div
      ref={containerRef}
      // The browser smoke test drags this element; Tailwind classes are not a
      // selector anyone should have to keep working.
      data-testid="timeline-slider"
      className="relative w-full h-11 overflow-hidden cursor-grab active:cursor-grabbing select-none"
      // The slider owns its gesture entirely: without this, a slightly
      // vertical drag hands the browser a pan it can turn into
      // pull-to-refresh on mobile.
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Scrolling ruler */}
      <div
        ref={contentRef}
        className="absolute inset-y-0"
        style={{ width: TOTAL_PX, willChange: "transform" }}
      >
        {/* ── Night: flat bands wherever the sun is at or below 0° ─────── */}
        {nights.map(([from, to]) => (
          <div
            key={from}
            data-testid="timeline-night"
            style={{
              position: "absolute",
              left: from * PX_PER_MIN,
              width: (to - from) * PX_PER_MIN,
              top: 0,
              bottom: 0,
              backgroundColor: "color-mix(in srgb, var(--color-ink) 8%, transparent)",
            }}
          />
        ))}

        {sunriseMin !== undefined && <SunEventLabel minutes={sunriseMin} side="left" text={`↑ ${fmtMin(sunriseMin)}`} />}
        {sunsetMin !== undefined && <SunEventLabel minutes={sunsetMin} side="right" text={`↓ ${fmtMin(sunsetMin)}`} />}

        {/* ── Sun-path diagram: the SunCalc altitude over the day, 0° on the
            rule. Sun data, so the dot is the sun hue; the path stays ink. */}
        {trace && (
          <svg
            width={TOTAL_PX}
            height={RULER_H}
            viewBox={`0 0 ${TOTAL_PX} ${RULER_H}`}
            style={{ position: "absolute", inset: 0, pointerEvents: "none", userSelect: "none" }}
            aria-hidden="true"
          >
            <polyline
              points={sunPathPoints}
              fill="none"
              stroke="var(--color-ink-muted)"
              strokeWidth={1.5}
            />
            {/* sun dot at the slider's time — with the needle, what a drag re-renders */}
            {sunDot && (
              <circle
                data-testid="timeline-sun"
                cx={sunDot.x}
                cy={sunDot.y}
                r={4}
                fill="var(--color-sun-signal)"
                stroke="var(--color-ink)"
                strokeWidth={1.5}
              />
            )}
          </svg>
        )}

        {/* ── Rule, hour/minute ticks and hour labels ──────────────────── */}
        <Ruler />
      </div>

      {/* Needle: stands on the rule at the selected time, clear of the labels.
          Ink keylines hold the orange core against the day panel in glare. */}
      <div
        data-testid="timeline-needle"
        className="absolute pointer-events-none z-10"
        style={{
          left: "50%",
          top: 0,
          height: RULE_Y,
          width: 5,
          transform: "translateX(-2px)",
          backgroundColor: needleColor,
          borderInline: "1px solid var(--color-ink)",
        }}
      />
      {!trace && (
        <span
          className="absolute left-3 pointer-events-none select-none"
          style={{ top: 2, fontSize: 11, lineHeight: 1, color: "var(--color-ink-muted)", fontFamily: "var(--font-mono)" }}
        >
          No sun path until the map has a place
        </span>
      )}
    </div>
  );
});

export default TimelineSlider;

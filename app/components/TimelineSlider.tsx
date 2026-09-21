import { useRef, useEffect, useCallback, memo } from "react";
import { toMapLocal } from "../lib/timezone";
import { sunriseSunset } from "../lib/sunTimes";

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
      h: isHour ? 20 : isQuarter ? 12 : 5,
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
      {TICKS.map(({ x, h, label }) => (
        <div key={x} style={{ position: "absolute", left: x, bottom: 0, top: 0 }}>
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              width: 1,
              height: h,
              backgroundColor: label
                ? "color-mix(in srgb, var(--color-ink) 35%, transparent)"
                : h === 12
                ? "color-mix(in srgb, var(--color-ink) 18%, transparent)"
                : "color-mix(in srgb, var(--color-ink) 8%, transparent)",
            }}
          />
          {label && (
            <span
              style={{
                position: "absolute",
                bottom: h + 4,
                left: 0,
                transform: "translateX(-50%)",
                whiteSpace: "nowrap",
                fontSize: 9,
                lineHeight: 1,
                color: "var(--color-ink-muted)",
                fontFamily: "var(--font-sans)",
                fontVariantNumeric: "tabular-nums",
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

// ---------------------------------------------------------------------------
// Sun-arc glyph (U4)
// ---------------------------------------------------------------------------

// The ruler's height (h-11). The arc's horizon sits at its midline and the
// apex just under the sunrise/sunset labels, so neither collides with the
// hour ticks at the bottom.
const RULER_H = 44;
const HORIZON_Y = 22;
const APEX_Y = 7;

/**
 * The sun's height on the arc at `minutes`, in ruler pixels — the SunCalc
 * pattern: a thin sun-path curve over the horizon with the sun dot at the
 * slider's time. The curve is a stylised path, not an ephemeris: the glyph's
 * job is "morning vs afternoon" at a glance.
 */
export function sunArcPoint(
  minutes: number,
  riseMin: number,
  setMin: number
): { x: number; y: number } | null {
  if (minutes < riseMin || minutes > setMin) return null; // sun below the horizon
  const u = (minutes - riseMin) / (setMin - riseMin);
  // The parabola through (rise, horizon), (midday, apex), (set, horizon) — the
  // same curve the quadratic Bézier path below draws.
  return {
    x: minutes * PX_PER_MIN,
    y: HORIZON_Y - 4 * (HORIZON_Y - APEX_Y) * u * (1 - u),
  };
}

const TimelineSlider = memo(function TimelineSlider({ minutes, onChange, date, latDeg, lngDeg, utcOffsetMin: utcOffsetMinProp }: Props) {
  const effectiveOffset = utcOffsetMinProp ?? (date ? -date.getTimezoneOffset() : 0);
  const sunRiseSet =
    date !== undefined && latDeg !== undefined && lngDeg !== undefined
      ? sunriseSunsetMinutes(date, latDeg, lngDeg, effectiveOffset)
      : null;
  const sunriseMin = sunRiseSet?.riseMin;
  const sunsetMin  = sunRiseSet?.setMin;
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

  const hasRise = sunriseMin !== undefined;
  const hasSet  = sunsetMin  !== undefined;
  const sunDot =
    hasRise && hasSet
      ? sunArcPoint(minutes, sunriseMin!, sunsetMin!)
      : null;

  return (
    <div
      ref={containerRef}
      // The browser smoke test drags this element; Tailwind classes are not a
      // selector anyone should have to keep working.
      data-testid="timeline-slider"
      className="relative w-full h-11 overflow-hidden cursor-grab active:cursor-grabbing select-none"
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
        {/* ── Night before sunrise ─────────────────────────────────────── */}
        {hasRise && (
          <div
            style={{
              position: "absolute",
              left: 0,
              width: sunriseMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              backgroundColor: "color-mix(in srgb, var(--color-ink) 8%, transparent)",
            }}
          />
        )}

        {/* ── Daytime gradient: dawn warm → pale noon → dusk warm */}
        {hasRise && hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunriseMin! * PX_PER_MIN,
              width: (sunsetMin! - sunriseMin!) * PX_PER_MIN,
              top: 0, bottom: 0,
              background: "linear-gradient(to right, var(--color-sun-soft), color-mix(in srgb, var(--color-sun) 6%, transparent) 50%, var(--color-route-soft))",
            }}
          />
        )}

        {/* ── Night after sunset ───────────────────────────────────────── */}
        {hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunsetMin! * PX_PER_MIN,
              width: TOTAL_PX - sunsetMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              backgroundColor: "color-mix(in srgb, var(--color-ink) 8%, transparent)",
            }}
          />
        )}

        {/* ── Sunrise marker + label (label inside slider at top) ──────── */}
        {hasRise && (
          <div
            style={{
              position: "absolute",
              left: sunriseMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              width: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: 0, width: 2,
                backgroundColor: "var(--color-sun)",
                boxShadow: "0 0 6px 2px color-mix(in srgb, var(--color-sun) 55%, transparent)",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: 3,
                left: 5,
                fontSize: 10,
                lineHeight: 1.2,
                color: "var(--color-sun)",
                whiteSpace: "nowrap",
                userSelect: "none",
                pointerEvents: "none",
                backgroundColor: "var(--color-raised)",
                borderRadius: 8,
                padding: "1px 4px",
              }}
            >
              ↑ {fmtMin(sunriseMin!)}
            </span>
          </div>
        )}

        {/* ── Sunset marker + label (label inside slider at top) ───────── */}
        {hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunsetMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              width: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: 0, width: 2,
                backgroundColor: "var(--color-route)",
                boxShadow: "0 0 6px 2px color-mix(in srgb, var(--color-route) 55%, transparent)",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: 3,
                left: 5,
                fontSize: 10,
                lineHeight: 1.2,
                color: "var(--color-route)",
                whiteSpace: "nowrap",
                userSelect: "none",
                pointerEvents: "none",
                backgroundColor: "var(--color-raised)",
                borderRadius: 8,
                padding: "1px 4px",
              }}
            >
              ↓ {fmtMin(sunsetMin!)}
            </span>
          </div>
        )}

        {/* ── Sun-arc glyph (U4): the SunCalc pattern — a thin sun-path curve
            with the sun dot at the slider's time. Pure data (sun position),
            so it is the sun hue; amber stays reserved for it per the law. */}
        {hasRise && hasSet && (
          <svg
            width={TOTAL_PX}
            height={RULER_H}
            viewBox={`0 0 ${TOTAL_PX} ${RULER_H}`}
            preserveAspectRatio="none"
            style={{ position: "absolute", inset: 0, pointerEvents: "none", userSelect: "none" }}
            aria-hidden="true"
          >
            {/* horizon */}
            <line
              x1={sunriseMin! * PX_PER_MIN}
              y1={HORIZON_Y}
              x2={sunsetMin! * PX_PER_MIN}
              y2={HORIZON_Y}
              stroke="color-mix(in srgb, var(--color-ink) 14%, transparent)"
              strokeWidth={1}
            />
            {/* the sun path: a quadratic from sunrise through the apex to sunset */}
            <path
              d={
                `M ${sunriseMin! * PX_PER_MIN} ${HORIZON_Y} ` +
                `Q ${((sunriseMin! + sunsetMin!) / 2) * PX_PER_MIN} ${2 * APEX_Y - HORIZON_Y} ` +
                `${sunsetMin! * PX_PER_MIN} ${HORIZON_Y}`
              }
              fill="none"
              stroke="color-mix(in srgb, var(--color-sun) 35%, transparent)"
              strokeWidth={1.5}
            />
            {/* sun dot at the slider's time — the only element this component
                re-renders for during a drag */}
            {sunDot && (
              <circle
                cx={sunDot.x}
                cy={sunDot.y}
                r={4}
                fill="var(--color-sun)"
                stroke="var(--color-raised)"
                strokeWidth={1.5}
              />
            )}
          </svg>
        )}

        {/* ── Hour/minute ticks ────────────────────────────────────────── */}
        <Ruler />
      </div>

      {/* Compass needle cursor — diamond cap + gradient shaft */}
      <div
        className="absolute pointer-events-none z-10"
        style={{
          left: "50%",
          top: 0,
          transform: "translateX(-4px)",
          width: 8,
          height: 8,
          backgroundColor: "var(--color-sun)",
          rotate: "45deg",
          boxShadow: "0 0 6px 2px color-mix(in srgb, var(--color-sun) 50%, transparent)",
        }}
      />
      <div
        className="absolute pointer-events-none z-10"
        style={{
          left: "50%",
          top: 8,
          bottom: 0,
          width: 2,
          transform: "translateX(-1px)",
          background: "linear-gradient(to bottom, var(--color-sun), color-mix(in srgb, var(--color-sun) 30%, transparent))",
          boxShadow: "0 0 4px 1px color-mix(in srgb, var(--color-sun) 35%, transparent)",
        }}
      />
    </div>
  );
});

export default TimelineSlider;

import { useRef, useEffect, useMemo, memo } from "react";

const PX_PER_DAY = 8;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Timetable ruler geometry, shared with TimelineSlider (R6a): ticks stand on a
// 2px ink rule, month labels sit under it, and the needle stops at the rule.
const RULE_Y = 28;
const RULE_W = 2;

interface Props {
  /** 0-indexed day of year (0 = Jan 1) */
  dayOfYear: number;
  year: number;
  onChange: (day: number) => void;
}

const DaySlider = memo(function DaySlider({ dayOfYear, year, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Month start days, leap-year aware. monthStarts[12] = total days in year.
  const monthStarts = useMemo(() => {
    const s: number[] = [];
    let acc = 0;
    for (let m = 0; m < 12; m++) {
      s.push(acc);
      acc += new Date(year, m + 1, 0).getDate();
    }
    s.push(acc);
    return s;
  }, [year]);

  const totalDays = monthStarts[12];

  // Precompute tick marks once per year
  const ticks = useMemo(() => {
    type Tick = { day: number; height: number; label?: string };
    const r: Tick[] = [];
    for (let m = 0; m < 12; m++) {
      const s = monthStarts[m];
      const e = monthStarts[m + 1];
      r.push({ day: s, height: 10, label: MONTH_NAMES[m] });
      for (let d = s + 1; d < e; d++) {
        const inM = d - s;
        const isWeek = inM % 7 === 0;
        r.push({ day: d, height: isWeek ? 6 : 3 });
      }
    }
    return r;
  }, [monthStarts]);

  // Drag state
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartTx = useRef(0);
  const lastDayRef = useRef(dayOfYear);
  const velRef = useRef(0);
  const lastPX = useRef(0);
  const lastPT = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Stable refs so inertia closures don't capture stale values
  const totalDaysRef = useRef(totalDays);
  const onChangeRef = useRef(onChange);
  totalDaysRef.current = totalDays;
  onChangeRef.current = onChange;

  const hw = () => (containerRef.current?.clientWidth ?? window.innerWidth) / 2;
  const clamp = (d: number) => Math.max(0, Math.min(totalDaysRef.current - 1, Math.round(d)));
  const setTx = (tx: number) => {
    if (contentRef.current) contentRef.current.style.transform = `translateX(${tx}px)`;
  };
  const getTx = () => {
    const m = contentRef.current?.style.transform?.match(/translateX\(([^)]+)px\)/);
    return m ? parseFloat(m[1]) : hw() - lastDayRef.current * PX_PER_DAY;
  };

  // Sync prop → DOM position (only when not dragging)
  useEffect(() => {
    if (!isDragging.current) setTx(hw() - dayOfYear * PX_PER_DAY);
    lastDayRef.current = dayOfYear;
  });

  // Re-center on container resize
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (!isDragging.current) setTx(hw() - lastDayRef.current * PX_PER_DAY);
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  function stopInertia() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    stopInertia();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartTx.current = getTx();
    velRef.current = 0;
    lastPX.current = e.clientX;
    lastPT.current = e.timeStamp;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return;
    const tx = dragStartTx.current + (e.clientX - dragStartX.current);
    setTx(tx);
    const dt = e.timeStamp - lastPT.current;
    if (dt > 0) velRef.current = 0.7 * (e.clientX - lastPX.current) / dt + 0.3 * velRef.current;
    lastPX.current = e.clientX;
    lastPT.current = e.timeStamp;
    const d = clamp((hw() - tx) / PX_PER_DAY);
    if (d !== lastDayRef.current) { lastDayRef.current = d; onChangeRef.current(d); }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!isDragging.current) return;
    isDragging.current = false;
    const v0 = velRef.current;
    if (Math.abs(v0) < 0.04) {
      setTx(hw() - lastDayRef.current * PX_PER_DAY);
      return;
    }
    let tx = getTx(), v = v0, prevT = e.timeStamp;
    function step(now: number) {
      const dt = Math.min(now - prevT, 64); prevT = now;
      v *= Math.exp(-0.018 * dt);
      tx += v * dt;
      const h = hw();
      const minTx = h - (totalDaysRef.current - 1) * PX_PER_DAY;
      if (tx < minTx) { tx = minTx; v = 0; }
      if (tx > h) { tx = h; v = 0; }
      setTx(tx);
      const d = clamp((h - tx) / PX_PER_DAY);
      if (d !== lastDayRef.current) { lastDayRef.current = d; onChangeRef.current(d); }
      if (Math.abs(v) < 0.04) { setTx(h - d * PX_PER_DAY); return; }
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
  }

  return (
    <div
      ref={containerRef}
      className="relative h-11 overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Fixed center needle — ink, not orange: a date is not sun data */}
      <div
        className="absolute top-0 z-10 pointer-events-none"
        style={{ left: "50%", height: RULE_Y, width: 3, transform: "translateX(-1px)", backgroundColor: "var(--color-ink)" }}
      />

      {/* Scrollable content */}
      <div
        ref={contentRef}
        className="absolute top-0 h-full"
        style={{ width: totalDays * PX_PER_DAY, willChange: "transform" }}
      >
        <div
          className="absolute inset-x-0"
          style={{ top: RULE_Y, height: RULE_W, backgroundColor: "var(--color-ink)" }}
        />

        {/* Tick marks + month labels */}
        {ticks.map(({ day, height, label }) => (
          <div key={day} className="absolute inset-y-0" style={{ left: day * PX_PER_DAY }}>
            <div
              className="absolute left-0"
              style={{
                top: RULE_Y - height,
                width: label ? 2 : 1,
                height,
                backgroundColor: label ? "var(--color-ink)" : "var(--color-ink-muted)",
              }}
            />
            {label && (
              <span
                className="absolute text-[11px] leading-none whitespace-nowrap select-none"
                style={{ top: RULE_Y + RULE_W + 2, left: 2, color: "var(--color-ink)", fontFamily: "var(--font-mono)" }}
              >
                {label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

export default DaySlider;

import { useEffect, useState, useRef, memo } from "react";
import { toMapLocal, fromZonedParts } from "../lib/timezone";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatDateDisplay(d: Date, utcOffsetMin: number): string {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return `${MONTHS[month]} ${day}, ${year}`;
}

function parseDateText(
  s: string,
  base: Date,
  utcOffsetMin: number,
  zone: string | null
): Date | null {
  s = s.trim();
  const { hours, minutes } = toMapLocal(base, utcOffsetMin);

  const makeDate = (year: number, month: number, day: number): Date | null => {
    // Typing a date in another season crosses a DST boundary, and `utcOffsetMin`
    // is the offset in effect *now* — so reusing it would move the clock an hour
    // without the user touching the time. Resolve in the zone where we have one.
    const d = zone
      ? fromZonedParts(zone, year, month, day, hours, minutes)
      : new Date(
          Date.UTC(year, month, day) - utcOffsetMin * 60000 + (hours * 60 + minutes) * 60000
        );
    return isNaN(d.getTime()) ? null : d;
  };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return makeDate(+iso[1], +iso[2] - 1, +iso[3]);

  const mdy = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (mdy) {
    const { year: baseYear } = toMapLocal(base, utcOffsetMin);
    const rawYear = mdy[3] ? +mdy[3] : baseYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return makeDate(year, +mdy[1] - 1, +mdy[2]);
  }

  const { year: baseYear } = toMapLocal(base, utcOffsetMin);
  const attempt = new Date(`${s} ${baseYear}`);
  if (!isNaN(attempt.getTime())) {
    return makeDate(baseYear, attempt.getMonth(), attempt.getDate());
  }

  return null;
}

interface DateInputProps {
  date: Date;
  onChange: (d: Date) => void;
  utcOffsetMin?: number;
  /** IANA zone of the map centre, when it is known. Makes date edits DST-correct. */
  zone?: string | null;
  ariaLabel?: string;
}

const DateInput = memo(function DateInput({
  date,
  onChange,
  utcOffsetMin: utcOffsetMinProp,
  zone = null,
  ariaLabel,
}: DateInputProps) {
  const utcOffsetMin = utcOffsetMinProp ?? -new Date().getTimezoneOffset();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldCommit = useRef(true);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit() {
    shouldCommit.current = true;
    setText(formatDateDisplay(date, utcOffsetMin));
    setEditing(true);
  }

  function commit(val: string) {
    if (!shouldCommit.current) {
      shouldCommit.current = true;
      return;
    }
    setEditing(false);
    const next = parseDateText(val, date, utcOffsetMin, zone);
    if (next) onChange(next);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            shouldCommit.current = false;
            setEditing(false);
          }
        }}
        className="min-h-11 rounded px-2 py-1 text-xs border focus:outline-none w-32 text-center"
        style={{
          background: "var(--color-canvas)",
          color: "var(--color-ink)",
          borderColor: "var(--color-hairline)",
          fontFamily: "var(--font-sans)",
        }}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={startEdit}
      className="min-h-11 text-xs tabular-nums w-32 text-center rounded px-2 py-1 hover:bg-canvas transition-colors"
      style={{
        color: "var(--color-ink-muted)",
        fontFamily: "var(--font-sans)",
      }}
      title="Click to set date (e.g. Mar 3, 3/3/2026)"
    >
      {formatDateDisplay(date, utcOffsetMin)}
    </button>
  );
});

export default DateInput;

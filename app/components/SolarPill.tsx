import { memo } from "react";

/**
 * The one sun-data status line above the route stack: how hard the sun is
 * loading right now, i.e. how much the shadow figures below matter.
 *
 * One component for both layouts — the floating desktop cards used to render
 * a two-tier variant of the same sentence, which was the panels disagreeing
 * with each other about the same number.
 */
const SolarPill = memo(function SolarPill({ intensity }: { intensity: number }) {
  if (intensity < 0.15) {
    return (
      <div
        className="text-xs px-2.5 py-1 rounded-full self-start"
        style={{ background: "color-mix(in srgb, var(--color-ink) 8%, transparent)", color: "var(--color-ink-muted)" }}
      >
        Low sun — shadow routing minimal
      </div>
    );
  }
  if (intensity <= 0.6) {
    return (
      <div
        className="text-xs px-2.5 py-1 rounded-full self-start"
        style={{ background: "var(--color-sun-soft)", color: "var(--color-sun)" }}
      >
        Moderate solar load
      </div>
    );
  }
  return (
    <div
      className="text-xs px-2.5 py-1 rounded-full self-start"
      style={{ background: "var(--color-sun)", color: "var(--color-on-sun)" }}
    >
      High solar load — shadow matters
    </div>
  );
});

export default SolarPill;

import { memo } from "react";
import Tag from "./ui/Tag";

/**
 * The one sun-data status line above the route stack: how hard the sun is
 * loading right now, i.e. how much the shadow figures below matter.
 *
 * One component for both layouts — the floating desktop cards used to render
 * a two-tier variant of the same sentence, which was the panels disagreeing
 * with each other about the same number.
 *
 * `afterSunset` is the route card's 0° rule (`routeAfterSunset`), the same one
 * the theme and the timeline's Sun down cell use. Below the horizon routing
 * scales shadow's weight by an intensity of zero, so the pill says the sun is
 * down instead of calling it low.
 */
const SolarPill = memo(function SolarPill({
  intensity,
  afterSunset = false,
}: {
  intensity: number;
  afterSunset?: boolean;
}) {
  if (afterSunset) {
    return <Tag className="self-start">Sun down — shadow not weighed</Tag>;
  }
  if (intensity < 0.15) {
    return (
      <Tag
        className="self-start"
        style={{ background: "var(--color-panel)", color: "var(--color-ink)", border: "1px solid var(--color-rule-strong)" }}
      >
        Low sun — shadow routing minimal
      </Tag>
    );
  }
  if (intensity <= 0.6) {
    return (
      <Tag
        className="self-start"
        style={{ background: "var(--color-sun-light)", color: "var(--color-on-sun-signal)" }}
      >
        Moderate solar load
      </Tag>
    );
  }
  return (
    <Tag
      className="self-start"
      style={{ background: "var(--color-sun-signal)", color: "var(--color-on-sun-signal)" }}
    >
      High solar load — shadow matters
    </Tag>
  );
});

export default SolarPill;

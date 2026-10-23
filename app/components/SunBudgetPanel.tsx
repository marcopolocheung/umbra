import { type CSSProperties, useId } from "react";
import type { SunBudgetStatus } from "../hooks/useSunBudget";
import { SUN_BUDGET_WALK_MINUTES } from "../hooks/useSunBudget";
import type { SunReachOutcome } from "../lib/sunReach";
import Kicker from "./ui/Kicker";
import Plate from "./ui/Plate";
import Segmented from "./ui/Segmented";
import "./sunBudget.css";

interface SunBudgetPanelProps {
  status: SunBudgetStatus;
  outcome: SunReachOutcome | null;
  /** Proven streets drawn; zero is "nothing confirmed", never "nowhere". */
  provenCount: number;
  undecidedCount: number;
  sunMin: number;
  walkMin: number;
  /** The budgets of the region on screen; the sliders run ahead of it while a search runs. */
  shown: { sunMin: number; walkMin: number } | null;
  /** The region was cut at the edge of NYC's shade data (#380). */
  clipped?: boolean;
  onSunMinChange: (minutes: number) => void;
  onWalkMinChange: (minutes: number) => void;
  onUseLocation?: () => void;
  onExit: () => void;
}

const ACTION =
  "flex min-h-11 items-center justify-center gap-2 border-2 border-ink px-3 py-2 font-extrabold uppercase tracking-wider focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current";

/**
 * What the map can honestly say about the region. An undecided street is not
 * an unreachable one (sun-budget-model.md, H3), so no line here says "can't".
 */
export function sunBudgetMessage(p: {
  status: SunBudgetStatus;
  outcome: SunReachOutcome | null;
  provenCount: number;
  undecidedCount: number;
  shown: { sunMin: number; walkMin: number } | null;
  clipped?: boolean;
}): { headline: string; detail?: string; plate?: string } {
  if (p.status === "sun-down") {
    return {
      headline: "The sun is down at the selected time.",
      detail: "There's no direct sun to budget. Move the time slider into daylight.",
    };
  }
  if (p.status === "picking") return { headline: "Tap the map to set a start." };
  if (p.status === "uncovered") {
    return { headline: "Sun Budget needs NYC shade data.", detail: "It isn't available for this start yet." };
  }
  if (p.status === "error") return { headline: "Couldn't load the streets here.", detail: "Try another start." };
  if (p.status === "loading" || !p.shown) return { headline: "Finding where you can go…" };
  // Worded from the region on screen, never from a slider that has moved past it.
  const scope = `in ${p.shown.walkMin} min on ≤ ${p.shown.sunMin} min of direct sun, one way`;
  const dashed = p.undecidedCount > 0;
  // Appended wherever it applies: the region ends where NYC's data does.
  const edge = p.clipped ? " Streets past the edge of NYC's data aren't shown." : "";
  if (p.provenCount === 0) {
    return {
      plate: "None confirmed",
      headline: `No street confirmed ${scope}.`,
      detail: (dashed ? "Dashed streets weren't confirmed either way." : "") + edge || undefined,
    };
  }
  if (p.outcome === "budget-exhausted" && dashed) {
    return {
      plate: "Stopped early",
      headline: `Solid streets: a walk from your start reaches them ${scope}.`,
      detail: `The search stopped early. Dashed streets may still be reachable.${edge}`,
    };
  }
  if (dashed) {
    return {
      plate: "Some confirmed",
      headline: `Solid streets: a walk from your start reaches them ${scope}.`,
      detail: `Dashed streets weren't confirmed either way.${edge}`,
    };
  }
  if (p.clipped) {
    return {
      plate: "Up to the data's edge",
      headline: `Solid streets: a walk from your start reaches them ${scope}.`,
      detail: edge.trim(),
    };
  }
  return { plate: "All streets", headline: `Every street a walk from your start reaches ${scope}.` };
}

export default function SunBudgetPanel(props: SunBudgetPanelProps) {
  const sliderId = useId();
  const { headline, detail, plate } = sunBudgetMessage(props);
  const sunLabel = `${props.sunMin} min of sun`;
  return (
    <section aria-label="Sun Budget" className="flex flex-col gap-3 border-2 border-ink bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <Kicker>Sun Budget</Kicker>
          <h2 className="font-display text-xl font-semibold leading-tight" style={{ color: "var(--color-ink)" }}>
            Where can I go?
          </h2>
        </div>
        <button type="button" onClick={props.onExit} className={`${ACTION} bg-panel text-ink hover:bg-ground`}>
          Done
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={sliderId} style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}>
            Most direct sun
          </label>
          {/* The slider speaks its value (aria-valuetext); the one live region is the result below. */}
          <output htmlFor={sliderId} aria-hidden="true" className="font-semibold tabular-nums" style={{ fontSize: "var(--text-body)" }}>
            {sunLabel}
          </output>
        </div>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={20}
          step={1}
          value={props.sunMin}
          aria-valuetext={sunLabel}
          disabled={props.status === "sun-down"}
          onChange={(event) => props.onSunMinChange(Number(event.target.value))}
          className="sun-budget-range min-h-11 w-full"
          style={{ "--sun-budget-fill": `${(props.sunMin / 20) * 100}%` } as CSSProperties}
        />
        <div className="flex justify-between tabular-nums" aria-hidden="true" style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
          <span>0 min</span>
          <span>20 min</span>
        </div>
      </div>

      <Segmented
        label="Walking time"
        value={String(props.walkMin)}
        onChange={(value) => props.onWalkMinChange(Number(value))}
        options={SUN_BUDGET_WALK_MINUTES.map((m) => ({ value: String(m), label: `${m} min walk` }))}
      />

      {props.status === "picking" && props.onUseLocation && (
        <button type="button" onClick={props.onUseLocation} className={`${ACTION} bg-panel text-ink hover:bg-ground`}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">my_location</span>
          Start from my location
        </button>
      )}

      <div role="status" aria-live="polite" className="flex flex-col items-start gap-1">
        {/* The outcome in words (#381): the map's dashes say the same, never colour alone. */}
        {plate && (
          <Plate as="span" tone="ink" className="px-2 py-0.5 font-extrabold uppercase tracking-wider" style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}>
            {plate}
          </Plate>
        )}
        <p className="font-semibold" style={{ fontSize: "var(--text-body)", color: "var(--color-ink)" }}>
          {headline}
        </p>
        {detail && (
          <p style={{ fontSize: "var(--text-small)", color: "var(--color-ink-muted)" }}>{detail}</p>
        )}
      </div>

      <p style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
        Modelled shade (clear sky) in 15-minute steps from building and tree data, for a steady 5 km/h walk with no stops at crossings. One way, no waiting for shade.
      </p>
    </section>
  );
}

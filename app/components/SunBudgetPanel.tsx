import { type CSSProperties, useId, useRef } from "react";
import type { SunBudgetStatus } from "../hooks/useSunBudget";
import { SUN_BUDGET_STAY_MINUTES, SUN_BUDGET_WALK_MINUTES } from "../hooks/useSunBudget";
import type { SunReachOutcome, SunReachWalk } from "../lib/sunReach";
import Kicker from "./ui/Kicker";
import Tag from "./ui/Tag";
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
  /** H5c: null for one way; else a round trip with a stop of this many minutes. */
  stayMin?: number | null;
  /** The budgets of the region on screen; the sliders run ahead of it while a search runs. */
  shown: { sunMin: number; walkMin: number; stayMin?: number | null } | null;
  /** The region was cut at the edge of NYC's shade data (#380). */
  clipped?: boolean;
  /** The walk behind a tapped street (#379); "none" when this search can't replay it. */
  walk?: SunReachWalk | "none" | null;
  onHideWalk?: () => void;
  /** "Show walks": a tap on a solid street shows its walk instead of moving the start (#379). */
  walkMode?: boolean;
  onWalkModeChange?: (on: boolean) => void;
  onSunMinChange: (minutes: number) => void;
  onWalkMinChange: (minutes: number) => void;
  onStayMinChange?: (minutes: number | null) => void;
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
  shown: { sunMin: number; walkMin: number; stayMin?: number | null } | null;
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
  const stay = p.shown.stayMin;
  const trip =
    stay === null || stay === undefined ? "one way" : stay === 0 ? "there and back" : `there and back, with a ${stay}-min stop`;
  const scope = `in ${p.shown.walkMin} min on ≤ ${p.shown.sunMin} min of direct sun, ${trip}`;
  const dashed = p.undecidedCount > 0;
  // Appended wherever it applies: the region ends where NYC's data does.
  const edge = p.clipped
    ? " Streets past the edge of NYC's data aren't shown, and streets near it may be missing if the only way there runs past it."
    : "";
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { headline, detail, plate } = sunBudgetMessage(props);
  const sunLabel = `${props.sunMin} min of sun`;
  return (
    <section aria-label="Sun Budget" className="flex flex-col gap-3 border-2 border-ink bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <Kicker>Sun Budget</Kicker>
          <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-semibold leading-tight focus:outline-none" style={{ color: "var(--color-ink)" }}>
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

      {props.onStayMinChange && (
        <Segmented
          label="Trip"
          value={props.stayMin === null || props.stayMin === undefined ? "one-way" : "round"}
          onChange={(value) => props.onStayMinChange?.(value === "round" ? 0 : null)}
          options={[
            { value: "one-way", label: "One way" },
            { value: "round", label: "Round trip" },
          ]}
        />
      )}
      {props.onStayMinChange && props.stayMin !== null && props.stayMin !== undefined && (
        <Segmented
          label="Stop on the way"
          value={String(props.stayMin)}
          onChange={(value) => props.onStayMinChange?.(Number(value))}
          options={SUN_BUDGET_STAY_MINUTES.map((m) => ({ value: String(m), label: m === 0 ? "No stop" : `${m} min stop` }))}
        />
      )}

      {props.onWalkModeChange && props.status === "ready" && (
        <Segmented
          label="What a tap does"
          value={props.walkMode ? "walk" : "start"}
          onChange={(value) => props.onWalkModeChange?.(value === "walk")}
          options={[
            { value: "start", label: "Move start" },
            { value: "walk", label: "Show walks" },
          ]}
        />
      )}

      {props.status === "picking" && props.onUseLocation && (
        <button type="button" onClick={props.onUseLocation} className={`${ACTION} bg-panel text-ink hover:bg-ground`}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">my_location</span>
          Start from my location
        </button>
      )}

      <div role="status" aria-live="polite" className="flex flex-col items-start gap-1">
        {/* The outcome in words (#381): the map's dashes say the same, never colour alone. */}
        {plate && (
          <Tag tone="neutral">{plate}</Tag>
        )}
        <p className="font-semibold" style={{ fontSize: "var(--text-body)", color: "var(--color-ink)" }}>
          {headline}
        </p>
        {detail && (
          <p style={{ fontSize: "var(--text-small)", color: "var(--color-ink-muted)" }}>{detail}</p>
        )}
        {props.walk && (
          <p className="border-2 border-ink p-2" style={{ fontSize: "var(--text-small)", color: "var(--color-ink)" }}>
            {props.walk === "none"
              ? "Can't redraw the walk behind this street. Change a budget and tap it again."
              : // Rounded up: never shows less sun than the walk has. Not "the best way there".
                props.walk.dwell
                ? `Shadiest round trip found: ${Math.ceil(props.walk.arrivalSec / 60)} min home${props.walk.dwell.seconds > 0 ? `, ${Math.round(props.walk.dwell.seconds / 60)} of them at the stop` : ""}, ${Math.ceil(props.walk.sunSec / 60)} min of direct sun in all, on the sidewalks drawn.`
                : `Shadiest walk found: ${Math.ceil(props.walk.arrivalSec / 60)} min, ${Math.ceil(props.walk.sunSec / 60)} min of direct sun, on the sidewalks drawn.`}
          </p>
        )}
        {props.status === "ready" && !props.walk && (
          <p style={{ fontSize: "var(--text-small)", color: "var(--color-ink-muted)" }}>
            {props.walkMode ? "Tap a solid street to see the walk behind it." : "Tap the map to move the start."}
          </p>
        )}
      </div>

      {props.walk && props.walk !== "none" && props.onHideWalk && (
        <button
          type="button"
          onClick={() => {
            props.onHideWalk?.();
            // The button leaves with the walk: hand focus to the panel, not the page body.
            headingRef.current?.focus();
          }}
          className={`${ACTION} self-start bg-panel text-ink hover:bg-ground`}
        >
          Hide walk
        </button>
      )}

      <p style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
        Modelled shade (clear sky) in 15-minute steps from building and tree data, for a steady 5 km/h walk with no stops at crossings and no waiting for shade. A stop is spent on that corner's shadiest sidewalk.
      </p>
    </section>
  );
}

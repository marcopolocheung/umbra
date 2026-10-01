import Kicker from "./ui/Kicker";

interface QuickActionsProps {
  onNavigate: () => void;
  onDrawRoute: () => void;
  drawMode: boolean;
}

const ACTION =
  "flex min-h-11 items-center justify-center gap-2 border-2 border-ink px-3 py-2 font-extrabold uppercase tracking-wider focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current";

/** The idle sheet's empty state: nothing is planned, so it says so and offers the two ways to start. */
export default function QuickActions({ onNavigate, onDrawRoute, drawMode }: QuickActionsProps) {
  return (
    <div className="flex flex-col gap-3 border-2 border-ink bg-panel p-4">
      <div className="flex flex-col items-start gap-1">
        <Kicker>Before you set out</Kicker>
        <h3 className="font-display text-xl font-semibold leading-tight" style={{ color: "var(--color-ink)" }}>
          Nothing planned yet
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-2" style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}>
        <button type="button" onClick={onNavigate} className={`${ACTION} bg-panel text-ink hover:bg-ground`}>
          <span className="material-symbols-outlined text-lg" aria-hidden="true">route</span>
          Directions
        </button>
        <button
          type="button"
          onClick={onDrawRoute}
          aria-pressed={drawMode}
          className={`${ACTION} ${drawMode ? "bg-ink text-on-ink" : "bg-panel text-ink hover:bg-ground"}`}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">draw</span>
          Draw route
        </button>
      </div>
    </div>
  );
}

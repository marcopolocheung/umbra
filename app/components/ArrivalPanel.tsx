import type { RouteOption } from "../lib/routing";
import { routeExposureMinutes } from "../lib/routeTradeoff";

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

interface ArrivalPanelProps {
  route: RouteOption | null;
  waypointBLabel: string | null;
  waypointB: [number, number] | null;
  onPlanAnother: () => void;
  onDone: () => void;
}

export default function ArrivalPanel({
  route,
  waypointBLabel,
  waypointB,
  onPlanAnother,
  onDone,
}: ArrivalPanelProps) {
  const destination = waypointBLabel ?? (waypointB ? `${waypointB[1].toFixed(5)}, ${waypointB[0].toFixed(5)}` : "Destination");

  // The peak-end line: what the walk earned. Journeys are remembered by their
  // end, and the arrival card used to restate only distance and a percentage.
  // The earned figure is the same mode-paced conversion the route cards print,
  // so it inherits their stated basis rather than being a new number.
  const exposure = route ? routeExposureMinutes(route) : null;
  const earned =
    route && exposure
      ? (() => {
          const sun = Math.round(exposure.sunMinutes);
          const total = Math.max(1, Math.round(exposure.sunMinutes + exposure.shadowMinutes));
          return `${formatDistance(route.distanceM)} walked — ${sun} of ${total} min in sun`;
        })()
      : route
        ? `${formatDistance(route.distanceM)} route — ${Math.round(route.shadowCoverage * 100)}% shadow${exposure === null && route.legs ? ", sun time unknown" : ""}`
        : null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <div className="w-7" />
        <h2 className="text-[13px] font-medium" style={{ color: "var(--color-ink)" }}>Arrived</h2>
        <button
          type="button"
          onClick={onDone}
          className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-canvas"
          style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
          title="Close"
          aria-label="Close"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>

      <div
        className="rounded-xl border p-4 text-center"
        style={{
          background: "var(--color-shade-soft)",
          borderColor: "var(--color-shade-mid)",
          color: "var(--color-ink)",
        }}
      >
        <span
          className="material-symbols-outlined rounded-full p-3 text-[28px]"
          style={{ background: "var(--color-shade)", color: "var(--color-on-shade)" }}
        >
          flag
        </span>
        <div className="mt-3 text-sm font-semibold">Arrived at {destination}</div>
        {earned && (
          <div className="mt-1 text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
            {earned}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPlanAnother}
          className="flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          style={{ background: "var(--color-ink)", color: "var(--color-on-ink)" }}
        >
          Plan another
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

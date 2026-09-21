import type { RouteOption } from "../lib/routing";
import { routeExposureMinutes, routeExposureScope } from "../lib/routeTradeoff";
import { getTravelModePolicy } from "../lib/travelMode";

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

  // The peak-end line: what the trip earned. Journeys are remembered by their
  // end, and the arrival card used to restate only distance and a percentage.
  // It states its basis (the fixed pace, as the route cards' caption does) and
  // its scope on a transit trip (the ride is never in the figure), because
  // neither travels with the number once it leaves the card.
  const earned = route
    ? (() => {
        const exposure = routeExposureMinutes(route);
        const scope = routeExposureScope(route);
        const dist = `${formatDistance(route.distanceM)} route`;
        if (!exposure) return `${dist} — sun exposure unknown`;
        const total = Math.round(exposure.sunMinutes + exposure.shadowMinutes);
        const sun =
          exposure.sunMinutes < 1
            ? "under a minute"
            : `${Math.round(exposure.sunMinutes)} of ${total} min`;
        const paceKmh = (
          (getTravelModePolicy(route.travelMode ?? "walk").speedMps * 3.6).toFixed(1)
        );
        return `${dist} — ${sun} in sun at a fixed ${paceKmh} km/h pace${scope ? `; ${scope}` : ""}`;
      })()
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

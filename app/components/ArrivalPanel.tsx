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
  rainMode?: boolean;
}

export default function ArrivalPanel({
  route,
  waypointBLabel,
  waypointB,
  onPlanAnother,
  onDone,
  rainMode = false,
}: ArrivalPanelProps) {
  const destination = waypointBLabel ?? (waypointB ? `${waypointB[1].toFixed(5)}, ${waypointB[0].toFixed(5)}` : "Destination");

  // The peak-end line: what the trip earned. Journeys are remembered by their
  // end, and the arrival card used to restate only distance and a percentage.
  // It states its basis (the fixed pace, as the route cards' caption does) and
  // its scope on a transit trip (the ride is never in the figure), because
  // neither travels with the number once it leaves the card.
  const earned = route
    ? (() => {
        // A rain trip earned shelter, not sun minutes — the objective's own
        // wording carries (#64), with the same unknown-part honesty.
        if (rainMode) {
          const shelter = route.exposure?.shelteredDistancePct ?? route.dryCoverage ?? null;
          const unknown =
            (route.exposure?.unknownDistanceM ?? 0) > 0 || (route.exposure?.unknownDurationSec ?? 0) > 0;
          // The headline above already states the shelter figure; the caption
          // keeps only what the headline leaves out (U5: no number twice).
          const shelterText =
            unknown ? "with shelter partly unknown" : shelter == null ? "with shelter unknown" : "";
          return `${formatDistance(route.distanceM)} route${shelterText ? ` ${shelterText}` : ""}`;
        }
        const exposure = routeExposureMinutes(route);
        const scope = routeExposureScope(route);
        const dist = `${formatDistance(route.distanceM)} route`;
        const paceKmh = (
          (getTravelModePolicy(route.travelMode ?? "walk").speedMps * 3.6).toFixed(1)
        );
        if (!exposure) return `${dist} — sun exposure unknown`;
        const total = Math.round(exposure.sunMinutes + exposure.shadowMinutes);
        const pace = `at a fixed ${paceKmh} km/h pace`;
        // The headline above states the sun minutes; the caption keeps only
        // the basis and the scope (U5: no number twice on one card).
        if (total >= 1) return `${dist} — ${pace}${scope ? `; ${scope}` : ""}`;
        return `${dist} — under a minute in sun, ${pace}${scope ? `; ${scope}` : ""}`;
      })()
    : null;

  // The shade story the arrival card leads with: the same exposure figures the
  // earned line cites, as the display voice plus the split bar's fill width —
  // no new number, only a bigger telling of the measured one. Null whenever
  // the earned line would say "unknown": an invented split is a fabricated
  // verdict.
  const shadeStory = route
    ? (() => {
        if (rainMode) {
          const shelter = route.exposure?.shelteredDistancePct ?? route.dryCoverage ?? null;
          const unknown =
            (route.exposure?.unknownDistanceM ?? 0) > 0 || (route.exposure?.unknownDurationSec ?? 0) > 0;
          if (shelter == null || unknown) return null;
          const pct = Math.round(shelter * 100);
          return { headline: `${pct}% sheltered`, pct };
        }
        const exposure = routeExposureMinutes(route);
        if (!exposure) return null;
        const total = Math.round(exposure.sunMinutes + exposure.shadowMinutes);
        if (total < 1) return null;
        const sun =
          exposure.sunMinutes < 1
            ? "under a minute in sun"
            : `${Math.round(exposure.sunMinutes)} of ${total} min in sun`;
        return { headline: sun, pct: Math.round((exposure.shadowMinutes / total) * 100) };
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

      {/* The peak-end sentence (U7): the walk's shade story told once, at the
          display voice, with the same split bar the route card carries. The
          boldness is spent on the story — the badge demotes to a small glyph
          so nothing on this card competes with it. */}
      <div
        className="rounded-xl border p-4 text-center"
        style={{
          background: "var(--color-shade-soft)",
          borderColor: "var(--color-shade-mid)",
          color: "var(--color-ink)",
        }}
      >
        <div className="flex items-center justify-center gap-1.5">
          <span
            className="material-symbols-outlined text-[20px]"
            style={{ color: "var(--color-shade)" }}
            aria-hidden="true"
          >
            flag
          </span>
          <div className="text-[13px] font-semibold">Arrived at {destination}</div>
        </div>
        {shadeStory ? (
          <>
            <div
              className="font-display text-verdict mt-3 font-bold leading-tight tabular-nums tracking-[-0.02em]"
              style={{ color: "var(--color-ink)" }}
            >
              {shadeStory.headline}
            </div>
            {/* The split bar: the sun wash is the track, the shade fill covers
                it — the same mark as the route card, so the story ends on the
                same visual it started with. */}
            <div
              className="mt-2 h-3 rounded-full overflow-hidden"
              style={{
                background: rainMode
                  ? "color-mix(in srgb, var(--color-ink) 8%, transparent)"
                  : "var(--color-sun-soft)",
              }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${shadeStory.pct}%`,
                  background: rainMode ? "var(--color-route-mid)" : "var(--color-shade)",
                }}
              />
            </div>
          </>
        ) : null}
        {earned && (
          <div className="mt-2 text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
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

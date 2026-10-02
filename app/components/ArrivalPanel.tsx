import { useId } from "react";
import type { RouteOption } from "../lib/routing";
import { routeAfterSunset, routeExposureMinutes, routeExposureScope, routeSplitBasis } from "../lib/routeTradeoff";
import { describeShadowProvenance } from "../lib/shadowProvenance";
import { getTravelModePolicy } from "../lib/travelMode";
import Kicker from "./ui/Kicker";
import StampBadge from "./ui/StampBadge";
import Sigil from "./ui/Sigil";
import { INK_REVEAL } from "./ui/motion";

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
  const biteId = useId();
  // A coordinate is a number, and numbers never take the display face: an
  // unnamed destination gets a plain title and its coordinates as a caption.
  const destination = waypointBLabel ?? "Your destination";
  const coordinates = !waypointBLabel && waypointB ? `${waypointB[1].toFixed(5)}, ${waypointB[0].toFixed(5)}` : null;
  // Sun at or below the horizon where the route was evaluated: the route card
  // already says "after sunset" instead of a share, and the postcard must not
  // turn the same night walk back into daylight sun minutes (R8a).
  const afterSunset = !!route && !rainMode && routeAfterSunset(route);
  // Where the shadow (or shelter) figure came from, as the route card states it.
  // Absent on sketch and transit routes, which were not sampled per sidewalk.
  const sourceLine = route && !afterSunset && !(rainMode && route.exposureUpdating)
    ? (() => {
        const source = rainMode ? route.shelterSource : route.shadowSource;
        return source ? describeShadowProvenance(source) : null;
      })()
    : null;

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
          if (route.exposureUpdating) return `${formatDistance(route.distanceM)} route — updating shelter…`;
          const shelterText =
            unknown ? "with shelter partly unknown" : shelter == null ? "with shelter unknown" : "";
          return `${formatDistance(route.distanceM)} route${shelterText ? ` ${shelterText}` : ""}`;
        }
        const exposure = routeExposureMinutes(route);
        const scope = routeExposureScope(route);
        const dist = `${formatDistance(route.distanceM)} route`;
        if (afterSunset) return `${dist} — no sun minutes: the sun was down at the route's time`;
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
          // While shelter is still recomputing, no verdict: the display voice
          // must not present a stale figure as the trip's final split
          // (grounding audit — RouteCard suppresses its bar for the same reason).
          if (route.exposureUpdating) return null;
          const shelter = route.exposure?.shelteredDistancePct ?? route.dryCoverage ?? null;
          const unknown =
            (route.exposure?.unknownDistanceM ?? 0) > 0 || (route.exposure?.unknownDurationSec ?? 0) > 0;
          if (shelter == null || unknown) return null;
          const pct = Math.round(shelter * 100);
          return { headline: `${pct}% sheltered`, pct };
        }
        if (afterSunset) return { headline: "After sunset", pct: null };
        const exposure = routeExposureMinutes(route);
        if (!exposure) return null;
        const total = Math.round(exposure.sunMinutes + exposure.shadowMinutes);
        if (total < 1) return null;
        const sun =
          exposure.sunMinutes < 1
            ? "under a minute in sun"
            : `${Math.round(exposure.sunMinutes)} of ${total} min in sun`;
        // The bar takes the exact ratio: a rounded minute total skews a short
        // walk's share by up to half (a 120 m walk read 43% for its 30%).
        return {
          headline: sun,
          pct: Math.round((exposure.shadowMinutes / (exposure.sunMinutes + exposure.shadowMinutes)) * 100),
        };
      })()
    : null;

  const sunVerdict = !rainMode && shadeStory?.pct != null;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Arrival as a postcard (R8a): the greeting on a kicker plate, the place
          as its title, the umbra disc as the postmark, then the trip's one
          sun-time verdict told once in square numbers with the split bar the
          route card carries. Voice lives in the kicker; the numbers stay plain. */}
      <article
        aria-labelledby={`${biteId}-title`}
        className="border-2 border-ink bg-panel p-4 shadow-hard-2"
        style={{ color: "var(--color-ink)" }}
      >
        <header className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <Kicker plated>Greetings from</Kicker>
            <h2 id={`${biteId}-title`} className="font-display text-verdict font-semibold leading-tight">
              <span className="sr-only">Arrived at</span> {destination}
            </h2>
            {coordinates && (
              <div className="font-mono text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                {coordinates}
              </div>
            )}
          </div>
          {/* The umbra disc — a sun with its own shadow's bite — postmarks the card. */}
          {/* Orange only beside a sun figure: the disc is the sun, not decoration.
              The heading already says Arrived to a screen reader. */}
          <StampBadge tone={sunVerdict ? "sun" : "ink"} className="shrink-0" aria-hidden="true">
            {/* Side padding widens the ring so the word sits inside it below centre. */}
            <span className="flex flex-col items-center px-1">
              <Sigil name="disc" size={22} />
              Arrived
            </span>
          </StampBadge>
        </header>

        {shadeStory ? (
          <>
            <div
              key={shadeStory.headline}
              className={`${INK_REVEAL} font-numeric text-verdict mt-3 font-bold leading-tight tabular-nums tracking-[-0.02em]`}
              style={{
                color: shadeStory.pct == null ? "var(--color-ink)" : rainMode ? "var(--color-rain)" : "var(--color-sun)",
              }}
            >
              {shadeStory.headline}
            </div>
            {/* The split bar, square and ink-ruled as on the route card: shade
                against sun (signal orange), or sheltered against open on a
                neutral track in rain. Never drawn after sunset. */}
            {shadeStory.pct != null && route && (
              <>
                <div className="mt-2 flex h-3 border border-ink" aria-hidden="true">
                  <div
                    className="h-full"
                    style={{ width: `${shadeStory.pct}%`, background: rainMode ? "var(--color-rain)" : "var(--color-shade)" }}
                  />
                  {shadeStory.pct < 100 && (
                    <div
                      className={`h-full flex-1 ${shadeStory.pct > 0 ? "border-l-2 border-panel" : ""}`}
                      style={{
                        background: rainMode
                          ? "color-mix(in srgb, var(--color-ink) 8%, transparent)"
                          : "var(--color-sun-signal)",
                      }}
                    />
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[11px]" style={{ color: "var(--color-ink-muted)" }} aria-hidden="true">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2" style={{ background: rainMode ? "var(--color-rain)" : "var(--color-shade)" }} />
                    {rainMode ? "sheltered" : "shade"}
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      className="h-2 w-2 border border-ink"
                      style={{ background: rainMode ? "transparent" : "var(--color-sun-signal)" }}
                    />
                    {rainMode ? "open" : "sun"}
                  </span>
                  <span className="ml-auto">{routeSplitBasis(route)} share</span>
                </div>
              </>
            )}
          </>
        ) : null}
        {earned && (
          <div className="mt-2 border-t pt-1 text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)", borderColor: "var(--color-rule)" }}>
            <div>{earned}</div>
            {sourceLine && <div>{rainMode ? "Shelter" : "Shadow"} estimate · {sourceLine}</div>}
          </div>
        )}
      </article>

      <div className="flex gap-3">
        <button type="button" onClick={onPlanAnother} className="umbra-start-button flex-1">
          PLAN ANOTHER
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-11 border-2 border-ink px-4 font-extrabold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-small)", color: "var(--color-ink)" }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

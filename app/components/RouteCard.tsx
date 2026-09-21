import type { ReactNode } from "react";
import { token } from "../lib/css-tokens";
import type { RouteOption, RouteLeg } from "../lib/routing";
import type { WeatherHour } from "../lib/heat/types";
import { describeShadowProvenance } from "../lib/shadowProvenance";
import { partialRouteNotice } from "../lib/partialRoute";
import {
  routeLegSummary,
  transitSunCardLabel,
  transitSunCaveat,
  transitSunTone,
} from "../lib/routeLegSummary";
import { rainDryPct, rainExposureLine, rainTradeoffLine } from "../lib/routeRain";
import {
  isTimetableExpired,
  riderFacingNotes,
  transitScheduleLine,
} from "../lib/transitProvenance";
import {
  routeDurationLabel,
  routeExposureLine,
  routeExposureMinutes,
  routeExposureScope,
  routeShadowLabel,
  routeTradeoffLine,
} from "../lib/routeTradeoff";
import { getTravelModePolicy, roughSurfaceLine } from "../lib/travelMode";
import RouteConditionsLine from "./RouteConditionsLine";
import RainRouteSummary from "./RainRouteSummary";

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

interface RouteCardProps {
  route: RouteOption;
  selected: boolean;
  onSelect: () => void;
  onSave?: () => void;
  onExport?: (format: "gpx" | "geojson") => void;
  recommended?: boolean;
  /** The shortest complete route, so every card can state its own trade-off. */
  baselineRoute?: RouteOption;
  /** Rain objective: show shelter figures; absent dryCoverage keeps the sun card. */
  rainMode?: boolean;
  /** 0–10 intensity setting that scales the wet-minute figure only. */
  rainIntensity?: number;
  /** Wind the last rain calculation priced, for the rain details to state. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
  /** The forecast hour at the map's location, for the heat score (selected card). */
  weather?: WeatherHour | null;
  /** The dose line and hourly exposure strip, rendered inside the selected card. */
  exposureSlot?: ReactNode;
}

export default function RouteCard({
  route: r,
  selected,
  onSelect,
  onSave,
  onExport,
  recommended,
  baselineRoute,
  rainMode = false,
  rainIntensity = 5,
  rainWind = null,
  weather = null,
  exposureSlot,
}: RouteCardProps) {
  const rainCard = rainMode && r.dryCoverage !== undefined;
  const streak =
    rainCard
      ? (r.longestContinuousWetM ?? 0) >= 10
        ? `${Math.round(r.longestContinuousWetM ?? 0)}m wet`
        : null
      : r.longestContinuousShadowM >= 10
        ? `${Math.round(r.longestContinuousShadowM)}m shadow`
        : null;
  const transitions = rainCard
    ? (r.wetTransitions ?? 0) === 0
      ? "continuous"
      : `${r.wetTransitions} break${r.wetTransitions === 1 ? "" : "s"}`
    : r.shadowTransitions === 0
      ? "continuous"
      : `${r.shadowTransitions} break${r.shadowTransitions === 1 ? "" : "s"}`;
  const detour = r.detourRatio > 1.05 ? `${r.detourRatio.toFixed(1)}×` : null;
  const shadowPct = rainCard ? rainDryPct(r) : Math.round(r.shadowCoverage * 100);
  // Null when too little of a transit trip's time outdoors is measured; the
  // bar is then not drawn, since an empty one reads as full sun (#393).
  // A rain card has no transit wait, so its figure is always known.
  const shadowKnown = rainCard || routeExposureMinutes(r) !== null;
  // What a transit card's sun figures leave out; null on every other route.
  const exposureScope = rainCard ? null : routeExposureScope(r);
  // Absent on sketch and transit routes, whose shadow was not sampled per sidewalk.
  const shadowSource = rainCard
    ? r.shelterSource
      ? describeShadowProvenance(r.shelterSource)
      : null
    : r.shadowSource
      ? describeShadowProvenance(r.shadowSource)
      : null;
  // Names the avoided surfaces the chosen route still crosses in scoot/bike
  // mode (E4) — raw surface tags, so a smoothness=good sett section is still
  // named, and silence is absence of data, not proof of smooth. Absent on
  // walk, sketch and transit routes.
  const roughLine = roughSurfaceLine(r.surfaceMetresM, r.travelMode ?? "walk");
  const isPartial = !!r.partial;
  const isTransit = !!r.legs?.some((l: RouteLeg) => l.type === "transit");
  const duration = routeDurationLabel(r);
  // The duration verdict is a conversion, and the caption says of what: a
  // fixed pace for walk-priced routes, the walk legs' pace for transit (the
  // ride's own time is timetable provenance, stated in the transit details).
  const policy = getTravelModePolicy(r.travelMode ?? "walk");
  const paceKmh = (policy.speedMps * 3.6).toFixed(1);
  const durationBasis = isTransit
    ? `walk legs at a fixed ${paceKmh} km/h pace + timetable ride + estimated platform wait`
    : `duration at a fixed ${paceKmh} km/h ${policy.gerund} pace`;
  // The one-line trade-off against the shortest complete route. The baseline
  // card's own line drops the trailing shadow/dry figure — it is the verdict
  // one row above, and saying it twice is the lumpiness this redesign removes.
  const tradeoff = baselineRoute
    ? r === baselineRoute
      ? "Shortest baseline"
      : rainCard && baselineRoute.dryCoverage !== undefined
        ? rainTradeoffLine(r, baselineRoute)
        : routeTradeoffLine(r, baselineRoute)
    : rainCard
      ? rainExposureLine(r, rainIntensity)
      : routeExposureLine(r);
  const captionParts = [
    ...(shadowSource ? [shadowSource] : []),
    ...(exposureScope ? [exposureScope] : []),
    durationBasis,
  ];

  return (
    <div
      className={`flex flex-col rounded-xl text-xs transition-all bg-raised border-l-4 ${
        selected ? "p-3.5 shadow-level-2" : "p-3 border-hairline hover:bg-canvas"
      }`}
      style={selected ? { borderColor: "var(--color-route)" } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-h-11 min-w-0 flex-1 text-left"
      >
        {/* Ranking: the recommended option is the one card that gets an
            eyebrow, so the stack reads in rank order at a glance. */}
        {recommended && (
          <div
            className="text-[10px] font-bold uppercase tracking-widest"
            style={{ color: "var(--color-route)" }}
          >
            Recommended
          </div>
        )}

        {/* Verdict row: what it costs in time, at reading size. */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`truncate font-semibold ${selected ? "text-sm" : "text-[13px]"}`}
              style={{ color: "var(--color-ink)" }}
            >
              {r.label}
            </span>
            {isPartial && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ background: "var(--color-sun-soft)", color: "var(--color-sun)" }}
              >
                Partial
              </span>
            )}
          </span>
          <span
            className="shrink-0 text-sm font-bold tabular-nums"
            style={{ color: "var(--color-ink)" }}
          >
            {duration}
          </span>
        </div>

        {r.partial && (
          <div className="mt-1 text-[11px] font-medium" style={{ color: "var(--color-sun-strong)" }}>
            {partialRouteNotice(r.partial)}
          </div>
        )}

        {/* Shade verdict: the bar carries the colour, the number stays ink. */}
        <div className="mt-2 flex items-center gap-2">
          {shadowKnown ? (
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--color-ink) 8%, transparent)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${shadowPct}%`,
                  background: rainCard ? "var(--color-route-mid)" : "var(--color-shade)",
                }}
              />
            </div>
          ) : (
            <div
              className="flex-1 h-1.5 rounded-full border border-dashed"
              style={{ borderColor: "var(--color-ink-muted)" }}
            />
          )}
          <span
            className={`text-[11px] font-semibold whitespace-nowrap ${shadowKnown ? "" : "italic"}`}
            style={{ color: shadowKnown ? "var(--color-ink)" : "var(--color-ink-muted)" }}
          >
            {rainCard ? `${shadowPct}% dry` : routeShadowLabel(r)}
          </span>
          <span className="ml-auto text-[10px] tabular-nums whitespace-nowrap" style={{ color: "var(--color-ink-muted)" }}>
            {formatDist(r.distanceM)}
          </span>
        </div>

        {/* One line states the trade-off; the rest is detail, collapsed away
            unless this card is the selected one. */}
        <div className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
          {tradeoff}
        </div>

        {/* Provenance/uncertainty caption: what the numbers above are made of. */}
        <div className="mt-1 text-[10px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
          {captionParts.join(" · ")}
        </div>
      </button>

      {/* Details — only the selected card carries them, inside the card
          rather than a separate panel above the stack. */}
      {selected && (
        <div
          className="mt-3 flex flex-col gap-3 border-t pt-3"
          style={{ borderColor: "var(--color-hairline)" }}
        >
          <div className="text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
            {rainCard ? rainExposureLine(r, rainIntensity) : routeExposureLine(r)}
          </div>

          {roughLine && (
            <div className="text-[11px] font-medium" style={{ color: "var(--color-sun-strong)" }}>
              {roughLine}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {streak && (
              <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>
                  {rainCard ? "Continuous Wet" : "Continuous Shadow"}
                </div>
                <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{streak}</div>
              </div>
            )}
            {detour && (
              <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Detour Ratio</div>
                <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{detour}</div>
              </div>
            )}
            <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>
                {rainCard ? "Wet Breaks" : "Shadow Breaks"}
              </div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{transitions}</div>
            </div>
            <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Turns</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{r.turnCount}</div>
            </div>
          </div>

          {r.legs && r.legs.length > 1 && (
            <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Journey Legs</div>
              <div className="mt-1 flex flex-col gap-1">
                {r.legs.map((leg, index) => {
                  const summary = routeLegSummary(leg, index, r.travelMode ?? "walk");
                  return (
                    <div key={`${leg.type}-${index}`} className="flex items-center gap-2 text-[10px]">
                      <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: "var(--color-route-soft)", color: "var(--color-route)" }}>
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="font-semibold" style={{ color: "var(--color-ink)" }}>{summary.title}</span>
                        <span style={{ color: "var(--color-ink-muted)" }}> · {summary.detail}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Transit info */}
          {r.legs?.find((l: RouteLeg) => l.type === 'transit') && (() => {
            const tLeg = r.legs!.find((l: RouteLeg) => l.type === 'transit')!;
            const lineColor = tLeg.lineColor ?? token("color-route");
            const lineName = tLeg.lineName ?? tLeg.line ?? 'Transit';
            const stopCount = (tLeg.stops?.length ?? 2) - 1;
            const sunExposure = tLeg.sunExposure ?? 0;
            const sunCoverage = tLeg.sunExposureCoverage;
            const aboveGround = tLeg.aboveGroundShare;
            const sunLabel = transitSunCardLabel(sunExposure, sunCoverage, aboveGround);
            const scheduleLine = transitScheduleLine(r.transitProvenance);
            const notes = riderFacingNotes(r.transitProvenance);
            const expired = isTimetableExpired(r.transitProvenance);
            const sunColor = {
              enclosed: token("color-route"),
              shaded: token("color-shade"),
              sunny: token("color-sun"),
              unknown: "var(--color-ink-muted)",
            }[transitSunTone(sunExposure, sunCoverage, aboveGround)];
            return (
              <div className="text-[10px] flex flex-col gap-0.5" style={{ color: "var(--color-ink-muted)" }}>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lineColor }} />
                  <span style={{ color: "var(--color-ink)" }}>{lineName}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{stopCount} stop{stopCount !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-x-2 flex-wrap">
                  <span style={{ color: sunColor }} title={transitSunCaveat(sunCoverage)}>{sunLabel}</span>
                </div>
                {scheduleLine && (
                  // The producer publishes these statements so a client states
                  // them; the tooltip carries its words verbatim (#410).
                  <div
                    className="flex items-start gap-1"
                    style={{ opacity: 0.75 }}
                    title={notes.join("\n\n")}
                  >
                    <span
                      className="material-symbols-outlined shrink-0"
                      style={{ fontSize: "11px", lineHeight: "1.3" }}
                      aria-hidden="true"
                    >
                      info
                    </span>
                    <span style={expired ? { color: "var(--color-sun)" } : undefined}>
                      {expired ? `${scheduleLine} — this timetable has expired` : scheduleLine}
                    </span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Conditions and dose — the sun/rain detail block the old
              separate summary panel carried, now folded into the card. The
              old panel's guard (never on a partial route) carries over. */}
          {!isPartial && baselineRoute && (
            rainCard ? (
              <RainRouteSummary route={r} rainIntensity={rainIntensity} wind={rainWind} />
            ) : (
              <RouteConditionsLine route={r} baselineRoute={baselineRoute} weather={weather} />
            )
          )}
          {exposureSlot}

          {/* Actions: explicit labelled buttons rather than icon-only targets
              with a hover menu that never existed on touch. */}
          {(onSave || onExport) && !isPartial && (
            <div className="flex gap-2">
              {onSave && (
                <button
                  type="button"
                  onClick={onSave}
                  title="Save this route"
                  className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition-colors hover:bg-canvas"
                  style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink)" }}
                >
                  <span className="material-symbols-outlined text-base" aria-hidden="true">bookmark</span>
                  Save
                </button>
              )}
              {onExport && (
                <>
                  <button
                    type="button"
                    onClick={() => onExport("gpx")}
                    title="Export route as GPX"
                    className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition-colors hover:bg-canvas"
                    style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink)" }}
                  >
                    <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
                    GPX
                  </button>
                  <button
                    type="button"
                    onClick={() => onExport("geojson")}
                    title="Export route as GeoJSON"
                    className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition-colors hover:bg-canvas"
                    style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink)" }}
                  >
                    <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
                    GeoJSON
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
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
import { rainExposureLine, rainTradeoffLine } from "../lib/routeRain";
import {
  isTimetableExpired,
  riderFacingNotes,
  transitScheduleLine,
} from "../lib/transitProvenance";
import {
  routeAfterSunset,
  routeDurationLabel,
  routeExposureLine,
  routeExposureMinutes,
  routeExposureScope,
  routeShadowLabel,
  routeShadowShare,
  routeSplitBasis,
  routeTradeoffLine,
} from "../lib/routeTradeoff";
import { getTravelModePolicy, roughSurfaceLine } from "../lib/travelMode";
import RouteConditionsLine from "./RouteConditionsLine";
import RainRouteSummary from "./RainRouteSummary";
import Kicker from "./ui/Kicker";
import LineBullet from "./ui/LineBullet";
import Tag from "./ui/Tag";

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
  /** Deprecated compatibility prop; rain exposure is never intensity-scaled. */
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
  const rainCard = rainMode && (r.objective === "rain" || r.dryCoverage !== undefined);
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
  const shelterPct = r.exposure?.shelteredDistancePct ?? (r.dryCoverage ?? null);
  const shadowPct = rainCard ? (shelterPct == null ? null : Math.round(shelterPct * 100)) : Math.round(routeShadowShare(r) * 100);
  const exposureUnknown = rainCard
    ? (r.exposure?.unknownDistanceM ?? 0) > 0 || (r.exposure?.unknownDurationSec ?? 0) > 0
    : false;
  const exposureUpdating = rainCard && r.exposureUpdating;
  // Null when too little of a transit trip's time outdoors is measured; the
  // bar is then not drawn, since an empty one reads as full sun (#393).
  // A rain card has no transit wait, so its figure is always known.
  const shadowKnown = rainCard
    ? !exposureUpdating && shadowPct != null && !exposureUnknown
    : routeExposureMinutes(r) !== null;
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
      : rainCard
        ? r.dryCoverage !== undefined && baselineRoute.dryCoverage !== undefined
          ? rainTradeoffLine(r, baselineRoute)
          : r.exposure?.unknownDurationSec
            ? "Rain shelter comparison unavailable"
            : rainTradeoffLine(r, baselineRoute)
        : routeTradeoffLine(r, baselineRoute)
    : rainCard
      ? exposureUpdating
        ? "route choices from earlier conditions · updating shelter…"
        : rainExposureLine(r, rainIntensity)
      : routeExposureLine(r);
  const captionParts = [
    ...(shadowSource ? [shadowSource] : []),
    ...(exposureScope ? [exposureScope] : []),
    durationBasis,
  ];

  // Night (sun at or below the horizon where the route was evaluated): the
  // shadow share is every metre by definition, so the card quotes no daylight
  // percentage and draws no split bar, and says why instead (R5).
  const afterSunset = !rainCard && routeAfterSunset(r);
  const showBar = shadowKnown && !afterSunset;
  const transitLegs = r.legs?.filter((l: RouteLeg) => l.type === "transit") ?? [];
  const verdictLabel = rainCard
    ? exposureUpdating
      ? "updating shelter…"
      : shadowPct == null || exposureUnknown
        ? "shelter unknown"
        : `${shadowPct}% sheltered`
    : routeShadowLabel(r);

  return (
    <div
      className={`flex flex-col border-2 bg-panel text-xs transition-colors ${
        selected ? "border-ink p-3.5 shadow-hard-2" : "border-rule p-3 hover:bg-ground"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-h-11 min-w-0 flex-1 text-left"
      >
        {/* Transit strip head: the option on a kicker plate, its lines as
            bullets, and — on one card only, so the stack reads in rank order —
            the recommendation, as a shade or neutral label, never orange.
            Hidden while a rain route's shelter figures are still updating. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Kicker plated>{r.label}</Kicker>
          {isPartial && <Tag>Partial</Tag>}
          {transitLegs.map((leg) => (
            <LineBullet
              // One boarding per leg: the line and where it is boarded name it.
              key={`${leg.line ?? leg.lineName}-${leg.stops?.[0]}`}
              accent={leg.lineColor}
              code={leg.line || leg.lineName || "?"}
            />
          ))}
          {recommended && !exposureUpdating && (
            <Tag tone={rainCard ? "rain" : "shade"} className="ml-auto">
              Recommended
            </Tag>
          )}
        </div>

        {/* Verdict row: duration, then the shade verdict, in the square
            tabular numeric face — never the display face, never tilted. */}
        <div className="mt-2 flex items-baseline gap-2">
          <span
            className="font-numeric text-verdict shrink-0 font-bold leading-none tabular-nums tracking-[-0.02em]"
            style={{ color: "var(--color-ink)" }}
          >
            {duration}
          </span>
          <span
            className={`min-w-0 truncate font-numeric text-[13px] font-extrabold ${showBar ? "" : "italic"}`}
            style={{
              color: showBar ? (rainCard ? "var(--color-rain)" : "var(--color-shade)") : "var(--color-ink-muted)",
            }}
          >
            {verdictLabel}
          </span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
            {formatDist(r.distanceM)}
          </span>
        </div>

        {r.partial && (
          <div className="mt-1 text-[11px] font-medium" style={{ color: "var(--color-ink-muted)" }}>
            {partialRouteNotice(r.partial)}
          </div>
        )}

        {/* The split bar: shade (cool) against sun (signal orange — sun data,
            not decoration), square and ink-ruled, with what it is a share of
            stated under it. Rain cards split sheltered against open on a
            neutral track: shelter is not sun data. Not drawn after sunset or
            when the share is unknown — an empty bar reads as full sun (issue 393). */}
        {showBar ? (
          <>
            <div className="mt-2 flex h-3 border border-ink" aria-hidden="true">
              <div
                className="h-full transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${shadowPct ?? 0}%`, background: rainCard ? "var(--color-rain)" : "var(--color-shade)" }}
              />
              {(shadowPct ?? 0) < 100 && (
                <div
                  className={`h-full flex-1 ${(shadowPct ?? 0) > 0 ? "border-l-2 border-panel" : ""}`}
                  style={{
                    background: rainCard
                      ? "color-mix(in srgb, var(--color-ink) 8%, transparent)"
                      : "var(--color-sun-signal)",
                  }}
                />
              )}
            </div>
            {/* The key, for sighted readers; the verdict text above carries the figure. */}
            <div className="mt-1 flex items-center gap-3 font-mono text-[11px]" style={{ color: "var(--color-ink-muted)" }} aria-hidden="true">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2" style={{ background: rainCard ? "var(--color-rain)" : "var(--color-shade)" }} aria-hidden="true" />
                {rainCard ? "sheltered" : "shade"}
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="h-2 w-2 border border-ink"
                  style={{ background: rainCard ? "transparent" : "var(--color-sun-signal)" }}
                  aria-hidden="true"
                />
                {rainCard ? "open" : "sun"}
              </span>
              <span className="ml-auto">{routeSplitBasis(r)} share</span>
            </div>
          </>
        ) : (
          !afterSunset && (
            <div className="mt-2 h-1.5 border border-dashed" style={{ borderColor: "var(--color-ink-muted)" }} />
          )
        )}

        {/* One line states the trade-off; the rest is detail, collapsed away
            unless this card is the selected one. */}
        <div className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
          {tradeoff}
        </div>

        {/* Provenance/uncertainty caption: what the numbers above are made of.
            Three middle-dot facts are one chunk; a fourth starts a second line
            instead of diluting the first into an unscannable run (U5). */}
        {captionParts.length > 0 && (
          <div className="mt-1 border-t pt-1 text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)", borderColor: "var(--color-rule)" }}>
            <div>{captionParts.slice(0, 3).join(" · ")}</div>
            {captionParts.length > 3 && <div>{captionParts.slice(3).join(" · ")}</div>}
          </div>
        )}
      </button>

      {/* Details — only the selected card carries them, inside the card
          rather than a separate panel above the stack. */}
      {selected && (
        <div
          className="mt-3 flex flex-col gap-3 border-t-2 pt-3"
          style={{ borderColor: "var(--color-ink)" }}
        >
          <div className="text-[11px] leading-snug" style={{ color: "var(--color-ink-muted)" }}>
            {rainCard ? rainExposureLine(r, rainIntensity) : routeExposureLine(r)}
          </div>

          {roughLine && (
            <div className="text-[11px] font-medium" style={{ color: "var(--color-ink-muted)" }}>
              {roughLine}
            </div>
          )}

          {/* The strip's fare table: square ruled cells, key over value.
              Continuity and breaks are per-edge shade figures: they drop out
              after sunset with the percentage, and on transit, whose shade
              was never sampled edge by edge (their zeros are placeholders). */}
          <dl className="grid grid-cols-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
            {[
              ...(streak && !afterSunset && !isTransit ? [[rainCard ? "Continuous shelter" : "Continuous shadow", streak]] : []),
              ...(detour ? [["Detour ratio", detour]] : []),
              ...(afterSunset || isTransit ? [] : [[rainCard ? "Shelter breaks" : "Shadow breaks", transitions]]),
              ["Turns", String(r.turnCount)],
            ].map(([key, value], i) => (
              <div
                key={key}
                className={`border-b py-1.5 ${i % 2 === 0 ? "pr-2" : "border-l pl-2"}`}
                style={{ borderColor: "var(--color-rule)" }}
              >
                <dt className="umbra-kicker">{key}</dt>
                <dd className="mt-0.5 font-numeric text-xs font-bold tabular-nums" style={{ color: "var(--color-ink)" }}>{value}</dd>
              </div>
            ))}
          </dl>

          {r.legs && r.legs.length > 1 && (
            <div>
              <div className="umbra-kicker">Journey legs</div>
              <ol className="mt-1 flex flex-col gap-1.5">
                {r.legs.map((leg, index) => {
                  const summary = routeLegSummary(leg, index, r.travelMode ?? "walk", afterSunset);
                  return (
                    <li key={`${leg.type}-${index}`} className="flex items-center gap-2 text-[11px]">
                      {leg.type === "transit" ? (
                        <LineBullet accent={leg.lineColor} code={leg.line || leg.lineName || "?"} className="shrink-0" />
                      ) : (
                        <span className="material-symbols-outlined shrink-0 text-base" style={{ color: "var(--color-ink-muted)" }} aria-hidden="true">
                          directions_walk
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="font-semibold" style={{ color: "var(--color-ink)" }}>{summary.title}</span>
                        <span style={{ color: "var(--color-ink-muted)" }}> · {summary.detail}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* Transit info */}
          {r.legs?.find((l: RouteLeg) => l.type === 'transit') && (() => {
            const tLeg = r.legs!.find((l: RouteLeg) => l.type === 'transit')!;
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
              enclosed: "var(--color-route)",
              shaded: "var(--color-shade)",
              sunny: "var(--color-sun)",
              unknown: "var(--color-ink-muted)",
            }[transitSunTone(sunExposure, sunCoverage, aboveGround)];
            const rainTransit = rainCard && r.objective === "rain";
            const rainLabel = tLeg.waitExposure?.shelter == null
              ? "outdoor wait shelter unknown"
              : `${Math.round(tLeg.waitExposure.shelter * 100)}% sheltered at stops`;
            return (
              <div className="text-[11px] flex flex-col gap-0.5" style={{ color: "var(--color-ink-muted)" }}>
                <div className="flex items-center gap-1.5">
                  <LineBullet accent={tLeg.lineColor} code={tLeg.line || lineName} label={lineName} />
                  <span>{stopCount} stop{stopCount !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-x-2 flex-wrap">
                  {rainTransit ? (
                    <span style={{ color: "var(--color-rain)" }}>
                      {rainLabel} · {tLeg.vehicleSheltered ? "ride sheltered by enclosed-vehicle assumption" : "ride shelter unknown"}
                    </span>
                  ) : (
                    <span style={{ color: sunColor }} title={transitSunCaveat(sunCoverage)}>{sunLabel}</span>
                  )}
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
                    <span style={expired ? { color: "var(--color-danger)" } : undefined}>
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
                  className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-sm border text-[11px] font-medium transition-colors hover:bg-ground"
                  style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
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
                    className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-sm border text-[11px] font-medium transition-colors hover:bg-ground"
                    style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
                  >
                    <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
                    GPX
                  </button>
                  <button
                    type="button"
                    onClick={() => onExport("geojson")}
                    title="Export route as GeoJSON"
                    className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-sm border text-[11px] font-medium transition-colors hover:bg-ground"
                    style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
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

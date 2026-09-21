import { token } from "../lib/css-tokens";
import type { RouteOption, RouteLeg } from "../lib/routing";
import { describeShadowProvenance } from "../lib/shadowProvenance";
import { partialRouteNotice } from "../lib/partialRoute";
import {
  routeLegSummary,
  transitSunCardLabel,
  transitSunCaveat,
  transitSunTone,
} from "../lib/routeLegSummary";
import { rainExposureLine } from "../lib/routeRain";
import {
  isTimetableExpired,
  riderFacingNotes,
  transitScheduleLine,
} from "../lib/transitProvenance";
import { routeExposureLine, routeExposureMinutes, routeExposureScope, routeShadowLabel } from "../lib/routeTradeoff";
import { roughSurfaceLine } from "../lib/travelMode";

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
  /** Rain objective: show shelter figures; absent dryCoverage keeps the sun card. */
  rainMode?: boolean;
  /** Deprecated compatibility prop; rain exposure is never intensity-scaled. */
  rainIntensity?: number;
}

export default function RouteCard({ route: r, selected, onSelect, onSave, onExport, recommended, rainMode = false, rainIntensity: _rainIntensity = 5 }: RouteCardProps) {
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
  const shadowPct = rainCard ? (shelterPct == null ? null : Math.round(shelterPct * 100)) : Math.round(r.shadowCoverage * 100);
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

  return (
    <div
      className={`flex gap-1.5 items-start rounded-lg text-xs transition-all ${
        selected
          ? 'bg-raised p-4 shadow-level-2 border-l-4'
          : 'bg-raised p-3 border-l-4 border-hairline hover:bg-canvas'
      }`}
      style={selected ? { borderColor: "var(--color-route)" } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-w-0 flex-1 text-left"
      >
        {/* Header */}
        <div className="flex justify-between items-center">
          <span className="flex items-center gap-1.5">
            <span
              className={`font-semibold ${selected ? 'text-sm' : ''}`}
              style={{ color: selected ? "var(--color-ink)" : "var(--color-ink-muted)" }}
            >
              {r.label}
            </span>
            {recommended && !exposureUpdating && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ background: "var(--color-route-soft)", color: "var(--color-route)" }}
              >
                Recommended
              </span>
            )}
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
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
              shadowKnown ? "" : "border border-dashed"
            }`}
            style={
              shadowKnown
                ? {
                    background: selected ? "var(--color-route-soft)" : "color-mix(in srgb, var(--color-ink) 8%, transparent)",
                    color: selected ? "var(--color-ink)" : "var(--color-ink-muted)",
                  }
                : { borderColor: "var(--color-ink-muted)", color: "var(--color-ink-muted)" }
            }
          >
            {rainCard
              ? exposureUpdating
                ? "updating shelter…"
                : (shadowPct == null || exposureUnknown ? "shelter unknown" : `${shadowPct}% sheltered`)
              : routeShadowLabel(r)}
          </span>
        </div>

        {r.partial && (
          <div className="mt-1 text-[11px] font-medium" style={{ color: "var(--color-sun-strong)" }}>
            {partialRouteNotice(r.partial)}
          </div>
        )}

        {/* Shadow bar */}
        <div className="mt-2 flex items-center gap-2">
          {shadowKnown ? (
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--color-ink) 8%, transparent)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${shadowPct ?? 0}%`,
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
          <span className="text-[10px] tabular-nums w-12 text-right" style={{ color: "var(--color-ink-muted)" }}>
            {formatDist(r.distanceM)}
          </span>
        </div>

        <div className="mt-1 text-[10px]" style={{ color: "var(--color-ink-muted)" }}>
          {rainCard ? (exposureUpdating ? "route choices from earlier conditions · updating shelter…" : rainExposureLine(r)) : routeExposureLine(r)}
          {!rainCard && exposureScope && ` · ${exposureScope}`}
        </div>

        {roughLine && (
          <div className="mt-1 text-[10px] font-medium" style={{ color: "var(--color-sun-strong)" }}>
            {roughLine}
          </div>
        )}

        {shadowSource && (
          <div className="mt-1 text-[10px]" style={{ color: "var(--color-ink-muted)" }}>
            {shadowSource}
          </div>
        )}

        {/* Metrics grid — only on selected */}
        {selected && (
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Distance</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{formatDist(r.distanceM)}</div>
            </div>
            {streak && (
              <div className="rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>
                  {rainCard ? "Continuous shelter" : "Continuous Shadow"}
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
                  {rainCard ? "Shelter breaks" : "Shadow Breaks"}
              </div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--color-ink)" }}>{transitions}</div>
            </div>
          </div>
        )}

        {selected && r.legs && r.legs.length > 1 && (
          <div className="mt-3 rounded-lg p-2" style={{ background: "var(--color-canvas)" }}>
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

        {/* Compact metrics — only on unselected */}
        {!selected && (streak || detour || r.turnCount > 0) && (
          <div className="text-[10px] mt-1 flex flex-wrap gap-x-2" style={{ color: "var(--color-ink-muted)" }}>
            {streak && <span>{streak}</span>}
            <span>{transitions}</span>
            {detour && <span>{detour} detour</span>}
            {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? '' : 's'}</span>}
          </div>
        )}

        {/* Transit info */}
        {r.legs?.find((l: RouteLeg) => l.type === 'transit') && (() => {
          const tLeg = r.legs!.find((l: RouteLeg) => l.type === 'transit')!;
          const lineColor = tLeg.lineColor ?? token("color-route");
          const lineName = tLeg.lineName ?? tLeg.line ?? 'Transit';
          const stopCount = (tLeg.stops?.length ?? 2) - 1;
          const totalMin = Math.ceil((r.totalTimeSec ?? 0) / 60);
          const rainTransit = rainCard && r.objective === "rain";
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
          const rainLabel = tLeg.waitExposure?.shelter == null
            ? "outdoor wait shelter unknown"
            : `${Math.round(tLeg.waitExposure.shelter * 100)}% sheltered at stops`;
          return (
            <div className="mt-2 text-[10px] flex flex-col gap-0.5" style={{ color: "var(--color-ink-muted)" }}>
              <div className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lineColor }} />
                <span style={{ color: "var(--color-ink)" }}>{lineName}</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>{stopCount} stop{stopCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex gap-x-2 flex-wrap">
                <span>{totalMin} min total</span>
                <span style={{ opacity: 0.4 }}>·</span>
                {rainTransit ? (
                  <span style={{ color: "var(--color-route)" }}>
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
                  <span style={expired ? { color: "var(--color-sun)" } : undefined}>
                    {expired ? `${scheduleLine} — this timetable has expired` : scheduleLine}
                  </span>
                </div>
              )}
            </div>
          );
        })()}
      </button>

      {onSave && !isPartial && (
        <button
          type="button"
          onClick={onSave}
          title="Save this route"
          className="shrink-0 mt-0.5 p-1.5 rounded-lg text-ink-faint hover:text-route hover:bg-route-soft transition-all"
        >
          <span className="material-symbols-outlined text-base">bookmark</span>
        </button>
      )}

      {onExport && !isPartial && (
        <div className="relative group/export shrink-0 mt-0.5">
          <button type="button" className="p-1.5 rounded-lg text-ink-faint hover:text-ink-muted transition-colors" title="Export route">
            <span className="material-symbols-outlined text-base">download</span>
          </button>
          <div
            className="hidden group-hover/export:flex absolute right-0 top-full mt-1 flex-col rounded-lg shadow-xl z-30 min-w-max border"
            style={{ background: "white", borderColor: "var(--color-hairline)" }}
          >
            <button type="button" onClick={() => onExport("gpx")} className="px-3 py-1.5 text-[11px] hover:bg-canvas text-left transition-colors" style={{ color: "var(--color-ink)" }}>GPX</button>
            <button type="button" onClick={() => onExport("geojson")} className="px-3 py-1.5 text-[11px] hover:bg-canvas text-left transition-colors" style={{ color: "var(--color-ink)" }}>GeoJSON</button>
          </div>
        </div>
      )}
    </div>
  );
}

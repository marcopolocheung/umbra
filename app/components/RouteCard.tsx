import type { RouteOption, RouteLeg } from "../lib/routing";
import { describeShadowProvenance } from "../lib/shadowProvenance";
import { partialRouteNotice } from "../lib/partialRoute";
import {
  routeLegSummary,
  transitSunCardLabel,
  transitSunCaveat,
  transitSunTone,
} from "../lib/routeLegSummary";
import { rainDryPct, rainExposureLine } from "../lib/routeRain";
import {
  isTimetableExpired,
  riderFacingNotes,
  transitScheduleLine,
} from "../lib/transitProvenance";
import { routeExposureLine } from "../lib/routeTradeoff";
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
  /** 0–10 intensity setting that scales the wet-minute figure only. */
  rainIntensity?: number;
}

export default function RouteCard({ route: r, selected, onSelect, onSave, onExport, recommended, rainMode = false, rainIntensity = 5 }: RouteCardProps) {
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
          ? 'bg-white/80 backdrop-blur-xl p-4 shadow-xl border-l-4'
          : 'bg-white/60 backdrop-blur-md p-3 border-l-4 border-slate-200 hover:bg-white/70'
      }`}
      style={selected ? { borderColor: "var(--md-primary)" } : undefined}
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
              style={{ color: selected ? "var(--md-on-surface)" : "var(--md-on-surface-variant)" }}
            >
              {r.label}
            </span>
            {recommended && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ background: "var(--md-primary-container)", color: "var(--md-on-primary-container)" }}
              >
                Recommended
              </span>
            )}
            {isPartial && (
              <span
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(217,119,6,0.12)", color: "#92400e" }}
              >
                Partial
              </span>
            )}
          </span>
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{
              background: selected ? "var(--md-primary-container)" : "rgba(130,85,0,0.08)",
              color: selected ? "var(--md-on-surface)" : "var(--md-on-surface-variant)",
            }}
          >
            {shadowPct}%{rainCard ? " dry" : " shadow"}
          </span>
        </div>

        {r.partial && (
          <div className="mt-1 text-[11px] font-medium" style={{ color: "#a16207" }}>
            {partialRouteNotice(r.partial)}
          </div>
        )}

        {/* Shadow bar */}
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(130,85,0,0.08)" }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${shadowPct}%`,
                background: rainCard ? "rgba(14,116,144,0.55)" : "var(--md-primary-container)",
              }}
            />
          </div>
          <span className="text-[10px] tabular-nums w-12 text-right" style={{ color: "var(--md-on-surface-variant)" }}>
            {formatDist(r.distanceM)}
          </span>
        </div>

        <div className="mt-1 text-[10px]" style={{ color: "var(--md-on-surface-variant)" }}>
          {rainCard ? rainExposureLine(r, rainIntensity) : routeExposureLine(r)}
        </div>

        {roughLine && (
          <div className="mt-1 text-[10px] font-medium" style={{ color: "#a16207" }}>
            {roughLine}
          </div>
        )}

        {shadowSource && (
          <div className="mt-1 text-[10px]" style={{ color: "var(--md-on-surface-variant)" }}>
            {shadowSource}
          </div>
        )}

        {/* Metrics grid — only on selected */}
        {selected && (
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="rounded-lg p-2" style={{ background: "var(--md-surface-container-low)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--md-on-surface-variant)" }}>Distance</div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--md-on-surface)" }}>{formatDist(r.distanceM)}</div>
            </div>
            {streak && (
              <div className="rounded-lg p-2" style={{ background: "var(--md-surface-container-low)" }}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--md-on-surface-variant)" }}>
                  {rainCard ? "Continuous Wet" : "Continuous Shadow"}
                </div>
                <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--md-on-surface)" }}>{streak}</div>
              </div>
            )}
            {detour && (
              <div className="rounded-lg p-2" style={{ background: "var(--md-surface-container-low)" }}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--md-on-surface-variant)" }}>Detour Ratio</div>
                <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--md-on-surface)" }}>{detour}</div>
              </div>
            )}
            <div className="rounded-lg p-2" style={{ background: "var(--md-surface-container-low)" }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--md-on-surface-variant)" }}>
                {rainCard ? "Wet Breaks" : "Shadow Breaks"}
              </div>
              <div className="text-xs font-semibold mt-0.5" style={{ color: "var(--md-on-surface)" }}>{transitions}</div>
            </div>
          </div>
        )}

        {selected && r.legs && r.legs.length > 1 && (
          <div className="mt-3 rounded-lg p-2" style={{ background: "var(--md-surface-container-low)" }}>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--md-on-surface-variant)" }}>Journey Legs</div>
            <div className="mt-1 flex flex-col gap-1">
              {r.legs.map((leg, index) => {
                const summary = routeLegSummary(leg, index, r.travelMode ?? "walk");
                return (
                  <div key={`${leg.type}-${index}`} className="flex items-center gap-2 text-[10px]">
                    <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: "var(--md-primary-container)", color: "var(--md-on-primary-container)" }}>
                      {index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="font-semibold" style={{ color: "var(--md-on-surface)" }}>{summary.title}</span>
                      <span style={{ color: "var(--md-on-surface-variant)" }}> · {summary.detail}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Compact metrics — only on unselected */}
        {!selected && (streak || detour || r.turnCount > 0) && (
          <div className="text-[10px] mt-1 flex flex-wrap gap-x-2" style={{ color: "var(--md-on-surface-variant)" }}>
            {streak && <span>{streak}</span>}
            <span>{transitions}</span>
            {detour && <span>{detour} detour</span>}
            {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? '' : 's'}</span>}
          </div>
        )}

        {/* Transit info */}
        {r.legs?.find((l: RouteLeg) => l.type === 'transit') && (() => {
          const tLeg = r.legs!.find((l: RouteLeg) => l.type === 'transit')!;
          const lineColor = tLeg.lineColor ?? '#0070BD';
          const lineName = tLeg.lineName ?? tLeg.line ?? 'Transit';
          const stopCount = (tLeg.stops?.length ?? 2) - 1;
          const totalMin = Math.ceil((r.totalTimeSec ?? 0) / 60);
          const sunExposure = tLeg.sunExposure ?? 0;
          const sunCoverage = tLeg.sunExposureCoverage;
          const aboveGround = tLeg.aboveGroundShare;
          const sunLabel = transitSunCardLabel(sunExposure, sunCoverage, aboveGround);
          const scheduleLine = transitScheduleLine(r.transitProvenance);
          const notes = riderFacingNotes(r.transitProvenance);
          const expired = isTimetableExpired(r.transitProvenance);
          const sunColor = {
            enclosed: "#0e7490",
            shaded: "#15803d",
            sunny: "#a16207",
            unknown: "var(--md-on-surface-variant)",
          }[transitSunTone(sunExposure, sunCoverage, aboveGround)];
          return (
            <div className="mt-2 text-[10px] flex flex-col gap-0.5" style={{ color: "var(--md-on-surface-variant)" }}>
              <div className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: lineColor }} />
                <span style={{ color: "var(--md-on-surface)" }}>{lineName}</span>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>{stopCount} stop{stopCount !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex gap-x-2 flex-wrap">
                <span>{totalMin} min total</span>
                <span style={{ opacity: 0.4 }}>·</span>
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
                  <span style={expired ? { color: "#b45309" } : undefined}>
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
          className="shrink-0 mt-0.5 p-1.5 rounded-lg text-slate-400 hover:text-amber-700 hover:bg-amber-50 transition-all"
        >
          <span className="material-symbols-outlined text-base">bookmark</span>
        </button>
      )}

      {onExport && !isPartial && (
        <div className="relative group/export shrink-0 mt-0.5">
          <button type="button" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 transition-colors" title="Export route">
            <span className="material-symbols-outlined text-base">download</span>
          </button>
          <div
            className="hidden group-hover/export:flex absolute right-0 top-full mt-1 flex-col rounded-lg shadow-xl z-30 min-w-max border"
            style={{ background: "white", borderColor: "var(--md-outline-variant)" }}
          >
            <button type="button" onClick={() => onExport("gpx")} className="px-3 py-1.5 text-[11px] hover:bg-amber-50 text-left transition-colors" style={{ color: "var(--md-on-surface)" }}>GPX</button>
            <button type="button" onClick={() => onExport("geojson")} className="px-3 py-1.5 text-[11px] hover:bg-amber-50 text-left transition-colors" style={{ color: "var(--md-on-surface)" }}>GeoJSON</button>
          </div>
        </div>
      )}
    </div>
  );
}

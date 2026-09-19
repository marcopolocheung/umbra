import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import { rainExposureLine, rainTradeoffLine } from "../lib/routeRain";
import { routeExposureLine, routeTradeoffLine } from "../lib/routeTradeoff";
import RainRouteSummary from "./RainRouteSummary";
import RouteConditionsLine from "./RouteConditionsLine";

interface RouteTradeoffSummaryProps {
  route?: RouteOption;
  baselineRoute?: RouteOption;
  /** The forecast hour at the map's location, or null when none is available. */
  weather?: WeatherHour | null;
  /** Rain objective active: swap the figures and suppress the sun-derived ones. */
  rainMode?: boolean;
  /** 0–10 user setting that scales the wet-minute figure only. */
  rainIntensity?: number;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
}

export default function RouteTradeoffSummary({
  route,
  baselineRoute,
  weather = null,
  rainMode = false,
  rainIntensity = 5,
  rainWind = null,
}: RouteTradeoffSummaryProps) {
  if (!route || route.partial || !baselineRoute) return null;

  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-l-2 px-3 py-2 shadow-lg backdrop-blur-xl"
      style={{
        background: "rgba(255,255,255,0.86)",
        borderColor: "var(--md-outline-variant)",
        borderLeftColor: "var(--md-primary)",
      }}
    >
      <div
        className="text-[10px] uppercase tracking-widest font-bold"
        style={{ color: "var(--md-on-surface-variant)" }}
      >
        Selected route
      </div>
      {rainMode && route.dryCoverage !== undefined && baselineRoute.dryCoverage !== undefined ? (
        <>
          <div className="text-sm font-semibold leading-snug" style={{ color: "var(--md-primary)" }}>
            {rainTradeoffLine(route, baselineRoute)}
          </div>
          <div className="text-xs leading-snug" style={{ color: "var(--md-on-surface-variant)" }}>
            {rainExposureLine(route, rainIntensity)}
          </div>
          <RainRouteSummary route={route} rainIntensity={rainIntensity} wind={rainWind} />
        </>
      ) : (
        <>
          <div className="text-sm font-semibold leading-snug" style={{ color: "var(--md-primary)" }}>
            {routeTradeoffLine(route, baselineRoute)}
          </div>
          <div className="text-xs leading-snug" style={{ color: "var(--md-on-surface-variant)" }}>
            {routeExposureLine(route)}
          </div>
          <RouteConditionsLine route={route} baselineRoute={baselineRoute} weather={weather} />
        </>
      )}
    </div>
  );
}

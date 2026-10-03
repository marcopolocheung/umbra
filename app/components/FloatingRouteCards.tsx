import type { ReactNode } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import { routeAfterSunset, shortestRoute } from "../lib/routeTradeoff";
import RouteCard from "./RouteCard";
import SolarPill from "./SolarPill";

interface FloatingRouteCardsProps {
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  onSaveRoute?: (routeIndex: number) => void;
  onExportRoute?: (routeIndex: number, format: "gpx" | "geojson") => void;
  /** The forecast hour at the map's location, for the heat score. */
  weather?: WeatherHour | null;
  solarIntensity?: number | null;
  onStartNavigation?: () => void;
  grip?: ReactNode;
  position?: { x: number; y: number } | null;
  dragging?: boolean;
  /** The dose line and hourly exposure strip, rendered in the selected card. */
  exposureSlot?: ReactNode;
  /** Rain objective: cards present shelter, and the solar pill steps aside. */
  rainMode?: boolean;
  /** Deprecated compatibility prop; rain exposure is never intensity-scaled. */
  rainIntensity?: number;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
  /** S2b: the learned shade preference behind the default card. */
  learnedPreference?: { detourM: number; picks: number; stated: boolean } | null;
  onResetLearnedPreference?: () => void;
}

function routeKey(route: RouteOption): string {
  const protection = route.objective === "rain"
    ? route.exposure?.shelteredDistancePct ?? route.dryCoverage ?? 0
    : route.shadowCoverage;
  return `${route.label}-${Math.round(route.distanceM)}-${Math.round(protection * 1000)}`;
}

export default function FloatingRouteCards({
  routes,
  selectedRouteIndex,
  onSelectRoute,
  onSaveRoute,
  onExportRoute,
  weather = null,
  solarIntensity,
  onStartNavigation,
  grip,
  position = null,
  dragging = false,
  exposureSlot,
  rainMode = false,
  rainIntensity = 5,
  rainWind = null,
  learnedPreference = null,
  onResetLearnedPreference,
}: FloatingRouteCardsProps) {
  if (routes.length === 0) return null;
  const baselineRoute = shortestRoute(routes);
  const completeBaselineRoute = shortestRoute(routes.filter((route) => !route.partial)) ?? baselineRoute;
  const selectedRoute = routes[selectedRouteIndex];

  return (
    <div
      data-testid="route-preview-floating"
      data-route-preview-surface="float"
      className={`hidden md:flex absolute bottom-24 w-80 pointer-events-none ${position ? "" : "right-6 top-20"} ${dragging ? "z-50" : "z-30"}`}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div
        className="pointer-events-auto flex max-h-full w-full flex-col gap-3 border p-3 shadow-hard-2"
        style={{
          background: "var(--color-panel)",
          borderColor: "var(--color-rule)",
        }}
      >
        {grip}
        {/* Solar pill — sun semantics, so it yields to a rain objective. The
            recommended option needs no header here: the card says it. */}
        {!rainMode && solarIntensity != null && (
          <SolarPill intensity={solarIntensity} afterSunset={routeAfterSunset(selectedRoute ?? routes[0])} />
        )}

        {/* Route cards — the selected card carries the detail block. Same
            radiogroup semantics as the panel's stack (U4). */}
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto umbra-scrollbar"
          role="radiogroup"
          aria-label="Route options"
        >
          {routes.map((r, i) => (
            <RouteCard
              key={routeKey(r)}
              route={r}
              selected={i === selectedRouteIndex}
              onSelect={() => onSelectRoute(i)}
              onSave={onSaveRoute ? () => onSaveRoute(i) : undefined}
              onExport={onExportRoute ? (fmt) => onExportRoute(i, fmt) : undefined}
              recommended={!r.exposureUpdating && (rainMode ? r.label === "Driest" : r.label === "Balanced")}
              baselineRoute={completeBaselineRoute ?? undefined}
              rainMode={rainMode}
              rainIntensity={rainIntensity}
              rainWind={rainWind}
              weather={weather}
              exposureSlot={i === selectedRouteIndex ? exposureSlot : undefined}
              learnedPreference={i === selectedRouteIndex ? learnedPreference : undefined}
              onResetLearnedPreference={onResetLearnedPreference}
            />
          ))}
        </div>

        {/* Start navigating */}
        {onStartNavigation && !selectedRoute?.partial && (
          <button type="button" onClick={onStartNavigation} className="umbra-start-button">
            START NAVIGATING
          </button>
        )}
      </div>
    </div>
  );
}

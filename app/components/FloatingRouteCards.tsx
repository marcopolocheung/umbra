import type { ReactNode } from "react";
import type { WeatherHour } from "../lib/heat/types";
import type { RouteOption } from "../lib/routing";
import { shortestRoute } from "../lib/routeTradeoff";
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
  /** The dose line and hourly exposure strip, rendered in the selected card. */
  exposureSlot?: ReactNode;
  /** Rain objective: cards present shelter, and the solar pill steps aside. */
  rainMode?: boolean;
  /** Deprecated compatibility prop; rain exposure is never intensity-scaled. */
  rainIntensity?: number;
  /** Wind the last rain calculation priced, for the card to state it. */
  rainWind?: { dirDeg: number | null; windMs: number | null } | null;
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
  exposureSlot,
  rainMode = false,
  rainIntensity = 5,
  rainWind = null,
}: FloatingRouteCardsProps) {
  if (routes.length === 0) return null;
  const baselineRoute = shortestRoute(routes);
  const completeBaselineRoute = shortestRoute(routes.filter((route) => !route.partial)) ?? baselineRoute;
  const selectedRoute = routes[selectedRouteIndex];

  return (
    <div className="hidden md:flex absolute right-6 top-20 bottom-24 w-80 z-30 pointer-events-none">
      <div
        className="pointer-events-auto flex max-h-full w-full flex-col gap-3 rounded-xl border p-3 shadow-level-2"
        style={{
          background: "var(--color-raised)",
          borderColor: "var(--color-hairline)",
        }}
      >
        {/* Solar pill — sun semantics, so it yields to a rain objective. The
            recommended option needs no header here: the card says it. */}
        {!rainMode && solarIntensity != null && <SolarPill intensity={solarIntensity} />}

        {/* Route cards — the selected card carries the detail block */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto umbra-scrollbar">
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
            />
          ))}
        </div>

        {/* Start navigating */}
        {onStartNavigation && !selectedRoute?.partial && (
          <button
            type="button"
            onClick={onStartNavigation}
            className="w-full min-h-11 px-4 py-3 rounded-lg text-sm font-bold transition-colors"
            style={{ background: "var(--color-shade)", color: "var(--color-on-shade)" }}
          >
            START NAVIGATING
          </button>
        )}
      </div>
    </div>
  );
}

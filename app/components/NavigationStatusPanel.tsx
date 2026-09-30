import type { RouteLeg, RouteOption } from "../lib/routing";
import { routeAfterSunset, routeDurationLabel, routeShadowShare } from "../lib/routeTradeoff";
import { getTravelModePolicy, type TravelModeId } from "../lib/travelMode";
import Kicker from "./ui/Kicker";
import LineBullet from "./ui/LineBullet";

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

function coordLabel(coord: [number, number] | null): string {
  if (!coord) return "Not set";
  return `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`;
}

/**
 * The leg list, in the pattern a rider already knows: walk / ride / walk, each
 * step with its own time and distance, and for transit the station to board at
 * and the station to exit at. Data comes from `route.legs` — the same records
 * the route cards summarize — so nothing here is a new claim to ground.
 */
function LegList({ legs, travelMode }: { legs: RouteLeg[]; travelMode: TravelModeId }) {
  const paceMps = getTravelModePolicy(travelMode).speedMps;
  return (
    <ol className="flex flex-col gap-2" aria-label="Route steps">
      {legs.map((leg, i) => {
        if (leg.type === "transit") {
          const board = leg.stops?.[0];
          const exit = leg.stops?.[leg.stops.length - 1];
          const line = leg.lineName || leg.line || "Transit";
          const rideSec = leg.travelTimeSec != null && leg.waitSec != null
            ? leg.travelTimeSec - leg.waitSec
            : leg.travelTimeSec;
          return (
            <li key={i} className="flex items-start gap-2">
              <LineBullet accent={leg.lineColor} code={leg.line || leg.lineName || "?"} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium" style={{ color: "var(--color-ink)" }}>
                  Ride {line}
                  {rideSec != null && <span style={{ color: "var(--color-ink-muted)" }}> · {formatDuration(rideSec)}</span>}
                </div>
                {board && (
                  <div className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
                    Enter at {board}
                  </div>
                )}
                {exit && exit !== board && (
                  <div className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
                    Exit at {exit}
                  </div>
                )}
              </div>
            </li>
          );
        }
        const walkSec = leg.distanceM != null ? leg.distanceM / paceMps : null;
        return (
          <li key={i} className="flex items-start gap-2">
            <span className="material-symbols-outlined shrink-0 text-base" style={{ color: "var(--color-ink-muted)" }} aria-hidden="true">
              directions_walk
            </span>
            <div className="min-w-0 flex-1 text-xs font-medium" style={{ color: "var(--color-ink)" }}>
              {getTravelModePolicy(travelMode).label}
              {leg.distanceM != null && <span style={{ color: "var(--color-ink-muted)" }}> · {formatDistance(leg.distanceM)}</span>}
              {walkSec != null && <span style={{ color: "var(--color-ink-muted)" }}> · {formatDuration(walkSec)}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface NavigationStatusPanelProps {
  route: RouteOption | null;
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onBack: () => void;
  onArrive: () => void;
  onExit: () => void;
  rainMode?: boolean;
}

export default function NavigationStatusPanel({
  route,
  waypointA,
  waypointB,
  waypointALabel,
  waypointBLabel,
  onBack,
  onArrive,
  onExit,
  rainMode = false,
}: NavigationStatusPanelProps) {
  const protectedPct = route?.exposure?.shelteredDistancePct ?? route?.dryCoverage ?? null;
  const exposureUnknown = !!route && rainMode && (
    (route.exposure?.unknownDistanceM ?? 0) > 0 ||
    (route.exposure?.unknownDurationSec ?? 0) > 0
  );
  // The same figures, and the same rules, as the route card it came from:
  // a transit share from its legs (#144), none quoted after sunset.
  const afterSunset = !!route && !rainMode && routeAfterSunset(route);
  const shadowPct = route
    ? (rainMode
      ? (protectedPct == null || exposureUnknown ? null : Math.round(protectedPct * 100))
      : Math.round(routeShadowShare(route) * 100))
    : null;
  const duration = route ? routeDurationLabel(route) : null;
  const destination = waypointBLabel ?? coordLabel(waypointB);

  const cells: [string, string][] = route
    ? [
        ["Time", duration ?? ""],
        ["Distance", formatDistance(route.distanceM)],
        [rainMode ? "Shelter" : route.legs?.some((l) => l.type === "transit") ? "Shadow on foot" : "Shadow", afterSunset ? "After sunset" : shadowPct == null ? "Unknown" : `${shadowPct}%`],
        ["Turns", String(route.turnCount)],
      ]
    : [];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex h-11 w-11 items-center justify-center rounded-sm border-2 transition-colors hover:bg-ground"
          style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
          title="Back to route options"
          aria-label="Back to route options"
        >
          <span className="material-symbols-outlined text-base" aria-hidden="true">arrow_back</span>
        </button>
        <h2 className="umbra-kicker" style={{ color: "var(--color-ink)" }}>Navigating</h2>
        <button
          type="button"
          onClick={onExit}
          className="flex h-11 w-11 items-center justify-center rounded-sm border-2 transition-colors hover:bg-ground"
          style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
          title="End navigation"
          aria-label="End navigation"
        >
          <span className="material-symbols-outlined text-base" aria-hidden="true">close</span>
        </button>
      </div>

      {/* The ticket: the ridden option on its kicker plate and where it goes. */}
      <div className="border-2 p-3" style={{ background: "var(--color-panel)", borderColor: "var(--color-ink)", color: "var(--color-ink)" }}>
        <Kicker plated>{route?.label ?? "No route selected"}</Kicker>
        <div className="mt-2 truncate text-sm font-semibold" style={{ color: "var(--color-ink)" }}>
          To {destination}
        </div>
      </div>

      {route ? (
        <dl className="grid grid-cols-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
          {cells.map(([key, value], i) => (
            <div
              key={key}
              className={`border-b py-1.5 ${i % 2 === 0 ? "pr-2" : "border-l pl-2"}`}
              style={{ borderColor: "var(--color-rule)" }}
            >
              <dt className="umbra-kicker">{key}</dt>
              <dd className="mt-0.5 font-numeric text-sm font-bold tabular-nums" style={{ color: "var(--color-ink)" }}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="rounded-sm border-2 p-3 text-xs" style={{ borderColor: "var(--color-rule)", color: "var(--color-ink-muted)" }}>
          Pick a complete route before starting navigation.
        </div>
      )}

      {/* Leg list — walk / ride / walk with times and board/exit stations,
          the pattern a rider already knows. Single-leg walk routes skip it:
          the stats grid already says everything there is to say. */}
      {route?.legs && route.legs.length > 1 && (
        <div className="border-t pt-2" style={{ borderColor: "var(--color-rule)" }}>
          <LegList legs={route.legs} travelMode={route.travelMode ?? "walk"} />
        </div>
      )}

      <div className="border-t pt-2" style={{ borderColor: "var(--color-rule)" }}>
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]" style={{ color: "var(--color-ink)" }} aria-hidden="true">trip_origin</span>
          <div className="min-w-0 flex-1">
            <div className="umbra-kicker">Start</div>
            <div className="truncate text-xs font-medium" style={{ color: "var(--color-ink)" }}>
              {waypointALabel ?? coordLabel(waypointA)}
            </div>
          </div>
        </div>
        <div className="my-2 ml-2 h-5 border-l" style={{ borderColor: "var(--color-rule)" }} />
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]" style={{ color: "var(--color-ink)" }} aria-hidden="true">location_on</span>
          <div className="min-w-0 flex-1">
            <div className="umbra-kicker">Destination</div>
            <div className="truncate text-xs font-medium" style={{ color: "var(--color-ink)" }}>{destination}</div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onArrive}
        disabled={!route}
        className="umbra-start-button gap-1 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="material-symbols-outlined text-base" aria-hidden="true">flag</span>
        ARRIVED
      </button>
    </div>
  );
}

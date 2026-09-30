import type { CSSProperties, ReactNode } from "react";
import { lineCssColor } from "../lib/lineBulletInk";
import type { RouteLeg, RouteOption } from "../lib/routing";
import { routeAfterSunset, routeDurationLabel, routeExposureMinutes, routeShadowShare } from "../lib/routeTradeoff";
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

type RailKind = "foot" | "ride";

interface ItineraryRow {
  id: string;
  node: ReactNode;
  /** The segment that leaves this node, drawn down to the next one; none after the last. */
  rail: RailKind | null;
  color?: string;
  body: ReactNode;
}

/**
 * The trip as one itinerary, in the pattern a rider already knows: the start
 * pin, dots on foot to the walk step, dots on to the boarding stop, where the
 * line's bullet heads a solid bar in its colour that ends in a ring at the exit
 * stop, then dots again past the walk step to the destination pin. Data comes
 * from `route.legs` (a plain walk is one leg) — the same records the route
 * cards summarize — so nothing here is a new claim to ground.
 */
function Itinerary({
  legs,
  travelMode,
  startLabel,
  destinationLabel,
}: {
  legs: RouteLeg[];
  travelMode: TravelModeId;
  startLabel: string;
  destinationLabel: string;
}) {
  const policy = getTravelModePolicy(travelMode);
  const muted = { color: "var(--color-ink-muted)" };
  const ink = { color: "var(--color-ink)" };
  const rows: ItineraryRow[] = [
    {
      id: "start",
      node: <span className="material-symbols-outlined text-[18px]" style={ink} aria-hidden="true">trip_origin</span>,
      rail: legs[0]?.type === "transit" ? "ride" : "foot",
      color: legs[0]?.type === "transit" && legs[0].lineColor ? lineCssColor(legs[0].lineColor) : undefined,
      body: (
        <>
          <div className="umbra-kicker">Start</div>
          <div className="truncate text-xs font-medium" style={ink}>{startLabel}</div>
        </>
      ),
    },
  ];
  legs.forEach((leg, n) => {
    if (leg.type === "transit") {
      const board = leg.stops?.[0];
      const exit = leg.stops?.[leg.stops.length - 1];
      const color = leg.lineColor ? lineCssColor(leg.lineColor) : undefined;
      rows.push({
        id: `board-${n}`,
        node: <LineBullet accent={leg.lineColor} code={leg.line || leg.lineName || "?"} aria-hidden="true" />,
        rail: "ride",
        color,
        body: (
          <>
            {board && <div className="text-xs font-semibold" style={ink}>{board}</div>}
            <div className="text-xs font-medium" style={ink}>
              Ride {leg.lineName || leg.line || "Transit"}
              {leg.travelTimeSec != null && (
                <span style={muted}>
                  {/* The whole leg, wait included, so the steps add up to Time. */}
                  {" "}· {formatDuration(leg.travelTimeSec)}
                  {leg.waitSec ? ` incl. ~${formatDuration(leg.waitSec)} wait` : ""}
                </span>
              )}
            </div>
          </>
        ),
      });
      rows.push({
        id: `exit-${n}`,
        node: <span className="umbra-leg-stop" style={color ? ({ "--leg-color": color } as CSSProperties) : undefined} aria-hidden="true" />,
        // Off the train, the rider is on foot again until the next boarding or the end.
        rail: "foot",
        body: <div className="text-xs font-semibold" style={ink}>{exit && exit !== board ? `Exit at ${exit}` : "Exit"}</div>,
      });
      return;
    }
    const walkSec = leg.distanceM != null ? leg.distanceM / policy.speedMps : null;
    rows.push({
      id: `walk-${n}`,
      node: <span className="material-symbols-outlined text-base" style={muted} aria-hidden="true">directions_walk</span>,
      rail: "foot",
      body: (
        <div className="text-xs font-medium" style={ink}>
          {policy.label}
          {leg.distanceM != null && <span style={muted}> · {formatDistance(leg.distanceM)}</span>}
          {walkSec != null && <span style={muted}> · {formatDuration(walkSec)}</span>}
        </div>
      ),
    });
  });
  rows.push({
    id: "end",
    node: <span className="material-symbols-outlined text-[18px]" style={ink} aria-hidden="true">location_on</span>,
    rail: null,
    body: (
      <>
        <div className="umbra-kicker">Destination</div>
        <div className="truncate text-xs font-medium" style={ink}>{destinationLabel}</div>
      </>
    ),
  });

  return (
    <ol className="flex flex-col" aria-label="Route steps">
      {rows.map((row) => (
        <li key={row.id} className="flex gap-2">
          <div className="umbra-leg-rail-column">
            {row.node}
            {row.rail && (
              <span
                className={`umbra-leg-rail umbra-leg-rail--${row.rail}`}
                style={row.color ? ({ "--leg-color": row.color } as CSSProperties) : undefined}
                aria-hidden="true"
              />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-4">{row.body}</div>
        </li>
      ))}
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
  // The same figures, by the same rules, as the route card it came from: a
  // rain card only for a rain-priced route, a transit share from its legs
  // (#144) and none where its time outdoors is unmeasured (#393), and no
  // shade share after sunset.
  const rainCard = !!route && rainMode && (route.objective === "rain" || route.dryCoverage !== undefined);
  const protectedPct = route?.exposure?.shelteredDistancePct ?? route?.dryCoverage ?? null;
  const exposureUnknown = !!route && rainCard && (
    (route.exposure?.unknownDistanceM ?? 0) > 0 ||
    (route.exposure?.unknownDurationSec ?? 0) > 0
  );
  const afterSunset = !!route && !rainCard && routeAfterSunset(route);
  const shadeValue = !route
    ? null
    : rainCard
      ? route.exposureUpdating
        ? "Updating…"
        : protectedPct == null || exposureUnknown ? "Unknown" : `${Math.round(protectedPct * 100)}%`
      : afterSunset
        ? "After sunset"
        : routeExposureMinutes(route) === null ? "Unknown" : `${Math.round(routeShadowShare(route) * 100)}%`;
  const duration = route ? routeDurationLabel(route) : null;
  const destination = waypointBLabel ?? coordLabel(waypointB);

  const cells: [string, string][] = route
    ? [
        ["Time", duration ?? ""],
        ["Distance", formatDistance(route.distanceM)],
        [rainCard ? "Shelter" : route.legs?.some((l) => l.type === "transit") ? "Shadow on foot" : "Shadow", shadeValue ?? ""],
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
              {/* Figures in the numeric face; a word in place of one reads as a word. */}
              <dd
                className={`mt-0.5 text-sm ${/\d/.test(value) ? "font-numeric font-bold tabular-nums" : "font-semibold italic"}`}
                style={{ color: /\d/.test(value) ? "var(--color-ink)" : "var(--color-ink-muted)" }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="rounded-sm border-2 p-3 text-xs" style={{ borderColor: "var(--color-rule)", color: "var(--color-ink-muted)" }}>
          Pick a complete route before starting navigation.
        </div>
      )}

      {/* The itinerary: start to destination on one rail, every leg between. */}
      <div className="border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
        <Itinerary
          legs={route?.legs && route.legs.length > 0 ? route.legs : route ? [{ type: "walk", geojson: route.geojson, distanceM: route.distanceM }] : []}
          travelMode={route?.travelMode ?? "walk"}
          startLabel={waypointALabel ?? coordLabel(waypointA)}
          destinationLabel={destination}
        />
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

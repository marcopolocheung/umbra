import type { RouteOption } from "../lib/routing";

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
  const shadowPct = route
    ? (rainMode
      ? (protectedPct == null || exposureUnknown ? null : Math.round(protectedPct * 100))
      : Math.round(route.shadowCoverage * 100))
    : null;
  const duration = route?.totalTimeSec ? formatDuration(route.totalTimeSec) : null;
  const destination = waypointBLabel ?? coordLabel(waypointB);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-canvas"
          style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
          title="Back to route options"
          aria-label="Back to route options"
        >
          <span className="material-symbols-outlined text-base">arrow_back</span>
        </button>
        <h2 className="text-[13px] font-medium" style={{ color: "var(--color-ink)" }}>Navigating</h2>
        <button
          type="button"
          onClick={onExit}
          className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-canvas"
          style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
          title="End navigation"
          aria-label="End navigation"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>

      <div
        className="rounded-xl border p-4"
        style={{
          background: "var(--color-shade-soft)",
          borderColor: "var(--color-shade-mid)",
          color: "var(--color-ink)",
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="material-symbols-outlined mt-0.5 rounded-full p-2 text-[20px]"
            style={{ background: "var(--color-shade)", color: "var(--color-on-shade)" }}
          >
            navigation
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--color-shade)" }}>
              Navigation active
            </div>
            <div className="mt-1 truncate text-sm font-semibold" style={{ color: "var(--color-ink)" }}>
              {route?.label ?? "No route selected"}
            </div>
            <div className="mt-1 truncate text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
              To {destination}
            </div>
          </div>
        </div>
      </div>

      {route ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg p-3" style={{ background: "var(--color-canvas)" }}>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Distance</div>
            <div className="mt-1 text-sm font-semibold" style={{ color: "var(--color-ink)" }}>{formatDistance(route.distanceM)}</div>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--color-canvas)" }}>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>{rainMode ? "Shelter" : "Shadow"}</div>
            <div className="mt-1 text-sm font-semibold" style={{ color: "var(--color-ink)" }}>{shadowPct == null ? "Unknown" : `${shadowPct}%`}</div>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--color-canvas)" }}>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Turns</div>
            <div className="mt-1 text-sm font-semibold" style={{ color: "var(--color-ink)" }}>{route.turnCount}</div>
          </div>
          <div className="rounded-lg p-3" style={{ background: "var(--color-canvas)" }}>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>
              {duration ? "Time" : "Shadow breaks"}
            </div>
            <div className="mt-1 text-sm font-semibold" style={{ color: "var(--color-ink)" }}>
              {duration ?? route.shadowTransitions}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink-muted)" }}>
          Pick a complete route before starting navigation.
        </div>
      )}

      <div className="rounded-xl p-3" style={{ background: "var(--color-canvas)" }}>
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]" style={{ color: "var(--color-ink)" }}>trip_origin</span>
          <div className="min-w-0 flex-1">
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Start</div>
            <div className="truncate text-xs font-medium" style={{ color: "var(--color-ink)" }}>
              {waypointALabel ?? coordLabel(waypointA)}
            </div>
          </div>
        </div>
        <div className="my-2 ml-2 h-5 border-l" style={{ borderColor: "var(--color-hairline)" }} />
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]" style={{ color: "var(--color-danger)" }}>location_on</span>
          <div className="min-w-0 flex-1">
            <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--color-ink-muted)" }}>Destination</div>
            <div className="truncate text-xs font-medium" style={{ color: "var(--color-ink)" }}>{destination}</div>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onArrive}
        disabled={!route}
        className="flex w-full items-center justify-center gap-1 rounded-lg px-3 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: "var(--color-shade)", color: "var(--color-on-shade)" }}
      >
        <span className="material-symbols-outlined text-base">flag</span>
        ARRIVED
      </button>
    </div>
  );
}

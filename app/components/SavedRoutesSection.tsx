import { useEffect, useId, useRef, useState, memo } from "react";
import type { SavedRoute, SavedFolder } from "../lib/savedRoutes";
import { routeShadowLabel } from "../lib/routeTradeoff";
import Kicker from "./ui/Kicker";

/**
 * The date and time a saved figure was computed for, as a ticket stub prints
 * it: the trip's departure instant in the departure stop's own zone, never the
 * browser's clock (a 9 PM New York walk saved from Los Angeles must not read
 * 6 PM). Null when the record holds no readable instant or zone.
 */
function stubDate(at: { instant: string; zone: string } | undefined): [string, string] | null {
  const d = at ? new Date(at.instant) : null;
  if (!at || !d || Number.isNaN(d.getTime())) return null;
  try {
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { timeZone: at.zone, ...options }).format(d).replace(/\u202f/g, " ");
    return [format({ month: "short", day: "numeric" }), format({ hour: "numeric", minute: "2-digit" })];
  } catch {
    return null;
  }
}

interface SavedRoutesSectionProps {
  routes: SavedRoute[];
  folders: SavedFolder[];
  onLoad: (r: SavedRoute) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

const SavedRoutesSection = memo(function SavedRoutesSection({
  routes,
  folders,
  onLoad,
  onDelete,
  onRename,
}: SavedRoutesSectionProps) {
  // Open by default — except once route options exist, when the section must
  // not spend the sheet's first snap point on itself (U3).
  const [open, setOpen] = useState(!routes.length);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const folderIdPrefix = useId();

  useEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  const uncategorised = routes.filter(r => !r.folderId);
  const byFolder = folders.map(f => ({
    folder: f,
    routes: routes.filter(r => r.folderId === f.id),
  })).filter(g => g.routes.length > 0);

  function commitRename(id: string) {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
  }

  // Each saved route is a ticket stub: name and figure on the ticket, the date
  // and time the figure was computed for on the stub past the perforation (a
  // shadow share is only true of its hour), then rename and delete as square
  // 44px controls that are always shown — they used to appear on hover only,
  // which a phone never has (R8b).
  function renderRoute(r: SavedRoute) {
    const rain = r.routeOption.objective === "rain"
      || r.routeOption.dryCoverage !== undefined
      || r.legacyRainResult === true;
    const shelteredPct = r.routeOption.exposure?.shelteredDistancePct ?? r.routeOption.dryCoverage;
    const exposureUnknown = (r.routeOption.exposure?.unknownDistanceM ?? 0) > 0
      || (r.routeOption.exposure?.unknownDurationSec ?? 0) > 0;
    // A sun route says what its card said: "after sunset" at night, "on foot"
    // on transit, never a bare share the route card would not show.
    const protectionLabel = rain
      ? shelteredPct == null || exposureUnknown ? "shelter unknown" : `${Math.round(shelteredPct * 100)}% sheltered`
      : routeShadowLabel(r.routeOption);
    const distKm = r.routeOption.distanceM >= 1000
      ? `${(r.routeOption.distanceM / 1000).toFixed(1)} km`
      : `${Math.round(r.routeOption.distanceM)} m`;
    const stub = stubDate(r.trip?.departAt);
    return (
      <li key={r.id} className="flex min-w-0 border-2 border-ink bg-panel">
        {renamingId === r.id ? (
          <input
            ref={renameInputRef}
            aria-label={`Rename ${r.name}`}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename(r.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
            onBlur={() => commitRename(r.id)}
            className="min-h-11 min-w-0 flex-1 px-3 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current"
            // 16px: anything smaller makes iOS Safari zoom when the field takes focus.
            style={{ background: "var(--color-ground)", color: "var(--color-ink)", fontSize: "1rem" }}
          />
        ) : (
          <button type="button"
            onClick={() => onLoad(r)}
            className="flex min-h-11 min-w-0 flex-1 items-stretch text-left hover:bg-ground focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current"
          >
            <span className="flex min-w-0 flex-1 flex-col justify-center px-3 py-1.5">
              <span className="truncate font-semibold" title={r.name} style={{ color: "var(--color-ink)", fontSize: "var(--text-small)" }}>{r.name}</span>
              <span className="font-numeric text-[11px] font-extrabold tabular-nums" style={{ color: "var(--color-ink)" }}>{distKm} · {protectionLabel}</span>
            </span>
            {stub && (
              <span
                className="flex shrink-0 flex-col items-end justify-center border-l-2 border-dashed border-ink px-2 font-mono text-[11px] uppercase tabular-nums"
                style={{ color: "var(--color-ink)" }}
              >
                <span>{stub[0]}</span>
                <span>{stub[1]}</span>
              </span>
            )}
          </button>
        )}
        <button type="button"
          onClick={() => { setRenamingId(r.id); setRenameValue(r.name); }}
          aria-label={`Rename ${r.name}`}
          className="flex w-11 shrink-0 items-center justify-center border-l-2 border-ink text-ink focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current"
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
        </button>
        <button type="button"
          onClick={() => { if (confirm(`Delete "${r.name}"?`)) onDelete(r.id); }}
          aria-label={`Delete ${r.name}`}
          className="flex w-11 shrink-0 items-center justify-center border-l-2 border-ink text-ink hover:text-danger focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current"
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">delete</span>
        </button>
      </li>
    );
  }

  return (
    // The strong hairline separates saved trips from the planning form below —
    // different kinds of content need more than spacing between them (U4).
    <div className="border-b pb-2 mb-1" style={{ borderColor: "var(--color-rule-strong)" }}>
      <button type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        style={{ color: "var(--color-ink)" }}
      >
        <span
          className={`material-symbols-outlined text-base ${open ? 'umbra-disclosure-open' : ''}`}
          aria-hidden="true"
        >
          chevron_right
        </span>
        <Kicker>Saved routes</Kicker>
        <span className="ml-auto font-mono text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>{routes.length}</span>
      </button>

      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {uncategorised.length > 0 && <ul className="flex flex-col gap-2">{uncategorised.map(renderRoute)}</ul>}
          {byFolder.map(({ folder, routes: fr }) => (
            <section key={folder.id} aria-labelledby={`${folderIdPrefix}-${folder.id}`} className="flex flex-col gap-1">
              <Kicker id={`${folderIdPrefix}-${folder.id}`}>{folder.name}</Kicker>
              <ul className="flex flex-col gap-2">{fr.map(renderRoute)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
});

export default SavedRoutesSection;

// @deprecated — replaced by DirectionsPanel
import { useState, useRef, useEffect, memo } from "react";
import type { RouteOption, RouteLeg } from "../lib/routing";
import { geocodeForward, type NominatimResult } from "../lib/nominatim";
import { transitSunCardLabel } from "../lib/routeLegSummary";

export interface NavigationPanelProps {
  navMode: boolean;
  onToggleNavMode: () => void;
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onSetWaypointA: (coord: [number, number], label: string) => void;
  onSetWaypointB: (coord: [number, number], label: string) => void;
  onSwapWaypoints: () => void;
  onClearWaypointA: () => void;
  onClearWaypointB: () => void;
  onClear: () => void;
  onCalculate: () => void;
  isCalculating: boolean;
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  error: string | null;
  solarIntensity?: number | null;
  pendingSlot: 'A' | 'B' | null;
  onSetPendingSlot: (slot: 'A' | 'B' | null) => void;
  locationSearchSlot?: React.ReactNode;
  onSaveRoute?: (routeIndex: number) => void;
  savedRoutes?: import("../lib/savedRoutes").SavedRoute[];
  savedFolders?: import("../lib/savedRoutes").SavedFolder[];
  onLoadRoute?: (route: import("../lib/savedRoutes").SavedRoute) => void;
  onDeleteSavedRoute?: (id: string) => void;
  onRenameSavedRoute?: (id: string, name: string) => void;
  additionalWaypoints?: [number, number][];
  onRemoveAdditionalWaypoint?: (index: number) => void;
  onExportRoute?: (routeIndex: number, format: "gpx" | "geojson") => void;
  userLocation?: [number, number] | null;
  isLocating?: boolean;
  onLocateMe?: () => void;
  onUseLocationAsA?: (coord: [number, number]) => void;
  onUseLocationAsB?: (coord: [number, number]) => void;
  onPinDragStart?: (slot: 'A' | 'B') => void;
  drawMode?: boolean;
  onDrawModeToggle?: () => void;
  sketchPointCount?: number;
  warning?: string | null;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatShadowStreak(m: number): string | null {
  return m >= 10 ? `${Math.round(m)}m shadow` : null;
}

function formatTransitions(n: number): string {
  return n === 0 ? "continuous" : `${n} break${n === 1 ? "" : "s"}`;
}

function formatDetour(r: number): string | null {
  return r > 1.05 ? `${r.toFixed(1)}× detour` : null;
}

const SolarPill = memo(function SolarPill({ intensity }: { intensity: number }) {
  if (intensity < 0.15) {
    return (
      <div className="text-xs px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 self-start">
        Low sun — shadow routing minimal
      </div>
    );
  }
  if (intensity <= 0.6) {
    return (
      <div className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300 self-start">
        Moderate solar load
      </div>
    );
  }
  return (
    <div className="text-xs px-2 py-0.5 rounded-full bg-amber-900/50 text-amber-300 self-start">
      High solar load — shadow matters
    </div>
  );
});

const WaypointInput = memo(function WaypointInput({
  label,
  placeholder,
  dotColor,
  onSet,
  onClear,
}: {
  label: string | null;
  placeholder: string;
  dotColor: "green" | "red";
  onSet: (coord: [number, number], label: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState(label ?? "");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const searchGenRef = useRef(0);
  const focusedRef = useRef(false);
  const labelRef = useRef(label);
  labelRef.current = label;

  // Sync query when label changes externally (e.g. reverse geocode resolves, swap)
  useEffect(() => {
    if (!focusedRef.current) {
      setQuery(label ?? "");
    }
  }, [label]);

  function closeDropdown() {
    setResults([]);
    setHighlight(-1);
    setInlineError(null);
  }

  // Runs only on an explicit submit (Enter). Nominatim's usage policy lists
  // autocomplete under unacceptable use, so no request fires from a keystroke.
  async function search(q: string) {
    if (q.trim().length < 2) { closeDropdown(); return; }
    const gen = ++searchGenRef.current;
    try {
      const res = await geocodeForward(q);
      if (gen !== searchGenRef.current) return; // stale result
      if (res.length === 0) {
        setResults([]);
        setInlineError(`No results found for "${q}". Try a different address.`);
      } else {
        setResults(res);
        setHighlight(0);
        setInlineError(null);
      }
    } catch {
      if (gen !== searchGenRef.current) return;
      setResults([]);
      setInlineError("Address search failed. Check your connection.");
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    // Clear the waypoint only if one was set — avoids repeated parent updates
    if (labelRef.current !== null) onClear();
    // Retyping invalidates a geocode already in flight for the previous query:
    // its results are armed for the next Enter and would commit the old place.
    searchGenRef.current++;
    closeDropdown();
  }

  function handleSelect(r: NominatimResult) {
    const coord: [number, number] = [parseFloat(r.lon), parseFloat(r.lat)];
    setQuery(r.display_name);
    closeDropdown();
    onSet(coord, r.display_name);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && results[highlight]) handleSelect(results[highlight]);
      else search(query);
      return;
    }
    if (e.key === "Escape") {
      closeDropdown();
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    }
  }

  const dotClass =
    dotColor === "green"
      ? label
        ? "bg-green-400 shadow-[0_0_6px_1px_rgba(74,222,128,0.5)]"
        : "bg-green-900/60 border border-green-700/50"
      : label
      ? "bg-red-400 shadow-[0_0_6px_1px_rgba(248,113,113,0.5)]"
      : "bg-red-900/60 border border-red-700/50";

  return (
    <div className="relative flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full shrink-0 transition-all ${dotClass}`} />
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={(e) => {
            focusedRef.current = true;
            setTimeout(() => e.target.select(), 0);
          }}
          onBlur={() => {
            focusedRef.current = false;
            // Revert to current label (or empty) if user didn't complete a selection
            setQuery(labelRef.current ?? "");
            closeDropdown();
          }}
          className="flex-1 min-w-0 rounded px-2 py-1 text-xs placeholder-white/30 border focus:outline-none transition-colors"
          style={{ background: 'transparent', color: 'var(--parchment)', borderColor: 'var(--brass-dim)', fontFamily: 'var(--font-serif)' }}
        />
        {label && (
          <button type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onClear(); setQuery(""); closeDropdown(); }}
            className="shrink-0 text-white/30 hover:text-white/70 transition-colors leading-none px-0.5"
            title="Clear waypoint"
          >
            ×
          </button>
        )}
      </div>
      {inlineError && (
        <p className="text-[10px] text-red-400 pl-5">{inlineError}</p>
      )}
      {results.length > 0 && (
        <div className="absolute top-full left-5 right-0 mt-0.5 z-50 bg-[#1c1c1c] border border-white/10 rounded shadow-xl overflow-hidden">
          {results.map((r, i) => {
            const comma = r.display_name.indexOf(",");
            const primary = comma >= 0 ? r.display_name.slice(0, comma) : r.display_name;
            const secondary = comma >= 0 ? r.display_name.slice(comma + 1).trim() : "";
            return (
              <button type="button"
                key={r.place_id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(r)}
                onMouseEnter={() => setHighlight(i)}
                className={`w-full text-left px-2 py-1.5 transition-colors ${
                  i === highlight ? "bg-amber-500/20" : "hover:bg-white/5"
                }`}
              >
                <div className={`text-xs truncate ${i === highlight ? "text-amber-300" : "text-white/80"}`}>
                  {primary}
                </div>
                {secondary && (
                  <div className="text-[10px] text-white/30 truncate">{secondary}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

const SavedRoutesSection = memo(function SavedRoutesSection({
  routes,
  folders,
  onLoad,
  onDelete,
  onRename,
}: {
  routes: import("../lib/savedRoutes").SavedRoute[];
  folders: import("../lib/savedRoutes").SavedFolder[];
  onLoad: (r: import("../lib/savedRoutes").SavedRoute) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  function renderRoute(r: import("../lib/savedRoutes").SavedRoute) {
    const shadowPct = Math.round(r.routeOption.shadowCoverage * 100);
    const distKm = r.routeOption.distanceM >= 1000
      ? `${(r.routeOption.distanceM / 1000).toFixed(1)} km`
      : `${Math.round(r.routeOption.distanceM)} m`;
    return (
      <div key={r.id} className="flex items-center gap-1 group">
        {renamingId === r.id ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename(r.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
            onBlur={() => commitRename(r.id)}
            className="flex-1 bg-white/5 border border-amber-400/40 rounded px-1.5 py-0.5 text-[11px] text-white/80 focus:outline-none"
          />
        ) : (
          <button type="button"
            onClick={() => onLoad(r)}
            className="flex-1 text-left px-1.5 py-1 rounded hover:bg-white/5 transition-colors min-w-0"
          >
            <div className="text-[11px] text-white/70 truncate">{r.name}</div>
            <div className="text-[10px] text-white/30">{distKm} · {shadowPct}% shadow</div>
          </button>
        )}
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button type="button"
            onClick={() => { setRenamingId(r.id); setRenameValue(r.name); }}
            title="Rename"
            className="p-0.5 text-white/20 hover:text-white/60 transition-colors"
          >
            <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 9h2L8.5 2.5a1.06 1.06 0 0 0-1.5-1.5L1 7.5V9z"/>
            </svg>
          </button>
          <button type="button"
            onClick={() => { if (confirm(`Delete "${r.name}"?`)) onDelete(r.id); }}
            title="Delete"
            className="p-0.5 text-white/20 hover:text-red-400 transition-colors"
          >
            <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/>
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-white/[0.07] pb-2 mb-1">
      <button type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full text-left text-[11px] text-white/40 hover:text-white/70 transition-colors py-0.5"
      >
        <svg aria-hidden="true" focusable="false"
          width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="2,1 6,4 2,7"/>
        </svg>
        Saved Routes
        <span className="ml-auto text-white/20">{routes.length}</span>
      </button>

      {open && (
        <div className="flex flex-col mt-1 gap-0">
          {uncategorised.map(renderRoute)}
          {byFolder.map(({ folder, routes: fr }) => (
            <div key={folder.id}>
              <div className="text-[10px] text-white/25 px-1.5 pt-1.5 pb-0.5 uppercase tracking-wide">
                {folder.name}
              </div>
              {fr.map(renderRoute)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export default function NavigationPanel({
  navMode,
  onToggleNavMode,
  waypointA,
  waypointB,
  waypointALabel,
  waypointBLabel,
  onSetWaypointA,
  onSetWaypointB,
  onSwapWaypoints,
  onClearWaypointA,
  onClearWaypointB,
  onClear,
  onCalculate,
  isCalculating,
  routes,
  selectedRouteIndex,
  onSelectRoute,
  error,
  solarIntensity,
  pendingSlot,
  onSetPendingSlot,
  locationSearchSlot,
  onSaveRoute,
  savedRoutes,
  savedFolders,
  onLoadRoute,
  onDeleteSavedRoute,
  onRenameSavedRoute,
  additionalWaypoints,
  onRemoveAdditionalWaypoint,
  onExportRoute,
  userLocation,
  isLocating,
  onLocateMe,
  onUseLocationAsA,
  onUseLocationAsB,
  onPinDragStart,
  drawMode = false,
  onDrawModeToggle,
  sketchPointCount = 0,
  warning,
}: NavigationPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!navMode) setCollapsed(false);
  }, [navMode]);

  if (!navMode) {
    return (
      <div className="absolute bottom-6 left-3 z-20 flex gap-1.5">
        <button type="button"
          onClick={onToggleNavMode}
          className="glass-panel border px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:border-[rgba(200,175,110,0.35)]"
          style={{ color: 'var(--brass)', fontFamily: 'var(--font-display)' }}
        >
          Navigate
        </button>
        <button type="button"
          onClick={onDrawModeToggle}
          className={`glass-panel border px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            drawMode
              ? "text-yellow-300 border-yellow-400/40 hover:border-yellow-400/60"
              : "hover:border-[rgba(200,175,110,0.35)]"
          }`}
          style={{ color: drawMode ? undefined : 'var(--brass)', fontFamily: 'var(--font-display)' }}
        >
          {drawMode ? "Cancel Drawing" : "Draw Route"}
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-y-0 left-0 z-20 flex items-stretch pointer-events-none">
      {/* Panel content — 288px when expanded, 0 when collapsed */}
      <div
        className={`relative flex flex-col overflow-hidden transition-all duration-200 ease-in-out pointer-events-auto ${
          collapsed ? 'w-0' : 'w-72'
        }`}
      >
        <div className="w-72 h-full flex flex-col glass-panel border-r">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.07] shrink-0">
            <span className="panel-heading">Navigate</span>
            <button type="button"
              onClick={onToggleNavMode}
              className="text-white/30 hover:text-white/70 transition-colors p-1 rounded"
              title="Exit navigation mode"
            >
              <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>

          {/* LocationSearch slot */}
          {locationSearchSlot && (
            <div className="px-2 py-2 border-b border-white/[0.07] shrink-0">
              {locationSearchSlot}
            </div>
          )}

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 flex flex-col gap-3 min-h-0">
            {/* Saved Routes section */}
            {savedRoutes && savedRoutes.length > 0 && (
              <SavedRoutesSection
                routes={savedRoutes}
                folders={savedFolders ?? []}
                onLoad={onLoadRoute ?? (() => {})}
                onDelete={onDeleteSavedRoute ?? (() => {})}
                onRename={onRenameSavedRoute ?? (() => {})}
              />
            )}
            {/* Locate me */}
            <div className="flex flex-col gap-1.5">
              <button type="button"
                onClick={onLocateMe}
                disabled={isLocating}
                className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs font-medium transition-all border ${
                  userLocation
                    ? "text-blue-400 border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20"
                    : "text-white/50 border-white/10 bg-white/5 hover:text-white/80 hover:border-white/20"
                } ${isLocating ? "opacity-50 cursor-not-allowed" : ""}`}
                title="Show your current location"
              >
                {isLocating ? (
                  <svg aria-hidden="true" focusable="false" className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                ) : (
                  <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                    <circle cx="12" cy="12" r="9" strokeOpacity="0.3"/>
                  </svg>
                )}
                {isLocating ? "Locating…" : userLocation ? "Located" : "Locate me"}
              </button>

              {userLocation && (
                <div className="flex gap-1">
                  <button type="button"
                    onClick={() => onUseLocationAsA?.(userLocation)}
                    className="flex-1 text-[10px] px-2 py-1 rounded bg-green-500/15 border border-green-500/30 text-green-400 hover:bg-green-500/25 transition-colors"
                  >
                    Use as start (A)
                  </button>
                  <button type="button"
                    onClick={() => onUseLocationAsB?.(userLocation)}
                    className="flex-1 text-[10px] px-2 py-1 rounded bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-colors"
                  >
                    Use as end (B)
                  </button>
                </div>
              )}
            </div>

            {/* Waypoint rows */}
            <div className="flex flex-col gap-1 text-xs">
              {/* Waypoint A */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointALabel}
                    placeholder="Search or click pin for start"
                    dotColor="green"
                    onSet={onSetWaypointA}
                    onClear={onClearWaypointA}
                  />
                </div>
                <button type="button"
                  onClick={() => onSetPendingSlot(pendingSlot === 'A' ? null : 'A')}
                  onPointerDown={() => { onPinDragStart?.('A'); }}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'A'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg aria-hidden="true" focusable="false" width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>

              {/* Swap */}
              <div className="flex items-center pl-1">
                <button type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSwapWaypoints}
                  className="text-white/30 hover:text-white/70 transition-colors text-base leading-none px-1"
                  title="Swap start and destination"
                >
                  ⇅
                </button>
              </div>

              {/* Waypoint B */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointBLabel}
                    placeholder="Search or click pin for destination"
                    dotColor="red"
                    onSet={onSetWaypointB}
                    onClear={onClearWaypointB}
                  />
                </div>
                <button type="button"
                  onClick={() => onSetPendingSlot(pendingSlot === 'B' ? null : 'B')}
                  onPointerDown={() => { onPinDragStart?.('B'); }}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'B'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg aria-hidden="true" focusable="false" width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Intermediate waypoints list */}
            {(additionalWaypoints ?? []).length > 0 && (
              <div className="pl-4 flex flex-col gap-0.5 text-[10px] text-white/40">
                <span className="text-[10px] text-white/25 mb-0.5">Waypoints (Alt+click on map)</span>
                {(additionalWaypoints ?? []).map((wp, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="w-4 h-4 rounded-full bg-slate-600 text-white text-[9px] flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="flex-1 tabular-nums truncate">{wp[1].toFixed(5)}, {wp[0].toFixed(5)}</span>
                    <button type="button"
                      onClick={() => onRemoveAdditionalWaypoint?.(i)}
                      className="text-white/20 hover:text-red-400 transition-colors px-0.5"
                    >×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Draw Route toggle */}
            <div className="border-t border-white/[0.07] pt-2">
              <button type="button"
                onClick={onDrawModeToggle}
                className={`w-full px-2 py-1.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  drawMode
                    ? "bg-yellow-500/20 text-yellow-300 border border-yellow-400/40 hover:bg-yellow-500/30"
                    : "bg-white/5 text-white/60 hover:text-white/80 border border-white/10 hover:border-white/20"
                }`}
              >
                {drawMode ? (
                  <>
                    <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/>
                    </svg>
                    Cancel Drawing
                  </>
                ) : (
                  <>
                    <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9l2-2L8.5 1.5a1 1 0 0 1 1.5 1.5L4.5 8.5 2.5 9z"/>
                    </svg>
                    Draw Route
                  </>
                )}
              </button>
              {drawMode && (
                <div className="mt-2 flex flex-col gap-1">
                  <p className="text-[11px] text-white/40">
                    Click to add points &middot; then click Find Shadowed Route
                  </p>
                  {sketchPointCount > 0 && (
                    <p className="text-[11px] text-yellow-400/70 tabular-nums">
                      {sketchPointCount} point{sketchPointCount !== 1 ? "s" : ""} drawn
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 shrink-0">
              <button type="button"
                onClick={onCalculate}
                disabled={drawMode ? sketchPointCount < 2 || isCalculating : !waypointA || !waypointB || isCalculating}
                className="flex-1 px-2 py-1.5 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
                style={{ background: 'var(--brass)', color: 'var(--ink)', fontFamily: 'var(--font-display)' }}
              >
                {isCalculating && (
                  <svg aria-hidden="true" focusable="false" className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {isCalculating ? 'Calculating…' : 'Find Shadowed Route'}
              </button>
              <button type="button"
                onClick={onClear}
                className="px-2 py-1.5 rounded text-xs text-white/60 hover:text-white/90 border border-white/10 transition-colors"
              >
                Clear
              </button>
            </div>

            {/* Route cards */}
            {routes.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
                {solarIntensity != null && <SolarPill intensity={solarIntensity} />}
                {routes.map((r, i) => {
                  const streak = formatShadowStreak(r.longestContinuousShadowM);
                  const transitions = formatTransitions(r.shadowTransitions);
                  const detour = formatDetour(r.detourRatio);
                  const hasSecondLine =
                    streak !== null || r.shadowTransitions > 0 || r.detourRatio > 1.05 || r.turnCount > 0;
                  return (
                    <div key={i} className="flex gap-1 items-start">
                      <button type="button"
                        onClick={() => onSelectRoute(i)}
                        className={`flex-1 text-left px-2 py-1.5 rounded text-xs transition-all ${
                          i === selectedRouteIndex
                            ? 'bg-amber-500/20 border border-amber-500 shadow-sm shadow-amber-500/20'
                            : 'border border-white/10 hover:border-white/25 hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex justify-between items-center">
                          <span className={i === selectedRouteIndex ? 'text-amber-300 font-semibold' : 'text-white/50'}>
                            {r.label}
                          </span>
                          <span className={`text-[10px] tabular-nums ${i === selectedRouteIndex ? 'text-amber-400/70' : 'text-white/30'}`}>
                            {formatDist(r.distanceM)}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-400 transition-all duration-300"
                              style={{ width: `${Math.round(r.shadowCoverage * 100)}%` }}
                            />
                          </div>
                          <span className="text-white/40 text-[10px] tabular-nums w-7 text-right">
                            {Math.round(r.shadowCoverage * 100)}%
                          </span>
                        </div>
                        {hasSecondLine && (
                          <div className="text-slate-400 text-[10px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                            {streak && <span>{streak}</span>}
                            <span>{transitions}</span>
                            {detour && <span>{detour}</span>}
                            {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? '' : 's'}</span>}
                          </div>
                        )}
                        {r.legs?.find((l: RouteLeg) => l.type === 'transit') && (() => {
                          const tLeg = r.legs!.find((l: RouteLeg) => l.type === 'transit')!;
                          const lineColor = tLeg.lineColor ?? '#0070BD';
                          const lineName = tLeg.lineName ?? tLeg.line ?? 'Transit';
                          const stopCount = (tLeg.stops?.length ?? 2) - 1;
                          const totalMin = Math.ceil((r.totalTimeSec ?? 0) / 60);
                          const sunExposure = tLeg.sunExposure ?? 0;
                          const sunLabel = transitSunCardLabel(sunExposure);
                          const sunColorClass = sunExposure < 0.05
                            ? "text-cyan-400/70"
                            : sunExposure < 0.2
                            ? "text-green-400/70"
                            : "text-yellow-400/70";
                          return (
                            <div className="mt-1.5 text-[10px] text-white/50 flex flex-col gap-0.5">
                              <div className="flex items-center gap-1">
                                <span
                                  className="inline-block w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: lineColor }}
                                />
                                <span>{lineName}</span>
                                <span className="text-white/20">·</span>
                                <span>{stopCount} stop{stopCount !== 1 ? 's' : ''}</span>
                              </div>
                              <div className="flex gap-x-2 flex-wrap">
                                <span>{totalMin} min total</span>
                                <span className="text-white/20">·</span>
                                <span className={sunColorClass}>{sunLabel}</span>
                              </div>
                            </div>
                          );
                        })()}
                      </button>
                      {onSaveRoute && (
                        <button type="button"
                          onClick={() => onSaveRoute(i)}
                          title="Save this route"
                          className="shrink-0 mt-0.5 p-1.5 rounded text-white/25 hover:text-amber-400 hover:bg-amber-400/10 border border-transparent hover:border-amber-400/20 transition-all"
                        >
                          <svg aria-hidden="true" focusable="false" width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 1h9v11L5.5 9.5 1 12V1z"/>
                          </svg>
                        </button>
                      )}
                      {onExportRoute && (
                        <div className="relative group/export shrink-0 mt-0.5">
                          <button type="button"
                            className="p-1.5 rounded text-white/25 hover:text-white/60 transition-colors"
                            title="Export route"
                          >
                            <svg aria-hidden="true" focusable="false" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5.5 1v7M2 5l3.5 3.5L9 5"/><line x1="1" y1="10" x2="10" y2="10"/>
                            </svg>
                          </button>
                          <div className="hidden group-hover/export:flex absolute right-0 top-full mt-1 flex-col bg-[#1a1a1a] border border-white/10 rounded shadow-xl z-30 min-w-max">
                            <button type="button" onClick={() => onExportRoute(i, "gpx")} className="px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/5 text-left transition-colors">GPX</button>
                            <button type="button" onClick={() => onExportRoute(i, "geojson")} className="px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/5 text-left transition-colors">GeoJSON</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Warning (non-fatal, e.g. sketch gaps) */}
            {warning && (
              <div className="text-xs text-yellow-400/80 border-t border-white/10 pt-2 shrink-0">
                {warning}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="text-xs text-red-400 border-t border-white/10 pt-2 shrink-0">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Collapse toggle tab — always visible on the sidebar's right edge */}
      <button type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="pointer-events-auto self-center glass-panel border border-l-0 rounded-r-lg px-1 py-4 text-white/40 hover:text-white/80 transition-colors shrink-0"
        title={collapsed ? 'Expand navigation panel' : 'Collapse navigation panel'}
      >
        <svg aria-hidden="true" focusable="false"
          width="8" height="12" viewBox="0 0 8 12"
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        >
          {collapsed
            ? <polyline points="2,2 6,6 2,10" />
            : <polyline points="6,2 2,6 6,10" />
          }
        </svg>
      </button>
    </div>
  );
}

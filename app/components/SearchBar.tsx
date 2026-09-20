import "../lib/storageMigration";
import { useState, useRef, useCallback, useEffect } from "react";
import { geocodeForward, type NominatimResult } from "../lib/nominatim";

interface SearchBarProps {
  onSelect: (place: {
    name: string;
    category?: string | null;
    address?: string | null;
    center: [number, number];
    zoom: number;
  }) => void;
  /** Map center used to compute distances for dropdown rows. [lng, lat] */
  mapCenter?: [number, number] | null;
  /** Optional: also close the panel when user clears the search */
  onClearPanel?: () => void;
  /** Called when the hamburger button is clicked (desktop sidebar toggle) */
  onMenuToggle?: () => void;
  /** Called when the directions button is clicked */
  onDirections?: () => void;
}

type RecentItem = { label: string; center: [number, number]; zoom: number };
type SavedItem = { label: string; center: [number, number]; zoom: number };

function haversineM(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem("umbra:recentSearches");
    const arr = raw ? (JSON.parse(raw) as any[]) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.label === "string" && Array.isArray(x.center) && x.center.length === 2)
      .slice(0, 6)
      .map((x) => ({
        label: String(x.label),
        center: [Number(x.center[0]), Number(x.center[1])],
        zoom: typeof x.zoom === "number" ? x.zoom : 14,
      }));
  } catch {
    return [];
  }
}

function saveRecent(item: RecentItem) {
  try {
    const existing = loadRecent();
    const next = [item, ...existing.filter((x) => x.label !== item.label)].slice(0, 8);
    localStorage.setItem("umbra:recentSearches", JSON.stringify(next));
  } catch {
    // ignore
  }
}

function loadSaved(): SavedItem[] {
  try {
    const raw = localStorage.getItem("umbra:savedPlaces");
    const arr = raw ? (JSON.parse(raw) as any[]) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.label === "string" && Array.isArray(x.center) && x.center.length === 2)
      .slice(0, 6)
      .map((x) => ({
        label: String(x.label),
        center: [Number(x.center[0]), Number(x.center[1])],
        zoom: typeof x.zoom === "number" ? x.zoom : 16,
      }));
  } catch {
    return [];
  }
}

function guessCategory(displayName: string): string {
  const parts = (displayName ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[1] ?? "Place";
}

function addressFromDisplayName(displayName: string): string {
  const parts = (displayName ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(1).join(", ");
}

function primaryName(displayName: string): string {
  return (displayName ?? "").split(",")[0]?.trim() || displayName;
}

function computeZoomFromBbox(bb: [string, string, string, string]): number {
  const [south, north] = [Number(bb[0]), Number(bb[1])];
  const latSpan = Math.max(1e-6, north - south);
  return Math.min(16, Math.max(2, Math.round(8 - Math.log2(latSpan))));
}

export default function SearchBar({ onSelect, mapCenter, onClearPanel, onMenuToggle, onDirections }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [isActive, setIsActive] = useState(false);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // Invalidates an in-flight geocode whose query the user has since changed.
  const searchGenRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useRef(`search-results-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    setRecent(loadRecent());
    setSaved(loadSaved());
  }, []);

  // Close recent/saved dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsActive(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Only ever called from an explicit submit. Nominatim's usage policy lists
  // autocomplete under unacceptable use, so no request may fire from a
  // keystroke; geocodeForward also caches and paces the request.
  const search = useCallback(async (q: string): Promise<NominatimResult[]> => {
    const gen = ++searchGenRef.current;
    if (q.trim().length === 0) {
      setResults([]);
      return [];
    }
    setIsSearching(true);
    try {
      const data = await geocodeForward(q);
      // The query moved on while this was in flight — its results belong to a
      // string the user is no longer looking at, and the top one is armed for
      // the next Enter, so dropping them is the whole point of the guard.
      if (gen !== searchGenRef.current) return [];
      setResults(data);
      // Highlight the top match so a second Enter takes it.
      setHighlightIndex(data.length > 0 ? 0 : -1);
      return data;
    } catch {
      if (gen !== searchGenRef.current) return [];
      setResults([]);
      return [];
    } finally {
      if (gen === searchGenRef.current) setIsSearching(false);
    }
  }, []);

  const handleSelect = useCallback(function handleSelect(r: NominatimResult) {
    const name = primaryName(r.display_name);
    setQuery(name);
    setResults([]);
    setIsActive(false);

    const bb = r.boundingbox;
    const center: [number, number] = bb
      ? [(Number(bb[2]) + Number(bb[3])) / 2, (Number(bb[0]) + Number(bb[1])) / 2]
      : [Number(r.lon), Number(r.lat)];
    const zoom = bb ? computeZoomFromBbox(bb) : 16;

    const item: RecentItem = { label: name, center, zoom };
    saveRecent(item);
    setRecent(loadRecent());

    onSelect({
      name,
      category: guessCategory(r.display_name),
      address: addressFromDisplayName(r.display_name) || null,
      center,
      zoom,
    });
  }, [onSelect]);

  const runSearchNow = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    await search(q);
  }, [query, search]);

  const handleMagnifierClick = useCallback(async () => {
    await runSearchNow();
  }, [runSearchNow]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    // Deliberately no search here — see the comment on `search`. Retyping does
    // still invalidate a geocode already in flight for the previous query.
    searchGenRef.current++;
    setResults([]);
    setHighlightIndex(-1);
  }


  function handleSelectSaved(item: SavedItem) {
    setQuery(item.label);
    setResults([]);
    setIsActive(false);
    saveRecent(item);
    setRecent(loadRecent());
    onSelect({ name: item.label, center: item.center, zoom: item.zoom });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      if (results.length === 0) return;
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && results[highlightIndex]) {
        handleSelect(results[highlightIndex]);
      } else {
        runSearchNow();
      }
    } else if (e.key === "Escape") {
      setResults([]);
      setIsActive(false);
      inputRef.current?.blur();
    }
  }

  function handleFocus() {
    setIsActive(true);
  }

  function handleClear() {
    setQuery("");
    setResults([]);
    onClearPanel?.();
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (highlightIndex < 0) return;
    const el = document.getElementById(`${listId}-opt-${highlightIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, listId]);

  const isOpen = results.length > 0;
  const showSections = isActive && !isOpen && (recent.length > 0 || saved.length > 0);

  return (
    <div ref={containerRef} className="relative">
      {/* Canopy search — the one 999 pill, >=70% white, the only blurred surface */}
      <div
        className="w-full flex items-center rounded-full bg-raised/90 backdrop-blur-md h-14 px-4 gap-3 border border-hairline"
        style={isActive ? { boxShadow: "var(--shadow-level-2)" } : undefined}
      >
        {/* Hamburger — toggles desktop sidebar */}
        {onMenuToggle && (
          <button type="button"
            onClick={onMenuToggle}
            className="shrink-0 text-ink hover:opacity-80 transition-opacity"
            aria-label="Toggle menu"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder="Search destinations..."
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={highlightIndex >= 0 ? `${listId}-opt-${highlightIndex}` : undefined}
          aria-autocomplete="list"
          className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none placeholder-ink-faint"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-sans)" }}
        />

        {/* Clear button */}
        {query.length > 0 && (
          <button type="button"
            onClick={handleClear}
            className="shrink-0 text-ink-faint hover:text-ink-muted transition-colors"
            aria-label="Clear search"
          >
            <svg width="16" height="16" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        )}

        {/* Magnifying glass — triggers search */}
        <button type="button"
          onClick={handleMagnifierClick}
          onMouseDown={(e) => e.preventDefault()}
          className="shrink-0 text-ink hover:opacity-80 transition-opacity"
          aria-label={isSearching ? "Searching" : "Search"}
          aria-busy={isSearching}
        >
          <span className={`material-symbols-outlined${isSearching ? " animate-spin" : ""}`}>
            {isSearching ? "progress_activity" : "search"}
          </span>
        </button>

        {/* Directions button */}
        {onDirections && (
          <button type="button"
            onClick={onDirections}
            className="shrink-0 text-ink-faint hover:opacity-80 transition-opacity"
            aria-label="Directions"
          >
            <span className="material-symbols-outlined">directions</span>
          </button>
        )}
      </div>

      {/* Recent/Saved sections */}
      {showSections && (
        <div
          className="absolute top-full mt-2 w-full bg-raised rounded-2xl overflow-hidden border z-20"
          style={{ borderColor: "var(--color-hairline)", boxShadow: "var(--shadow-level-2)" }}
        >
          {recent.length > 0 && (
            <div className="py-1">
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-ink-muted)" }}>
                RECENT
              </div>
              {recent.map((it, i) => {
                const dist = mapCenter ? formatDistance(haversineM(mapCenter, it.center)) : "";
                return (
                  <button type="button"
                    key={`${it.label}-${i}`}
                    onClick={() => handleSelectSaved(it)}
                    className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-canvas"
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}>
                      <span className="material-symbols-outlined text-base">location_on</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>{it.label}</div>
                      {dist && <div className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>{dist}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {saved.length > 0 && (
            <div className="border-t py-1" style={{ borderColor: "var(--color-hairline)" }}>
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide" style={{ color: "var(--color-ink-muted)" }}>
                SAVED
              </div>
              {saved.map((it, i) => {
                const dist = mapCenter ? formatDistance(haversineM(mapCenter, it.center)) : "";
                return (
                  <button type="button"
                    key={`${it.label}-${i}`}
                    onClick={() => handleSelectSaved(it)}
                    className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-canvas"
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}>
                      <span className="material-symbols-outlined text-base">bookmark</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>{it.label}</div>
                      {dist && <div className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>{dist}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Results dropdown */}
      {isOpen && (
        <div
          id={listId}
          role="listbox"
          className="absolute top-full mt-2 w-full bg-raised rounded-2xl overflow-hidden border z-20 max-h-72 overflow-y-auto umbra-scrollbar"
          style={{ borderColor: "var(--color-hairline)", boxShadow: "var(--shadow-level-2)" }}
        >
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === highlightIndex}
              onClick={() => handleSelect(r)}
              className={`w-full text-left px-4 py-2 transition-colors flex items-center gap-3 ${
                i === highlightIndex ? "bg-canvas" : "hover:bg-canvas"
              }`}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}>
                <span className="material-symbols-outlined text-base">location_on</span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>
                  {primaryName(r.display_name)}
                </div>
                <div className="text-[11px] truncate" style={{ color: "var(--color-ink-muted)" }}>
                  {guessCategory(r.display_name)}
                </div>
              </div>

              {mapCenter && (
                <div className="text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                  {formatDistance(haversineM(mapCenter, [Number(r.lon), Number(r.lat)]))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

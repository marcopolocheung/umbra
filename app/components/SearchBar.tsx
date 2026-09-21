import "../lib/storageMigration";
import { useState, useRef, useCallback, useEffect } from "react";
import { geocodeForward, type NominatimResult } from "../lib/nominatim";
import { suggestPlaces, type FoursquareSuggestion } from "../services/foursquare";

interface SearchBarProps {
  onSelect: (place: {
    name: string;
    category?: string | null;
    address?: string | null;
    center: [number, number];
    zoom: number;
  }) => void;
  /** Map center used to compute distances for dropdown rows. [lat, lng] */
  mapCenter?: [number, number] | null;
  /** Optional: also close the panel when user clears the search */
  onClearPanel?: () => void;
  /** Called when the hamburger button is clicked (desktop sidebar toggle) */
  onMenuToggle?: () => void;
  /** Called when the directions button is clicked */
  onDirections?: () => void;
  /** Called when the assistant button is clicked — the launcher's only home. */
  onOpenAssistant?: () => void;
  /** The agent's turn status, for the thinking ping on the assistant button. */
  isAssistantThinking?: boolean;
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

/**
 * The map hook's `mapCenter` is [lat, lng], but every distance helper here
 * (and Foursquare's `ll`) speaks [lng, lat]. One swap point so no caller
 * guesses the convention.
 */
function toLngLat(c: [number, number]): [number, number] {
  return [c[1], c[0]];
}

/**
 * One dropdown row, whatever provider answered. An explicit submit races both
 * providers — Nominatim for addresses and streets, Foursquare for POIs — and
 * the merge interleaves them by distance so the user reads one ranking, not
 * two provider sections. Neither provider usually *fails* loudly; the real
 * failure is a silent empty list from one of them, which is exactly what the
 * race covers. Exported for tests.
 */
export type MergedSearchResult =
  | { kind: "nominatim"; r: NominatimResult; distM: number | null }
  | { kind: "fsq"; s: FoursquareSuggestion };

export function mergeSearchResults(
  nominatim: NominatimResult[],
  fsq: FoursquareSuggestion[],
  center: [number, number] | null,
): MergedSearchResult[] {
  const rows: MergedSearchResult[] = nominatim.map((r) => ({
    kind: "nominatim",
    r,
    distM: center ? haversineM(center, [Number(r.lon), Number(r.lat)]) : null,
  }));
  for (const s of fsq) {
    // A POI the address geocoder also found is the same place twice in one
    // list; the Nominatim row wins (it carries the bounding box), the
    // Foursquare duplicate is dropped.
    const duplicate = rows.some(
      (row) =>
        row.kind === "nominatim" &&
        primaryName(row.r.display_name).trim().toLocaleLowerCase() === s.name.trim().toLocaleLowerCase() &&
        Math.abs(Number(row.r.lat) - s.lat) < 0.002 &&
        Math.abs(Number(row.r.lon) - s.lng) < 0.002,
    );
    if (!duplicate) rows.push({ kind: "fsq", s });
  }
  // Distance-first where the anchor allows it; rows without a distance keep
  // their provider order at the end.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const da = a.row.kind === "fsq" ? (a.row.s.distanceM ?? Number.POSITIVE_INFINITY) : (a.row.distM ?? Number.POSITIVE_INFINITY);
      const db = b.row.kind === "fsq" ? (b.row.s.distanceM ?? Number.POSITIVE_INFINITY) : (b.row.distM ?? Number.POSITIVE_INFINITY);
      return da - db || a.i - b.i;
    })
    .map(({ row }) => row)
    .slice(0, 8);
}

export default function SearchBar({ onSelect, mapCenter, onClearPanel, onMenuToggle, onDirections, onOpenAssistant, isAssistantThinking = false }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MergedSearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<FoursquareSuggestion[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [isActive, setIsActive] = useState(false);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // Invalidates an in-flight geocode whose query the user has since changed.
  const searchGenRef = useRef(0);
  // Same guard for the Foursquare typeahead, plus its debounce handle. The
  // typeahead is the one autocomplete path in the app — Foursquare only; the
  // Nominatim policy forbids autocomplete, so `search` stays submit-only.
  const suggestGenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
        // A tap on the map must close the typeahead like every other dropdown.
        setSuggestions([]);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Only ever called from an explicit submit. Nominatim's usage policy lists
  // autocomplete under unacceptable use, so no Nominatim request may fire from
  // a keystroke; on submit, though, both providers race — Nominatim answers
  // addresses, Foursquare answers POIs, and either alone can come back
  // silently empty for what the user typed.
  const search = useCallback(async (q: string): Promise<MergedSearchResult[]> => {
    const gen = ++searchGenRef.current;
    if (q.trim().length === 0) {
      setResults([]);
      return [];
    }
    setIsSearching(true);
    try {
      const ll = mapCenterRef.current;
      const [nominatim, fsq] = await Promise.all([
        geocodeForward(q).catch(() => [] as NominatimResult[]),
        ll
          ? suggestPlaces(q, toLngLat(ll), { limit: 4 }).catch(
              () => [] as FoursquareSuggestion[],
            )
          : Promise.resolve([] as FoursquareSuggestion[]),
      ]);
      const merged = mergeSearchResults(nominatim, fsq, ll ?? null);
      // The query moved on while this was in flight — its results belong to a
      // string the user is no longer looking at, and the top one is armed for
      // the next Enter, so dropping them is the whole point of the guard.
      if (gen !== searchGenRef.current) return [];
      setResults(merged);
      // Highlight the top match so a second Enter takes it.
      setHighlightIndex(merged.length > 0 ? 0 : -1);
      return merged;
    } finally {
      if (gen === searchGenRef.current) setIsSearching(false);
    }
  }, []);

  const handleSelectSuggestion = useCallback(
    function handleSelectSuggestion(s: FoursquareSuggestion) {
      setQuery(s.name);
      setSuggestions([]);
      setResults([]);
      setIsActive(false);

      saveRecent({ label: s.name, center: [s.lng, s.lat], zoom: 16 });
      setRecent(loadRecent());

      onSelect({
        name: s.name,
        category: s.category,
        address: s.address,
        center: [s.lng, s.lat],
        zoom: 16,
      });
    },
    [onSelect],
  );

  const handleSelect = useCallback(function handleSelect(row: MergedSearchResult) {
    if (row.kind === "fsq") {
      handleSelectSuggestion(row.s);
      return;
    }
    const r = row.r;
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
  }, [onSelect, handleSelectSuggestion]);

  const runSearchNow = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    // An explicit submit hands the dropdown to Nominatim's full results.
    suggestGenRef.current++;
    abortRef.current?.abort();
    setSuggestions([]);
    await search(q);
  }, [query, search]);

  const handleMagnifierClick = useCallback(async () => {
    await runSearchNow();
  }, [runSearchNow]);

  // The typeahead re-anchors on the next keystroke, not on every pan: the map
  // center flows into a ref, so a completed pan never re-fires the search (and
  // never drops a surprise dropdown over the map the user is looking at).
  const mapCenterRef = useRef(mapCenter);
  mapCenterRef.current = mapCenter;

  // Foursquare typeahead: debounced, abortable, anchored to the map center.
  // Only Foursquare may autocomplete (OSMF policy — see the comment on
  // `search`); Nominatim still waits for an explicit submit.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setHighlightIndex(-1);
      return;
    }
    const gen = ++suggestGenRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const timer = setTimeout(() => {
      const ll = mapCenterRef.current;
      if (!ll) return;
      suggestPlaces(q, toLngLat(ll), { signal: controller.signal }).then((data) => {
        if (gen !== suggestGenRef.current) return;
        setSuggestions(data);
        setHighlightIndex(data.length > 0 ? 0 : -1);
      });
    }, 300);
    debounceRef.current = timer;
    return () => clearTimeout(timer);
  }, [query]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    // Deliberately no Nominatim search here — see the comment on `search`.
    // Retyping does still invalidate a geocode already in flight, and the
    // typeahead effect above re-arms on the new value.
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

  // The visible dropdown is the Foursquare suggestions while they exist, else
  // the merged submit results; one highlight index serves whichever shows.
  function handleKeyDown(e: React.KeyboardEvent) {
    const suggestionList = results.length === 0 && suggestions.length > 0;
    const listLen = suggestionList ? suggestions.length : results.length;
    if (e.key === "ArrowDown") {
      if (listLen === 0) return;
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, listLen - 1));
    } else if (e.key === "ArrowUp") {
      if (listLen === 0) return;
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestionList && highlightIndex >= 0 && suggestions[highlightIndex]) {
        handleSelectSuggestion(suggestions[highlightIndex]);
      } else if (!suggestionList && highlightIndex >= 0 && results[highlightIndex]) {
        handleSelect(results[highlightIndex]);
      } else {
        runSearchNow();
      }
    } else if (e.key === "Escape") {
      setResults([]);
      setSuggestions([]);
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
    setSuggestions([]);
    onClearPanel?.();
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (highlightIndex < 0) return;
    const el = document.getElementById(`${listId}-opt-${highlightIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, listId]);

  const isOpen = results.length > 0;
  // While the user types, the Foursquare suggestions own the dropdown; the
  // submitted Nominatim results take it back on submit.
  const suggestionsOpen = !isOpen && suggestions.length > 0;
  const showSections = isActive && !isOpen && !suggestionsOpen && (recent.length > 0 || saved.length > 0);

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
          aria-expanded={isOpen || suggestionsOpen}
          aria-controls={isOpen || suggestionsOpen ? listId : undefined}
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

        {/* Assistant — its single permanent launcher home; the bottom-of-screen
            blobs are gone. Ping while the agent is thinking. */}
        {onOpenAssistant && (
          <button type="button"
            onClick={onOpenAssistant}
            className="relative shrink-0 text-ink hover:opacity-80 transition-opacity"
            aria-label="Open Umbra Assistant"
          >
            {isAssistantThinking && (
              <span
                className="absolute inset-0 rounded-full opacity-40 motion-safe:animate-ping"
                style={{ background: "var(--color-ink)" }}
                aria-hidden="true"
              />
            )}
            <span
              className="material-symbols-outlined"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              assistant
            </span>
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
                const dist = mapCenter ? formatDistance(haversineM(toLngLat(mapCenter), it.center)) : "";
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
                const dist = mapCenter ? formatDistance(haversineM(toLngLat(mapCenter), it.center)) : "";
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

      {/* Foursquare typeahead suggestions — the one autocomplete path */}
      {suggestionsOpen && (
        <div
          id={listId}
          role="listbox"
          className="absolute top-full mt-2 w-full bg-raised rounded-2xl overflow-hidden border z-20 max-h-72 overflow-y-auto umbra-scrollbar"
          style={{ borderColor: "var(--color-hairline)", boxShadow: "var(--shadow-level-2)" }}
        >
          {suggestions.map((s, i) => (
            <button
              key={`${s.fsqId ?? s.name}-${i}`}
              type="button"
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === highlightIndex}
              onClick={() => handleSelectSuggestion(s)}
              className={`w-full text-left px-4 py-2.5 transition-colors flex items-center gap-3 min-h-11 ${
                i === highlightIndex ? "bg-canvas" : "hover:bg-canvas"
              }`}
            >
              {s.photo ? (
                <img
                  src={s.photo}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-10 h-10 rounded-lg object-cover shrink-0"
                  style={{ border: "1px solid var(--color-hairline)" }}
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
                >
                  <span className="material-symbols-outlined text-base">location_on</span>
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>
                  {s.name}
                </div>
                {(s.category || s.hours) && (
                  <div className="text-[11px] truncate" style={{ color: "var(--color-ink-muted)" }}>
                    {[s.category, s.hours].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>

              <div className="shrink-0 flex flex-col items-end gap-0.5">
                {typeof s.rating === "number" && (
                  <div
                    className="text-[11px] tabular-nums flex items-center gap-0.5"
                    style={{ color: "var(--color-ink)" }}
                  >
                    <span className="material-symbols-outlined text-xs" aria-hidden="true">star</span>
                    {s.rating.toFixed(1)}/10
                  </div>
                )}
                {mapCenter && typeof s.distanceM === "number" && (
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                    {formatDistance(s.distanceM)}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Results dropdown — merged submit results from both providers */}
      {isOpen && (
        <div
          id={listId}
          role="listbox"
          className="absolute top-full mt-2 w-full bg-raised rounded-2xl overflow-hidden border z-20 max-h-72 overflow-y-auto umbra-scrollbar"
          style={{ borderColor: "var(--color-hairline)", boxShadow: "var(--shadow-level-2)" }}
        >
          {results.map((row, i) =>
            row.kind === "fsq" ? (
              <button
                key={`fsq-${row.s.fsqId ?? row.s.name}-${i}`}
                type="button"
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === highlightIndex}
                onClick={() => handleSelect(row)}
                className={`w-full text-left px-4 py-2.5 transition-colors flex items-center gap-3 min-h-11 ${
                  i === highlightIndex ? "bg-canvas" : "hover:bg-canvas"
                }`}
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
                >
                  <span className="material-symbols-outlined text-base">location_on</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>
                    {row.s.name}
                  </div>
                  {(row.s.category || row.s.hours) && (
                    <div className="text-[11px] truncate" style={{ color: "var(--color-ink-muted)" }}>
                      {[row.s.category, row.s.hours].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                {mapCenter && typeof row.s.distanceM === "number" && (
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                    {formatDistance(row.s.distanceM)}
                  </div>
                )}
              </button>
            ) : (
              <button
                key={`nom-${i}`}
                type="button"
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === highlightIndex}
                onClick={() => handleSelect(row)}
                className={`w-full text-left px-4 py-2.5 transition-colors flex items-center gap-3 min-h-11 ${
                  i === highlightIndex ? "bg-canvas" : "hover:bg-canvas"
                }`}
              >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}>
                  <span className="material-symbols-outlined text-base">location_on</span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>
                    {primaryName(row.r.display_name)}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: "var(--color-ink-muted)" }}>
                    {guessCategory(row.r.display_name)}
                  </div>
                </div>

                {mapCenter && row.distM != null && (
                  <div className="text-[11px] tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                    {formatDistance(row.distM)}
                  </div>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

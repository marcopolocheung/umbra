import { useState, useRef, useEffect, memo } from "react";
import { geocodeForward, type NominatimResult } from "../lib/nominatim";

interface WaypointInputProps {
  label: string | null;
  placeholder: string;
  dotColor: "green" | "red" | "amber";
  onSet: (coord: [number, number], label: string) => void;
  onClear: () => void;
}

const WaypointInput = memo(function WaypointInput({
  label,
  placeholder,
  dotColor,
  onSet,
  onClear,
}: WaypointInputProps) {
  const [query, setQuery] = useState(label ?? "");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const searchGenRef = useRef(0);
  const focusedRef = useRef(false);
  const labelRef = useRef(label);
  labelRef.current = label;

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
    setSearching(true);
    try {
      const res = await geocodeForward(q);
      if (gen !== searchGenRef.current) return;
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
    } finally {
      if (gen === searchGenRef.current) setSearching(false);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
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

  return (
    <div className="relative flex flex-col gap-0.5">
      <div className="flex items-center gap-3 relative z-10">
        {dotColor === "green" ? (
          <span className="material-symbols-outlined text-chrome bg-chrome-soft rounded-full p-0.5 text-sm shrink-0">
            radio_button_checked
          </span>
        ) : dotColor === "red" ? (
          <span className="material-symbols-outlined text-chrome bg-chrome-soft rounded-full p-0.5 text-sm shrink-0">
            location_on
          </span>
        ) : (
          <span className="material-symbols-outlined text-chrome bg-chrome-soft rounded-full p-0.5 text-sm shrink-0">
            add_location
          </span>
        )}
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
            setQuery(labelRef.current ?? "");
            closeDropdown();
          }}
          className="flex-1 min-w-0 rounded px-2 py-1 text-xs placeholder-ink-faint border-none focus:outline-none transition-colors bg-transparent"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-sans)" }}
        />
        {label && (
          <button type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onClear(); setQuery(""); closeDropdown(); }}
            className="shrink-0 text-ink-faint hover:text-ink transition-colors leading-none px-0.5"
            title="Clear waypoint"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        )}
      </div>
      {inlineError ? (
        <p className="text-[10px] text-danger pl-8">{inlineError}</p>
      ) : searching ? (
        <p className="text-[10px] pl-8" style={{ color: "var(--color-ink-muted)" }}>Searching…</p>
      ) : results.length === 0 && query.trim().length >= 2 && label === null ? (
        <p className="text-[10px] pl-8" style={{ color: "var(--color-ink-muted)" }}>Press Enter to search</p>
      ) : null}
      {results.length > 0 && (
        <div
          className="absolute top-full left-8 right-0 mt-0.5 z-50 bg-raised border rounded-xl overflow-hidden"
          style={{ borderColor: "var(--color-hairline)", boxShadow: "var(--shadow-level-2)" }}
        >
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
                className={`w-full text-left px-3 py-2 transition-colors ${
                  i === highlight ? "bg-chrome-soft" : "hover:bg-chrome-soft"
                }`}
              >
                <div className="text-xs truncate" style={{ color: i === highlight ? "var(--color-chrome)" : "var(--color-ink)" }}>
                  {primary}
                </div>
                {secondary && (
                  <div className="text-[10px] truncate" style={{ color: "var(--color-ink-muted)" }}>{secondary}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default WaypointInput;

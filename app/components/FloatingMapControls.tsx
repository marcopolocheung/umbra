import type maplibregl from "maplibre-gl";

/** Pitch the 3D view tilts to. Enough to read building height without losing the street. */
const TILTED_PITCH_DEG = 55;

interface FloatingMapControlsProps {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  /** Current camera pitch in degrees, from `useShadowTime`. 0 means top-down. */
  pitch: number;
  onLocateMe: () => void;
  isLocating: boolean;
  onShare?: () => void;
  shareStatus?: "idle" | "copied" | "error";
  /** Rain objective toggle — absent keeps the control out of the column. */
  rainMode?: boolean;
  onRainModeChange?: (mode: boolean) => void;
  /** Deprecated compatibility props; rain has no intensity slider. */
  rainIntensity?: number;
  onRainIntensityChange?: (v: number) => void;
}

export default function FloatingMapControls({
  mapRef,
  pitch,
  onLocateMe,
  isLocating,
  onShare,
  shareStatus = "idle",
  rainMode = false,
  onRainModeChange,
  rainIntensity: _rainIntensity = 5,
  onRainIntensityChange: _onRainIntensityChange,
}: FloatingMapControlsProps) {
  const is3D = pitch > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Zoom in */}
      <button
        type="button"
        onClick={() => mapRef.current?.zoomIn()}
        className="w-12 h-12 rounded-2xl bg-raised shadow-level-2 flex items-center justify-center text-ink-muted hover:text-ink transition-colors"
        aria-label="Zoom in"
        title="Zoom in"
      >
        <span className="material-symbols-outlined">add</span>
      </button>

      {/* Zoom out */}
      <button
        type="button"
        onClick={() => mapRef.current?.zoomOut()}
        className="w-12 h-12 rounded-2xl bg-raised shadow-level-2 flex items-center justify-center text-ink-muted hover:text-ink transition-colors"
        aria-label="Zoom out"
        title="Zoom out"
      >
        <span className="material-symbols-outlined">remove</span>
      </button>

      <div className="h-px w-8 bg-hairline-strong self-center my-1" />

      {/* Objective toggle and share live in the sheet on mobile (the directions
          panel owns the sun/rain switch; share rides the route card) — the phone
          keeps only camera controls in this column. */}
      {onRainModeChange && (
          <fieldset
            className="hidden md:flex rounded-2xl overflow-hidden shadow-xl self-center border-0 p-0 m-0"
            aria-label="Route objective"
          >
            <button
              type="button"
              onClick={() => onRainModeChange(false)}
              aria-pressed={!rainMode}
              title="Route by sun exposure"
              className={`w-14 h-10 flex items-center justify-center transition-colors ${
                !rainMode ? "bg-ink text-on-ink" : "bg-raised text-ink-muted hover:text-ink"
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">light_mode</span>
            </button>
            <button
              type="button"
              onClick={() => onRainModeChange(true)}
              aria-pressed={rainMode}
              title="Route away from rain (experimental)"
              className={`w-14 h-10 flex items-center justify-center transition-colors ${
                rainMode ? "bg-route text-on-route" : "bg-raised text-ink-muted hover:text-route"
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">rainy</span>
            </button>
          </fieldset>
      )}

      {onShare && (
        <button
          type="button"
          onClick={onShare}
          className="hidden md:flex w-12 h-12 rounded-2xl bg-raised shadow-level-2 items-center justify-center text-ink-muted hover:text-ink transition-colors"
          aria-label={shareStatus === "copied" ? "Share link copied" : "Copy share link"}
          title={shareStatus === "copied" ? "Copied" : shareStatus === "error" ? "Copy failed" : "Copy share link"}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontVariationSettings: shareStatus === "copied" ? "'FILL' 1" : undefined }}
          >
            {shareStatus === "copied" ? "check" : "ios_share"}
          </span>
        </button>
      )}

      {/* My Location */}
      <button
        type="button"
        onClick={onLocateMe}
        className="w-12 h-12 rounded-2xl bg-raised shadow-level-2 flex items-center justify-center text-ink-muted hover:text-ink transition-colors"
        aria-label="My location"
        title="My location"
        disabled={isLocating}
      >
        {isLocating ? (
          <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20" className="animate-spin text-ink">
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeDashoffset="8" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>my_location</span>
        )}
      </button>

      {/* 2D / 3D */}
      <button
        type="button"
        onClick={() => {
          const map = mapRef.current;
          if (!map) return;
          const to3D = map.getPitch() === 0;
          // Tilting is the one camera move that can provoke motion sickness, so honour
          // the OS setting rather than easing into it.
          const reduceMotion =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const camera = { pitch: to3D ? TILTED_PITCH_DEG : 0 };
          if (reduceMotion) map.jumpTo(camera);
          else map.easeTo({ ...camera, duration: 400 });
        }}
        className={`w-12 h-12 rounded-2xl shadow-xl flex items-center justify-center transition-colors ${
          is3D ? "bg-ink text-on-ink" : "bg-raised text-ink-muted hover:text-ink"
        }`}
        aria-pressed={is3D}
        aria-label={is3D ? "Return to 2D map" : "Tilt to 3D map"}
        title={is3D ? "Return to 2D map" : "Tilt to 3D map"}
      >
        <span className="material-symbols-outlined">3d_rotation</span>
      </button>
    </div>
  );
}

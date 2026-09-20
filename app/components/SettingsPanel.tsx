import { useState } from "react";

interface SettingsPanelProps {
  showSunLines: boolean;
  onShowSunLinesChange: (v: boolean) => void;
}

export default function SettingsPanel({
  showSunLines,
  onShowSunLinesChange,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 items-start">
      <button type="button"
        onClick={() => setOpen((o) => !o)}
        className={`text-xs px-3 py-1.5 rounded-lg transition-colors border ${
          open ? "bg-canvas" : "bg-raised hover:bg-canvas"
        }`}
        style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink)" }}
        title="Settings"
      >
        <span className="material-symbols-outlined text-sm align-middle mr-1">settings</span>
        Settings
      </button>

      {open && (
        <div
          className="rounded-lg p-3 flex flex-col gap-3 text-xs min-w-panel-min border"
          style={{
            background: "var(--color-raised)",
            color: "var(--color-ink)",
            borderColor: "var(--color-hairline)",
            boxShadow: "var(--shadow-level-1)",
          }}
        >
          <div className="uppercase tracking-widest text-[9px] font-bold" style={{ color: "var(--color-ink-muted)" }}>
            Display
          </div>

          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span style={{ color: "var(--color-ink)" }}>Sun direction lines</span>
            <input
              type="checkbox"
              checked={showSunLines}
              onChange={(e) => onShowSunLinesChange(e.target.checked)}
              className="accent-chrome w-4 h-4"
            />
          </label>

          {showSunLines && (
            <div className="flex flex-col gap-1.5 pl-1 border-l" style={{ borderColor: "var(--color-hairline)" }}>
              <div className="flex items-center gap-2">
                <span className="text-sun text-sm leading-none">☀</span>
                <span style={{ color: "var(--color-ink-muted)" }}>Current sun (overlay)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: "var(--color-sun)" }} />
                <span style={{ color: "var(--color-ink-muted)" }}>Sunrise</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: "var(--color-route)" }} />
                <span style={{ color: "var(--color-ink-muted)" }}>Sunset</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

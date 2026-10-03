import { useState } from "react";
import type { HeatProfile, HeatTolerance } from "../lib/heat/profile";
import type { SkinType } from "../lib/heat/types";
import type { ThemePreference } from "../lib/uiTheme";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "day", label: "Day" },
  { value: "night", label: "Night" },
];

interface SettingsPanelProps {
  themePreference: ThemePreference;
  onThemePreferenceChange: (v: ThemePreference) => void;
  showSunLines: boolean;
  onShowSunLinesChange: (v: boolean) => void;
  showSheds: boolean;
  onShowShedsChange: (v: boolean) => void;
  /** D5: the personal heat profile. */
  profile: HeatProfile;
  onProfileChange: (p: HeatProfile) => void;
}

export default function SettingsPanel({
  themePreference,
  onThemePreferenceChange,
  showSunLines,
  onShowSunLinesChange,
  showSheds,
  onShowShedsChange,
  profile,
  onProfileChange,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 items-start">
      <button type="button"
        onClick={() => setOpen((o) => !o)}
        className={`min-h-11 px-3 text-xs transition-colors border ${
          open ? "bg-ground" : "bg-panel hover:bg-ground"
        }`}
        style={{ borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
        title="Settings"
      >
        <span className="material-symbols-outlined text-sm align-middle mr-1">settings</span>
        Settings
      </button>

      {open && (
        <div
          className="p-3 flex flex-col gap-3 text-xs min-w-panel-min border"
          style={{
            background: "var(--color-panel)",
            color: "var(--color-ink)",
            borderColor: "var(--color-rule)",
            boxShadow: "var(--shadow-hard-1)",
          }}
        >
          <div className="uppercase tracking-widest text-[11px] font-bold" style={{ color: "var(--color-ink-muted)" }}>
            Display
          </div>

          {/* Umbra redesign 2.0 D2: the override changes panels only; the basemap
              follows the sun so shadow detection never runs on a dark map. The focus
              ring is inset because the group clips an outer outline. */}
          <fieldset className="flex flex-col gap-1.5 min-w-0 border-0 p-0 m-0">
            <legend className="mb-1.5 p-0" style={{ color: "var(--color-ink)" }}>Theme</legend>
            <div
              className="flex overflow-hidden border"
              style={{ borderColor: "var(--color-rule)" }}
            >
              {THEME_OPTIONS.map(({ value, label }) => (
                <button type="button"
                  key={value}
                  onClick={() => onThemePreferenceChange(value)}
                  aria-pressed={themePreference === value}
                  aria-describedby="settings-theme-scope"
                  className={`flex flex-1 min-h-11 items-center justify-center px-2.5 font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current ${
                    themePreference === value ? "bg-ink text-on-ink" : "text-ink hover:bg-ground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span id="settings-theme-scope" className="max-w-panel-min" style={{ color: "var(--color-ink-muted)" }}>
              Auto follows the sun at the map's place and time. Day and Night change the
              panels only, not the map.
            </span>
          </fieldset>

          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span style={{ color: "var(--color-ink)" }}>Sun direction lines</span>
            <input
              type="checkbox"
              checked={showSunLines}
              onChange={(e) => onShowSunLinesChange(e.target.checked)}
              className="accent-ink w-4 h-4"
            />
          </label>

          {showSunLines && (
            <div className="flex flex-col gap-1.5 pl-1 border-l" style={{ borderColor: "var(--color-rule)" }}>
              <div className="flex items-center gap-2">
                <span className="text-sun text-sm leading-none">☀</span>
                <span style={{ color: "var(--color-ink-muted)" }}>Current sun (overlay)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: "var(--color-sun-signal)" }} />
                <span style={{ color: "var(--color-ink-muted)" }}>Sunrise</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: "var(--color-sun-signal)" }} />
                <span style={{ color: "var(--color-ink-muted)" }}>Sunset</span>
              </div>
            </div>
          )}

          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span style={{ color: "var(--color-ink)" }}>Sidewalk sheds</span>
            <input
              type="checkbox"
              checked={showSheds}
              onChange={(e) => onShowShedsChange(e.target.checked)}
              className="accent-ink w-4 h-4"
            />
          </label>

          {showSheds && (
            <div className="flex items-start gap-2 pl-1 border-l" style={{ borderColor: "var(--color-rule)" }}>
              {/* The map fill: --color-shed-map at 30% (shedLayer.ts). */}
              <span
                className="inline-block w-3 h-3 rounded-sm shrink-0 mt-0.5 border"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--color-shed-map) 30%, transparent)",
                  borderColor: "var(--color-rule-strong)",
                }}
              />
              <span className="max-w-panel-min" style={{ color: "var(--color-ink-muted)" }}>
                Current NYC permits near the last route's streets; placement is approximate.
                Their shade counts in routing but is not painted on the map.
              </span>
            </div>
          )}
          <div
            className="uppercase tracking-widest text-[11px] font-bold pt-2 border-t"
            style={{ color: "var(--color-ink-muted)", borderColor: "var(--color-rule)" }}
          >
            You
          </div>

          {/* D5 — local-only profile. Labels wrap their controls, so each field is
              associated without an id; nothing here leaves the device. */}
          <label className="flex flex-col gap-1" style={{ color: "var(--color-ink)" }}>
            <span>Skin type (Fitzpatrick I–VI)</span>
            <select
              value={profile.skinType}
              onChange={(e) => onProfileChange({ ...profile, skinType: e.target.value as SkinType })}
              className="min-h-11 border px-2"
              style={{ background: "var(--color-panel)", borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
            >
              {(["I", "II", "III", "IV", "V", "VI"] as SkinType[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1" style={{ color: "var(--color-ink)" }}>
            <span>Heat tolerance</span>
            <select
              value={profile.heatTolerance}
              onChange={(e) => onProfileChange({ ...profile, heatTolerance: e.target.value as HeatTolerance })}
              className="min-h-11 border px-2"
              style={{ background: "var(--color-panel)", borderColor: "var(--color-rule)", color: "var(--color-ink)" }}
            >
              {(["low", "moderate", "high"] as HeatTolerance[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span style={{ color: "var(--color-ink)" }}>I burn easily</span>
            <input
              type="checkbox"
              checked={profile.burnsEasily}
              onChange={(e) => onProfileChange({ ...profile, burnsEasily: e.target.checked })}
              className="accent-ink w-4 h-4"
            />
          </label>

          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span style={{ color: "var(--color-ink)" }}>I overheat easily</span>
            <input
              type="checkbox"
              checked={profile.overheatsEasily}
              onChange={(e) => onProfileChange({ ...profile, overheatsEasily: e.target.checked })}
              className="accent-ink w-4 h-4"
            />
          </label>

          <p className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
            Used only on this device to tune the dose, heat score and how much shade routes
            favour. Nothing is sent anywhere.
          </p>
        </div>
      )}
    </div>
  );
}

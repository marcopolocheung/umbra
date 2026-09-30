import SunCalc from "suncalc";

/**
 * Umbra redesign 2.0 UI theme (decision D2, docs/design/language.md).
 *
 * Automatic: day while the sun is above the horizon at the selected map place and
 * time, night at or below it. Settings may force either UI theme. This only picks
 * the UI palette — the basemap follows `solarTheme` regardless of the override
 * (R4), so a forced night UI never pairs the dark basemap with daylight shadows.
 */
export type UiTheme = "day" | "night";
export type ThemePreference = "auto" | UiTheme;

export const THEME_PREFERENCE_KEY = "umbra:uiTheme";

/** Day for solar altitude > 0°, night at or below 0°. Day while the place is unknown. */
export function solarTheme(date: Date, center: [lat: number, lng: number] | null): UiTheme {
  if (!center) return "day";
  return SunCalc.getPosition(date, center[0], center[1]).altitude > 0 ? "day" : "night";
}

export function resolveUiTheme(preference: ThemePreference, solar: UiTheme): UiTheme {
  return preference === "auto" ? solar : preference;
}

/** Switches every role token, and the browser chrome to the new ground role. */
export function applyUiTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = theme;
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--color-ground").trim();
  if (ground) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ground);
}

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_PREFERENCE_KEY);
    return raw === "day" || raw === "night" ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "auto") localStorage.removeItem(THEME_PREFERENCE_KEY);
    else localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Storage unavailable (private mode, quota): the choice lasts this session only.
  }
}

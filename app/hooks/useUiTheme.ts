import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import {
  applyUiTheme,
  readThemePreference,
  resolveUiTheme,
  solarTheme,
  writeThemePreference,
  type ThemePreference,
} from "../lib/uiTheme";

/**
 * The UI theme for the selected map time and place, with the persisted Settings
 * override. Writes `data-theme` on `<html>`, which switches every role token.
 * `solar` is exposed separately because the basemap (R4) follows it, never the override.
 */
export function useUiTheme(date: Date, mapCenter: [number, number] | null) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
  const solar = useMemo(() => solarTheme(date, mapCenter), [date, mapCenter]);
  const theme = resolveUiTheme(preference, solar);

  useLayoutEffect(() => applyUiTheme(theme), [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    setPreferenceState(next);
  }, []);

  return { theme, solar, preference, setPreference };
}

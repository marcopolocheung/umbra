/* @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_PREFERENCE_KEY } from "../../lib/uiTheme";
import { useUiTheme } from "../useUiTheme";

afterEach(cleanup);

const NYC: [number, number] = [40.7128, -74.006];
const NOON = new Date("2026-06-21T16:00:00Z");
const MIDNIGHT = new Date("2026-06-21T04:00:00Z");

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("useUiTheme", () => {
  it("follows the selected time on auto and writes data-theme", () => {
    const { result, rerender } = renderHook(({ date }) => useUiTheme(date, NYC), {
      initialProps: { date: NOON },
    });
    expect(result.current.preference).toBe("auto");
    expect(document.documentElement.dataset.theme).toBe("day");
    rerender({ date: MIDNIGHT });
    expect(result.current.theme).toBe("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("lets the override win over the sun, keeps solar for the basemap, and persists", () => {
    const { result } = renderHook(() => useUiTheme(NOON, NYC));
    act(() => result.current.setPreference("night"));
    expect(result.current.theme).toBe("night");
    expect(result.current.solar).toBe("day");
    expect(document.documentElement.dataset.theme).toBe("night");
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("night");

    cleanup();
    const reloaded = renderHook(() => useUiTheme(NOON, NYC));
    expect(reloaded.result.current.preference).toBe("night");
    expect(reloaded.result.current.theme).toBe("night");
  });

  it("returns to the sun when set back to auto", () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, "day");
    const { result } = renderHook(() => useUiTheme(MIDNIGHT, NYC));
    expect(result.current.theme).toBe("day");
    act(() => result.current.setPreference("auto"));
    expect(result.current.theme).toBe("night");
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBeNull();
  });

  it("ignores an unrecognised stored value", () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, "sepia");
    const { result } = renderHook(() => useUiTheme(MIDNIGHT, NYC));
    expect(result.current.preference).toBe("auto");
    expect(result.current.theme).toBe("night");
  });
});

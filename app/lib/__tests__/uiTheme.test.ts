import SunCalc from "suncalc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sunriseSunset } from "../sunTimes";
import { resolveUiTheme, solarTheme } from "../uiTheme";

const NYC: [number, number] = [40.7128, -74.006];
const SOLSTICE = new Date("2026-06-21T16:00:00Z"); // noon EDT

afterEach(() => vi.restoreAllMocks());

describe("solarTheme", () => {
  it("is day above the horizon and night at or below it", () => {
    const spy = vi.spyOn(SunCalc, "getPosition");
    spy.mockReturnValue({ altitude: 1e-6, azimuth: 0 });
    expect(solarTheme(SOLSTICE, NYC)).toBe("day");
    spy.mockReturnValue({ altitude: 0, azimuth: 0 });
    expect(solarTheme(SOLSTICE, NYC)).toBe("night");
    spy.mockReturnValue({ altitude: -0.2, azimuth: 0 });
    expect(solarTheme(SOLSTICE, NYC)).toBe("night");
  });

  it("follows the real sun at the selected place and time", () => {
    expect(solarTheme(SOLSTICE, NYC)).toBe("day");
    expect(solarTheme(new Date("2026-06-21T04:00:00Z"), NYC)).toBe("night");
    // Same instant, other side of the world: NYC's noon is Tokyo's 01:00.
    expect(solarTheme(SOLSTICE, [35.68, 139.69])).toBe("night");
  });

  it("switches at 0° geometric altitude, a few minutes before the sunset time", () => {
    // SunCalc's sunset is the upper limb at −0.833° (refraction), so 0° comes first.
    const { sunset } = sunriseSunset(SOLSTICE, NYC[0], NYC[1])!;
    const minutes = (m: number) => new Date(sunset.getTime() + m * 60_000);
    expect(solarTheme(minutes(-10), NYC)).toBe("day");
    expect(solarTheme(sunset, NYC)).toBe("night");
  });

  it("is day while the map place is unknown", () => {
    expect(solarTheme(new Date("2026-06-21T04:00:00Z"), null)).toBe("day");
  });
});

describe("resolveUiTheme", () => {
  it("follows the sun on auto and the override otherwise", () => {
    expect(resolveUiTheme("auto", "day")).toBe("day");
    expect(resolveUiTheme("auto", "night")).toBe("night");
    expect(resolveUiTheme("night", "day")).toBe("night");
    expect(resolveUiTheme("day", "night")).toBe("day");
  });
});

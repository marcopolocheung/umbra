import SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import { altitudeAt, nightSpans, SUN_PATH_STEP_MIN, sunAltitudeTrace } from "../sunPath";
import { sunriseSunset } from "../sunTimes";

// Midtown Manhattan on the June solstice, EDT (UTC−4).
const NYC = { lat: 40.754, lng: -73.984 };
const EDT = -240;
const solsticeNoon = new Date("2026-06-21T16:00:00Z");

const minutesOf = (d: Date) => {
  const local = new Date(d.getTime() + EDT * 60000);
  return local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60;
};

describe("sunAltitudeTrace", () => {
  const trace = sunAltitudeTrace(solsticeNoon, NYC.lat, NYC.lng, EDT);

  it("samples the map-local day from midnight to midnight", () => {
    expect(trace).toHaveLength(1440 / SUN_PATH_STEP_MIN + 1);
    // 09:00 EDT is 13:00Z on the same day, whatever time of that day was passed in.
    const nine = sunAltitudeTrace(new Date("2026-06-21T23:30:00Z"), NYC.lat, NYC.lng, EDT)[54];
    const expected = (SunCalc.getPosition(new Date("2026-06-21T13:00:00Z"), NYC.lat, NYC.lng).altitude * 180) / Math.PI;
    expect(nine).toBeCloseTo(expected, 6);
  });

  it("peaks near 72.6° around 1 PM on the solstice and is negative at midnight", () => {
    const peak = Math.max(...trace);
    expect(peak).toBeGreaterThan(72);
    expect(peak).toBeLessThan(73);
    expect(trace.indexOf(peak) * SUN_PATH_STEP_MIN).toBeGreaterThanOrEqual(12 * 60 + 40);
    expect(trace.indexOf(peak) * SUN_PATH_STEP_MIN).toBeLessThanOrEqual(13 * 60 + 10);
    expect(trace[0]).toBeLessThan(0);
  });
});

describe("altitudeAt", () => {
  it("returns samples exactly and interpolates between them", () => {
    const trace = [0, 10, 30];
    expect(altitudeAt(trace, 10)).toBe(10);
    expect(altitudeAt(trace, 15)).toBe(20);
    expect(altitudeAt(trace, 99)).toBe(30);
  });
});

describe("nightSpans", () => {
  it("brackets the solstice day with two nights that meet the horizon crossings", () => {
    const trace = sunAltitudeTrace(solsticeNoon, NYC.lat, NYC.lng, EDT);
    const spans = nightSpans(trace);
    expect(spans).toHaveLength(2);
    expect(spans[0][0]).toBe(0);
    expect(spans[1][1]).toBe(1440);
    // Altitude 0° falls a few minutes after the published sunrise (−0.833°, refraction)
    // and before the published sunset.
    const times = sunriseSunset(solsticeNoon, NYC.lat, NYC.lng)!;
    const dawn = spans[0][1] - minutesOf(times.sunrise);
    const dusk = minutesOf(times.sunset) - spans[1][0];
    expect(dawn).toBeGreaterThan(0);
    expect(dawn).toBeLessThan(8);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(8);
  });

  it("is one whole-day span in a polar night and none in a polar day", () => {
    const tromso = { lat: 69.65, lng: 18.96 };
    const midwinter = sunAltitudeTrace(new Date("2026-12-21T11:00:00Z"), tromso.lat, tromso.lng, 60);
    expect(nightSpans(midwinter)).toEqual([[0, 1440]]);
    const midsummer = sunAltitudeTrace(new Date("2026-06-21T11:00:00Z"), tromso.lat, tromso.lng, 120);
    expect(nightSpans(midsummer)).toEqual([]);
  });

  it("interpolates the crossing between samples", () => {
    // Up from −10° to +10° across the second interval: the sun rises at its midpoint.
    expect(nightSpans([-20, -10, 10, 20])).toEqual([[0, 1.5 * SUN_PATH_STEP_MIN]]);
  });
});

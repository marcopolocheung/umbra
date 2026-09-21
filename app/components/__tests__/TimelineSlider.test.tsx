/* @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sunArcPoint } from "../TimelineSlider";

afterEach(cleanup);

/**
 * The sun-arc glyph's geometry (U4). The claims are behavioural: the dot sits
 * on the horizon at sunrise and sunset, rides above it through the day, and
 * disappears at night — so a wrong curve breaks them.
 */
describe("sunArcPoint", () => {
  const rise = 6 * 60; // 06:00
  const set = 20 * 60; // 20:00
  const HORIZON_Y = 22;
  const APEX_Y = 7;

  it("sits on the horizon at sunrise and sunset", () => {
    expect(sunArcPoint(rise, rise, set)?.y).toBe(HORIZON_Y);
    expect(sunArcPoint(set, rise, set)?.y).toBe(HORIZON_Y);
  });

  it("peaks at the apex at midday", () => {
    const noon = (rise + set) / 2;
    const p = sunArcPoint(noon, rise, set);
    expect(p?.y).toBeCloseTo(APEX_Y, 5);
    // And its x tracks the minutes → px scale the ruler uses.
    expect(p?.x).toBe(noon * 2);
  });

  it("climbs monotonically to solar noon and descends after", () => {
    // SVG y grows downward, so sun height is HORIZON_Y − y. Solar noon is the
    // rise/set midpoint — 13:00 for this 06:00–20:00 day.
    const heightAt = (m: number) => HORIZON_Y - sunArcPoint(m, rise, set)!.y;
    expect(heightAt(9 * 60)).toBeGreaterThan(heightAt(8 * 60));
    expect(heightAt(12 * 60)).toBeGreaterThan(heightAt(11 * 60));
    expect(heightAt(14 * 60)).toBeLessThan(heightAt(13 * 60));
    // Morning is the mirror of the afternoon two hours either side of noon.
    expect(heightAt(11 * 60)).toBeCloseTo(heightAt(15 * 60), 5);
  });

  it("is gone before sunrise and after sunset (night)", () => {
    expect(sunArcPoint(rise - 1, rise, set)).toBeNull();
    expect(sunArcPoint(set + 1, rise, set)).toBeNull();
  });
});

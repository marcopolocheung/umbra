import { describe, expect, it } from "vitest";
import {
  MAX_RAIN_ALTITUDE_DEG,
  MIN_RAIN_ALTITUDE_DEG,
  RAIN_FALL_SPEED_MPS,
  directionForWindReport,
  rainDirectionFromWind,
  verticalRainDirection,
  windFromLabel,
} from "../direction";

describe("rainDirectionFromWind", () => {
  it("zero wind is the vertical cap, with the windless direction equal to it", () => {
    const spot = rainDirectionFromWind(90, 0);
    expect(spot).toEqual(verticalRainDirection());
    expect(spot.altitudeDeg).toBe(MAX_RAIN_ALTITUDE_DEG);
  });

  it("tilts at atan(u / fall speed)", () => {
    // 9 m/s against a 9 m/s fall speed is exactly 45°.
    expect(rainDirectionFromWind(0, RAIN_FALL_SPEED_MPS).altitudeDeg).toBeCloseTo(45, 6);
    expect(rainDirectionFromWind(0, 4.5).altitudeDeg).toBeCloseTo(
      90 - (Math.atan(0.5) * 180) / Math.PI, 6,
    );
  });

  it("clamps never to plausibly-horizontal rays", () => {
    expect(rainDirectionFromWind(0, 1000).altitudeDeg).toBe(MIN_RAIN_ALTITUDE_DEG);
    expect(rainDirectionFromWind(0, 1000).altitudeDeg).toBeLessThan(45);
  });

  it("keeps the bearing inside [0, 360) and survives nonsense", () => {
    expect(rainDirectionFromWind(450, 2).fromDeg).toBe(90);
    expect(rainDirectionFromWind(-90, 2).fromDeg).toBe(270);
    expect(rainDirectionFromWind(Number.NaN, 2).fromDeg).toBe(0);
    expect(rainDirectionFromWind(10, Number.NaN).windMs).toBe(0);
  });
});

describe("directionForWindReport", () => {
  it("is vertical when the forecast names no direction", () => {
    expect(directionForWindReport(null, 5)).toEqual(verticalRainDirection());
    expect(directionForWindReport(90, null)).toEqual(verticalRainDirection());
  });

  it("tilts from the report once both fields exist", () => {
    expect(directionForWindReport(90, RAIN_FALL_SPEED_MPS).altitudeDeg).toBeCloseTo(45, 6);
    expect(directionForWindReport(90, RAIN_FALL_SPEED_MPS).fromDeg).toBe(90);
  });
});

describe("windFromLabel", () => {
  it("names the eight compass points", () => {
    expect(windFromLabel(0)).toBe("N");
    expect(windFromLabel(45)).toBe("NE");
    expect(windFromLabel(90)).toBe("E");
    expect(windFromLabel(270)).toBe("W");
    expect(windFromLabel(359)).toBe("N");
    expect(windFromLabel(-90)).toBe("W");
  });
});

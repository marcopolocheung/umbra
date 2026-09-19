import { describe, expect, it } from "vitest";
import {
  MAX_RAIN_ALTITUDE_DEG,
  MIN_RAIN_ALTITUDE_DEG,
  RAIN_FALL_SPEED_MPS,
  rainDirectionFromWind,
  verticalRainDirection,
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

import { describe, expect, it } from "vitest";
import { freezeSolar, isNight, SOLAR_CONVENTION_VERSION, sunwardDirection } from "../solar";

describe("shared solar convention", () => {
  it("pins the legacy SunCalc shadow azimuth and keeps night distinct", () => {
    expect(freezeSolar({ azimuth: 0, altitude: 0.2 })).toMatchObject({ convention: SOLAR_CONVENTION_VERSION });
    expect(sunwardDirection({ azimuth: 0, altitude: 0.2 })).toEqual({ east: -0, north: -1 });
    expect(isNight({ azimuth: 0, altitude: 0 })).toBe(true);
  });
});

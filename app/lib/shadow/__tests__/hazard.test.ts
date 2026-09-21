import { describe, expect, it } from "vitest";
import { HAZARD_PROFILES } from "../hazard";

describe("HAZARD_PROFILES", () => {
  it("sun owns the shared ground and roof pipeline", () => {
    expect(HAZARD_PROFILES.sun).toEqual({
      mode: "sun",
      drawsGround: true,
      erasesRoofs: true,
    });
  });

  it("rain uses the same shared ground and roof pipeline", () => {
    expect(HAZARD_PROFILES.rain).toEqual({
      mode: "rain",
      drawsGround: true,
      erasesRoofs: true,
    });
  });
});

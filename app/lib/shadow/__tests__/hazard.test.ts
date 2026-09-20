import { describe, expect, it } from "vitest";
import { HAZARD_PROFILES } from "../hazard";

describe("HAZARD_PROFILES", () => {
  it("sun owns the ground canvas, erases its roofs, and paints shadow", () => {
    expect(HAZARD_PROFILES.sun).toEqual({
      mode: "sun",
      drawsGround: true,
      erasesRoofs: true,
      surfaceInverts: false,
    });
  });

  it("rain never draws the canvas ground, never erases footprints, and inverts surfaces", () => {
    // The wash is a basemap layer, and the footprint is the sheltered ground
    // being shown — the exact inversions that once blanked the rain canvas.
    expect(HAZARD_PROFILES.rain).toEqual({
      mode: "rain",
      drawsGround: false,
      erasesRoofs: false,
      surfaceInverts: true,
    });
  });
});

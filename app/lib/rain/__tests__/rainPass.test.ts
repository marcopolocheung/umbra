import { describe, expect, it } from "vitest";
import { runRoofExclusion } from "../rainPass";

describe("runRoofExclusion", () => {
  it("runs for the sun whenever roofs exist and the sun is up", () => {
    expect(runRoofExclusion(false, false, 10)).toBe(true);
  });

  it("never runs in rain mode — own-footprint coverage is the shelter we paint", () => {
    expect(runRoofExclusion(true, false, 10)).toBe(false);
    // even a trivially-horizontal (never produced) rain state stays safe
    expect(runRoofExclusion(true, true, 10)).toBe(false);
  });

  it("still respects the sun's night and empty-roof cases", () => {
    expect(runRoofExclusion(false, true, 10)).toBe(false);
    expect(runRoofExclusion(false, false, 0)).toBe(false);
  });
});

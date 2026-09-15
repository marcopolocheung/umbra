import { describe, expect, it } from "vitest";
import {
  getTravelModePolicy,
  isProhibitedEdge,
  minCostRatio,
  modeAdjustedDistanceM,
  parseTravelMode,
  travelTimeSeconds,
} from "../travelMode";

describe("travel mode policy", () => {
  it("keeps the existing walking speed centralized", () => {
    expect(getTravelModePolicy("walk").speedMps).toBe(1.4);
    expect(travelTimeSeconds(140, "walk")).toBeCloseTo(100);
  });

  it("defines bike as the first non-walking mode with route cost knobs", () => {
    const bike = getTravelModePolicy("bike");

    expect(bike.speedMps).toBeGreaterThan(getTravelModePolicy("walk").speedMps);
    expect(bike.stepsPenaltyM).toBeGreaterThan(0);
    expect(bike.roughSurfacePenaltyM).toBeGreaterThan(0);
    expect(bike.cyclewayPreferenceM).toBeLessThan(0);
  });
});

describe("modeAdjustedDistanceM", () => {
  it("leaves every edge untouched in walk mode", () => {
    const edge = { distanceM: 100, highway: "steps", surface: "cobblestone", cycleway: "lane" };
    expect(modeAdjustedDistanceM(edge, "walk")).toBe(100);
  });

  it("adds the steps penalty in bike mode", () => {
    const steps = { distanceM: 100, highway: "steps" };
    const plain = { distanceM: 100, highway: "footway" };
    expect(modeAdjustedDistanceM(steps, "bike")).toBe(
      modeAdjustedDistanceM(plain, "bike") + getTravelModePolicy("bike").stepsPenaltyM,
    );
  });

  it("adds the rough-surface penalty in bike mode", () => {
    const rough = { distanceM: 100, surface: "cobblestone" };
    const smooth = { distanceM: 100, surface: "asphalt" };
    expect(modeAdjustedDistanceM(rough, "bike")).toBe(
      modeAdjustedDistanceM(smooth, "bike") + getTravelModePolicy("bike").roughSurfacePenaltyM,
    );
  });

  it("discounts cycleways but never below half the edge length", () => {
    // Long edge: the full 40 m preference applies.
    expect(modeAdjustedDistanceM({ distanceM: 200, cycleway: "lane" }, "bike")).toBe(160);
    // Short edge: the discount caps at half the length (100 m → 50 m off max).
    expect(modeAdjustedDistanceM({ distanceM: 60, cycleway: "lane" }, "bike")).toBe(30);
    // "no" and missing cycleways get no discount.
    expect(modeAdjustedDistanceM({ distanceM: 200, cycleway: "no" }, "bike")).toBe(200);
    expect(modeAdjustedDistanceM({ distanceM: 200 }, "bike")).toBe(200);
  });

  it("floors adjusted cost at a positive meter", () => {
    expect(modeAdjustedDistanceM({ distanceM: 1, cycleway: "lane" }, "bike")).toBe(1);
  });

  it("discounts dedicated cycleways and designated bike routes", () => {
    expect(modeAdjustedDistanceM({ distanceM: 200, highway: "cycleway" }, "bike")).toBe(160);
    expect(modeAdjustedDistanceM({ distanceM: 200, bicycle: "designated" }, "bike")).toBe(160);
    // Permissive but undedicated ways get no discount.
    expect(modeAdjustedDistanceM({ distanceM: 200, bicycle: "yes" }, "bike")).toBe(200);
    expect(modeAdjustedDistanceM({ distanceM: 200, highway: "residential" }, "bike")).toBe(200);
  });
});

describe("isProhibitedEdge", () => {
  it("never prohibits in walk mode", () => {
    expect(isProhibitedEdge({ distanceM: 100, bicycle: "no" }, "walk")).toBe(false);
    expect(isProhibitedEdge({ distanceM: 100, access: "no" }, "walk")).toBe(false);
  });

  it("prohibits bicycle=no and access=no in bike mode", () => {
    expect(isProhibitedEdge({ distanceM: 100, bicycle: "no" }, "bike")).toBe(true);
    expect(isProhibitedEdge({ distanceM: 100, access: "no" }, "bike")).toBe(true);
  });

  it("allows ordinary and dedicated ways in bike mode", () => {
    expect(isProhibitedEdge({ distanceM: 100, highway: "residential" }, "bike")).toBe(false);
    expect(isProhibitedEdge({ distanceM: 100, bicycle: "designated" }, "bike")).toBe(false);
    expect(isProhibitedEdge({ distanceM: 100, bicycle: "yes" }, "bike")).toBe(false);
  });
});

describe("parseTravelMode / minCostRatio", () => {
  it("accepts bike and falls back to walk", () => {
    expect(parseTravelMode("bike")).toBe("bike");
    expect(parseTravelMode(null)).toBe("walk");
    expect(parseTravelMode("car")).toBe("walk");
  });

  it("bounds the cheapest possible cost ratio for the Pareto heuristic", () => {
    expect(minCostRatio("walk")).toBe(1);
    expect(minCostRatio("bike")).toBe(0.5);
  });
});

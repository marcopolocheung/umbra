import { describe, expect, it } from "vitest";
import {
  getTravelModePolicy,
  isProhibitedEdge,
  minCostRatio,
  modeAdjustedDistanceM,
  parseTravelMode,
  roughSurfaceLine,
  scootSurfacePenaltyM,
  speedRatioVsWalk,
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

  it("lets a specific bicycle tag override a general access=no", () => {
    for (const bicycle of ["yes", "designated", "permissive"]) {
      expect(isProhibitedEdge({ distanceM: 100, access: "no", bicycle }, "bike")).toBe(false);
    }
    // …but a non-allowing value falls back to the general tag.
    expect(isProhibitedEdge({ distanceM: 100, access: "no", bicycle: "private" }, "bike")).toBe(
      true,
    );
    expect(isProhibitedEdge({ distanceM: 100, access: "no" }, "bike")).toBe(true);
  });

  it("keeps bicycle=no prohibiting even when general access allows", () => {
    expect(isProhibitedEdge({ distanceM: 100, access: "yes", bicycle: "no" }, "bike")).toBe(true);
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

  it("accepts scoot and still falls back to walk on unknown values", () => {
    expect(parseTravelMode("scoot")).toBe("scoot");
    expect(parseTravelMode("")).toBe("walk");
    expect(parseTravelMode("SCOOT")).toBe("walk");
  });

  it("bounds the cheapest possible cost ratio for the Pareto heuristic", () => {
    expect(minCostRatio("walk")).toBe(1);
    expect(minCostRatio("bike")).toBe(0.5);
  });

  it("derives the bound from each mode's discount policy (scoot has none)", () => {
    // Scoot only ever adds penalties, so every edge costs at least its length.
    expect(minCostRatio("scoot")).toBe(1);
    expect(getTravelModePolicy("scoot").cyclewayPreferenceM).toBe(0);
  });
});

describe("scoot mode policy (E4)", () => {
  it("defines scoot between walking and cycling speed", () => {
    const scoot = getTravelModePolicy("scoot");
    expect(scoot.label).toBe("Scoot");
    expect(scoot.speedMps).toBeGreaterThan(getTravelModePolicy("walk").speedMps);
    expect(scoot.speedMps).toBeLessThan(getTravelModePolicy("bike").speedMps);
    expect(travelTimeSeconds(180, "scoot")).toBeCloseTo(60);
  });

  it("excludes steps by prohibition, not by penalty", () => {
    expect(isProhibitedEdge({ distanceM: 100, highway: "steps" }, "scoot")).toBe(true);
    expect(getTravelModePolicy("scoot").stepsPenaltyM).toBe(0);
    // …while walk still takes them and bike prices them.
    expect(isProhibitedEdge({ distanceM: 100, highway: "steps" }, "walk")).toBe(false);
    expect(isProhibitedEdge({ distanceM: 100, highway: "steps" }, "bike")).toBe(false);
  });

  it("honours foot=no and access=no, with a foot override — and ignores bicycle tags", () => {
    expect(isProhibitedEdge({ distanceM: 100, foot: "no" }, "scoot")).toBe(true);
    expect(isProhibitedEdge({ distanceM: 100, access: "no" }, "scoot")).toBe(true);
    for (const foot of ["yes", "designated", "permissive"]) {
      expect(isProhibitedEdge({ distanceM: 100, access: "no", foot }, "scoot")).toBe(false);
    }
    // Bicycle tags are about bikes: bicycle=no must not strand a scooter …
    expect(isProhibitedEdge({ distanceM: 100, bicycle: "no" }, "scoot")).toBe(false);
    // … but an access=no the bicycle tag would excuse still bans scoot without foot.
    expect(isProhibitedEdge({ distanceM: 100, access: "no", bicycle: "yes" }, "scoot")).toBe(true);
  });

  it("stays on dedicated cycleways even where foot is banned from them", () => {
    // Segregated cycle/foot pairs tag the cycleway half foot=no; that half is
    // the smooth network scooters legally ride, so only it is exempt.
    expect(
      isProhibitedEdge({ distanceM: 100, highway: "cycleway", foot: "no" }, "scoot"),
    ).toBe(false);
    expect(
      isProhibitedEdge({ distanceM: 100, highway: "footway", foot: "no" }, "scoot"),
    ).toBe(true);
    expect(
      isProhibitedEdge({ distanceM: 100, highway: "cycleway", access: "no" }, "scoot"),
    ).toBe(true);
  });

  it("penalizes rough surfaces near-disqualifyingly, not flatly like bike", () => {
    for (const surface of ["cobblestone", "sett", "gravel", "sand", "unpaved", "dirt", "ground"]) {
      expect(modeAdjustedDistanceM({ distanceM: 100, surface }, "scoot")).toBe(1100);
    }
    // Smooth laid surfaces ride free.
    for (const surface of ["asphalt", "paving_stones", "concrete", undefined]) {
      expect(modeAdjustedDistanceM({ distanceM: 100, surface }, "scoot")).toBe(100);
    }
    // Bike behavior is untouched by the scoot list.
    expect(modeAdjustedDistanceM({ distanceM: 100, surface: "sett" }, "bike")).toBe(100);
    expect(modeAdjustedDistanceM({ distanceM: 100, surface: "unpaved" }, "bike")).toBe(100);
  });

  it("lets smoothness override surface where tagged", () => {
    // Excellent/good ride free even on cobbles …
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "cobblestone", smoothness: "excellent" })).toBe(0);
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "sett", smoothness: "good" })).toBe(0);
    // … intermediate costs a little …
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "asphalt", smoothness: "intermediate" })).toBe(50);
    // … bad and worse are near-disqualifying even on asphalt …
    for (const smoothness of ["bad", "very_bad", "horrible", "very_horrible", "impassable"]) {
      expect(scootSurfacePenaltyM({ distanceM: 100, surface: "asphalt", smoothness })).toBe(1000);
    }
    // … and absent or unknown smoothness falls back to surface.
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "cobblestone" })).toBe(1000);
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "cobblestone", smoothness: "bogus" })).toBe(1000);
    expect(scootSurfacePenaltyM({ distanceM: 100, surface: "asphalt", smoothness: "bogus" })).toBe(0);
  });

  it("ignores smoothness in walk and bike mode (byte-identical E1 behavior)", () => {
    const edge = { distanceM: 100, surface: "cobblestone", smoothness: "bad" };
    expect(modeAdjustedDistanceM(edge, "walk")).toBe(100);
    expect(modeAdjustedDistanceM(edge, "bike")).toBe(175);
    const smooth = { distanceM: 100, surface: "asphalt", smoothness: "excellent" };
    expect(modeAdjustedDistanceM(smooth, "bike")).toBe(100);
  });

  it("never discounts cycleways in scoot mode", () => {
    expect(modeAdjustedDistanceM({ distanceM: 200, cycleway: "lane" }, "scoot")).toBe(200);
    expect(modeAdjustedDistanceM({ distanceM: 200, highway: "cycleway" }, "scoot")).toBe(200);
    // … while the bike discount is unchanged.
    expect(modeAdjustedDistanceM({ distanceM: 200, cycleway: "lane" }, "bike")).toBe(160);
  });

  it("keeps scoot edge costs at or above physical distance (Pareto stays admissible)", () => {
    const edges = [
      { distanceM: 100, surface: "asphalt" },
      { distanceM: 100, surface: "cobblestone", smoothness: "excellent" },
      { distanceM: 1, cycleway: "lane" },
      { distanceM: 60, cycleway: "lane", surface: "sett" },
    ];
    for (const edge of edges) {
      expect(modeAdjustedDistanceM(edge, "scoot")).toBeGreaterThanOrEqual(edge.distanceM);
    }
  });
});

describe("roughSurfaceLine (E4 route card)", () => {
  it("confesses cobbles in scoot mode", () => {
    expect(roughSurfaceLine({ cobblestone: 120, asphalt: 400 }, "scoot")).toBe(
      "includes 120 m of cobblestone",
    );
  });

  it("lists several rough surfaces longest-first", () => {
    expect(
      roughSurfaceLine({ sett: 30, cobblestone: 120, asphalt: 400 }, "scoot"),
    ).toBe("includes 120 m of cobblestone and 30 m of sett");
  });

  it("stays silent on walk mode and on smooth routes", () => {
    expect(roughSurfaceLine({ cobblestone: 120 }, "walk")).toBeNull();
    expect(roughSurfaceLine({ asphalt: 400 }, "scoot")).toBeNull();
    expect(roughSurfaceLine(undefined, "scoot")).toBeNull();
    expect(roughSurfaceLine({}, "bike")).toBeNull();
  });

  it("uses the bike surface list for bike mode", () => {
    expect(roughSurfaceLine({ cobblestone: 80 }, "bike")).toBe("includes 80 m of cobblestone");
    expect(roughSurfaceLine({ sett: 80 }, "bike")).toBeNull();
  });
});

describe("speedRatioVsWalk (E2)", () => {
  it("is exactly 1 for walk, which is what keeps walk routing byte-identical", () => {
    // Strict equality, not closeness: routing multiplies metre constants by
    // this, and anything but exactly 1 would perturb walk costs.
    expect(speedRatioVsWalk("walk")).toBe(1);
  });

  it("scales metre constants into the same time allowance for bikes", () => {
    // 4.5 / 1.4: a 15 m crossing reads as ~48 bike-metres ≈ the same ~11 s.
    expect(speedRatioVsWalk("bike")).toBeCloseTo(4.5 / 1.4, 10);
    expect(15 * speedRatioVsWalk("bike")).toBeCloseTo(48.21, 2);
  });

  it("time-normalizes scoot constants from the stated 3.0 m/s assumption", () => {
    expect(speedRatioVsWalk("scoot")).toBeCloseTo(3.0 / 1.4, 10);
  });

  it("names the trip for user-facing sentences", () => {
    expect(getTravelModePolicy("walk").journeyNoun).toBe("walk");
    expect(getTravelModePolicy("walk").gerund).toBe("walking");
    expect(getTravelModePolicy("bike").journeyNoun).toBe("ride");
    expect(getTravelModePolicy("bike").gerund).toBe("cycling");
  });
});

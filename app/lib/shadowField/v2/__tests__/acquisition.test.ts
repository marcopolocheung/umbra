import { describe, expect, it } from "vitest";
import { assembleTileBounds, buildCoverageIndex } from "../artifacts";
import { indexBounds, planAcquisition } from "../acquisition";

const generation = "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2";
describe("conservative offscreen acquisition", () => {
  it("includes sunward tower/canopy pages and changes scope at low sun", () => {
    const tiles = ["18/10/10", "18/10/11", "18/10/12"];
    const coverage = buildCoverageIndex({ generation, availableTiles: tiles, activationTiles: tiles, activationRule: "fixture", activationBoundary: null });
    const bounds = assembleTileBounds(generation, new Map([
      ["18/10/10", { minG: 0, maxG: 0, maxTopQ: 0, maxCrownQ: 0, coverage: 0 as const }],
      ["18/10/11", { minG: 0, maxG: 0, maxTopQ: 6400, maxCrownQ: 0, coverage: 0 as const }],
      ["18/10/12", { minG: 0, maxG: 0, maxTopQ: 0, maxCrownQ: 9600, coverage: 0 as const }],
    ]));
    const index = indexBounds(coverage, bounds);
    const low = planAcquisition(coverage, index, [{ kind: "viewport-ground", tiles: ["18/10/10"] }], { azimuth: 0, altitude: 0.02 });
    expect(low.pages).toContain("18/10/11");
    expect(low.pages).toContain("18/10/12");
    const reversed = planAcquisition(coverage, index, [{ kind: "viewport-ground", tiles: ["18/10/10"] }], { azimuth: Math.PI, altitude: 0.02 });
    expect(reversed.casterPages).not.toContain("18/10/12");
    expect(planAcquisition(coverage, index, [{ kind: "route-sidewalk", tiles: ["18/99/99"] }], { azimuth: 0, altitude: 0.4 }).incompleteReason).toBe("unknown-exterior");
  });

  it("fails corrupt hierarchy closed", () => {
    const coverage = buildCoverageIndex({ generation, availableTiles: ["18/10/10"], activationTiles: ["18/10/10"], activationRule: "fixture", activationBoundary: null });
    const bounds = assembleTileBounds(generation, new Map([["18/10/10", { minG: 0, maxG: 0, maxTopQ: 0, maxCrownQ: 0, coverage: 0 as const }]]));
    bounds.levels[0].maxTopQ[0] = -1;
    expect(() => indexBounds(coverage, bounds)).toThrow(/hierarchy/);
  });
});

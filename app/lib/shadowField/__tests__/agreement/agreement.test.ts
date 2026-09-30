/**
 * A3's gate: the shadow field must agree with the pixel sampler, and CI must say by
 * how much. The brief makes this a product gate rather than a test detail — when the
 * two diverge, the renderer is what the user believes, so a regression here means
 * either the field is wrong or its confidence is overstated.
 *
 * `harness.ts` documents exactly which disagreements this corpus can and cannot see.
 */

import { describe, expect, it } from "vitest";
import { BASEMAP_PALETTES } from "../../../basemapTheme";
import { CANOPY_FILL_OPACITY, CANOPY_FILL_RGB } from "../../../canopyRaster/canopyPaint";
import { agreementFixtures, sunFor } from "./fixtures";
import { BASEMAP_RGB, disagreementsFor, formatReport, referenceFor, reportFor } from "./harness";

/**
 * Committed thresholds.
 *
 * These are ceilings on a measured number, not aspirations: they were set just above
 * what the corpus currently reports so that a regression trips them, and they should
 * be *lowered* as the field improves, never raised to make a failure go away. Raising
 * one is a product decision — it means accepting more divergence between what the map
 * paints and what routing believes.
 */
const MAX_MEAN_DISAGREEMENT = 0.04;
const MAX_P90_DISAGREEMENT = 0.05;
const MAX_SEVERE_SHARE = 0.04;

describe("shadow field vs pixel sampler", () => {
  const fixtures = agreementFixtures();
  const disagreements = disagreementsFor(fixtures, (fixture) => {
    const sun = sunFor(fixture);
    return referenceFor(fixture, sun, sun.altitudeFraction);
  });
  const report = reportFor(disagreements);

  it("covers three city morphologies with a corpus worth trusting", () => {
    expect(report.cases).toBeGreaterThanOrEqual(100);
    expect(Object.keys(report.byCity).sort()).toEqual(["kent-wa", "madrid", "singapore"]);
  });

  it("reports the disagreement metric", () => {
    // Printed on every run so the number is visible in CI logs, not just when it fails.
    console.log(formatReport(report));

    expect(Number.isFinite(report.meanAbsolute)).toBe(true);
  });

  it("stays under the committed mean threshold", () => {
    expect(report.meanAbsolute).toBeLessThanOrEqual(MAX_MEAN_DISAGREEMENT);
  });

  it("stays under the committed p90 threshold", () => {
    expect(report.p90).toBeLessThanOrEqual(MAX_P90_DISAGREEMENT);
  });

  it("keeps the severe tail rare", () => {
    // One edge the field calls shadowed and the map paints sunlit is a promise the app
    // cannot keep, and p90 cannot see it while nine cases in ten agree exactly.
    expect(report.severeShare).toBeLessThanOrEqual(MAX_SEVERE_SHARE);
  });

  it("agrees in every city, not just on average", () => {
    for (const [city, mean] of Object.entries(report.byCity)) {
      expect(mean, `${city} mean disagreement`).toBeLessThanOrEqual(MAX_MEAN_DISAGREEMENT * 2);
    }
  });

  it("is measuring something — the corpus contains real shadow and real sun", () => {
    // A corpus where every case is fully sunlit would report perfect agreement and
    // prove nothing. Guard against that by checking the reference itself varies.
    const references = fixtures.slice(0, 40).map((fixture) => {
      const sun = sunFor(fixture);
      return referenceFor(fixture, sun, sun.altitudeFraction);
    });
    const values = references.flatMap((r) => [r.left, r.right]);

    expect(values.some((v) => v > 0.6)).toBe(true);
    expect(values.some((v) => v < 0.4)).toBe(true);
  });
});

/**
 * A3 re-measured under A8f's estimated-canopy fill (#275).
 *
 * The fill sits beneath the shadow layer, so on a treed street the pixel sampler reads
 * building shadow composited over the fill rather than over the basemap. If shadow
 * stays blue-dominant there and sunlit fill never becomes blue-dominant, the sampler
 * reads exactly what it read before, and the corpus reports exactly the same numbers.
 * Anything short of identical is invariant #5 breaking on tree-lined streets.
 *
 * Opacity 1 is the case where every pixel of the street is solid fill — the strongest
 * the fill can get, and the value the colour itself was chosen against.
 */
describe("shadow field vs pixel sampler, under the canopy fill", () => {
  const fixtures = agreementFixtures();
  const reportOver = (basemap: readonly [number, number, number]) =>
    reportFor(
      disagreementsFor(fixtures, (fixture) => {
        const sun = sunFor(fixture);
        return referenceFor(fixture, sun, sun.altitudeFraction, basemap);
      })
    );
  const underFill = (opacity: number) =>
    BASEMAP_RGB.map((c, i) =>
      Math.round(CANOPY_FILL_RGB[i] * opacity + c * (1 - opacity))
    ) as [number, number, number];

  const baseline = reportOver(BASEMAP_RGB);

  it("reports the same agreement at the fill's own opacity", { timeout: 10_000 }, () => {
    const report = reportOver(underFill(CANOPY_FILL_OPACITY));
    console.log(`under canopy fill: ${formatReport(report)}`);
    expect(report).toEqual(baseline);
  });

  it("reports the same agreement where the fill is solid", { timeout: 10_000 }, () => {
    expect(reportOver(underFill(1))).toEqual(baseline);
  });
});

/**
 * A3 re-measured over the redesign 2.0 day basemap (R4).
 *
 * The sampler reads a sidewalk off whatever the basemap paints there. If each day
 * surface reports exactly what the reference grey reports, recolouring the map moved
 * no routing decision.
 */
describe("shadow field vs pixel sampler, over the day basemap", () => {
  const fixtures = agreementFixtures();
  const reportOver = (basemap: readonly [number, number, number]) =>
    reportFor(
      disagreementsFor(fixtures, (fixture) => {
        const sun = sunFor(fixture);
        return referenceFor(fixture, sun, sun.altitudeFraction, basemap);
      })
    );
  const baseline = reportOver(BASEMAP_RGB);
  const day = BASEMAP_PALETTES.day;

  for (const role of ["land", "road", "landuse", "building", "field", "path"] as const) {
    it(`reports the same agreement over ${role}`, { timeout: 10_000 }, () => {
      const hex = day[role];
      const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      expect(reportOver(rgb)).toEqual(baseline);
    });
  }
});

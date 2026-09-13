import { beforeAll, describe, expect, it } from "vitest";
import { agreementFixtures, sunFor } from "./fixtures";
import { buildV2FixtureField, type V2FixtureField } from "./v2Fixtures";
import { assertV2Gate, evaluateV2Fixture, formatV2Report, reportV2 } from "./v2Harness";

describe("v2 candidate versus the retained pixel agreement corpus", () => {
  const fixtures = agreementFixtures();
  const fields = new Map<string, V2FixtureField>();
  let report: ReturnType<typeof reportV2>;

  beforeAll(async () => {
    for (const fixture of fixtures) {
      if (!fields.has(fixture.city)) fields.set(fixture.city, await buildV2FixtureField(fixture));
    }
    const readings = fixtures.flatMap((fixture, index) => {
      const source = fields.get(fixture.city);
      if (!source) throw new Error(`missing v2 fixture field for ${fixture.city}`);
      return evaluateV2Fixture(fixture, index, source.field, source.toMetres, sunFor(fixture));
    });
    report = reportV2(readings, fixtures.length);
  }, 60_000);

  it("runs all retained fixtures and prints the independent v2 gate report", () => {
    console.log(formatV2Report(report));
    expect(report.cases).toBe(150);
    expect(Object.keys(report.byCity).sort()).toEqual(["kent-wa", "madrid", "singapore"]);
    expect(report.nonNullReadings).toBe(300);
  });

  it("holds every committed agreement and validity ceiling", () => {
    expect(() => assertV2Gate(report)).not.toThrow();
  });

  it("fails if candidate output or the settled validity mask is corrupted", () => {
    const outputCorruption = { ...report, meanAbsolute: 1 };
    const maskCorruption = { ...report, invalidScheduledShare: 1 };
    expect(() => assertV2Gate(outputCorruption)).toThrow(/gate failed/);
    expect(() => assertV2Gate(maskCorruption)).toThrow(/gate failed/);
  });
});

import { describe, expect, it } from "vitest";
import { routeLegSummary, transitSunLabel, transitSunCardLabel, TRANSIT_SUN_CAVEAT } from "../routeLegSummary";
import type { RouteLeg } from "../routing";

const line: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
};

describe("routeLegSummary", () => {
  it("summarizes walking legs with distance and shadow", () => {
    const leg: RouteLeg = {
      type: "walk",
      geojson: line,
      distanceM: 845,
      shadowCoverage: 0.42,
    };

    expect(routeLegSummary(leg, 0)).toEqual({
      title: "Leg 1: Walk",
      detail: "845 m - 42% shadow",
    });
  });

  it("summarizes transit legs with line, time, stops, and sun exposure", () => {
    const leg: RouteLeg = {
      type: "transit",
      geojson: line,
      lineName: "Red Line",
      travelTimeSec: 620,
      stops: ["A", "B", "C"],
      sunExposure: 0,
    };

    expect(routeLegSummary(leg, 1)).toEqual({
      title: "Leg 2: Red Line",
      detail: "11 min - 2 stops - assumed underground",
    });
  });

  it("says how much of a ride's quoted time is spent on the platform", () => {
    // The wait is now inside `travelTimeSec`, so a card that only shows the
    // total says a five-minute ride takes eleven minutes and never says why.
    const leg: RouteLeg = {
      type: "transit",
      geojson: line,
      lineName: "Q",
      travelTimeSec: 620,
      waitSec: 120,
      stops: ["A", "B", "C"],
      sunExposure: 0,
    };

    expect(routeLegSummary(leg, 1).detail).toBe(
      "11 min - incl. ~2 min wait - 2 stops - assumed underground",
    );
  });

  it("says nothing about a wait the feed never priced", () => {
    // Overpass has no timetable. A "~0 min wait" would be a claim it cannot
    // make; silence is the honest rendering of an unpriced term.
    const leg: RouteLeg = {
      type: "transit",
      geojson: line,
      lineName: "Red Line",
      travelTimeSec: 620,
      waitSec: 0,
      stops: ["A", "B", "C"],
      sunExposure: 0,
    };

    expect(routeLegSummary(leg, 1).detail).not.toContain("wait");
  });

  it("does not state undergroundness as fact (#393)", () => {
    // `sunExposure` is TRAIN_SUN_EXPOSURE[mode] — a constant per mode, not a
    // measurement of this track. Every subway line prices at 0.0, and NYC's
    // elevated lines are in full sun, so the label has to read as the model
    // assumption it is.
    const elevated: RouteLeg = {
      type: "transit",
      geojson: line,
      lineName: "7",
      travelTimeSec: 600,
      stops: ["A", "B"],
      sunExposure: 0,
    };

    const { detail } = routeLegSummary(elevated, 0);
    expect(detail).toContain("assumed");
    expect(transitSunLabel(0)).toBe("assumed underground");
    expect(transitSunCardLabel(0)).toBe("Assumed underground");
    expect(TRANSIT_SUN_CAVEAT).toMatch(/not measured|elevated/i);
  });

  it("leaves a leg the model never priced unlabelled", () => {
    // Absent is not zero: an unpriced leg must not read as "underground".
    expect(transitSunLabel(undefined)).toBeNull();
  });

  it("labels unsampled legs in the route's mode, with a grammatical fallback", () => {
    const bare: RouteLeg = { type: "walk", geojson: line };

    expect(routeLegSummary(bare, 0)).toEqual({
      title: "Leg 1: Walk",
      detail: "Walking segment",
    });
    // "Bike" + "ing" would read "Bikeing" — the gerund exists for this.
    expect(routeLegSummary(bare, 0, "bike")).toEqual({
      title: "Leg 1: Bike",
      detail: "Cycling segment",
    });
  });

  it("labels legs from the mode policy, so new modes never read as walking", () => {
    const leg: RouteLeg = {
      type: "walk",
      geojson: line,
      distanceM: 500,
      shadowCoverage: 0.5,
    };
    expect(routeLegSummary(leg, 0, "scoot").title).toBe("Leg 1: Scoot");
    const bare: RouteLeg = { type: "walk", geojson: line };
    expect(routeLegSummary(bare, 0, "scoot")).toEqual({
      title: "Leg 1: Scoot",
      detail: "Riding segment",
    });
  });
});

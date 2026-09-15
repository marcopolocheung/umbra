import { describe, expect, it } from "vitest";
import { routeLegSummary } from "../routeLegSummary";
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
      detail: "11 min - 2 stops - underground",
    });
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

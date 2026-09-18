/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RouteCard from "../RouteCard";
import type { RouteLeg, RouteOption } from "../../lib/routing";

afterEach(cleanup);

const LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

function busRoute(walkM: number, waitCoverage: number, waitShadow?: number): RouteOption {
  const legs: RouteLeg[] = [
    { type: "walk", geojson: LINE, distanceM: walkM / 2, shadowCoverage: 1 },
    {
      type: "transit",
      geojson: LINE,
      travelTimeSec: 1200,
      waitSec: 600,
      waitExposure: {
        coverage: waitCoverage,
        boardings: 1,
        ...(waitShadow != null ? { shadow: waitShadow } : {}),
      },
    },
    { type: "walk", geojson: LINE, distanceM: walkM / 2, shadowCoverage: 1 },
  ];
  return {
    label: "Via Bus",
    geojson: LINE,
    distanceM: walkM,
    shadowCoverage: 1,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
    legs,
    totalTimeSec: 2400,
  };
}

describe("RouteCard on a transit route", () => {
  it("says the headline is about the time on foot", () => {
    render(<RouteCard route={busRoute(840, 1, 1)} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("100% shadow on foot")).toBeTruthy();
  });

  it("quotes no percentage when most of the time outdoors is unseen", () => {
    // 3 min walked, 10 min at a stop the field could not answer for.
    render(<RouteCard route={busRoute(252, 0.2)} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("shadow unknown")).toBeTruthy();
    expect(screen.queryByText(/% shadow/)).toBeNull();
    expect(screen.getByText("time in sun unknown")).toBeTruthy();
  });
});

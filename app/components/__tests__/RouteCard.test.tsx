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

/** A priced walk route: distance and shadow share only. */
function walkRoute(label: string, distanceM: number, shadowCoverage: number): RouteOption {
  return {
    label,
    geojson: LINE,
    distanceM,
    shadowCoverage,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
  };
}

describe("RouteCard on a transit route", () => {
  it("says the headline is about the time on foot", () => {
    render(<RouteCard route={busRoute(840, 1, 1)} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("100% shadow on foot")).toBeTruthy();
    // The scope sits on the card itself, not only in the selected card's details.
    expect(screen.getByText(/walk and stop wait only; ride not counted/)).toBeTruthy();
  });

  it("quotes no percentage when the sun at a stop is unknown", () => {
    // 3 min walked, 10 min at a stop the field could not answer for.
    render(<RouteCard route={busRoute(252, 0.2)} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("shadow unknown")).toBeTruthy();
    expect(screen.queryByText(/% shadow/)).toBeNull();
    // The unknown is still stated where a figure would have been: the card's
    // trade-off line (U3) — the sun-minutes sentence itself is detail, and
    // lives on the selected card.
    expect(screen.getByText("time in sun unknown")).toBeTruthy();
  });
});

describe("RouteCard ranking story (U3)", () => {
  const shortest = walkRoute("Shortest", 600, 0.3);
  const shadowed = walkRoute("Most shadowed", 900, 0.9);

  it("marks exactly the recommended option", () => {
    render(
      <div>
        <RouteCard route={shadowed} selected={false} onSelect={() => {}} recommended />
        <RouteCard route={shortest} selected={false} onSelect={() => {}} />
      </div>,
    );

    expect(screen.getAllByText("Recommended")).toHaveLength(1);
  });

  it("states every option's trade-off against the shortest, at a glance", () => {
    render(
      <div>
        <RouteCard route={shortest} selected={false} onSelect={() => {}} baselineRoute={shortest} />
        <RouteCard route={shadowed} selected={false} onSelect={() => {}} baselineRoute={shortest} />
      </div>,
    );

    // The baseline card names its role instead of repeating its own verdict.
    expect(screen.getByText("Shortest baseline")).toBeTruthy();
    // 900 m vs 600 m at 1.4 m/s: +4 min; sun 1 min vs 5 min: −79 %.
    expect(screen.getByText("+4 min, -79% sun exposure")).toBeTruthy();
  });

  it("puts the time verdict on the card at reading size", () => {
    render(<RouteCard route={shadowed} selected={false} onSelect={() => {}} baselineRoute={shortest} />);

    // 900 m at 1.4 m/s ≈ 11 min — and the caption says what the number assumes.
    expect(screen.getByText("11 min")).toBeTruthy();
    expect(screen.getByText(/duration at a fixed 5.0 km\/h walking pace/)).toBeTruthy();
  });

  it("collapses the details away unless the card is selected", () => {
    const { rerender } = render(
      <RouteCard route={shadowed} selected={false} onSelect={() => {}} baselineRoute={shortest} />,
    );

    expect(screen.queryByText("Turns")).toBeNull();
    expect(screen.queryByText(/^1 min in sun/)).toBeNull();

    rerender(<RouteCard route={shadowed} selected onSelect={() => {}} baselineRoute={shortest} />);

    expect(screen.getByText("Turns")).toBeTruthy();
    expect(screen.getByText(/^1 min in sun/)).toBeTruthy();
  });
});

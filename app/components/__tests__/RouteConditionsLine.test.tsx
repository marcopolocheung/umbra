/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RouteConditionsLine, { formatMinuteRange } from "../RouteConditionsLine";
import type { WeatherHour } from "../../lib/heat/types";
import type { RouteOption } from "../../lib/routing";

afterEach(cleanup);

function route(distanceM: number, shadowCoverage: number): RouteOption {
  return {
    label: "Most shadowed",
    distanceM,
    shadowCoverage,
    geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
  };
}

function bikeRoute(distanceM: number, shadowCoverage: number): RouteOption {
  return { ...route(distanceM, shadowCoverage), travelMode: "bike" };
}

const HOT: WeatherHour = {
  time: new Date(Date.UTC(2026, 5, 21, 13)),
  tempC: 31,
  humidityPct: 45,
  windMs: 2.5,
  apparentTempC: 33,
  shortwaveWm2: 820,
  uvIndex: 8.4,
  cloudPct: 6,
};

describe("RouteConditionsLine", () => {
  it("states the heat band and the dose under one heading", () => {
    render(<RouteConditionsLine route={route(1200, 0.4)} weather={HOT} />);

    // Heat leads: it is the figure that varies between the options below.
    expect(screen.getByText(/heat stress/)).toBeTruthy();
    expect(screen.getByText(/of full sun/)).toBeTruthy();
  });

  it("carries exactly one Experimental badge and one method link", () => {
    render(<RouteConditionsLine route={route(1200, 0.4)} weather={HOT} />);

    // The whole point of combining the rows: a second badge forty pixels away is
    // what turns the first into page furniture.
    expect(screen.getAllByText("Experimental")).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("drops the dose but keeps the heat score when UV is unknown", () => {
    render(<RouteConditionsLine route={route(1200, 0.4)} weather={{ ...HOT, uvIndex: null }} />);

    expect(screen.getByText(/heat stress/)).toBeTruthy();
    expect(screen.queryByText(/of full sun/)).toBeNull();
    expect(screen.queryByText(/UV/)).toBeNull();
  });

  it("stops saying Heat at all with no forecast, rather than assuming one", () => {
    render(<RouteConditionsLine route={route(1200, 0.4)} weather={null} />);

    expect(screen.getByText(/of this walk is in sun/)).toBeTruthy();
    expect(screen.getByText(/heat not scored/)).toBeTruthy();
    expect(screen.queryByText(/of full sun/)).toBeNull();
  });

  it("speaks of the ride, not the walk, on a bike route", () => {
    render(<RouteConditionsLine route={bikeRoute(1200, 0.4)} weather={null} />);

    expect(screen.getByText(/of this ride is in sun/)).toBeTruthy();
    expect(screen.queryByText(/of this walk is in sun/)).toBeNull();
  });

  it("says cycling, not walking, on a scored bike route", () => {
    render(<RouteConditionsLine route={bikeRoute(1200, 0.4)} weather={HOT} />);

    expect(screen.getByText(/cycling this/)).toBeTruthy();
    expect(screen.queryByText(/walking this/)).toBeNull();
  });

  it("names no person: a burn share needs a phototype this app does not have", () => {
    const { container } = render(<RouteConditionsLine route={route(1200, 0.4)} weather={HOT} />);

    expect(container.textContent).not.toMatch(/burn/i);
    expect(container.textContent).toMatch(/blocks the direct beam, not the diffuse sky/);
  });
});

describe("formatMinuteRange", () => {
  it("reads a sub-minute low bound as an upper bound, not as a range to itself", () => {
    // A short fully shadowed walk: low 0.44, high 1.32 both round toward 1, and the
    // old formatter rendered the nonsense "under 1–1 min".
    expect(formatMinuteRange(0.44, 1.32)).toBe("up to 1 min");
  });

  it("collapses a range whose ends round together", () => {
    expect(formatMinuteRange(1.6, 2.4)).toBe("2 min");
  });

  it("says under a minute when even the high end is under one", () => {
    expect(formatMinuteRange(0.1, 0.7)).toBe("under a minute");
  });

  it("renders an ordinary range as a range", () => {
    expect(formatMinuteRange(3.9, 4.8)).toBe("4–5 min");
  });
});

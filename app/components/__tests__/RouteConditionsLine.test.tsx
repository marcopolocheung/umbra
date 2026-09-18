/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RouteConditionsLine, { formatMinuteRange } from "../RouteConditionsLine";
import type { WeatherHour } from "../../lib/heat/types";
import type { RouteOption } from "../../lib/routing";
import type { TransitWaitExposure } from "../../lib/transitWaitExposure";

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
  windDirDeg: 225,
  windGustMs: 7,
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

  it("states the walking-pace basis, not a cycling estimate, on a scored bike route", () => {
    // The heat model estimates felt temperature while walking; cycling airflow
    // is unmodeled (#349), so the bike detail must not read "cycling this".
    render(<RouteConditionsLine route={bikeRoute(1200, 0.4)} weather={HOT} />);

    expect(screen.getByText(/walking-pace estimate/)).toBeTruthy();
    expect(screen.queryByText(/cycling this/)).toBeNull();
    expect(screen.queryByText(/walking this/)).toBeNull();
  });

  it("names no person: a burn share needs a phototype this app does not have", () => {
    const { container } = render(<RouteConditionsLine route={route(1200, 0.4)} weather={HOT} />);

    expect(container.textContent).not.toMatch(/burn/i);
    expect(container.textContent).toMatch(/blocks the direct beam, not the diffuse sky/);
  });
});

describe("RouteConditionsLine on a transit route", () => {
  const line = route(0, 0).geojson;

  function busRoute(waitExposure: TransitWaitExposure): RouteOption {
    return {
      ...route(840, 1),
      legs: [
        { type: "walk", geojson: line, distanceM: 420, shadowCoverage: 1 },
        { type: "transit", geojson: line, travelTimeSec: 1200, waitSec: 360, waitExposure },
        { type: "walk", geojson: line, distanceM: 420, shadowCoverage: 1 },
      ],
    };
  }

  it("counts the wait in the dose and says the ride is not counted", () => {
    render(
      <RouteConditionsLine route={busRoute({ shadow: 0, coverage: 1, boardings: 1 })} weather={HOT} />,
    );

    // 6 min at the stop in full sun, plus 10 min of shadowed walk at 20–60% of
    // full sun: 8–12 min. Without the wait it would be 2–6.
    expect(screen.getByText(/8–12 min/)).toBeTruthy();
    expect(screen.getByText("Sun figures: walk and stop wait only; ride not counted.")).toBeTruthy();
  });

  it("estimates nothing when the sun at a stop is unknown", () => {
    render(<RouteConditionsLine route={busRoute({ coverage: 0.2, boardings: 1 })} weather={HOT} />);

    expect(screen.getByText("heat and sun not estimated")).toBeTruthy();
    expect(screen.queryByText(/heat stress/)).toBeNull();
    expect(screen.queryByText(/of full sun/)).toBeNull();
    // The forecast's UV beside "not estimated" would read as a contradiction.
    expect(screen.queryByText(/UV \d/)).toBeNull();
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

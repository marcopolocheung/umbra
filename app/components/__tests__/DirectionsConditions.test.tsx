/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WeatherHour } from "../../lib/heat/types";
import DirectionsConditions, { compass16, conditionsValues } from "../DirectionsConditions";

afterEach(cleanup);

const selectedTime = new Date("2026-06-21T18:20:00Z");
const sunset = new Date("2026-06-21T22:39:00Z");
const weather: WeatherHour = {
  time: selectedTime, tempC: 21.67, uvIndex: 5, windMs: 4.02, windDirDeg: 270,
  humidityPct: null, windGustMs: null, cloudPct: null, apparentTempC: null, shortwaveWm2: null,
};
const props = { selectedTime, mapUtcOffsetMin: -240, solarPosition: { altitudeDeg: 42, azimuthDeg: 202.5 }, sunset, weather };

describe("Directions conditions board", () => {
  it("formats live map-local values and a 16-point bearing", () => {
    expect(compass16(202.5)).toBe("SSW");
    expect(conditionsValues(props)).toEqual({ sun: "42° SSW", air: "71°F", uv: "5 MOD", wind: "9 MPH W", sunset: "6:39 PM", time: "2:20 PM" });
    render(<DirectionsConditions {...props} />);
    expect(screen.getByTestId("conditions-sun").getAttribute("data-value")).toBe("42° SSW");
    expect(screen.getByTestId("conditions-wind").getAttribute("data-value")).toBe("9 MPH W");
  });

  it("shows a dash for each unavailable field, never a guessed zero", () => {
    render(<DirectionsConditions {...props} solarPosition={null} sunset={null} weather={{ ...weather, tempC: null, uvIndex: null, windDirDeg: null }} />);
    for (const row of ["sun", "air", "uv", "wind", "sunset"]) {
      expect(screen.getByTestId(`conditions-${row}`).getAttribute("data-value")).toBe("—");
    }
  });

  it("replaces the Sun flap when stamped time changes and explains its sources", () => {
    const view = render(<DirectionsConditions {...props} />);
    const previous = screen.getByTestId("conditions-sun");
    view.rerender(<DirectionsConditions {...props} selectedTime={new Date("2026-06-21T19:20:00Z")} solarPosition={{ altitudeDeg: 51, azimuthDeg: 225 }} />);
    expect(screen.getByTestId("conditions-sun")).not.toBe(previous);
    expect(screen.getByTestId("conditions-sun").getAttribute("data-value")).toBe("51° SW");
    fireEvent.click(screen.getByRole("button", { name: "How this is gathered" }));
    expect(screen.getByText(/nearest the stamped time, up to 90 minutes away/)).toBeTruthy();
  });
});

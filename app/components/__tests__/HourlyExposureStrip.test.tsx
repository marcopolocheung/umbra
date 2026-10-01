/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HourlyExposure } from "../../hooks/useHourlyExposure";
import type { HourlyExposureSample } from "../../lib/bestTime";
import HourlyExposureStrip, { rampStep } from "../HourlyExposureStrip";

afterEach(cleanup);

function sample(hour: number, sunExposure: number, extra: Partial<HourlyExposureSample> = {}): HourlyExposureSample {
  const label = hour === 12 ? "12 PM" : hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
  return {
    date: new Date(Date.UTC(2026, 5, 21, hour + 4)),
    hour,
    label,
    shadowCoverage: 1 - sunExposure,
    sunExposure,
    ...extra,
  };
}

function strip(exposure: HourlyExposure, currentHour = 10, onPickHour = vi.fn()) {
  render(<HourlyExposureStrip exposure={exposure} currentHour={currentHour} onPickHour={onPickHour} />);
  return onPickHour;
}

/** R6b: the hourly strip as a departures board. */
describe("HourlyExposureStrip", () => {
  it("steps the five-step ramp by fifths of the share", () => {
    expect(rampStep(0)).toBe("light");
    expect(rampStep(0.19)).toBe("light");
    expect(rampStep(0.2)).toBe("bright");
    expect(rampStep(0.5)).toBe("base");
    expect(rampStep(0.79)).toBe("dark");
    expect(rampStep(1)).toBe("darker");
  });

  it("colours each sun bar by its ramp step and keys hours in 12-hour numerals", () => {
    const samples = [sample(10, 0.1), sample(11, 0.5), sample(12, 0.95), sample(13, 0.3)];
    strip({ samples, readyCount: 4, best: samples[0] });
    const bars = screen.getAllByTestId("hour-bar");
    expect(bars.map((b) => b.style.background)).toEqual([
      "var(--color-sun-light)",
      "var(--color-sun-base)",
      "var(--color-sun-darker)",
      "var(--color-sun-bright)",
    ]);
    expect(screen.getByText("Sun by hour")).toBeTruthy();
    expect(screen.getByText("most shadowed around 10 AM")).toBeTruthy();
    // Meridiem shows where it changes: AM under 10, PM under 12.
    expect(screen.getByText("AM")).toBeTruthy();
    expect(screen.getByText("PM")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^1 PM: 30% in sun/ }).textContent).toContain("1");
  });

  it("marks the timeline's hour as an ink ticket and picks an hour on tap", () => {
    const samples = [sample(10, 0.1), sample(11, 0.5)];
    const onPick = strip({ samples, readyCount: 2, best: samples[0] }, 11);
    const now = screen.getByRole("button", { name: /^11 AM/ });
    expect(now.getAttribute("aria-current")).toBe("time");
    expect(within(now).getByText("11").style.background).toBe("var(--color-ink)");
    fireEvent.click(screen.getByRole("button", { name: /^10 AM/ }));
    expect(onPick).toHaveBeenCalledWith(samples[0].date);
  });

  it("dashes hours still being sampled instead of drawing a zero", () => {
    const samples = [sample(10, 0.1), sample(11, 0.5), sample(12, 0.9)];
    strip({ samples, readyCount: 1, best: samples[0] });
    expect(screen.getAllByTestId("hour-bar")).toHaveLength(1);
    expect(screen.getByText("checking…")).toBeTruthy();
    const pending = screen.getByRole("button", { name: "11 AM: unavailable for recommendation" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.textContent).toContain("–");
    expect(screen.queryByText("– not sampled")).toBeNull();
  });

  it("labels rain hours that have no reading once sampling ends", () => {
    const samples = [
      sample(10, 0.4, { objective: "rain", available: true }),
      sample(11, 0.4, { objective: "rain", available: false }),
    ];
    strip({ samples, readyCount: 2, best: samples[0] });
    expect(screen.getAllByText("Rain shelter by hour")).toHaveLength(2); // header and legend
    expect(screen.getAllByTestId("hour-bar")[0].style.background).toBe("var(--color-rain-dark)");
    expect(screen.getByRole("button", { name: "11 AM: unavailable for recommendation" })).toBeTruthy();
    expect(screen.getByText("– not sampled")).toBeTruthy();
  });
});

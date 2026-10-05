/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import registryCss from "../../globals.css?raw";
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

function strip(
  exposure: Omit<HourlyExposure, "requested" | "request"> & Partial<HourlyExposure>,
  currentHour = 10,
  onPickHour = vi.fn(),
) {
  render(
    <HourlyExposureStrip
      exposure={{ requested: true, request: vi.fn(), ...exposure }}
      currentHour={currentHour}
      onPickHour={onPickHour}
    />,
  );
  return onPickHour;
}

/** R6b: the hourly strip as a departures board. */
describe("HourlyExposureStrip", () => {
  it("steps the five-step ramp by fifths of the share", () => {
    expect(rampStep(0)).toBe(1);
    expect(rampStep(0.19)).toBe(1);
    expect(rampStep(0.2)).toBe(2);
    expect(rampStep(0.5)).toBe(3);
    expect(rampStep(0.79)).toBe(4);
    expect(rampStep(1)).toBe(5);
  });

  it("colours each sun bar by its ramp step and keys hours in 12-hour numerals", () => {
    const samples = [sample(10, 0.1), sample(11, 0.5), sample(12, 0.95), sample(13, 0.3)];
    strip({ samples, readyCount: 4, best: samples[0] });
    const bars = screen.getAllByTestId("hour-bar");
    expect(bars.map((b) => b.style.background)).toEqual([
      "var(--color-sun-step-1)",
      "var(--color-sun-step-3)",
      "var(--color-sun-step-5)",
      "var(--color-sun-step-2)",
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
    expect(screen.queryByText(/no reading$/)).toBeNull();
  });

  it("asks before sampling: a header button, no hour grid, and the tap requests the day", () => {
    const samples = [sample(10, 0), sample(11, 0)];
    const request = vi.fn();
    strip({ samples, readyCount: 0, best: null, requested: false, request });
    expect(screen.queryAllByRole("button", { name: /AM:/ })).toHaveLength(0);
    expect(screen.queryByText("checking…")).toBeNull();
    expect(screen.getByText("Sun by hour")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check sun on this route by hour" }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("labels rain hours that have no reading once sampling ends", () => {
    const samples = [
      sample(10, 0.4, { objective: "rain", available: true }),
      sample(11, 0.4, { objective: "rain", available: false }),
    ];
    strip({ samples, readyCount: 2, best: samples[0] });
    expect(screen.getAllByText("Rain shelter by hour")).toHaveLength(2); // header and legend
    expect(screen.getAllByTestId("hour-bar")[0].style.background).toBe("var(--color-rain-step-4)");
    expect(screen.getByRole("button", { name: "11 AM: unavailable for recommendation" })).toBeTruthy();
    expect(screen.getByText(/no reading$/)).toBeTruthy();
  });
});

describe("ramp step tokens", () => {
  function steps(block: string, meaning: "sun" | "rain"): string[] {
    return [1, 2, 3, 4, 5].map((n) => {
      const m = block.match(new RegExp(`--color-${meaning}-step-${n}:\\s*var\\(--color-${meaning}-(\\w+)\\)`));
      return m?.[1] ?? "missing";
    });
  }
  const night = registryCss.slice(registryCss.indexOf('html[data-theme="night"]'));
  const day = registryCss.slice(0, registryCss.indexOf('html[data-theme="night"]'));

  it("run light to darker by day and reverse at night, so more share is more contrast", () => {
    for (const meaning of ["sun", "rain"] as const) {
      expect(steps(day, meaning)).toEqual(["light", "bright", "base", "dark", "darker"]);
      expect(steps(night, meaning)).toEqual(["darker", "dark", "base", "bright", "light"]);
    }
  });
});

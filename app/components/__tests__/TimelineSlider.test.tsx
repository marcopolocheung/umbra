/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import TimelineSlider from "../TimelineSlider";

afterEach(cleanup);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// Midtown Manhattan on the June solstice, EDT (UTC−4): sun up 05:26–20:31.
const at = (iso: string, minutes: number) => (
  <TimelineSlider
    minutes={minutes}
    onChange={() => {}}
    date={new Date(iso)}
    latDeg={40.754}
    lngDeg={-73.984}
    utcOffsetMin={-240}
  />
);

/**
 * The timetable ruler (R6a): the sun dot and the orange needle are solar data,
 * so they follow the sun's altitude at the selected time, and night is drawn
 * as bands rather than an absent path.
 */
describe("TimelineSlider", () => {
  it("rides the sun dot on the path and paints the needle orange while the sun is up", () => {
    render(at("2026-06-21T13:00:00Z", 9 * 60));
    const sun = screen.getByTestId("timeline-sun");
    expect(Number(sun.getAttribute("cx"))).toBe(9 * 60 * 2);
    // Higher in the sky at 1 PM than at 9 AM: SVG y grows downward.
    const nineY = Number(sun.getAttribute("cy"));
    cleanup();
    render(at("2026-06-21T17:00:00Z", 13 * 60));
    expect(Number(screen.getByTestId("timeline-sun").getAttribute("cy"))).toBeLessThan(nineY);
    expect(screen.getByTestId("timeline-needle").style.backgroundColor).toBe("var(--color-sun-signal)");
  });

  it("drops the sun dot and inks the needle after sunset", () => {
    render(at("2026-06-22T02:00:00Z", 22 * 60));
    expect(screen.queryByTestId("timeline-sun")).toBeNull();
    expect(screen.getByTestId("timeline-needle").style.backgroundColor).toBe("var(--color-ink)");
  });

  it("bands both nights and prints sunrise and sunset beside them", () => {
    render(at("2026-06-21T13:00:00Z", 9 * 60));
    expect(screen.getAllByTestId("timeline-night")).toHaveLength(2);
    expect(screen.getByText("↑ 5:26 AM")).toBeTruthy();
    expect(screen.getByText("↓ 8:31 PM")).toBeTruthy();
  });

  it("draws no sun path without a map place", () => {
    render(<TimelineSlider minutes={600} onChange={() => {}} />);
    expect(screen.queryByTestId("timeline-sun")).toBeNull();
    expect(screen.queryByTestId("timeline-night")).toBeNull();
    expect(screen.getByText("10 AM")).toBeTruthy();
  });
});

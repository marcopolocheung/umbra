/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { nightSpans, sunAltitudeTrace } from "../../lib/sunPath";
import TimelineSlider from "../TimelineSlider";

afterEach(cleanup);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// Midtown Manhattan on the June solstice, EDT (UTC−4): published sun times 05:26–20:31.
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

  it("bands both nights and labels sunrise and sunset at the bands' 0° edges (#160)", () => {
    render(at("2026-06-21T13:00:00Z", 9 * 60));
    expect(screen.getAllByTestId("timeline-night")).toHaveLength(2);
    // The labels sit where the needle turns orange, a few minutes inside the
    // published 5:26 / 8:31, which use the −0.833° refraction convention.
    const [[, dawn], [dusk]] = nightSpans(sunAltitudeTrace(new Date("2026-06-21T13:00:00Z"), 40.754, -73.984, -240));
    expect(Math.round(dawn)).toBeGreaterThan(5 * 60 + 26);
    expect(Math.round(dusk)).toBeLessThan(20 * 60 + 31);
    const clock = (m: number) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, "0")}`;
    expect(screen.getByText(`↑ ${clock(Math.round(dawn))} AM`)).toBeTruthy();
    expect(screen.getByText(`↓ ${clock(Math.round(dusk))} PM`)).toBeTruthy();
  });

  it("lands the last drag position even when the drag pauses inside the throttle window (#161)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const onChange = vi.fn();
      render(<TimelineSlider minutes={600} onChange={onChange} />);
      const ruler = screen.getByTestId("timeline-slider");
      ruler.setPointerCapture = () => {};
      vi.advanceTimersByTime(1000); // a real clock is never at 0
      fireEvent.pointerDown(ruler, { clientX: 200, pointerId: 1 });
      fireEvent.pointerMove(ruler, { clientX: 180, pointerId: 1 }); // −20px = +10 min, sent at once
      vi.advanceTimersByTime(5);
      fireEvent.pointerMove(ruler, { clientX: 160, pointerId: 1 }); // throttled
      expect(onChange).toHaveBeenLastCalledWith(610);
      vi.advanceTimersByTime(30); // the thumb has stopped; no further move arrives
      expect(onChange).toHaveBeenLastCalledWith(620);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says there is no sun path without a map place, rather than drawing none", () => {
    render(<TimelineSlider minutes={600} onChange={() => {}} />);
    expect(screen.queryByTestId("timeline-sun")).toBeNull();
    expect(screen.queryByTestId("timeline-night")).toBeNull();
    expect(screen.getByText("No sun path until the map has a place")).toBeTruthy();
    expect(screen.getByText("10 AM")).toBeTruthy();
  });
});

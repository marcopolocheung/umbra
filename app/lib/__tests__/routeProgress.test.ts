import { describe, expect, it } from "vitest";
import { routeProgressCount, routeProgressPercent, shouldYield, YIELD_INTERVAL_MS } from "../routeProgress";

describe("route progress formatting", () => {
  it("returns null when progress has no bounded total", () => {
    expect(routeProgressPercent({ message: "Fetching" })).toBeNull();
    expect(routeProgressCount({ message: "Fetching", current: 1, total: 0 })).toBeNull();
  });

  it("formats bounded progress for visible and aria progress bars", () => {
    const progress = { message: "Sampling street shadow", current: 25, total: 100 };

    expect(routeProgressPercent(progress)).toBe(25);
    expect(routeProgressCount(progress)).toBe("25/100");
  });

  it("clamps progress to the known range", () => {
    const progress = { message: "Sampling street shadow", current: 120, total: 100 };

    expect(routeProgressPercent(progress)).toBe(100);
    expect(routeProgressCount(progress)).toBe("100/100");
  });
});

describe("shouldYield (#266)", () => {
  it("does not yield on edge count alone while under the interval", () => {
    // The old rule yielded at every 100th edge; that cost ~4 ms of timer clamp each.
    expect(shouldYield(100, 66_800, 10, 0)).toBe(false);
    expect(shouldYield(5_000, 66_800, YIELD_INTERVAL_MS - 1, 0)).toBe(false);
  });

  it("yields once the interval has elapsed since the last yield", () => {
    expect(shouldYield(7, 66_800, 1_000 + YIELD_INTERVAL_MS, 1_000)).toBe(true);
  });

  it("always yields after the last item, so the final progress update is published", () => {
    expect(shouldYield(440, 440, 0, 0)).toBe(true);
  });
});

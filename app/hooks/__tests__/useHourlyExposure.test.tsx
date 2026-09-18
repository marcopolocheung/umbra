/* @vitest-environment jsdom */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteOption } from "../../lib/routing";
import type { EdgeRef, EdgeShadow, ShadowField } from "../../lib/shadowField/ShadowField";
import { useHourlyExposure } from "../useHourlyExposure";

// Without this the hooks stay mounted past the end of the file, and React's
// scheduler still has a `performWorkUntilDeadline` immediate queued when the
// jsdom environment is torn down — "ReferenceError: window is not defined",
// an unhandled error that fails the run while every test passes. It surfaces
// under `--coverage`, where instrumentation is slow enough to lose the race.
afterEach(cleanup);

/** A straight west→east route of three ~111 m edges at the equator. */
function route(sides?: RouteOption["sides"]): RouteOption {
  return {
    label: "Balanced",
    geojson: {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [[0, 0], [0.001, 0], [0.002, 0], [0.003, 0]],
      },
    },
    sides,
    distanceM: 333,
    shadowCoverage: 0.5,
    longestContinuousShadowM: 0,
    longestContinuousSunM: 0,
    shadowTransitions: 0,
    detourRatio: 1,
    turnCount: 0,
  };
}

/**
 * A field whose shadow depends only on the hour, so the series is predictable:
 * fully shadowed before noon, fully sunlit after.
 */
function fieldByHour(overrides: Partial<ShadowField> = {}): ShadowField {
  return {
    shadowAt: vi.fn(),
    coverage: vi.fn(),
    sampleEdges: vi.fn(),
    ready: vi.fn().mockResolvedValue(undefined),
    sweep: vi.fn((edges: EdgeRef[], times: Date[]) =>
      times.map((when): EdgeShadow[] => {
        const shadow = when.getUTCHours() < 12 ? 1 : 0;
        return edges.map(() => ({ left: shadow, right: shadow, source: "tiles", confidence: 1 }));
      })
    ),
    ...overrides,
  } as ShadowField;
}

describe("useHourlyExposure", () => {
  it("samples the whole day and reports the most shadowed hour", async () => {
    const field = fieldByHour();
    const stable = route();
    const { result } = renderHook(() =>
      useHourlyExposure(stable, field, new Date("2026-06-21T12:00:00Z"), 0)
    );

    // 6:00 through 20:00 inclusive.
    await waitFor(() => expect(result.current.readyCount).toBe(15));
    expect(result.current.samples).toHaveLength(15);
    expect(result.current.samples[0].shadowCoverage).toBe(1);
    expect(result.current.samples[0].sunExposure).toBe(0);
    expect(result.current.samples.at(-1)!.shadowCoverage).toBe(0);
    // Every morning hour ties at fully shadowed; the first one wins the reduction.
    expect(result.current.best!.hour).toBe(6);
  });

  it("fills the strip incrementally rather than in one blocking pass", async () => {
    const field = fieldByHour();
    const stable = route();
    const { result } = renderHook(() =>
      useHourlyExposure(stable, field, new Date("2026-06-21T12:00:00Z"), 0)
    );

    // The schedule is known immediately; the measurements are not.
    await waitFor(() => expect(result.current.readyCount).toBeGreaterThan(0));
    expect(result.current.readyCount).toBeLessThan(15);

    await waitFor(() => expect(result.current.readyCount).toBe(15));
    // One `sweep` per hour, not one call for the whole day.
    expect(field.sweep).toHaveBeenCalledTimes(15);
  });

  it("credits the sidewalk the route actually chose", async () => {
    const lit: EdgeShadow = { left: 1, right: 0, source: "tiles", confidence: 1 };
    const field = fieldByHour({
      sweep: vi.fn((edges: EdgeRef[], times: Date[]) =>
        times.map(() => edges.map(() => lit))
      ),
    });

    const stable = route(["right", "right", "right"]);
    const { result } = renderHook(() =>
      useHourlyExposure(stable, field, new Date("2026-06-21T12:00:00Z"), 0)
    );
    await waitFor(() => expect(result.current.readyCount).toBe(15));

    // The right sidewalk is in full sun even though the left is fully shadowed.
    expect(result.current.samples[0].shadowCoverage).toBe(0);
  });

  it("averages both sidewalks when the search never chose a side", async () => {
    const lit: EdgeShadow = { left: 1, right: 0, source: "tiles", confidence: 1 };
    const field = fieldByHour({
      sweep: vi.fn((edges: EdgeRef[], times: Date[]) =>
        times.map(() => edges.map(() => lit))
      ),
    });

    const stable = route();
    const { result } = renderHook(() =>
      useHourlyExposure(stable, field, new Date("2026-06-21T12:00:00Z"), 0)
    );
    await waitFor(() => expect(result.current.readyCount).toBe(15));

    expect(result.current.samples[0].shadowCoverage).toBe(0.5);
  });

  it("does not restart the sweep when only the time of day changes", async () => {
    const field = fieldByHour();
    const routeOption = route();
    const { result, rerender } = renderHook(
      ({ date }: { date: Date }) => useHourlyExposure(routeOption, field, date, 0),
      { initialProps: { date: new Date("2026-06-21T09:00:00Z") } }
    );

    await waitFor(() => expect(result.current.readyCount).toBe(15));
    const callsAfterFirstDay = (field.sweep as ReturnType<typeof vi.fn>).mock.calls.length;

    rerender({ date: new Date("2026-06-21T17:00:00Z") });
    await waitFor(() => expect(result.current.readyCount).toBe(15));
    expect(field.sweep).toHaveBeenCalledTimes(callsAfterFirstDay);

    // A different day is a different series, so that one does resample.
    rerender({ date: new Date("2026-06-22T09:00:00Z") });
    await waitFor(() =>
      expect((field.sweep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        callsAfterFirstDay
      )
    );
  });

  it("reports nothing without a route or a field", () => {
    const { result: noRoute } = renderHook(() =>
      useHourlyExposure(null, fieldByHour(), new Date("2026-06-21T12:00:00Z"), 0)
    );
    expect(noRoute.current.samples).toEqual([]);

    const { result: noField } = renderHook(() =>
      useHourlyExposure(route(), null, new Date("2026-06-21T12:00:00Z"), 0)
    );
    expect(noField.current.samples).toEqual([]);
  });
});

/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMetrics,
  computeDerivedKpis,
  getMetricsSummary,
  getRunHistory,
  recordRoutingRun,
  type RoutingRunMetrics,
} from "../metrics";

/** A run whose only interesting field is its total wall-clock time. */
function run(totalMs: number, overrides: Partial<RoutingRunMetrics> = {}): RoutingRunMetrics {
  return {
    timestamp: 0,
    phases: {
      graphFetch: 0,
      canvasRead: 0,
      shadowSample: totalMs / 4,
      dijkstra: totalMs / 8,
      total: totalMs,
    },
    graphNodeCount: 0,
    graphDirectedEdges: 0,
    shadowFallbackShare: 0,
    routes: [],
    routeComputeMs: totalMs,
    shadowCoverageGainPp: null,
    pathLengthDeltaPct: null,
    ...overrides,
  };
}

function windowMetrics(): {
  latest: RoutingRunMetrics | null;
  history: readonly RoutingRunMetrics[];
  summary: ReturnType<typeof getMetricsSummary>;
  clearMetrics: () => void;
} {
  // The global is deliberately untyped; noExplicitAny is off repo-wide.
  return (window as any).__umbraMetrics;
}

beforeEach(() => {
  clearMetrics();
});

describe("getMetricsSummary", () => {
  it("returns null before any run is recorded", () => {
    expect(getMetricsSummary()).toBeNull();
  });

  it("reports the median as p50, not the mean", () => {
    // 1, 2, 3, 4, 100 — mean 22, median 3. A benchmark that quoted the mean here
    // would report a number no run came close to.
    for (const t of [100, 1, 4, 2, 3]) recordRoutingRun(run(t));

    const s = getMetricsSummary()!;
    expect(s.runs).toBe(5);
    expect(s.p50TotalMs).toBe(3);
    expect(s.avgTotalMs).toBe(22);
  });

  it("does not report the slowest run as p95", () => {
    // The whole of #182: at every N the buffer can hold, the old index landed on
    // the last element, so p95 was the maximum with a percentile's name on it.
    for (let i = 1; i <= 20; i++) recordRoutingRun(run(i));

    const s = getMetricsSummary()!;
    expect(s.runs).toBe(20);
    expect(s.p95TotalMs).toBeLessThan(20);
    // rank = 19 * 0.95 = 18.05, between the 19th and 20th values (19 and 20).
    expect(s.p95TotalMs).toBeCloseTo(19.05, 10);
  });

  it("keeps p95 above the median at every sample count from 2 to 20", () => {
    for (let n = 2; n <= 20; n++) {
      clearMetrics();
      for (let i = 1; i <= n; i++) recordRoutingRun(run(i * 10));

      const s = getMetricsSummary()!;
      expect(s.p50TotalMs, `n=${n}`).toBeGreaterThan(10);
      expect(s.p95TotalMs, `n=${n}`).toBeGreaterThan(s.p50TotalMs);
      expect(s.p95TotalMs, `n=${n}`).toBeLessThanOrEqual(n * 10);
    }
  });

  it("collapses both percentiles onto the only sample when there is one run", () => {
    recordRoutingRun(run(42));

    const s = getMetricsSummary()!;
    expect(s.p50TotalMs).toBe(42);
    expect(s.p95TotalMs).toBe(42);
  });

  it("averages the KPIs over only the runs that reported them", () => {
    recordRoutingRun(run(10, { shadowCoverageGainPp: 20, pathLengthDeltaPct: 8 }));
    recordRoutingRun(run(10, { shadowCoverageGainPp: 30, pathLengthDeltaPct: 12 }));
    recordRoutingRun(run(10)); // single-route run: both KPIs null

    const s = getMetricsSummary()!;
    expect(s.runs).toBe(3);
    expect(s.avgShadowCoverageGainPp).toBe(25);
    expect(s.avgPathLengthDeltaPct).toBe(10);
  });

  it("reports null KPI averages when no run measured them", () => {
    recordRoutingRun(run(10));

    const s = getMetricsSummary()!;
    expect(s.avgShadowCoverageGainPp).toBeNull();
    expect(s.avgPathLengthDeltaPct).toBeNull();
  });
});

describe("history buffer", () => {
  it("keeps the newest run first and drops past 20", () => {
    for (let i = 1; i <= 25; i++) recordRoutingRun(run(i));

    const history = getRunHistory();
    expect(history).toHaveLength(20);
    expect(history[0].phases.total).toBe(25);
    expect(history[19].phases.total).toBe(6);
  });
});

describe("window.__umbraMetrics", () => {
  it("exposes clearMetrics so a benchmark can reset between scenarios", () => {
    recordRoutingRun(run(10));

    expect(typeof windowMetrics().clearMetrics).toBe("function");
  });

  it("reports a fresh summary after the exposed clearMetrics runs", () => {
    // A snapshot taken at record time would still be sitting here, so scenario 2
    // would open by reading scenario 1's numbers.
    recordRoutingRun(run(500));
    expect(windowMetrics().summary!.runs).toBe(1);

    windowMetrics().clearMetrics();

    expect(windowMetrics().summary).toBeNull();
    expect(windowMetrics().latest).toBeNull();
    expect(windowMetrics().history).toHaveLength(0);
  });

  it("tracks later runs without being republished", () => {
    recordRoutingRun(run(10));
    const exposed = windowMetrics();

    recordRoutingRun(run(30));

    expect(exposed.latest!.phases.total).toBe(30);
    expect(exposed.summary!.runs).toBe(2);
  });

  it("preserves the Phase-0 graph-fetch attribution split when present, absent when not", () => {
    recordRoutingRun(
      run(100, {
        phases: {
          graphFetch: 10,
          navSnapshot: 1,
          staticStreets: 7,
          fieldReady: 2,
          canvasRead: 0,
          shadowSample: 20,
          dijkstra: 30,
          total: 100,
        },
      }),
    );

    const latest = windowMetrics().latest!;
    expect(latest.phases.graphFetch).toBe(10);
    expect(latest.phases.navSnapshot).toBe(1);
    expect(latest.phases.staticStreets).toBe(7);
    expect(latest.phases.fieldReady).toBe(2);
    // The split cannot exceed the span it attributes: the benchmark's sum
    // invariant reads exactly this on live runs.
    expect(latest.phases.navSnapshot! + latest.phases.staticStreets! + latest.phases.fieldReady!)
      .toBeLessThanOrEqual(latest.phases.graphFetch);

    recordRoutingRun(run(50));
    expect(windowMetrics().latest!.phases.navSnapshot).toBeUndefined();
    expect(windowMetrics().latest!.phases.staticStreets).toBeUndefined();
    expect(windowMetrics().latest!.phases.fieldReady).toBeUndefined();
  });

  it("preserves the Phase-0 transit audit split when present, absent when not", () => {
    recordRoutingRun(
      run(100, {
        phases: {
          graphFetch: 10,
          canvasRead: 0,
          shadowSample: 20,
          dijkstra: 30,
          walkPareto: 25,
          transitFetch: 5,
          trainSearch: 15,
          trainSearchSubway: 6,
          trainSearchBus: 9,
          entrances: 4,
          walkLegs: 8,
          busWait: 3,
          total: 100,
        },
        transitTried: true,
        transitStationCount: 200,
        transitLineCount: 12,
        entranceBoxCount: 2,
        entranceCount: 14,
        boardingStopCount: 3,
        busPreloadCount: 1,
      }),
    );

    const latest = windowMetrics().latest!;
    expect(latest.phases.walkPareto).toBe(25);
    expect(latest.phases.trainSearchSubway).toBe(6);
    expect(latest.phases.trainSearchBus).toBe(9);
    expect(latest.transitStationCount).toBe(200);
    expect(latest.busPreloadCount).toBe(1);

    recordRoutingRun(run(50));
    expect(windowMetrics().latest!.phases.walkPareto).toBeUndefined();
    expect(windowMetrics().latest!.transitTried).toBeUndefined();
  });
});

describe("computeDerivedKpis", () => {
  it("returns nulls when there is nothing to compare against", () => {
    expect(computeDerivedKpis([])).toEqual({
      shadowCoverageGainPp: null,
      pathLengthDeltaPct: null,
    });
    expect(
      computeDerivedKpis([{ label: "Shortest", distanceM: 1000, shadowCoverage: 0.2 }])
    ).toEqual({ shadowCoverageGainPp: null, pathLengthDeltaPct: null });
  });

  it("measures the last route against the first", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 1000, shadowCoverage: 0.2 },
      { label: "Balanced", distanceM: 1050, shadowCoverage: 0.4 },
      { label: "Most Shadowed", distanceM: 1200, shadowCoverage: 0.65 },
    ]);

    expect(kpis.shadowCoverageGainPp).toBeCloseTo(45, 10);
    expect(kpis.pathLengthDeltaPct).toBeCloseTo(20, 10);
  });

  it("returns nulls rather than dividing by a zero-length shortest route", () => {
    expect(
      computeDerivedKpis([
        { label: "Shortest", distanceM: 0, shadowCoverage: 0 },
        { label: "Most Shadowed", distanceM: 500, shadowCoverage: 0.5 },
      ])
    ).toEqual({ shadowCoverageGainPp: null, pathLengthDeltaPct: null });
  });
});

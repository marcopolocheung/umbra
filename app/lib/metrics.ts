/**
 * Routing instrumentation — captures KPIs for every calculateRoute() call.
 *
 * In development, results are logged to the console and exposed at:
 *   window.__umbraMetrics.latest       — most recent run
 *   window.__umbraMetrics.history      — last 20 runs
 *   window.__umbraMetrics.summary      — p50/p95 aggregates
 *   window.__umbraMetrics.clearMetrics — reset the history buffer
 *
 * The first three are getters, so a caller that resets the buffer never reads a
 * stale aggregate computed before the reset.
 *
 * Three headline KPIs:
 *   1. routeComputeMs  — end-to-end calculateRoute latency
 *   2. shadowCoverageGain — percentage-point improvement from Shortest → Most Shadowed
 *   3. pathLengthDeltaPct — how much longer Most Shadowed is vs Shortest (% overhead)
 */

export interface RoutingPhaseMs {
  graphFetch: number; // whole tFetch span (cache hit or network)
  /**
   * Phase-0 graph-fetch attribution split (all optional; absent = not measured).
   * `graphFetch` keeps its historic meaning — the whole `tFetch` wall-clock
   * span — so old readers keep working. The three sub-phases account for that
   * span: `navSnapshot` (pointer + manifest + digest verify), then
   * `staticStreets` (street shard bytes + adapter build, Overpass fallback
   * included), while `fieldReady` awaits readiness for the actual edge cells
   * first and the broad `shadowBbox` only when a subset of cells cannot
   * speak (A2 PR 2). The
   * invariant a reader can assert is:
   *   navSnapshot + staticStreets + fieldReady <= graphFetch.
   */
  navSnapshot?: number;
  staticStreets?: number;
  fieldReady?: number;
  canvasRead: number; // legacy composited-map read; production routing keeps this at 0
  /** Readback of the renderer's building-only FBO; separate from composited canvas reads. */
  dedicatedMaskRead?: number;
  shadowSample: number; // edge shadow-factor sampling loop
  dijkstra: number; // snap + graph build + walk search (kept for back-compat; see walkPareto)
  /**
   * Phase-0 transit audit split (all optional, 0/absent = phase did not run).
   * `dijkstra` keeps its historic meaning (snap + build + walk search) so old
   * readers keep working; `walkPareto` is the search-only portion of it, and
   * the five transit phases cover the block after the walk options are built
   * (`useRouting` transit branch) that previously fell into `total` unmeasured.
   */
  walkPareto?: number; // paretoRoutes (2-pt) or per-leg dijkstra loop (multi-pt)
  transitFetch?: number; // fetchBestTrainGraph (shards or Overpass)
  trainSearch?: number; // findBestTrainRoute across subway+bus
  trainSearchSubway?: number; // subway slice of trainSearch
  trainSearchBus?: number; // bus slice of trainSearch
  entrances?: number; // entrance-box fetch + match + pick (subway only)
  walkLegs?: number; // reachableFrom + snapToReachable + walkA/walkB dijkstras
  busWait?: number; // bus boarding shadowAt + stop preloads + waitExposureFrom
  total: number; // wall-clock end-to-end
}

export interface RouteMetricSnapshot {
  label: string;
  distanceM: number;
  shadowCoverage: number; // 0–1
}

export interface RoutingRunMetrics {
  /** Unix timestamp (ms) when calculateRoute was invoked. */
  timestamp: number;
  phases: RoutingPhaseMs;
  graphNodeCount: number;
  /** Total directed edges iterated during shadow sampling (both directions). */
  graphDirectedEdges: number;
  /**
   * Share of sampled edges (0–1) the geometric field could not answer confidently,
   * so the renderer's dedicated building mask answered instead. The legacy
   * composited-map classifier is retained only by the agreement harness.
   */
  shadowFallbackShare: number;
  /** Edge-count shares, recorded before path selection. */
  buildingProviderShares?: Partial<
    Record<"tiles" | "overpass" | "nyc-static" | "dedicated-mask" | "none", number>
  >;
  /** The static building generation that answered, when any edge used it. */
  staticBuildingGeneration?: string | null;
  /**
   * Phase-0 transit audit counters (all optional; absent = phase did not run).
   * Sizes, not coordinates — safe to log and to assert in benchmarks.
   */
  transitTried?: boolean; // transit branch entered (straight-line > 500 m, no partial)
  transitStationCount?: number | null; // trainGraph.stations.size
  transitLineCount?: number | null; // trainGraph.lineColors.size
  entranceBoxCount?: number; // station boxes fetched (subway only)
  entranceCount?: number; // doors returned (cache + network)
  boardingStopCount?: number; // bus boardings sampled
  busPreloadCount?: number; // bus stop ready() preloads issued (<= MAX_STOP_PRELOADS)
  canopySourceShares?: Partial<Record<"osm" | "raster" | "both" | "none", number>>;
  fallbackReason?: "low-confidence" | "mask-unavailable" | null;
  routes: RouteMetricSnapshot[];

  // ── Derived KPIs ──────────────────────────────────────────────────────────
  /**
   * KPI 1: Route compute latency (ms).
   * Target: < 3000 ms on a typical urban bbox (network-limited by Overpass).
   * Cache hit target: < 500 ms (canvas read + sampling + dijkstra only).
   */
  routeComputeMs: number;

  /**
   * KPI 2: Shadow coverage gain (percentage points, 0–100).
   * Difference in shadowCoverage between the Most Shadowed and Shortest routes.
   * null when only one route was found.
   * Target: > 10 pp for routes where a shadow-aware detour exists.
   */
  shadowCoverageGainPp: number | null;

  /**
   * KPI 3: Path length overhead (%).
   * How much longer Most Shadowed is compared to Shortest.
   * null when only one route was found.
   * A well-calibrated cost model keeps this below ~40% for useful shadow gains.
   */
  pathLengthDeltaPct: number | null;
}

// ── Internal circular history buffer ─────────────────────────────────────────

const MAX_HISTORY = 20;
const _history: RoutingRunMetrics[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

export function recordRoutingRun(m: RoutingRunMetrics): void {
  _history.unshift(m);
  if (_history.length > MAX_HISTORY) _history.pop();

  publishMetricsToWindow();

  if (process.env.NODE_ENV === "development") {
    const { phases, graphNodeCount, graphDirectedEdges } = m;
    console.groupCollapsed(
      `[Umbra] Route computed in ${phases.total.toFixed(0)} ms` +
        ` | ${graphNodeCount} nodes, ${graphDirectedEdges} directed edges`,
    );
    console.table({
      "Graph fetch (ms)": phases.graphFetch.toFixed(1),
      "Nav snapshot (ms)": (phases.navSnapshot ?? 0).toFixed(1),
      "Static streets (ms)": (phases.staticStreets ?? 0).toFixed(1),
      "Field ready (ms)": (phases.fieldReady ?? 0).toFixed(1),
      "Canvas read (ms)": phases.canvasRead.toFixed(1),
      "Building mask read (ms)": (phases.dedicatedMaskRead ?? 0).toFixed(1),
      "Canvas fallback (%)": (m.shadowFallbackShare * 100).toFixed(1),
      "Shadow sample (ms)": phases.shadowSample.toFixed(1),
      "Dijkstra (ms)": phases.dijkstra.toFixed(1),
      "Walk pareto (ms)": (phases.walkPareto ?? 0).toFixed(1),
      "Transit fetch (ms)": (phases.transitFetch ?? 0).toFixed(1),
      "Train search (ms)": (phases.trainSearch ?? 0).toFixed(1),
      "Entrances (ms)": (phases.entrances ?? 0).toFixed(1),
      "Walk legs (ms)": (phases.walkLegs ?? 0).toFixed(1),
      "Bus wait (ms)": (phases.busWait ?? 0).toFixed(1),
      "Total (ms)": phases.total.toFixed(1),
    });
    if (m.shadowCoverageGainPp !== null) {
      console.log(
        `[KPI] Shadowed route is ${m.pathLengthDeltaPct!.toFixed(1)}% longer` +
          ` and gains ${m.shadowCoverageGainPp.toFixed(1)} pp of shadow coverage`,
      );
    }
    console.groupEnd();
  }
}

/**
 * Installs (or reinstalls) `window.__umbraMetrics`.
 *
 * The three reads are getters rather than snapshots because a benchmark resets the
 * buffer between scenarios: a `summary` captured at record time would survive
 * `clearMetrics()` and report the previous scenario's numbers.
 */
function publishMetricsToWindow(): void {
  if (typeof window === "undefined") return;
  (window as any).__umbraMetrics = {
    get latest(): RoutingRunMetrics | null {
      return _history[0] ?? null;
    },
    get history(): readonly RoutingRunMetrics[] {
      return _history;
    },
    get summary(): MetricsSummary | null {
      return getMetricsSummary();
    },
    clearMetrics,
  };
}

export interface MetricsSummary {
  runs: number;
  avgTotalMs: number;
  p50TotalMs: number;
  p95TotalMs: number;
  avgShadowSampleMs: number;
  avgDijkstraMs: number;
  avgShadowCoverageGainPp: number | null;
  avgPathLengthDeltaPct: number | null;
}

/**
 * Linear-interpolated percentile (the R-7 definition) over an ascending-sorted array.
 *
 * The index form this replaced — `Math.min(Math.floor(n * q), n - 1)` — lands on the
 * last element for every n from 1 to MAX_HISTORY at q = 0.95, so `p95TotalMs` was the
 * maximum run at every sample count this buffer can hold, not a 95th percentile.
 * Interpolating between the two ranks that straddle the percentile is defined for
 * every n >= 1 and equals the maximum only when the maximum genuinely is the answer.
 *
 * At the sample counts a benchmark uses, p95 still leans hard on the top one or two
 * runs — read `p50TotalMs` for the centre and the pair for the spread.
 */
function percentile(sortedAsc: number[], q: number): number {
  const rank = (sortedAsc.length - 1) * q;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

export function getMetricsSummary(): MetricsSummary | null {
  if (_history.length === 0) return null;

  const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  const avg = (arr: number[]) => sum(arr) / arr.length;

  const totals = _history.map((h) => h.phases.total).sort((a, b) => a - b);

  const gainRuns = _history.filter((h) => h.shadowCoverageGainPp !== null);
  const deltaRuns = _history.filter((h) => h.pathLengthDeltaPct !== null);

  return {
    runs: _history.length,
    avgTotalMs: avg(totals),
    p50TotalMs: percentile(totals, 0.5),
    p95TotalMs: percentile(totals, 0.95),
    avgShadowSampleMs: avg(_history.map((h) => h.phases.shadowSample)),
    avgDijkstraMs: avg(_history.map((h) => h.phases.dijkstra)),
    avgShadowCoverageGainPp:
      gainRuns.length > 0 ? avg(gainRuns.map((h) => h.shadowCoverageGainPp!)) : null,
    avgPathLengthDeltaPct:
      deltaRuns.length > 0 ? avg(deltaRuns.map((h) => h.pathLengthDeltaPct!)) : null,
  };
}

/** Returns a copy of the raw run history (newest first). */
export function getRunHistory(): readonly RoutingRunMetrics[] {
  return _history;
}

/** Clears the history buffer (useful for tests, session resets, or between benchmark scenarios). */
export function clearMetrics(): void {
  _history.length = 0;
  publishMetricsToWindow();
}

// ── Helper: compute derived KPIs from route options ───────────────────────────

export function computeDerivedKpis(routes: RouteMetricSnapshot[]): {
  shadowCoverageGainPp: number | null;
  pathLengthDeltaPct: number | null;
} {
  if (routes.length < 2) {
    return { shadowCoverageGainPp: null, pathLengthDeltaPct: null };
  }
  // Shortest is always first (label "Shortest"), Most Shadowed is always last.
  const shortest = routes[0];
  const mostShadowed = routes[routes.length - 1];
  if (shortest === mostShadowed || shortest.distanceM === 0) {
    return { shadowCoverageGainPp: null, pathLengthDeltaPct: null };
  }
  return {
    shadowCoverageGainPp: (mostShadowed.shadowCoverage - shortest.shadowCoverage) * 100,
    pathLengthDeltaPct: ((mostShadowed.distanceM - shortest.distanceM) / shortest.distanceM) * 100,
  };
}

import { expect, type Page, test } from "@playwright/test";
import { SAMPLE_STEP, stubNetwork, type StubNetworkOptions } from "../helpers/scenario";
import { sampleMapCanvas, shadowMask, shadowedFraction } from "../helpers/map";
import { markdownTable, ms, pct, stats, type Stats } from "./stats";
import {
  COLD_REPEATS,
  FIVE_POINT_URL,
  TRANSIT_TWO_POINT_URL,
  TWO_POINT_URL,
  VIA_WAYPOINTS,
  WARM_REPEATS,
} from "./scenarios";

/**
 * G2 — the route benchmark.
 *
 * Nobody may claim a routing perf win without a number, and until this existed
 * there was no number: `docs/notes/performance-baseline.md` measured the bundle
 * and `sampleEdges` in Node, and said outright that end-to-end route calculation
 * was missing.
 *
 * **This measures and commits. It does not gate.** Failing a build on regression
 * is G3. It runs on demand — `npm run bench:route`, its own Playwright config —
 * and never in CI: a 2-core GitHub runner on SwiftShader is roughly 3x slower
 * than this machine, so a baseline collected there and a comparison collected
 * here would not be the same measurement.
 *
 * **Keyless only.** The `smoke-live` half of G1 exists to check MapTiler's real
 * building schema; putting real tile fetches inside a performance number puts
 * network variance inside a baseline instead.
 *
 * What is being timed is `useNavigation.calculateRoute` end to end, as the app's
 * own instrumentation reports it (`window.__umbraMetrics`) — graph fetch,
 * canvas read, shadow sampling and the Dijkstra/Pareto passes, with their phase
 * split. Two shapes, because they run different code:
 *
 * - **2-point** goes through `paretoRoutes`, the bi-criteria search.
 * - **5-point** goes through the per-segment branch, which runs a plain
 *   `dijkstra` per leg at several shadow strengths. It is a different algorithm,
 *   not a bigger version of the same one.
 *
 * A third shape, **transit 2-point**, runs the same bi-criteria walk search
 * over the ~950 m `TRANSIT_WAYPOINT` pair at the 500 m transit gate, where the
 * app fetches the transit graph and searches it per mode. Each transit
 * scenario names the dataset its stub serves: the 3-station smoke fixture, or
 * the seeded NYC-scale generator (~500 subway stations, ~16.4 k bus stops).
 *
 * The graph-fetch phase now splits into `navSnapshot` (pointer + manifest +
 * digest), `staticStreets` (street shards + adapter build, Overpass fallback
 * included) and `fieldReady` (the awaited field-readiness tail of the fetch
 * span). `graphFetch` stays the whole span for back-compat readers; the split
 * is what lets one decision gate a fix per phase.
 *
 * And two cache states: **cold** is the first calculation after a page load,
 * carrying the Overpass fetch and the first shadow build; **warm** reuses the
 * module-level graph cache in `overpass.ts`, which is what a user gets on every
 * calculation after their first.
 */

interface PhaseSample {
  graphFetch: number;
  /** Phase-0 graph-fetch attribution split — absent on runs recorded before it. */
  navSnapshot?: number;
  staticStreets?: number;
  fieldReady?: number;
  canvasRead: number;
  shadowSample: number;
  dijkstra: number;
  /** Phase-0 transit audit split — absent on runs recorded before it landed. */
  walkPareto?: number;
  transitFetch?: number;
  trainSearch?: number;
  trainSearchSubway?: number;
  trainSearchBus?: number;
  entrances?: number;
  walkLegs?: number;
  busWait?: number;
  /** Phase-0 static-build audit — the evidence the nav-static scenarios actually served. */
  nycStaticShare?: number;
  staticGeneration?: string | null;
  total: number;
  shadowFallbackShare: number;
}

interface AppSummary {
  runs: number;
  avgTotalMs: number;
  p50TotalMs: number;
  p95TotalMs: number;
}

interface ScenarioResult {
  name: string;
  samples: PhaseSample[];
  graphNodeCount: number;
  graphDirectedEdges: number;
  routeLabels: string[];
  /** Only warm scenarios have one: a reload wipes the app's history buffer. */
  appSummary: AppSummary | null;
}

const results: ScenarioResult[] = [];

/** Read the phase timings of every run the app has recorded, oldest first. */
async function readHistory(page: Page): Promise<PhaseSample[]> {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __umbraMetrics?: {
          history: {
            phases: Record<string, number>;
            shadowFallbackShare: number;
            buildingProviderShares?: Partial<Record<"tiles" | "overpass" | "nyc-static", number>>;
            staticBuildingGeneration?: string | null;
          }[];
        };
      }
    ).__umbraMetrics;
    if (!m) return [];
    // The buffer is newest-first; the benchmark wants chronological order.
    return [...m.history].reverse().map((h) => ({
      graphFetch: h.phases.graphFetch,
      navSnapshot: h.phases.navSnapshot ?? 0,
      staticStreets: h.phases.staticStreets ?? 0,
      fieldReady: h.phases.fieldReady ?? 0,
      canvasRead: h.phases.canvasRead,
      shadowSample: h.phases.shadowSample,
      dijkstra: h.phases.dijkstra,
      walkPareto: h.phases.walkPareto ?? 0,
      transitFetch: h.phases.transitFetch ?? 0,
      trainSearch: h.phases.trainSearch ?? 0,
      trainSearchSubway: h.phases.trainSearchSubway ?? 0,
      trainSearchBus: h.phases.trainSearchBus ?? 0,
      entrances: h.phases.entrances ?? 0,
      walkLegs: h.phases.walkLegs ?? 0,
      busWait: h.phases.busWait ?? 0,
      nycStaticShare: h.buildingProviderShares?.["nyc-static"] ?? 0,
      staticGeneration: h.staticBuildingGeneration ?? null,
      total: h.phases.total,
      shadowFallbackShare: h.shadowFallbackShare,
    }));
  });
}

async function readLatestShape(
  page: Page,
): Promise<{ graphNodeCount: number; graphDirectedEdges: number; routeLabels: string[] }> {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __umbraMetrics?: {
          latest: {
            graphNodeCount: number;
            graphDirectedEdges: number;
            routes: { label: string }[];
          } | null;
        };
      }
    ).__umbraMetrics;
    const latest = m?.latest;
    return {
      graphNodeCount: latest?.graphNodeCount ?? 0,
      graphDirectedEdges: latest?.graphDirectedEdges ?? 0,
      routeLabels: latest?.routes.map((r) => r.label) ?? [],
    };
  });
}

async function readAppSummary(page: Page): Promise<AppSummary | null> {
  return page.evaluate(() => {
    const m = (window as unknown as { __umbraMetrics?: { summary: AppSummary | null } })
      .__umbraMetrics;
    return m?.summary ?? null;
  });
}

async function clearAppMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __umbraMetrics?: { clearMetrics: () => void } }
    ).__umbraMetrics?.clearMetrics();
  });
}

/**
 * Load the app and wait until it is genuinely ready to route: the canvas is up
 * and the shadow field has stopped changing on its own. Timing a calculation
 * against a half-built shadow field would measure the load, not the route.
 */
async function loadAndSettle(
  page: Page,
  url: string,
  opts: StubNetworkOptions = { basemap: "fixture" },
): Promise<void> {
  await stubNetwork(page, opts);
  await page.goto(url);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();

  await expect
    .poll(async () => shadowedFraction(shadowMask(await sampleMapCanvas(page, SAMPLE_STEP))), {
      timeout: 90_000,
      message: "no shadow pixels ever appeared, so there was nothing to route against",
    })
    .toBeGreaterThan(0.02);

  let mask = shadowMask(await sampleMapCanvas(page, SAMPLE_STEP));
  await expect
    .poll(
      async () => {
        const next = shadowMask(await sampleMapCanvas(page, SAMPLE_STEP));
        const drift = next.filter((s, i) => s !== mask[i]).length / next.length;
        mask = next;
        return drift;
      },
      { timeout: 15_000, message: "the shadow field never settled" },
    )
    .toBeLessThan(0.005);
}

/** Click Find Shadowed Route and wait for the run count to advance by one. */
async function calculateOnce(page: Page, runsBefore: number): Promise<void> {
  await page.getByRole("button", { name: "Find Shadowed Route" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = (window as unknown as { __umbraMetrics?: { history: unknown[] } })
            .__umbraMetrics;
          return m?.history.length ?? 0;
        }),
      { timeout: 60_000, message: "a route calculation never completed" },
    )
    .toBe(runsBefore + 1);
}

/**
 * Cold: one page load per repeat. The Overpass graph cache lives in a module in
 * `overpass.ts`, so a reload is the only honest reset — clearing the metrics
 * buffer would leave the graph cached and quietly measure a warm run.
 */
async function benchCold(
  page: Page,
  name: string,
  url: string,
  repeats: number,
  opts: StubNetworkOptions = { basemap: "fixture" },
) {
  const samples: PhaseSample[] = [];
  let shape = { graphNodeCount: 0, graphDirectedEdges: 0, routeLabels: [] as string[] };

  for (let i = 0; i < repeats; i++) {
    await loadAndSettle(page, url, opts);
    await calculateOnce(page, 0);
    const history = await readHistory(page);
    expect(history, `${name}: expected exactly one run on a fresh page`).toHaveLength(1);
    samples.push(history[0]);
    shape = await readLatestShape(page);
  }

  results.push({ name, samples, ...shape, appSummary: null });
}

/**
 * Warm: one page load, one discarded warm-up calculation to populate the graph
 * cache, then `clearMetrics()` and the measured repeats. The reset is what #183
 * added — without it the warm-up's own timing sits inside the aggregate.
 */
async function benchWarm(
  page: Page,
  name: string,
  url: string,
  repeats: number,
  opts: StubNetworkOptions = { basemap: "fixture" },
) {
  await loadAndSettle(page, url, opts);
  await calculateOnce(page, 0); // warm-up: fetches and caches the graph
  await clearAppMetrics(page);

  for (let i = 0; i < repeats; i++) {
    await calculateOnce(page, i);
  }

  const samples = await readHistory(page);
  expect(samples, `${name}: metrics buffer did not hold every measured run`).toHaveLength(repeats);

  results.push({
    name,
    samples,
    ...(await readLatestShape(page)),
    appSummary: await readAppSummary(page),
  });
}

test.describe.configure({ mode: "serial" });

test("2-point, cache-cold", async ({ page }) => {
  await benchCold(page, "2-point cold", TWO_POINT_URL, COLD_REPEATS);
});

test("2-point, cache-warm", async ({ page }) => {
  await benchWarm(page, "2-point warm", TWO_POINT_URL, WARM_REPEATS);
});

test("5-point, cache-cold", async ({ page }) => {
  await benchCold(page, "5-point cold", FIVE_POINT_URL, COLD_REPEATS);
});

test("5-point, cache-warm", async ({ page }) => {
  await benchWarm(page, "5-point warm", FIVE_POINT_URL, WARM_REPEATS);
});

// Transit 2-point scenarios: the ~950 m TRANSIT_WAYPOINT pair crosses the
// 500 m gate the walk-only pair is deliberately under, so the transit branch
// runs. `fixture` exercises it on the 3-station smoke line and the seeded
// NYC-scale dataset exercises it at ~500 stations / ~16.4 k stops, with the
// bus-only showcase proving the bus search is not degenerate (the corridor
// answer). Repeat counts are the shared COLD/WARM constants, unchanged.
test("transit 2-point, fixture", async ({ page }) => {
  await benchCold(page, "transit-2pt fixture", TRANSIT_TWO_POINT_URL, COLD_REPEATS, {
    basemap: "fixture",
    transit: "fixture",
  });
});

test("transit 2-point, NYC-scale", async ({ page }) => {
  await benchCold(page, "transit-2pt NYC-scale", TRANSIT_TWO_POINT_URL, COLD_REPEATS, {
    basemap: "fixture",
    transit: "scale",
  });
});

test("transit 2-point, NYC-scale bus-only showcase", async ({ page }) => {
  await benchCold(page, "transit-2pt NYC-scale bus-only", TRANSIT_TWO_POINT_URL, COLD_REPEATS, {
    basemap: "fixture",
    transit: "scale-bus-only",
  });
});

test("transit 2-point, cache-warm", async ({ page }) => {
  await benchWarm(page, "transit-2pt warm", TRANSIT_TWO_POINT_URL, WARM_REPEATS, {
    basemap: "fixture",
    transit: "scale",
  });
});

// Nav-static scenarios (latency session A4): the same shapes as their keyless
// counterparts, with the published NYC navigation dataset configured and a
// seeded pointer → manifest → street/building shard fixture served behind it.
// Each row sits beside its committed keyless twin, so the difference between
// the two rows is the static path alone: `navSnapshot` (pointer + manifest +
// digest) and `staticStreets` (street shard bytes + verified adapter build,
// no Overpass fallback), with `fieldReady` carrying the static building
// prism load. The existing scenario set is deliberately untouched above.
test("nav-static 2-point, cache-cold", async ({ page }) => {
  await benchCold(page, "nav-static 2-pt cold", TWO_POINT_URL, COLD_REPEATS, {
    basemap: "fixture",
    navigation: "scale",
  });
});

test("nav-static 2-point, cache-warm", async ({ page }) => {
  await benchWarm(page, "nav-static 2-pt warm", TWO_POINT_URL, WARM_REPEATS, {
    basemap: "fixture",
    navigation: "scale",
  });
});

test("nav-static NYC-scale, cache-cold", async ({ page }) => {
  await benchCold(page, "nav-static NYC-scale", TRANSIT_TWO_POINT_URL, COLD_REPEATS, {
    basemap: "fixture",
    transit: "scale",
    navigation: "scale",
  });
});

test.afterAll(() => {
  if (results.length === 0) return;

  const totals = new Map<string, Stats>();
  for (const r of results) totals.set(r.name, stats(r.samples.map((s) => s.total)));

  const phaseRows = results.map((r) => {
    const phase = (pick: (s: PhaseSample) => number) => ms(stats(r.samples.map(pick)).p50);
    const t = totals.get(r.name)!;
    return [
      r.name,
      String(t.n),
      ms(t.p50),
      ms(t.p95),
      `±${pct(t.spreadPct)}%`,
      phase((s) => s.graphFetch),
      phase((s) => s.navSnapshot ?? 0),
      phase((s) => s.staticStreets ?? 0),
      phase((s) => s.fieldReady ?? 0),
      phase((s) => s.canvasRead),
      phase((s) => s.shadowSample),
      phase((s) => s.dijkstra),
      phase((s) => s.walkPareto ?? 0),
      phase((s) => s.transitFetch ?? 0),
      phase((s) => s.trainSearch ?? 0),
      phase((s) => s.entrances ?? 0),
      phase((s) => s.walkLegs ?? 0),
      phase((s) => s.busWait ?? 0),
    ];
  });

  console.log(
    `\n### Route calculation — ${new Date().toISOString().slice(0, 10)}\n\n` +
      markdownTable(
        [
          "Scenario",
          "N",
          "p50 total (ms)",
          "p95 total (ms)",
          "spread",
          "graph fetch",
          "nav snapshot",
          "static streets",
          "field ready",
          "canvas read",
          "shadow sample",
          "dijkstra",
          "walk pareto",
          "transit fetch",
          "train search",
          "entrances",
          "walk legs",
          "bus wait",
        ],
        phaseRows,
      ) +
      "\n\nPhase columns are medians in ms and do not sum to the total: the phases " +
      "are timed inside one wall-clock span that also covers work between them.\n",
  );

  for (const r of results) {
    const fallback = stats(r.samples.map((s) => s.shadowFallbackShare)).p50;
    console.log(
      `${r.name}: ${r.graphNodeCount} nodes, ${r.graphDirectedEdges} directed edges, ` +
        `routes [${r.routeLabels.join(", ")}], median canvas fallback ${pct(fallback * 100)}%`,
    );
    // Every run in order, not just the aggregate. A median hides the difference
    // between noise and a monotonic climb, and a warm scenario is a series of
    // calculations on one page — exactly where a climb would show up.
    console.log(`  totals in order: ${r.samples.map((s) => ms(s.total)).join(", ")}`);
    const fetchSum = (s: PhaseSample) =>
      (s.navSnapshot ?? 0) + (s.staticStreets ?? 0) + (s.fieldReady ?? 0);
    console.log(`  nav snapshot:    ${r.samples.map((s) => ms(s.navSnapshot ?? 0)).join(", ")}`);
    console.log(`  static streets:  ${r.samples.map((s) => ms(s.staticStreets ?? 0)).join(", ")}`);
    console.log(`  field ready:     ${r.samples.map((s) => ms(s.fieldReady ?? 0)).join(", ")}`);
    // The sum invariant: the three sub-phases attribute the graph-fetch span,
    // The three sub-phases attribute the graph-fetch span and never exceed it.
    // Post-A2-PR2 the field-ready tail no longer overlaps the street fetch:
    // exact edge cells are readied first, the broad fallback only when needed.
    const g = stats(r.samples.map((s) => s.graphFetch));
    const subSum = stats(r.samples.map(fetchSum));
    console.log(
      `  fetch sub-sum:   median ${ms(subSum.p50)} (< graphFetch median ${ms(g.p50)}; ` +
        `field ready: edge cells first, broad bbox fallback)`,
    );
    console.log(`  canvas read:     ${r.samples.map((s) => ms(s.canvasRead)).join(", ")}`);
    console.log(`  dijkstra:        ${r.samples.map((s) => ms(s.dijkstra)).join(", ")}`);
    console.log(`  walk pareto:     ${r.samples.map((s) => ms(s.walkPareto ?? 0)).join(", ")}`);
    console.log(`  transit fetch:   ${r.samples.map((s) => ms(s.transitFetch ?? 0)).join(", ")}`);
    console.log(`  train search:    ${r.samples.map((s) => ms(s.trainSearch ?? 0)).join(", ")}`);
    console.log(`  entrances:       ${r.samples.map((s) => ms(s.entrances ?? 0)).join(", ")}`);
    console.log(`  walk legs:       ${r.samples.map((s) => ms(s.walkLegs ?? 0)).join(", ")}`);
    console.log(`  bus wait:        ${r.samples.map((s) => ms(s.busWait ?? 0)).join(", ")}`);
    // Per-run, not just the median: "the pixel sampler answered no edges" is a
    // claim about every run, and a median of 0 is consistent with half of them
    // being non-zero. Whatever is asserted from this has to be readable here.
    console.log(
      `  fallback share:  ${r.samples.map((s) => pct(s.shadowFallbackShare * 100)).join("%, ")}%`,
    );
    // Whether the static dataset answered: A4's whole question is the real
    // shard path, so a zero share on a nav-static scenario is a broken stub
    // (or a silent fallback), and that has to be visible, not guessed.
    console.log(
      `  nyc-static share: ${r.samples.map((s) => pct((s.nycStaticShare ?? 0) * 100)).join("%, ")}%`,
    );
    console.log(
      `  static generation: ${r.samples.map((s) => s.staticGeneration ?? "…").join(", ")}`,
    );
  }

  // CLIMB: monotonic degradation across the warm series, as mean(last 3) /
  // mean(first 3) of the totals. A ratio near 1 is a flat series; the gating
  // table in the baseline note reads this against its 1.5 trigger.
  for (const r of results) {
    if (!r.appSummary) continue;
    const totalsInOrder = r.samples.map((s) => s.total);
    const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const climb = mean(totalsInOrder.slice(-3)) / mean(totalsInOrder.slice(0, 3));
    console.log(`  CLIMB ${r.name}: ${climb.toFixed(2)}`);
  }

  // The app's own summary and this harness must agree about the same runs. They
  // are two implementations of one percentile definition; if they ever drift,
  // the committed baseline and the number the app reports stop being comparable.
  for (const r of results) {
    if (!r.appSummary) continue;
    const t = totals.get(r.name)!;
    expect(r.appSummary.runs, `${r.name}: run count`).toBe(t.n);
    expect(
      r.appSummary.p50TotalMs,
      `${r.name}: p50 disagrees with window.__umbraMetrics`,
    ).toBeCloseTo(t.p50, 6);
    expect(
      r.appSummary.p95TotalMs,
      `${r.name}: p95 disagrees with window.__umbraMetrics`,
    ).toBeCloseTo(t.p95, 6);
  }

  console.log(
    `\nvia waypoints for the 5-point shape: ${VIA_WAYPOINTS.map((v) => v.join(",")).join(" ")}\n`,
  );
});

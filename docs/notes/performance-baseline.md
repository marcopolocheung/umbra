# Performance Baseline

Each section states its own date and commit — they were taken at different times.

Environment (unchanged across all of them):
- OS: WSL2 Linux `6.18.33.2-microsoft-standard-WSL2`
- Node: `v20.20.1`
- npm: `10.8.2`

## Build Artifacts

Measured on 2026-08-15 from branch `perf/baseline-metrics` at commit `dca020d`
after `npm run build`.

| Artifact | Raw bytes | Gzip bytes |
|---|---:|---:|
| `dist/assets/maplibre-EPPFnYTc.js` | 953234 | 256181 |
| `dist/assets/react-vendor-BE91f6Ds.js` | 229914 | 73158 |
| `dist/assets/index-BuiovaZN.js` | 156946 | 47483 |
| `dist/assets/MapView-BAZp6Pgx.js` | 48378 | 14638 |
| `dist/assets/agentLoop-BvVIQobA.js` | 18033 | 7239 |
| `dist/assets/earcut-Dbb6WtNR.js` | 9492 | 4155 |
| `dist/assets/sunPosition.worker-Cacf_Fkb.js` | 3587 | 1826 |
| `dist/assets/maplibre-B4QYLKPJ.css` | 69367 | 10003 |
| `dist/assets/index-Dl5krxH_.css` | 50098 | 9434 |
| `dist/index.html` | 1119 | 587 |
| `dist/sw.js` | 1772 | 652 |
| `dist/manifest.webmanifest` | 441 | 289 |

Total `dist/`: 1.6 MiB.

## Bundle — real timezones (D0)

Cost of replacing the longitude offset estimate with an IANA zone lookup, recorded because
D0's acceptance asks for it and G3 has no automated check yet. Reproduce with `npm run
build` and read the gzip column Vite prints.

Measured 2026-09-08, Node `v20.20.1`. **Before** is `main` at `4180e02`; **after** is
`feat/d0-real-timezones` (#204). Both built from a clean `npm ci` in the same environment.

| Artifact | Before (gzip) | After (gzip) | Change |
|---|---:|---:|---:|
| `index-*.js` | 65.55 kB | 66.22 kB | +0.67 kB |
| `MapView-*.js` | 17.39 kB | 17.41 kB | +0.02 kB |
| `agentLoop-*.js` | 6.63 kB | 6.67 kB | +0.04 kB |
| `tz-*.js` *(new, async)* | — | 29.60 kB | +29.60 kB |
| `maplibre-*.js`, `react-vendor-*.js` | unchanged | unchanged | 0 |

**The entry path grew by 0.67 kB gzip, not 30.** The boundary dataset is behind a dynamic
`import()` in `app/lib/tzLookup.ts`, so Rollup emits it as its own chunk that is fetched
after first paint. Nothing blocks on it: the app renders on a longitude estimate and
upgrades to the real zone when the chunk lands. The 0.67 kB is the loader plus the
`Intl`-based offset helpers in `timezone.ts`.

Method and accuracy trade-off: [`timezone.md`](./timezone.md).

## Route Calculation — static NYC navigation (Checkpoint 6)

Moved to [`nyc-navigation-checkpoint6-2026-09-20.md`](./nyc-navigation-checkpoint6-2026-09-20.md)
on 2026-09-20: the per-phase split of the static navigation path, cold/warm
static-vs-Overpass p50/p95 for the five fixed cases, shard byte/count records,
and the one tuning decision those measurements gate. Visible MapLibre
rendering is unchanged by that work.

## Shadow Sampling

`ShadowField.sampleEdges` — the call routing makes once per calculation, and the
hot path behind issue #122. Reproduce with `npm run bench`
(`UMBRA_BENCH_FULL=1` adds the city-scale case);
`app/lib/shadowField/__benchmarks__/shadowField.bench.ts` holds the fixtures.

Measured 2026-09-04 in the environment above, Node `v20.20.1`. **Before** is `main`
at `c2821f7`; **after** is `shadow/shadow-index` at `c6b21a1` (PR #164, the shadow
index). Both columns come from the same benchmark file, unmodified.

| Case | Before (mean) | After (mean) | Change |
|---|---:|---:|---:|
| 400 prisms × 200 edges | 691.5 ms ±0.9% | 0.66 ms ±2.3% | ~1,050× |
| 800 prisms × 200 edges | 1282.6 ms ±1.5% | 0.91 ms ±26.9% | ~1,410× |
| 1600 prisms × 200 edges | 2347.4 ms ±0.8% | 1.40 ms ±13.8% | ~1,670× |
| 400 prisms × 400 edges | 1366.8 ms ±1.2% | 1.27 ms ±13.8% | ~1,075× |
| 2000 prisms × 1000 edges | 13899.5 ms ±1.4% | 6.31 ms ±22.0% | ~2,200× |

8 iterations each, 3 for the last. Margins are Tinybench's relative margin of error.

**Read these numbers with four caveats.**

1. **They are warm-JIT, steady-state figures.** Tinybench warms up and then repeats,
   so the first `sampleEdges` call in a real browser session is slower than the table
   suggests on *both* sides. A cold single-shot pass on the same fixtures measured
   773 ms → 16 ms for 400 × 200; that is the same change viewed cold, not a
   contradiction.
2. **The wide margins on the "after" column are timer noise, not instability.** Those
   operations now run in about a millisecond, where GC and clock granularity dominate
   in relative terms. The before column is stable to ~1% and reproduced within 1%
   across two separate runs.
3. **The footprints are squares.** Four-vertex rings make `earcut` nearly free, so this
   understates triangulation cost against real tile or Overpass geometry. It affects
   both columns, so the comparison holds; the absolute numbers are optimistic.
4. **A full route graph is not measured here.** ~5,400 edges takes minutes per
   iteration on the pre-index code, which blocks the event loop past vitest's worker
   heartbeat and reports nothing. The 200-vs-400 edge pair is in the table to show the
   scaling is linear in edges, so a graph-scale estimate is a multiplication away.

## Time Sweep (A6)

`ShadowField.sweep` — the call Track D's hourly strip already makes and Track H's
traversal-time pricing will make N times per route. Same benchmark file as the
section above; the sweep cases are `ShadowField.sweep — a 3 km route across a day`.

Measured 2026-09-09 in the environment above but on **Node `v24.20.0`**, not the
`v20.20.1` in the header — the repo's `engines` field asks for 24, and 20 fails to
start nine jsdom test workers. **Before** is `main` at `cb85011`; **after** is
`feat/a6-time-sweep`. Both columns come from the same benchmark file, unmodified,
in the same session. 40 iterations, 10 warmup for the sweep cases, 8 for the rest.

| Case | Before (mean) | After (mean) | Change |
|---|---:|---:|---:|
| 3 km route, `sampleEdges`, one hour | 1.960 ms ±4.5% | 1.044 ms ±7.8% | 1.88× |
| 3 km route, `sampleEdges` × 14 hours | 33.44 ms ±1.3% | 21.00 ms ±2.2% | 1.59× |
| 3 km route, `sweep`, 14 hours | 34.42 ms ±3.3% | 21.86 ms ±3.4% | 1.57× |
| 400 prisms × 200 edges | 2.438 ms ±41.1% | 1.416 ms ±72.4% | *see below* |
| 800 prisms × 200 edges | 0.857 ms ±19.3% | 0.514 ms ±2.2% | 1.67× |
| 1600 prisms × 200 edges | 1.370 ms ±5.8% | 0.882 ms ±3.6% | 1.55× |
| 400 prisms × 400 edges | 1.337 ms ±14.5% | 1.176 ms ±13.7% | 1.14× |

The four caveats on the section above apply here unchanged — warm-JIT figures, wide
margins on sub-millisecond cases, square footprints, no full route graph. Two more:

- **`400 prisms × 200 edges` is the first case the runner executes and its margins say
  so** (±41% and ±72%). It is in the table because the section above lists it, not
  because the ratio means anything. Read the three stable rows.
- **Run-to-run spread on the headline cases is real.** An independent re-run of the
  same file in a fresh session gave 2.010 / 33.54 / 33.65 ms before and
  1.005 / 21.11 / 20.81 ms after — the same conclusion, with the sweep ratio landing
  at 20.7× instead of 20.9×. Treat the third digit as noise.

### A6's acceptance criterion is not met, and this is what it costs instead

A6's brief asks for *"a 14-hour sweep over a 3 km route costs < 2× a single-hour
sample"*. It costs **~21×** — `main` was ~17×, so the **ratio got worse while every
absolute number improved**, because the denominator sped up more than the numerator.
The ratio is the wrong instrument: it is optimised by making a single sample slower.

The mechanism, from a per-phase instrumentation of the sweep on the same fixture.
**That instrumentation is not in the tree** — it was `performance.now()` brackets
added temporarily around the four phases of `buildShadowIndexFor` and around the
per-sidewalk walk in `sampleEdgesWithSun`, then reverted. The absolute figures carry
its overhead and the shape is what to read, not the digits:

| Phase | Per 14-hour sweep, before | after |
|---|---:|---:|
| Prism preparation (ring bounds, flat ring, near cap, footprint grid) | — | ~1 ms, once |
| Shadow-bound scan + region filter | ~15 ms | ~1.5 ms |
| Triangulating the survivors | ~11 ms | ~7 ms |
| Shadow grid | ~0.5 ms | ~0.6 ms |
| **Point-in-shadow queries** | **~9.5 ms** | **~15.5 ms** |

Everything A6 could hoist was hoisted, and what is left is dominated by the point
queries — which are irreducibly per-hour, because the shadow moves. What sharing
remains is the batch plan, and it does not grow with the number of times: at graph
scale (1,000 edges, 2,000 prisms, 14 hours) `sweep` came out **0–11% faster** than 14
separate `sampleEdges` calls across three runs (52.8 vs 52.9, 50.2 vs 56.4, 52.2 vs
54.2 ms), and an independent run measured 10%. The preparation `sweep` shares is
memoised per prism set, so `sampleEdges` gets it too.

**Beating N× needs a different predicate, not more sharing** — see **#267** for the
design (per-(point, prism) angular intervals) and what it trades: the invariant that
the index answers *exactly* what `pointInPrismShadow` answered.

Three cheaper wins were measured and deliberately not taken:

- **A candidate-bounds short-circuit before the triangle pass — worth ~40%** of the
  sweep (23.3 ms → 13.4 ms). It fails `shadowIndex.test.ts`'s near-horizon case,
  because `pointInTriangleXY` reports containment outside a degenerate triangle's own
  bounds. That is **#163**, and fixing it is #163's call, not A6's. Filed as **#268**,
  which carries the exact three-line change so the number can be re-derived.
- **Sizing the shadow grid's cells below the mean shadow span — worth ~25%**
  (22.4 ms → 17.2 ms at a divisor of 4). Answer-preserving, but it speeds the per-hour
  and single-sample paths equally, so it does nothing for A6's ratio and belongs with
  whoever tunes #122's grid. Filed as **#269**, with the divisor sweep that produced it.
- **Reusing the near cap's triangulation for the far cap — worth ~11%** (22.2 ms →
  19.9 ms). The far cap is the near cap translated, so `earcut` returns the same
  indices — on 54,000 ring × sun combinations across the A3 corpus it always did, and
  **substituting one for the other passes the entire suite**, including the new
  vertex-for-vertex pin and a 296,000-point independent fuzz. That cuts both ways and
  is why it is not taken: no test in this repo can tell the two apart, so nothing would
  protect the property if `earcut`'s tie-breaking ever changed under a version bump.
  An observation across a corpus is not the same thing as `earcut` seeing byte-identical
  input, which is what every other float in this change rests on.

### What the sweep costs at sub-hourly resolution (#245)

A one-hour max-shadow window needs the shadow at several instants per displayed hour.
On the same 3 km fixture, `sweep` at 10-minute steps over the same 14 hours (84 times)
costs **6.9× the 14-hour sweep** across two runs, against a linear floor of 6.0×; an
independent run measured 6.3×. Whichever, the sweep is **linear in times**, so a window
is priced at its sub-sample count. Recorded because #245's case for adopting the window
was that A6 would make it nearly free.

### The sweep has no multi-time consumer in shipped code yet

`app/hooks/useHourlyExposure.ts:93` is the only `sweep` call site in `app/`, and it
passes **one** time — deliberately, so a long route's day does not block a frame. So
the realised win today is the ~1.9× on `sampleEdges`, which route calculation gets
directly. The N-time sharing is built for **H1**, and #270 records what H1 should
budget for it.

## Route Calculation (G2)

The measurement `Missing Measurements` below asked for, and the baseline **A5 must beat and
Track H must compare against**. Reproduce with:

```bash
export PATH="$HOME/.local/node24/bin:$PATH"     # Node 24 is not on the default PATH here
LD_LIBRARY_PATH=$HOME/miniconda3/lib npm run bench:route
```

It prints these tables ready to paste. It is **on demand, never in CI** — `npm run e2e` ignores
`e2e/bench/**`, and the benchmark has its own Playwright config. Regression *gating* is G3;
this checkpoint measures and commits.

**Environment — the baseline names the machine, because a comparison has to happen on one.**
WSL2 `6.18.33.2-microsoft-standard-WSL2`, 20 cores, 15 GiB, Node `v24.21.0`, npm `11.19.0`,
Playwright `1.63.0` driving Chromium headless on ANGLE/SwiftShader, viewport 1280x900,
`America/New_York`. A 2-core GitHub runner on the same software is roughly 3x slower
(`smoke` is ~17 s locally against ~50 s in CI), so **numbers taken there are not comparable
to these.** Take before and after on the same machine.

**Fixed conditions are G1's fixed conditions** (`e2e/helpers/scenario.ts`): midtown Manhattan
at z17, 09:00 on 2026-06-21, the `overpassGrid` 11x11 street stub, the fixture basemap. The
run is **keyless** — the `smoke` basemap, not `smoke-live`. Real MapTiler tiles would put
network variance inside a number meant to be a baseline; the cost is that everything below
is measured against synthetic buildings.

Measured 2026-09-09 on branch `feat/g2-route-benchmark`. Timings come from the app's own
`window.__umbraMetrics`, so the benchmark reports the same numbers the product does.
**Every figure below is verbatim harness output from one code version** — three consecutive
full runs, all four scenarios each. The table is the first of the three; the other two are in
the reproducibility section, and nothing here is re-rounded by hand.

| Scenario | N | p50 total (ms) | p95 total (ms) | spread | graph fetch | canvas read | shadow sample | dijkstra |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 2563.9 | 2789.7 | ±9.3% | 17.8 | 1194.8 | 40.2 | 13.6 |
| 2-point warm | 10 | 3852.4 | 4070.4 | ±16.6% | 0.3 | 2164.3 | 22.0 | 6.6 |
| 5-point cold | 5 | 3211.8 | 3537.7 | ±25.8% | 18.4 | 1224.5 | 59.1 | 719.6 |
| 5-point warm | 10 | 5685.7 | 6266.6 | ±13.0% | 0.4 | 2084.2 | 61.0 | 1673.3 |

Phase columns are medians in ms. **They do not sum to the total** — the phases are timed
inside one wall-clock span that also covers the camera settle, graph rebuild and route
assembly between them.

**Graph shape, and a parity check on the sweep's fixture.** The app reports 440 directed edges
for both shapes, and 123 nodes (2-point) or 126 (5-point) — 121 grid nodes plus one virtual
snap node per waypoint. The sweep's constructed graph
(`e2e/fixtures/overpassGrid.ts:overpassGridGraph`) produces 121 nodes and the same 440 directed
edges, from 11 rows x 10 plus 11 columns x 10 undirected segments. That is the check the
fixture's docstring promises, recorded here so a reader can make it.

**Variance, stated.** `spread` is half the p95−p5 span as a share of the median, over the runs
*within* one scenario. Cold repeats cost a full page load each (the map must paint and the
shadow field must settle before a calculation means anything), so there are 5 of them against
10 warm; the smaller N is why cold spread is the looser figure. **Flake budget: zero retries.**
A benchmark that silently re-ran a bad sample would publish the luckier of two runs.

**Cold** is the first calculation after a page load and carries the Overpass fetch. **Warm**
reuses the module-level graph cache in `overpass.ts` — one discarded warm-up calculation, then
`clearMetrics()`, then the measured runs on the same page.

### Reproducibility — and a warning about it

Three consecutive full runs. `span` is **(max − min) ÷ median of the three run medians**;
every value comes from that one formula.

| Scenario | p50 across the three runs | span |
|---|---|---:|
| 2-point cold | 2563.9 / 2514.8 / 2348.3 | 8.6% |
| 2-point warm | 3852.4 / 3454.2 / 3074.5 | 22.5% |
| 5-point cold | 3211.8 / 2872.3 / 3070.4 | 11.1% |
| 5-point warm | 5685.7 / 5746.3 / 5612.1 | 2.4% |

**Do not read a ranking out of this table.** An earlier session of three runs, on the same
machine and the same code path, produced almost the opposite ordering — 2-point tight and
5-point cold loose. Three runs is far too few to estimate a run-to-run span, and the estimate
itself moves more than the thing it is estimating. The defensible statement is the range:
**across-session spans land between ~2% and ~25% on every row**, so **treat any before/after
movement under about 25% as noise on all four scenarios** until someone runs enough sessions
to say better. A5 and H should either clear that bar comfortably or raise the repeat counts
first.

### Four things this baseline says

**1. Warm is *slower* than cold, and the graph cache is not the story.** The cache works —
graph fetch falls from ~15 ms to ~0.3 ms — but that saves ~15 ms against a several-hundred-ms
rise in the canvas read. It held in all six comparisons: 2-point warm/cold was 1.50x, 1.37x,
1.31x across the three runs and 5-point 1.77x, 2.00x, 1.83x. Anyone quoting "cached route
calculation" as the fast path should quote the warm row, not the cold one.

**It is a level shift, not a leak**, and the per-run series is printed so that is checkable
rather than asserted. Neither warm shape climbs across its ten runs — run 1's 2-point warm
totals were 3912.7, 3142.9, 3961.7, 3576.6, 4159.4, 3792.0, 3959.0, 3956.6, 3615.0, 2497.7
(the *smallest* is last), and its 5-point warm totals were 5404.5, 6122.5, 5965.9, 6206.0,
6316.2, 5144.2, 5722.0, 4497.1, 5602.8, 5649.4. **Why** the level shifts is not established:
"a page that has already drawn a route reads back a busier canvas" is a hypothesis, and no
controlled variant — a warm run with the route layer removed — was measured.

**2. The canvas read is a third to well over half of route latency, and on this fixture it is
spent for nothing.** As a share of the scenario median it ran 33.3%–58.0% across the twelve
scenario-runs, highest on 2-point warm and lowest on 5-point warm; in absolute terms
1136–2164 ms. `canvasRead` was non-zero on **all 90 runs**, so `coverage()` returned confidence
below `LOW_CONFIDENCE` every time and `useNavigation` took the `needsCanvas` branch — while
`shadowFallbackShare` printed **0.0% on all 90**, meaning `sampleEdges` then answered every edge
from geometry and the pixels were used for nothing. Both halves are per-run output, not a
median: the harness prints the fallback share for every run precisely because a median of 0.0
is consistent with half the runs being non-zero. Filed as **#259**. Unverified against real
MapTiler tiles — the benchmark is keyless by decision, so this may be a property of the
fixture's geojson `maptiler_planet` source rather than of the app.

**3. Dijkstra is not the bottleneck on 2-point routes.** 3–18 ms against a ~3 s total across
all thirty 2-point runs. A5's worker offload moves the main-thread block, and the block is the
canvas read, not the search.

**4. The 5-point shape is a different algorithm, not a bigger one.** With `via` waypoints
`useNavigation` leaves `paretoRoutes` and runs a plain `dijkstra` per leg at several shadow
strengths, which is why its dijkstra phase is two orders of magnitude larger (320–2690 ms) and
why it returns a single route (`[Shortest]`) with no shadow-gain KPI at all.

### A8 follow-up — cell readiness and dedicated building-mask fallback

Measured 2026-09-11 after the time-aware canopy work, on the same machine and fixed G1
fixture. The command targeted `e2e/bench/routeCalc.bench.spec.ts` explicitly after the initial
`bench:route` invocation exposed that its config also discovered the live canopy COG specs;
the canopy harness cannot load under the route benchmark's preview server and timed out
before the route spec began. The config is now scoped to the route and detour specs, while
live canopy measurements remain under `bench:canopy`. This table is one complete, zero-retry
route-harness run and should be read against the 2–25% cross-session noise warning above.

| Scenario | N | p50 total (ms) | p95 total (ms) | spread | graph fetch/readiness | composited canvas read | shadow sample | dijkstra |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 983.3 | 1018.7 | ±2.3% | 935.8 | 0.0 | 20.9 | 32.3 |
| 2-point warm | 10 | 473.2 | 1012.8 | ±96.0% | 433.8 | 0.0 | 17.2 | 17.3 |
| 5-point cold | 5 | 2395.6 | 2488.9 | ±24.3% | 928.2 | 0.0 | 27.7 | 1411.3 |
| 5-point warm | 10 | 8357.2 | 10637.3 | ±45.6% | 2869.8 | 0.0 | 1298.9 | 3233.6 |

The common 2-point path clears A8's acceptance threshold: cold median latency moved from
2563.9 to 983.3 ms (**61.6% lower**) and warm from 3852.4 to 473.2 ms (**87.7% lower**),
both comfortably beyond the benchmark's 25% noise floor. `canvasRead` was exactly 0.0 ms
on all 30 calculations, and the median fallback share was 0.0% in every scenario. A genuine
low-confidence fallback now reads the renderer's building-only mask and records that time in
`dedicatedMaskRead`; canopy, water, static fill and basemap colours cannot enter that sample.

The five-point warm result is a regression and highly variable, not a claimed win: its median
moved from 5685.7 to 8357.2 ms and its within-run spread was ±45.6%. That branch repeatedly
runs the per-leg Dijkstra path and should be profiled separately before any five-point
performance claim. It does not change the stated A8 gate, which names common two-point routes.

### Detour budget sweep (#243)

`paretoRoutes` prunes any label whose optimistic length exceeds
`shortestDist × maxDetourFactor + 250 m`. `maxDetourFactor` defaults to **2.0** — a route
twice as long as the direct one. Three independent studies
([literature note](../research/shadow-thermal-comfort-literature-2026-09-09.md)) find useful
shadow detours at +1.3%, under 3%, and plateauing near 110%.

**This publishes the curve; it does not change the constant.** #243 is labelled `track-h`, and
H3 picks a value against the measured cost.

Same fixture grid and instant, 8 fixed O-D pairs, 5 repeats each, 20.7% mean sidewalk shadow.
The sweep runs in **Node against `paretoRoutes` directly**, because `maxDetourFactor` is a
`DijkstraOptions` field that `useNavigation` never passes — varying it from the browser would
mean adding a production seam the benchmark has no business adding. So this is the **search
alone**: no fetch, no canvas read, no sampling, and the whole 11x11 grid rather than the bbox
the app fetches. Comparable across rows, **not** against the totals above.

| maxDetourFactor | p50 search (ms) | p95 search (ms) | mean shadow gain (pp) | mean length overhead (%) | pairs with an alternative |
|---|---:|---:|---:|---:|---:|
| 1.05 | 0.5 | 1.2 | 4.9 | 13.7 | 7/8 |
| 1.10 | 0.4 | 1.3 | 5.7 | 17.6 | 8/8 |
| 1.25 | 0.4 | 2.1 | 6.0 | 18.8 | 8/8 |
| 1.50 | 0.9 | 3.4 | 8.6 | 42.7 | 8/8 |
| **2.0** (current) | 1.4 | 4.2 | 11.8 | 79.5 | 8/8 |
| 3.00 | 3.4 | 5.8 | 13.8 | 130.0 | 8/8 |

**The four quality columns are byte-identical across all three runs** — the search is
deterministic, and only the timing columns move (the 2.0 row's p50 read 1.4, 1.5 and 1.1 ms).
So the shape of this curve is a far more solid result than any single latency figure above it.

**What the curve costs and buys.** Between 1.10 and 1.25 the budget buys 0.3 pp of shadow for
1.2 pp of extra walking — nearly free. Between 1.25 and the current 2.0 it buys **5.8 pp of
shadow for 60.7 pp of extra walking** and roughly triples the search time. At 3.0 the mean
shadowed route is 130% longer than the shortest one, which is not a route anybody walks.

**Read this as a shape, not as a recommendation.** The grid is regular by construction and the
buildings are synthetic, which is what isolates the parameter and also why the absolute
percentages are not about real Manhattan. Two further caveats H3 has to carry: `shadowCoverage`
is a blue-pixel-derived fraction with tens of percentage points of worst-case uncertainty, and
**#241** reports that minimising unshadowed metres scored worse than the plain shortest route in
24% of 1200 real O-D pairs — so "more shadow gain" in this table is not the same claim as
"better route".

**Not measured: TTI.** #37 asks for throttled-4G time-to-interactive *and* route-calc timings.
G2's acceptance names route calculation only, and TTI is still outstanding — see the section
below, which is now accurate about TTI alone.

## Missing Measurements

The backlog (#37) asks for throttled-4G time-to-interactive **and** representative
2-point and 5-point route calculation timings. **The route timings are now recorded
above** — that was G2. **TTI is still missing**, and deliberately: G2's acceptance
names route calculation only, and half-measuring a time-to-interactive number is
worse than saying it is outstanding.

The reason originally given here — no browser automation binary — is stale twice
over. Playwright Chromium runs on this machine (`LD_LIBRARY_PATH=$HOME/miniconda3/lib`),
and since G1 the repo owns a browser setup that runs in CI. What TTI still needs is
a throttling profile and a definition of "interactive" for a map that keeps painting
after first render; neither is inherited from the route benchmark.

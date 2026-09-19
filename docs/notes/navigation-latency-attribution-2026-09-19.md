# Navigation Latency Attribution (Phase 0) — 2026-09-19

Attribution + committed numbers for every phase of a route calculation at NYC
scale, and the exact fix decision each number gates. **This measures and
commits; it does not gate** — the same G2 convention as
`performance-baseline.md`, whose environment and method this note reuses
verbatim. No routing constants or behaviors changed; the experiments turn PR
445's phase split into a decision-driving measurement system.

Measured on branch `perf/latency-attribution` at commit ``2ca10b1`` (PR 445's
instrumentation top cherry-picked onto `main` at ``48ee4d2` (#446)`), run from a
worktree of `ShadeMapNavigation` and performed with the repo's `npm run
bench:route` exactly as described in
[`performance-baseline.md`](./performance-baseline.md#route-calculation-g2),
except that this run needed no `LD_LIBRARY_PATH` overlay:

```bash
export PATH="$HOME/.local/node24/bin:$PATH"     # Node 24 is not on the default PATH here
npm run bench:route                              # x3, back to back, unchanged code
```

The three pass logs (including the per-run phase sequences) are not committed;
what follows is their verbatim aggregation.

## Environment & method

WSL2 marcopolo (`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node `v24.21.0` (`~/.local/node24/bin`, the G2 baseline's environment; no v20 fallback was needed), npm `11.19.0`, Playwright
`1.63.0` driving Chromium headless on ANGLE/SwiftShader, viewport 1280x900,
`America/New_York`. Fixed conditions are G1's fixed conditions
(`e2e/helpers/scenario.ts`): midtown Manhattan at z17, 09:00 on 2026-06-21, the
`overpassGrid` 11x11 street stub, the fixture basemap, keyless.

**SwiftShader absolute numbers are trend-only.** A 2-core GitHub runner on the
same software is roughly 3x slower, and a deployed machine renders on real
hardware — these numbers name *this box*, and only ratios and phase deltas
travel. Every figure below is verbatim harness output; the reported p50 is the
median of three consecutive suite passes (p95/spread columns come with the
table), and any scenario whose p50 spread across passes exceeds 40% gets a
fourth pass quoted alongside it.

## Route calculation — three consecutive suite passes

| Scenario | N | p50 total (ms) | p95 total (ms) | spread | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 973.5 | 1022.4 | ±40.0% | 925.2 | 0.0 | 15.4 | 910.3 | 0.0 | 22.6 | 32.7 | 29.4 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 2-point warm | 10 | 478.3 | 989.2 | ±81.7% | 435.5 | 0.0 | 0.3 | 434.3 | 0.0 | 18.6 | 18.7 | 16.7 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point cold | 5 | 1956.7 | 2363.7 | ±30.5% | 930.3 | 0.1 | 14.2 | 918.2 | 0.0 | 30.5 | 987.2 | 981.5 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point warm | 10 | 8467.1 | 10620.4 | ±32.7% | 2853.1 | 0.1 | 0.3 | 2852.0 | 0.0 | 1140.2 | 4485.1 | 4480.5 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| transit-2pt fixture | 5 | 1038.1 | 1073.6 | ±37.2% | 933.3 | 0.1 | 13.2 | 917.4 | 0.0 | 27.8 | 33.5 | 29.3 | 32.1 | 0.6 | 0.1 | 0.4 | 0.0 |
| transit-2pt NYC-scale | 5 | 1115.0 | 1170.0 | ±3.4% | 927.5 | 0.0 | 12.6 | 915.0 | 0.0 | 31.4 | 40.2 | 35.0 | 111.9 | 8.8 | 0.1 | 1.0 | 0.2 |
| transit-2pt NYC-scale bus-only | 5 | 1096.0 | 1152.0 | ±2.9% | 928.8 | 0.0 | 12.3 | 913.0 | 0.0 | 31.2 | 35.6 | 30.3 | 97.2 | 5.6 | 0.1 | 0.8 | 0.2 |
| transit-2pt warm | 10 | 603.7 | 1011.4 | ±49.1% | 527.7 | 0.0 | 0.3 | 526.8 | 0.0 | 17.1 | 18.1 | 16.9 | 15.4 | 4.6 | 0.1 | 0.6 | 0.2 |

Phase columns are medians in ms (median of the three passes for the headline
row). `graphFetch` is the whole `tFetch` span, kept for back-compat readers; its
new sub-phases attribute it: `navSnapshot` (pointer + manifest + digest),
`staticStreets` (street shards + adapter build; Overpass fallback accrues here
too), `fieldReady` (the awaited `broadPreload`/`field.readyEdges` tail — it
overlaps `staticStreets` by construction, so the three never sum past
`graphFetch`). Transit scenarios ride the ~950 m `TRANSIT_WAYPOINT` pair (the
walk-only pair is deliberately under the 500 m transit gate); `NYC-scale`
serves the seeded generator (506 subway stations / 638 states, 16,390 bus
stops), `bus-only` serves only the bus shards, where the 12-stop corridor line
is the answer that keeps `trainSearchBus` non-degenerate.

| Scenario | pass A p50 (ms) | pass B p50 (ms) | pass C p50 (ms) | cross-pass spread |
|---|---:|---:|---:|---:|
| 2-point cold | 973.5 | 973.5 | 998.6 | ±1.3% |
| 2-point warm | 469.6 | 478.3 | 773.4 | ±31.8% |
| 5-point cold | 1227.7 | 1956.7 | 2203.8 | ±24.9% |
| 5-point warm | 8657.9 | 8467.1 | 8443.8 | ±1.3% |
| transit-2pt fixture | 1039.6 | 1034.5 | 1038.1 | ±0.2% |
| transit-2pt NYC-scale | 1129.8 | 450.9 | 1115.0 | ±30.4% |
| transit-2pt NYC-scale bus-only | 1106.2 | 1087.7 | 1096.0 | ±0.8% |
| transit-2pt warm | 961.1 | 603.7 | 537.2 | ±35.1% |

Cross-pass spread is half the (max−min) range of the three p50s as a share of
their median — the same definition the in-scenario `spread` column uses. **No
scenario exceeded the 40% bar**, so the protocol's fourth pass was not needed.
`transit-2pt NYC-scale` at 450.9 in pass B is the field-ready bimodality below,
not a different scenario: three of its five cold loads landed on the cheap side
of the readiness coin.

Plain walk calculations leave every transit phase at 0 — the canonical
two/five-point pairs are deliberately below the 500 m transit gate, which is
why the `transit-2pt` scenarios exist.

| Warm scenario | pass A | pass B | pass C | median |
|---|---:|---:|---:|---:|
| 2-point warm | 0.79 | 0.54 | 1.03 | 0.79 |
| 5-point warm | 0.94 | 1.05 | 1.10 | 1.05 |
| transit-2pt warm | 0.48 | 1.43 | 0.99 | 0.99 |

CLIMB = mean of the last 3 warm totals over the mean of the first 3. No
scenario reaches the 1.5 trigger. The 5-point series is not monotonic — it
oscillates between a ~3.4–7 s floor and ~9–11 s peaks run to run, so the ratio
alone understates the instability; the per-run sequences are in the pass logs.
The same field-ready bimodality explains the transit-2pt warm oscillation.

## Node scale matrix (`npm run bench`, `app/lib/__benchmarks__/navigationScale.bench.ts`)

Search compute only, no fetch; the fixtures are the same seeded synthetic city
the browser bench loads. 8–20 iterations per case, Tinybench warm-JIT figures (the 121-node pareto case
runs first and its ±111% margin is first-case noise, not the case).

| Case | Mean | Margin |
|---|---:|---:|
| `paretoRoutes` 2-point, 121 nodes | 7.15 ms | ±110.9% |
| `paretoRoutes` 2-point, 4,600 nodes | 484.3 ms | ±2.6% |
| `paretoRoutes` 2-point, **16,800 nodes** | **2434.6 ms** | ±3.3% |
| per-leg 12-pass loop, 121 nodes | 0.48 ms | ±4.7% |
| per-leg 12-pass loop, 4,600 nodes | 9.50 ms | ±2.7% |
| per-leg 12-pass loop, 16,800 nodes | 49.6 ms | ±2.4% |
| `reachableFrom`, 16,800 nodes (whole grid) | 3.58 ms | ±3.6% |
| `findBestTrainRoute` subway, city-crossing (506 stations, 638 states) | 51.4 ms | ±3.8% |
| `findBestTrainRoute` bus, no corridor in range (16,390 stops, null answer) | 3.23 ms | ±11.2% |
| `findBestTrainRoute` bus, corridor answer (16,390 stops in graph) | 3.39 ms | ±2.0% |
| `findBestTrainRoute` combined, both modes (16,896 stations) | 56.8 ms | ±3.4% |
| trainSearch 25 pair-wise (as shipped), city-crossing | 51.9 ms | ±1.5% |
| trainSearch one-entry-per-search (replicated locally) | 9.55 ms | ±1.9% |

The one-entry-per-search replication prices the same city-crossing trip to
within floating-point equality of the pair-wise baseline, and is **5.4×
faster**. The subway city-crossing search runs ~50 ms in Node; the browser's
`trainSearch` phase at the ~950 m waypoint pair costs 8.8 ms because the
fixture's candidates there are chain neighbours (short trip, short search), not
a city crossing.

## What each number gates (specification table)

| Phase | Trigger (median, NYC-scale) | Gated fix / next experiment |
|---|---|---|
| `navSnapshot` + `staticStreets` | ≥ 800 ms | Cache street shards + built routing graph per generation and shard selection; revisit digest work. |
| `fieldReady` | ≥ 600 ms | Move shadow-field materialization off the route path (page-load prewarm per generation, readiness cache, narrower bbox/cells). |
| 5-pt `dijkstra`/leg span | ≥ 2 s while the Node leg loop at same graph ≤ 30 ms | Strip per-leg progress/preview work: one progress update per pass, one preview render, batched yields, avoid per-pass map churn. |
| `paretoRoutes` scale row | ≥ 300 ms at 16.8 k | Sweep `maxDetourFactor` + label caps at city scale (grid detour-sweep precedent); pick budget by the published curve, not a constant. |
| `trainSearch` | ≥ 200 ms | Replace 25 pair-wise searches with one-per-entry (measured ~5x) and run subway/bus modes concurrently; skip a mode with zero in-bbox stations. |
| `CLIMB` in any warm scenario | ≥ 1.5 | Block optimization work on a GC/accumulation audit. |

| Phase | Measured (median, NYC-scale) | Trigger | Decision |
|---|---|---|---|
| `navSnapshot` + `staticStreets` | 0.0 + 12.6 ms | ≥ 800 ms | **Not triggered — and not measurable yet.** The keyless bench never configures `VITE_NAVIGATION_BASE`, so these numbers are the unconfigured snapshot and the Overpass homologue of the static path, not the NYC static shard bytes + digest. Next experiment: wire a static street-shard stub into the bench before this row can gate. |
| `fieldReady` | 915.0 ms (transit NYC-scale), 2852.0 ms (5-pt warm) | ≥ 600 ms | **Triggered.** Field readiness waits dominate the graph-fetch span: ~910 ms median on every cold/first-shadow run, ~2.9 s on 5-pt warm, with a bimodal cheap side of ~340–560 ms. Proceed with moving shadow-field materialization off the route path (page-load prewarm per generation, readiness cache, narrower bbox/cells). |
| 5-pt `dijkstra`/leg span | 4485.1 ms; Node 12-pass loop at the same 121-node graph = 0.48 ms | ≥ 2 s and ≤ 30 ms | **Triggered.** The browser pays ~4.5 s for a loop the search itself does in half a millisecond. Proceed with stripping per-leg progress/preview work: one progress update per pass, one preview render, batched yields, no per-pass map churn. |
| `paretoRoutes` scale row | 484.3 ms at 4.6 k, 2434.6 ms at 16.8 k | ≥ 300 ms at 16.8 k | **Triggered.** The bi-criteria walk search is superlinear in graph size. Proceed with the `maxDetourFactor` + label-cap sweep at city scale; pick the budget from the published curve, not a constant. |
| `trainSearch` | 8.8 ms browser (NYC-scale, 2-pt); 56.8 ms Node combined city-crossing | ≥ 200 ms | **Not triggered.** The one-entry-per-search rewrite is measured at 5.4× (51.9 → 9.6 ms) and the zero-in-bbox bus scan costs 3.2 ms — kept as magazine, not scheduled. |
| `CLIMB` in any warm scenario | 0.79 / 1.05 / 0.99 medians | ≥ 1.5 | **Not triggered.** No scenario is monotone-climbing, but the 5-pt warm series still swings 3.4–11.3 s run to run — it is variance, not accumulation, and the field-ready bimodality is its largest source. No GC/accumulation audit is gated. |

## Assumptions & caveats

- **Synthetic fixtures approximate NYC shapes.** Production-real shard
  snapshots are deliberately deferred until the #442–444 wire shape
  stabilizes; the seeded generator pins counts and geometry facts in
  `app/lib/transit/__tests__/transitShardFixture.test.ts`.
- **The bus fixture answers from a corridor by construction**, because the
  published bus shards ship no transfers and refuse spatial stubs — a bus
  answer exists only where one route runs from near origin to near
  destination. The fixture makes that one route exist.
- **Node version:** the repo `engines` asks for Node 24; this box runs
  `v24.21.0` from `~/.local/node24/bin` (the G2 baseline's environment). See
  the note body if a pass had to fall back to the v20 system Node.
- Routing behavior is byte-identical: `routing.test.ts` and the full vitest
  suite are unchanged, and the changes live only in timing brackets, metrics
  types, fixtures, and bench specs.

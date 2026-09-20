# A2 — shadow-field readiness off the route path (PR 1) — 2026-09-19

Session A2 PR 1 from `docs/handoffs/LATENCY_ATTRIBUTION_SESSIONS.md`: the
page-load prewarm per generation plus the generation/bbox readiness cache.
The narrower edge-cell area (PR 2) follows this PR, off `main` after it merges,
so the cache win and the shrink win stay separately attributable.

**Before** is `main` at `6726646` (rain-map-layer merge, A1 already landed);
**after** is `feat/a2-field-ready-off-path` at `f5da0bb`. Both measured in the
same session, on the same machine, three consecutive `npm run bench:route`
passes each.

## Environment & method

WSL2 marcopolo (`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node
`v24.21.0` (`~/.local/node24/bin`), npm `11.19.0`, Playwright `1.63.0`
driving Chromium headless on ANGLE/SwiftShader, viewport 1280×900,
`America/New_York`. Fixed conditions are G1's
(`e2e/helpers/scenario.ts`): midtown Manhattan at z17, 09:00 on 2026-06-21,
the `overpassGrid` 11×11 street stub, the fixture basemap, keyless. Same
protocol as `performance-baseline.md` and the Phase-0 note: report the median
of the three p50s plus the printed p95/spread, quote the per-run sequences, and
a fourth pass only if a cross-pass p50 spread exceeds 40% (none did).

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
npm run bench:route          # x3 before, x3 after, back to back, unchanged code
```

## Route calculation — three consecutive suite passes

| Scenario | N | p50 total | p95 total | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 1000.7 | 1025.5 | 929.6 | 0.0 | 12.6 | 918.9 | 0.0 | 22.7 | 39.7 | 33.9 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 2-point warm | 10 | 557.0 | 996.9 | 510.3 | 0.0 | 0.3 | 509.5 | 0.0 | 15.7 | 18.5 | 17.3 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point cold | 5 | 987.7 | 1025.4 | 924.6 | 0.1 | 12.0 | 914.5 | 0.0 | 31.0 | 11.6 | 4.4 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point warm | 10 | 4420.8 | 5965.6 | 2722.2 | 0.1 | 0.3 | 2721.0 | 0.0 | 1223.4 | 3.6 | 1.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| transit-2pt fixture | 5 | 1028.1 | 1072.3 | 928.8 | 0.1 | 16.7 | 915.3 | 0.0 | 27.8 | 36.5 | 33.1 | 29.9 | 0.5 | 0.1 | 0.3 | 0.0 |
| transit-2pt NYC-scale | 5 | 1112.3 | 1181.8 | 933.4 | 0.0 | 11.9 | 920.3 | 0.0 | 29.5 | 31.4 | 26.8 | 112.7 | 9.5 | 0.2 | 1.4 | 0.2 |
| transit-2pt NYC-scale bus-only | 5 | 1100.6 | 1157.7 | 929.3 | 0.0 | 11.7 | 915.9 | 0.0 | 28.4 | 38.9 | 33.3 | 97.7 | 5.2 | 0.1 | 0.7 | 0.2 |
| transit-2pt warm | 10 | 968.4 | 1025.4 | 922.3 | 0.0 | 0.4 | 921.0 | 0.0 | 14.1 | 21.0 | 19.4 | 16.1 | 5.7 | 0.0 | 0.7 | 0.1 |

— measured before the A2 PR, on `main` at `6726646`.

| Scenario | N | p50 total | p95 total | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 995.9 | 1031.7 | 925.3 | 0.0 | 11.6 | 915.1 | 0.0 | 24.9 | 39.2 | 33.8 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 2-point warm | 10 | 48.0 | 91.4 | 1.0 | 0.0 | 0.2 | 0.3 | 0.0 | 20.2 | 21.2 | 19.9 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point cold | 5 | 986.2 | 1030.1 | 928.1 | 0.1 | 15.5 | 915.5 | 0.0 | 26.6 | 10.4 | 3.6 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point warm | 10 | 1880.1 | 2496.0 | 1.0 | 0.0 | 0.2 | 0.3 | 0.0 | 849.2 | 3.1 | 0.8 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| transit-2pt fixture | 5 | 1036.4 | 1066.8 | 930.4 | 0.0 | 15.8 | 908.1 | 0.0 | 25.4 | 38.9 | 32.9 | 37.0 | 0.4 | 0.1 | 0.4 | 0.0 |
| transit-2pt NYC-scale | 5 | 1121.9 | 1141.7 | 926.3 | 0.0 | 12.2 | 914.7 | 0.0 | 29.7 | 36.5 | 33.6 | 111.6 | 8.8 | 0.2 | 1.4 | 0.2 |
| transit-2pt NYC-scale bus-only | 5 | 1096.1 | 1137.9 | 926.1 | 0.0 | 12.3 | 915.5 | 0.0 | 26.7 | 36.8 | 32.8 | 100.4 | 5.3 | 0.2 | 0.7 | 0.2 |
| transit-2pt warm | 10 | 67.7 | 121.8 | 1.3 | 0.0 | 0.3 | 0.3 | 0.0 | 24.1 | 13.4 | 12.0 | 19.4 | 4.7 | 0.0 | 0.7 | 0.1 |

— measured after the A2 PR, on `feat/a2-field-ready-off-path` at `f5da0bb`.

Headline columns are the median of the three pass p50s, p95 is the median of
the three pass p95s, same aggregation the Phase-0 note used. `fieldReady`
overlaps the street fetch in the *before* rows by construction (broad preload
starts beside it); it stops costing on the *after* warm rows entirely.

## Warm field-ready acceptance

Target: warm `fieldReady` medians < 200 ms, no warm run over 600 ms,
bimodality gone. Per-run warm sequences across all three passes (10 runs per
pass, 30 per scenario, chronological within pass then across passes):

| Scenario | before (ms) | after (ms) |
|---|---|---|
| 2-point warm | 944, 327, 477, 730, 429, 197, 941, 196, 305, 454, 934, 384, 50, 955, 924, 938, 496, 479, 523, 391, 308, 345, 534, 925, 930, 950, 922, 389, 13, 943 | 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 9, 0 |
| 5-point warm | 3271, 3630, 1148, 2679, 3064, 716, 2611, 2236, 1186, 1300, 3070, 2768, 1346, 3157, 906, 1674, 3215, 2734, 2746, 3067, 2982, 2811, 3024, 12, 889, 1234, 3336, 2631, 1079, 3029 | 1, 0, 0, 0, 4, 1, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| transit-2pt warm | 941, 924, 231, 276, 429, 918, 944, 935, 500, 935, 85, 409, 922, 460, 856, 928, 292, 412, 547, 330, 932, 930, 427, 924, 462, 922, 300, 921, 927, 365 | 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0 |

Bucket counts, before → after:

| Scenario | <200 ms | 200–600 ms | >600 ms |
|---|---:|---:|---:|
| 2-point warm | 4 → 30 | 14 → 0 | 12 → 0 |
| 5-point warm | 1 → 30 | 0 → 0 | 29 → 0 |
| transit-2pt warm | 1 → 30 | 14 → 0 | 15 → 0 |

The 920/400 ms bimodality is gone: every after-run is ≤ 9.1 ms, every warm
median ≤ 0.3 ms. The 2-point warm total trends from 557.0 → 48.0 ms and the
transit warm total from 968.4 → 67.7 ms, both under the 250 ms line.

## Cold rows and the page-load prewarm

Cold `fieldReady` is essentially unchanged (918.9 → 915.1 ms on 2-point cold),
which is the point: the prewarm moves the *same broad readiness* to page load,
and a cold route never re-pays the broad materialization. Two caveats, both
keyless fixtures rather than production:

1. The page-load prewarm costs the full `ROUTE_READINESS_BUDGET_MS` here
   (`window.__umbraFieldPrewarmMs` = **2500.9 ms**, measured with a throwaway
   Playwright check; it resolves at the deadline). The harness aborts
   `source.coop`, and the raster provider's fetch-retry backoff keeps the
   keyless prewarm busy until the deadline. That stays inside the combined
   readiness budget, which is the acceptance's page-load requirement, and the
   smoke suite shows no first-paint regression (smoke 16.5 s, transit 10.5 s,
   same pass shapes as before the change).
2. The cold route cell keys are not the camera bbox key, so the keyless cold
   route still pays the per-cell raster retry. Cold may wait by the session's
   explicit acceptance; PR 2 (actual edge cells first) is the row that shrinks
   the cold tail further.

With the NYC pointer configured, the prewarm binds the published generation
before it loads, so the first route finds the *static* shard selection cached
too — the path the keyless bench cannot exercise (see the Phase-0 note's
`VITE_NAVIGATION_BASE` caveat).

## CLIMB re-read

Mean(last 3 warm totals) / mean(first 3), median of the passes:

| Scenario | before | after |
|---|---:|---:|
| 2-point warm | 0.99 | 0.70 |
| 5-point warm | 1.06 | 1.59 |
| transit-2pt warm | 0.93 | 0.69 |

The 5-point series still oscillates (its warm totals ran from 56.1 to
2559.3 ms in one pass), but now the variance lives entirely in
`shadowSample` — `fieldReady` is a constant sub-millisecond row after this
PR. This flips the magazine's B3/B4 re-read: the accumulation question is
about shadow sampling, `shadowSample ≈ 0.85–1.22 s` per 5-pt warm run, not
readiness. No A2 action follows; B3/B4 stay magazine.

## What changed

- `createGeometryShadowField(providers, canopy, raster, options)` gains
  `geometryFieldOptions.generationOf`; `ready()` and `readyEdges()` consult a
  bounded MRU readiness cache (8 entries, the providers' own shape) keyed on
  generation + the exact bbox/cell key, and record only completed passes.
- `app/hooks/useShadowFieldPrewarm.ts`: one page-load materialization per
  published generation. It waits for the real camera (shared-link hydration
  or the first useful move), binds the navigation snapshot, then runs
  `field.ready(bboxAroundEdges(camera bbox, QUERY_PAD_M))` under
  `ROUTE_READINESS_BUDGET_MS`. Wired in `app/page.tsx` beside the
  `useShadowTime`/`LocalShadowAdapter` area, **not inside `useRouting`**.
- `useRouting` only tells the field its `generationOf`; every
  `field.ready`/`field.readyEdges` call, the deadline, and the abort wiring
  are byte-for-byte unchanged.
- `useNavigation` now exposes `bindStaticSnapshot` (page consumers); the
  key-contract test is updated (it was already stale against main's rain
  keys — this PR fixes the whole list, not just its own addition).

## Safety & memory

Shadow behavior is byte-identical: the field's sampling, providers, handshake
and confidence paths are untouched; only *re-attempted readiness work* was
removed. An aborted or deadline-cut pass records nothing, so a calculation
that misses the cache behaves exactly like today. The readiness cache pins no
geometry — eight bbox descriptors total, far less than the per-route bbox's
prisms on a long route, so the viewport prewarm does not grow route memory.

Local gates before push, on this branch: `npm run lint` (59 pre-existing
warnings, none added), `npm run typecheck` (only the pre-existing
`@aws-sdk/client-s3` resolution error, also present on `main`), targeted
vitest + full vitest (only the three pre-existing transit-access failures,
reproduced on `main`), `npm run build`, `npm run e2e` (5/5, incl. published
transit), and three `bench:route` passes above.

---

# PR 2 — readiness narrowed to the actual edge cells

Branch `feat/a2-edge-cell-readiness`, off `main` after PR 1 merged (#455).
Same machine, same protocol, three consecutive passes (`a2pr2-*.log`).

## Change

`useRouting` and the sketch twin no longer start the broad
`field.ready(shadowBbox)` beside the street fetch. `field.readyEdges(edgeRefs)`
runs first, as soon as the graph is enumerated, and the broad bbox is loaded
only when `coverageEdges(...).confidence < LOW_CONFIDENCE` — i.e. when a
subset of the exact cells cannot speak. Same `readyOptions` object, same
`ROUTE_READINESS_BUDGET_MS` deadline, same abort wiring. The page-load
prewarm's camera listeners now persist so the bare-app-then-search flow also
gets its one prewarm per generation, and the three readiness-ordering pins in
`useNavigation.test.tsx` are re-pinned to the new semantics.

## Acceptance — PR 1's warm table under the shrink

| Scenario | PR 1 fieldReady | PR 2 fieldReady | PR 2 p50 total |
|---|---:|---:|---:|
| 2-point warm | 0.3 | **0.8** | **48.6** |
| 5-point warm | 0.3 | **0.5** | **1807.3** |
| transit-2pt warm | 0.3 | **1.0** | **74.9** |

Per-run warm sequences (30 runs each across the three passes):

| Scenario | PR 2 fieldReady (ms) |
|---|---|
| 2-point warm | 2, 0, 1, 6, 1, 1, 0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 0, 0, 1, 1, 2, 1, 1, 0, 1, 1, 1, 2, 0, 1 |
| 5-point warm | 1, 0, 0, 3, 5, 0, 4, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 6, 0, 1, 0, 0, 0, 0, 0, 0, 1 |
| transit-2pt warm | 2, 2, 1, 1, 1, 1, 1, 3, 1, 2, 4, 1, 1, 1, 0, 6, 1, 2, 2, 1, 2, 2, 1, 1, 1, 0, 0, 1, 2, 1 |

All 90 warm runs ≤ 6.2 ms — the <200 ms target and the zero-over-600 gate hold
under the shrink, and the bimodality stays gone (30/0/0 in every bucket).

## The cold tail, honestly

Keyless cold rows move within fixture noise: 2-point cold `fieldReady`
932.8 ms vs PR 1's 915.1 ms (+18 ms), totals 1019.2 vs 995.9. The heavy cold
run is one raster-admission cycle either way; PR 2's ordering removes the
*second* (broad) admission per run, but the keyless harness cannot show that
win because its broad admission is an instantly-declined Overpass ask. The
shrink's measurable surface is the configured NYC static/Overpass path —
broad shard/cell selection outside the actual edge cells — which stays
unmeasured by design until A4 turns the static path on in the bench. Warm is
the session's gate, and warm is what this PR reproduces on one-machine data.

CLIMB, median of the passes: 2-pt 0.58, 5-pt 1.83, transit 0.63. The 5-pt
swing is `shadowSample` (899.7 ms median), with `fieldReady` a constant
sub-millisecond row — same conclusion as PR 1.

Local gates on this branch: lint (no new warnings), typecheck (only the
pre-existing S3 error), `useNavigation`/`routing`/`metrics`/`ShadowField`
vitest targets green, full vitest with only the three pre-existing failures,
build, e2e 5/5, and the three bench passes above.

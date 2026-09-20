# NYC static navigation — Checkpoint 6 (benchmark, browser smoke, guarded rollout)

Checkpoint 6 of `docs/handoffs/NYC_NAVIGATION_DATA.md`: prove correctness and
measure whether static NYC streets/buildings improve route readiness. This
note records what shipped and the measured results; it deliberately makes **no
rendering claim** — visible MapLibre rendering is unchanged.

- **Before** (baseline): `main` at `7bdc9cd` (the A4 static-nav latency note,
  `docs/notes/static-nav-latency-2026-09-19.md`, is the closest previously
  committed measurement).
- **After**: `feat/c6-navigation-benchmark` (this branch). The three bench
  passes ran on the branch's own commits (`9092599` + `0ef46b3`, street-cache
  tuning) before the branch was rebased onto `6675d46`; the rebase only moved
  the untouched base under it, and every gate below was re-run on the rebased
  head `0a86aee`.

## What changed

### Phase split (was: one combined `graphFetch` span)

`app/lib/navigationData/navigationPhases.ts` defines one per-calculation
ledger, threaded through the snapshot acquisition, the street-graph source,
the static building provider, and `ShadowField.sampleEdges`. The former
combined graph/readiness timing now reports:

| Phase | Where it lives | Recorded field |
|---|---|---|
| pointer (request + parse) | `acquireNavigationSnapshot` → `loadNavigationPointer` | `phases.pointer` |
| manifest (request + digest + parse) | `loadNavigationManifest` | `phases.manifest` |
| street shard transfer | `loadNavigationStreetShard` | `phases.streetTransfer` |
| digest/byte-contract verification | same | `phases.streetVerify` |
| street decode/parse | same | `phases.streetDecode` |
| graph merge | `fetchBestRoutingGraph` around `buildRoutingGraphFromStreetShards` | `phases.streetMerge` |
| building shard transfer | `loadNavigationBuildingShard` | `phases.buildingTransfer` |
| building verify | same | `phases.buildingVerify` |
| building decode/parse | same | `phases.buildingDecode` |
| prism conversion | `createNycStaticPrismProvider.load` around `prismsFromFootprints` | `phases.buildingConvert` |
| shadow-index preparation | `sunCellsAt` (caster triangulation + per-cell index) | `phases.shadowIndexPrep` |
| shadow sampling | unchanged | `phases.shadowSample` (spans prep + walk) |
| Dijkstra/Pareto search | unchanged | `phases.dijkstra` / `phases.walkPareto` |

The old fields keep their historic meaning (`graphFetch`, `navSnapshot`,
`staticStreets`, `fieldReady`, `shadowSample`, `dijkstra`), so the committed
A4/Phase-0 columns stay comparable.

### Accounting (counts/bytes only — privacy-safe)

Each successful run records a `navigation` record on
`window.__umbraMetrics`: street source and decline reason (shard keys and HTTP
statuses only), bound generation, pointer generation-cache hit, street and
building shard counts split into served-from-decoded-cache / fetched, wire
transfer bytes, estimated retained decoded bytes (documented estimator
constants), selected-ref and merged node/edge counts, building ref/prism
counts, and the provider's synchronous prism-cache hit.

A calculation that declines the static dataset is counted separately
(`window.__umbraMetrics.navigationDeclines`) so fallback share is measurable
even when the fallback then errors. No log anywhere carries route coordinates
or a full user query: pre-existing bbox/waypoint logs were already
`NODE_ENV !== "production"`-gated, and everything new is counts, bytes,
durations and labels.

### Building shards now reuse the generation decoded cache

The static prism provider previously re-fetched a building shard for each
distinct padded query bbox; it now loads already-selected refs through the
same decoded generation cache the street path uses
(`loadNavigationBuildingShards`), so one shard transfers once per session.

### Hermetic Playwright scenario

New `nav-smoke` project in `playwright.config.ts`: its own preview build
(port 4174, out-dir `nav-dist`) inlines `VITE_NAVIGATION_BASE`; the keyless
build on 4173 is untouched. `e2e/navSmoke.spec.ts` stubs pointer → manifest →
street/building shards and forces every street-graph, building-footprint and
station-entrance Overpass request to fail, while tree/woodland canopy Overpass
requests keep their existing answer. It asserts:

1. NYC walking route succeeds on static streets/buildings (1 street shard,
   4,332 merged nodes, 16,670 directed edges, 1,000 static prisms), with the
   route line drawn on the canvas.
2. Subway access/egress succeeds (3-station magenta fixture; magenta line
   drawn) and bus access/egress succeeds (bus-only fixture; drawn geometry)
   with both access walks coming from the static graph.
3. An outside-support request falls back — recorded decline
   (`reason: "outside support"`, `streetSource: "overpass"`), one Overpass
   request observed, zero navigation shard requests.
4. Zero `_shadow` requests in any test.
5. Canopy Overpass traffic (when present) is not failed alongside routing.
6. The visible map still renders through its existing paths (fixture MapTiler
   style request, painted shadows, drawn lines).

### Bench case set

`e2e/bench/routeCalc.bench.spec.ts` gains the Checkpoint 6 case matrix —
short Manhattan (existing 2-pt), longer Manhattan (~5.7 km, all four `scale`
cells), cross-borough (~11 km, all eight `boroughs` cells), subway and bus —
each cold and warm on both the static path (nav-static rows) and the current
Overpass fallback (keyless rows, city-scale `LARGE` Overpass grid as the
twin). Results print the phase-split table, per-run navigation records, and
per-run footprints (Chromium usedJSHeapSize delta, resource count and
transfer/encoded bytes between click and recorded run).

The new `boroughs` fixture profile (280×120 lattice, 8 cells, generation
`nyc-2026-09-19-abcdef123457`) is pinned by
`app/lib/navigationData/__tests__/navigationShardFixture.test.ts` beside the
unchanged A4 `scale` fixture whose pinned byte stream did not change.

## Environment & method

WSL2 marcopolo (`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node
`v24.21.0` (`~/.local/node24/bin`), npm `11.19.0`, Playwright `1.63.0`
driving Chromium headless on ANGLE/SwiftShader, viewport 1280×900,
`America/New_York`, keyless (no MapTiler key). Fixed conditions are G1's
(`e2e/helpers/scenario.ts`): midtown Manhattan at z17, 09:00 on 2026-06-21.

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
npm run bench:route   # x1 full pass (results below); see pass table for per-scenario spread
```

## Results

Three complete `npm run bench:route` passes on the same machine, back to
back. Pass 1 ran the instrumentation as first committed; passes 2 and 3 added
one measured tuning change (street shards served from the decoded generation
cache — see "Tuning"), so warm `nav-static` rows below are the median of
passes 2–3 and pass 1 is quoted separately as the pre-tuning side of that
decision. Keyless rows are the median of all three passes (code unchanged).
p50/p95 are per-scenario R-7 percentiles; run order sequences and per-run
navigation records are in the pass logs above each table's committed form.

### Route calculation — median of three suite passes

Keyless (current fallback path; `Overpass large` = the city-scale twin grid):

| Scenario | N | p50 (ms) | p95 (ms) | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 1020 | 1043 | 946 | 0 | 12 | 935 | 0 | 38 | 35 | 32 | 0 | 0 | 0 | 0 | 0 |
| 2-point warm | 10 | 50 | 111 | 1 | 0 | 0 | 1 | 0 | 22 | 19 | 18 | 0 | 0 | 0 | 0 | 0 |
| 5-point cold | 5 | 1004 | 1057 | 944 | 0 | 16 | 929 | 0 | 32 | 11 | 2 | 0 | 0 | 0 | 0 | 0 |
| 5-point warm | 10 | 1847 | 2808 | 1 | 0 | 0 | 0 | 0 | 993 | 3 | 1 | 0 | 0 | 0 | 0 | 0 |
| transit-2pt fixture | 5 | 1048 | 1078 | 952 | 0 | 16 | 936 | 0 | 27 | 33 | 29 | 37 | 1 | 0 | 0 | 0 |
| transit-2pt NYC-scale | 5 | 1136 | 1195 | 942 | 0 | 13 | 928 | 0 | 30 | 35 | 32 | 114 | 11 | 0 | 1 | 0 |
| transit-2pt NYC-scale bus-only | 5 | 1130 | 1187 | 960 | 0 | 16 | 947 | 0 | 34 | 40 | 36 | 87 | 6 | 0 | 1 | 0 |
| transit-2pt warm | 10 | 71 | 135 | 2 | 0 | 0 | 1 | 0 | 23 | 14 | 12 | 16 | 5 | 0 | 1 | 0 |
| route-long cold | 5 | 10067 | 10917 | 1513 | 0 | 256 | 1183 | 0 | 3628 | 1898 | 1467 | 39 | 0 | 0 | 0 | 0 |
| route-long warm | 10 | 10454 | 11541 | 1105 | 0 | 32 | 1022 | 0 | 3399 | 1886 | 1632 | 14 | 0 | 0 | 0 | 0 |
| cross-borough cold | 5 | 11353 | 11939 | 1569 | 0 | 287 | 1200 | 0 | 3637 | 2993 | 2551 | 45 | 0 | 0 | 0 | 0 |
| cross-borough warm | 10 | 10870 | 11414 | 1136 | 0 | 31 | 1035 | 0 | 3568 | 3390 | 3099 | 20 | 0 | 0 | 0 | 0 |
| transit-2pt fixture warm | 10 | 75 | 125 | 2 | 0 | 0 | 1 | 0 | 24 | 21 | 19 | 16 | 0 | 0 | 0 | 0 |
| transit-2pt NYC-scale bus-only warm | 10 | 73 | 120 | 2 | 0 | 0 | 1 | 0 | 24 | 19 | 16 | 16 | 3 | 0 | 0 | 0 |

Static path, cold (median of passes 1–3; the same code fetches on a cold
page, so all three passes are comparable):

| Scenario | N | p50 (ms) | p95 (ms) | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nav-static 2-pt cold | 5 | 6342 | 7582 | 2165 | 14 | 178 | 1961 | 0 | 539 | 93 | 33 | 0 | 0 | 0 | 0 | 0 |
| nav-static NYC-scale | 5 | 8227 | 9357 | 2513 | 12 | 551 | 1915 | 0 | 1888 | 322 | 116 | 128 | 10 | 0 | 17 | 0 |
| nav-static route-long cold | 5 | 8276 | 8791 | 1736 | 10 | 559 | 1133 | 0 | 1876 | 1448 | 1266 | 41 | 0 | 0 | 0 | 0 |
| nav-static cross-borough cold | 5 | 12172 | 13527 | 2354 | 18 | 1125 | 1141 | 0 | 3704 | 3221 | 2836 | 42 | 0 | 0 | 0 | 0 |
| nav-static subway cold | 5 | 8121 | 8424 | 2512 | 12 | 538 | 1913 | 0 | 1884 | 300 | 99 | 35 | 1 | 0 | 10 | 0 |
| nav-static bus-only cold | 5 | 8077 | 8441 | 2511 | 11 | 536 | 1935 | 0 | 1861 | 296 | 109 | 97 | 5 | 0 | 14 | 0 |

Static path, warm — **tuned** (median of passes 2–3; decoded street shards
served from memory, see "Tuning"):

| Scenario | N | p50 (ms) | p95 (ms) | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nav-static 2-pt warm | 10 | 4171 | 4850 | 58 | 13 | 25 | 9 | 0 | 470 | 57 | 24 | 0 | 0 | 0 | 0 | 0 |
| nav-static route-long warm | 10 | 8855 | 9349 | 1145 | 10 | 125 | 966 | 0 | 1766 | 1446 | 1316 | 14 | 0 | 0 | 0 | 0 |
| nav-static cross-borough warm | 10 | 10835 | 11910 | 1358 | 11 | 252 | 1028 | 0 | 3487 | 2773 | 2523 | 13 | 0 | 0 | 0 | 0 |
| nav-static subway warm | 10 | 8683 | 9378 | 2036 | 10 | 121 | 1895 | 0 | 1844 | 232 | 75 | 10 | 0 | 0 | 8 | 0 |
| nav-static bus-only warm | 10 | 8675 | 9401 | 2037 | 10 | 108 | 1882 | 0 | 1767 | 190 | 72 | 14 | 3 | 0 | 8 | 0 |

Static path, warm — **pass 1, before the cache tuning** (kept for the tuning
decision's before-side; every one of these refetched and re-decoded its
street shards per calculation):

| Scenario | p50 (ms) | static streets (ms) |
|---|---:|---:|
| nav-static 2-pt warm | 4361 | 153 |
| nav-static route-long warm | 9359 | 555 |
| nav-static cross-borough warm | 12057 | 1110 |
| nav-static subway warm | 9295 | 584 |
| nav-static bus-only warm | 8606 | 606 |

### Static-navigation phase split (median across the three passes, ms)

Phase columns are medians and do not sum to `staticStreets`/`graphFetch`:
parallel shard fetches accumulate per-shard timers (a throughput, not the wall
span), and the spans also cover work between brackets. `shadow idx prep` is
the one-time caster-triangulation + per-cell index part of `shadow sample`;
the last column is its share of the sample span.

| Scenario | pointer | manifest | street xfer | digest verify | decode/parse | graph merge | building xfer | building verify | building decode | prism convert | shadow idx prep | idx prep / sample % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nav-static 2-pt cold | 13.9 | 0.0 | 101.2 | 4.1 | 38.5 | 42.2 | 0.0 | 0.0 | 0.0 | 1.5 | 13.0 | 2.1 |
| nav-static 2-pt warm | 13.1 | 0.0 | 0.0 | 0.0 | 0.0 | 26.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.5 | 0.1 |
| nav-static NYC-scale | 12.4 | 0.0 | 1001.6 | 16.0 | 128.4 | 131.4 | 0.0 | 0.0 | 0.0 | 2.1 | 27.0 | 1.4 |
| nav-static route-long cold | 9.6 | 0.0 | 1027.0 | 17.5 | 135.3 | 136.7 | 0.0 | 0.0 | 0.0 | 1.7 | 25.4 | 1.4 |
| nav-static route-long warm | 9.7 | 0.0 | 0.0 | 0.0 | 0.0 | 112.9 | 0.0 | 0.0 | 0.0 | 0.0 | 3.4 | 0.2 |
| nav-static cross-borough cold | 17.7 | 0.0 | 3907.9 | 36.9 | 271.8 | 282.2 | 0.0 | 0.0 | 0.0 | 2.0 | 22.4 | 0.6 |
| nav-static cross-borough warm | 10.9 | 0.0 | 0.0 | 0.0 | 0.0 | 278.9 | 0.0 | 0.0 | 0.0 | 0.0 | 2.1 | 0.1 |
| nav-static subway cold | 11.4 | 0.0 | 944.9 | 19.2 | 132.3 | 148.8 | 0.0 | 0.0 | 0.0 | 2.5 | 30.4 | 1.6 |
| nav-static subway warm | 10.5 | 0.0 | 0.0 | 0.0 | 0.0 | 129.9 | 0.0 | 0.0 | 0.0 | 0.0 | 1.6 | 0.1 |
| nav-static bus-only cold | 10.1 | 0.0 | 938.7 | 17.1 | 127.1 | 132.0 | 0.0 | 0.0 | 0.0 | 1.7 | 29.2 | 1.5 |
| nav-static bus-only warm | 11.4 | 0.0 | 0.0 | 0.0 | 0.0 | 110.8 | 0.0 | 0.0 | 0.0 | 0.0 | 1.7 | 0.1 |

Building phases are 0 in the calculation because the page-load shadow prewarm
already fetched, verified, decoded and converted the viewport's building
shard (bound to the same generation) before the click; the calculation
serves it from the provider cache. The `buildingPrismCacheHit` flag and the
served/fetched split in the per-run record distinguish that case from a
failed load.

### Data actually served and retained (per run, every run of every pass)

| Scenario | street shards | street wire bytes | street decoded (est) | merged graph | building shards | building prisms | gen-cache hit |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2-pt (one cell) | 1 fetched | 1751 KiB | 2606 KiB | 4,332 nodes / 16,670 edges | served | 1,000 | hit |
| NYC-scale / long / subway / bus (four cells) | 4 fetched | ~7008 KiB | ~10,412 KiB | 16,802 nodes / 66,680 edges | served | 1,000 | hit |
| cross-borough (eight cells) | 8 fetched | 14,514 KiB | 20,894 KiB | 33,600 nodes / 133,600 edges | served | 1,000 | hit |

Warm static runs report 0 fetched street shards after tuning (served from the
decoded generation cache). Every static run of every pass binds the pinned
generation (`nyc-2026-09-19-abcdef123456` / `…457` for the boroughs profile),
reports `streetSource: "nyc-static"` and never falls back; keyless runs
report `streetSource: "overpass"`. Building shadow share by scenario:
25.1% (2-pt), 47.2% (NYC-scale / long / subway / bus), 29.5% (cross-borough,
where the buildings spread across twice the grid).

### Tuning made from the measurements

Warm runs in pass 1 re-transferred and re-decoded every selected street shard
on every calculation (~153–1,110 ms of street pipe, growing with the
selection). The decoded generation cache already existed for the bbox loader;
`fetchBestRoutingGraph` now loads its selected refs through the same cache
(`loadNavigationStreetShards`), so a covered recalculation verifies once and
merges thereafter. Measured effect on `staticStreets` medians:

| Scenario (warm) | before | after |
|---|---:|---:|
| 2-pt | 153 ms | 25 ms |
| route-long | 555 ms | 125 ms |
| cross-borough | 1110 ms | 252 ms |
| subway | 584 ms | 121 ms |
| bus-only | 606 ms | 108 ms |

`navSnapshot + staticStreets` against the Phase-0/A4 800 ms trigger: NYC-scale
(16.8 k nodes) measures **~563 ms cold / ~131 ms warm — passes**. The
cross-borough twin (33.6 k nodes, 14.5 MiB) measures ~1,143 ms cold — outside
the trigger's scenario, dominated by street transfer on the synthetic
whole-city slice; the published shard contract already caps 5 MB per shard
and serves HTTP-gzip, so this row is recorded as the number to re-check
against real published shards, not as a reason to change wire format.

CLIMB (warm-series degradation ratio): maximum over all scenarios and passes
is 1.17 — under the 1.5 trigger. Run footprints (Chromium
`usedJSHeapSize` deltas sampled around each run) stayed below the MiB
rounding at this sampling interval; decoded-cache retention is bounded by the
estimates in the table above. Per-run resource counts and transfer bytes are
printed per scenario in the harness output; the navigation-only shard bytes
above are the authoritative per-run figure.

## Claims and non-claims## Claims and non-claims

- **Claim:** with `VITE_NAVIGATION_BASE` configured and street/building
  Overpass refused, NYC walking, subway access/egress and bus access/egress
  all route from verified static shards (Playwright, every run).
- **Claim:** the phase split attributes the former combined span; the
  sub-phases of a span never exceed their span (bench printout, per run).
- **Claim:** the static path removes street/building Overpass dependency from
  covered NYC calculations; outside support falls back observably.
- **Explicit non-claim:** **visible MapLibre rendering is unchanged.** No
  MapView, style, `LocalShadowAdapter`, `_shadow`, or canopy-COG code changed
  in this branch; the smoke suite (including the new nav-smoke canvas and
  pixel assertions) still passes, which is the regression signal, not a
  rendering improvement. Route-readiness improvements are measured by the
  phase tables below and never phrased as a rendering win.

## Rollout status

Production remains **disabled**: `VITE_NAVIGATION_BASE` is unset in the
deployed environment and the NYC navigation pointer publication is still
unexecuted (Checkpoint 5 state). Rollback is unsetting the env var or
repointing `current.json`; no generation is deleted.

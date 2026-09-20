# Static navigation latency (A4) — 2026-09-19

Session A4 from `docs/handoffs/LATENCY_ATTRIBUTION_SESSIONS.md`: the route
benchmark now configures `VITE_NAVIGATION_BASE` and serves a seeded,
digest-verified pointer → manifest → street/building shard fixture, so
`navSnapshot` and `staticStreets` measure the **real static path** — pointer +
manifest fetch and digest, street shard bytes + verified adapter build — for
the first time. The keyless scenario set is untouched and now runs against a
build that performs **no** navigation-data request at all (its own preview
server, see "What changed"), so the committed Phase-0/A2 columns stay the
measurements of the same code paths they committed.

The number this session exists to produce gates B5 (cache street shards + the
built routing graph per generation): `navSnapshot` + `staticStreets` < 800 ms
→ no fix needed; ≥ 800 ms → a cache session. It is also the win condition's
manual deployed-NYC cross-check (reported at the end, labelled
*deployed, not CI*).

**Before** is the Phase-0 committed table
(`docs/notes/navigation-latency-attribution-2026-09-19.md`); **after** is
`perf/a4-static-nav-bench` at `9fe431c`. Both measured on the same machine,
three full `npm run bench:route` passes (± the one
pass-B rerun the caveats disclose), unchanged code between them.

## Environment & method

WSL2 marcopolo (`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node
`v24.21.0` (`~/.local/node24/bin`, the G2 baseline's environment), npm
`11.19.0`, Playwright `1.63.0` driving Chromium headless on ANGLE/SwiftShader,
viewport 1280×900, `America/New_York`. Fixed conditions are G1's
(`e2e/helpers/scenario.ts`): midtown Manhattan at z17, 09:00 on 2026-06-21,
the `overpassGrid` 11×11 street stub for keyless rows / the
`navigationShards.ts` seeded grid for the `nav-static` rows, the fixture
basemap, keyless (no MapTiler key).

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
npm run bench:route          # x3, back to back, unchanged code
```

Same protocol as `performance-baseline.md` and the Phase-0 note: report the
median of the three p50s plus the printed p95/spread, quote the per-run
sequences, and a fourth pass only if a cross-pass p50 spread exceeds 40%.
The header row below is the median of the three pass p50s.

## What changed (bench-only)

1. `e2e/fixtures/navigationShards.ts` — a seeded static dataset in the exact
   `shardContract.ts` v1 shape: pointer → manifest → four z14-style street
   shards (16,800 nodes, 66,680 directed edges, ~1.8 MB each, under
   `MAX_STREET_SHARD_BYTES`) + one building shard (1,000 deterministic
   footprints, one unknown height in eight). Every digest is computed from the
   exact bytes served; the byte stream is pinned by
   `app/lib/navigationData/__tests__/navigationShardFixture.test.ts` (seed,
   counts, digest chain, per-shard budget, and the geometry facts the bench
   relies on — the 2-pt bbox selects one cell, the NYC-scale bbox plus its two
   2,000 m access zones selects the full 16,800-node slice, and both waypoint
   pairs route over it).
2. `e2e/helpers/scenario.ts` — a `navigation: "off" | "scale"` knob beside the
   existing `transit` knob. `off` (default) aborts the navigation origin;
   `scale` serves pointer/manifest/street-/building-shard/notices routes.
3. `playwright.bench.config.ts` — **two preview servers** for two builds: the
   keyless build (no `VITE_NAVIGATION_BASE`, served to the committed `bench`
   project) and the static build (`VITE_NAVIGATION_BASE`, served to the new
   `bench-nav` project). A single build cannot keep the committed columns
   comparable: its every keyless run would start with a doomed pointer
   attempt, and on the per-leg 5-point loop the renderer stays busy through
   the failed fetch's settlement (measured ~450 ms, pure measurement artifact,
   not navigation cost). Ports 4191/4192, separate `bench-dist/` out-dirs so
   the second build cannot `emptyOutDir` the first's bundle.
4. `e2e/bench/routeCalc.bench.spec.ts` — three appended scenarios
   (`nav-static 2-pt cold`, `nav-static 2-pt warm`, `nav-static NYC-scale`),
   one per committed twin row + `navigation: "scale"`; the existing scenario
   set is untouched. Each run now also records the `nyc-static` building share
   and the bound static generation, printed per scenario.

## Route calculation — three consecutive suite passes

Median of the three pass p50s (p95 is the median of the pass p95s). Keyless
rows are the same scenarios the Phase-0 note committed, against the keyless
build; `nav-static` rows are the new measurements.

| Scenario | N | p50 total (ms) | p95 total (ms) | graph fetch | nav snapshot | static streets | field ready | canvas read | shadow sample | dijkstra | walk pareto | transit fetch | train search | entrances | walk legs | bus wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 1037.5 | 1055.0 | 941.9 | 0.0 | 11.6 | 929.4 | 0.0 | 32.4 | 40.1 | 36.8 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 2-point warm | 10 | 49.3 | 94.5 | 1.6 | 0.0 | 0.3 | 0.8 | 0.0 | 19.3 | 23.8 | 22.6 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point cold | 5 | 1006.5 | 1038.8 | 952.6 | 0.1 | 12.8 | 938.7 | 0.0 | 33.1 | 12.1 | 3.8 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| 5-point warm | 10 | 1836.2 | 2609.0 | 1.3 | 0.1 | 0.2 | 0.6 | 0.0 | 1001.4 | 4.3 | 1.2 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| transit-2pt fixture | 5 | 1050.4 | 1106.4 | 949.3 | 0.1 | 16.5 | 931.8 | 0.0 | 33.3 | 41.3 | 34.3 | 27.6 | 0.5 | 0.1 | 0.7 | 0.0 |
| transit-2pt NYC-scale | 5 | 1159.2 | 1190.4 | 950.2 | 0.1 | 15.1 | 937.0 | 0.0 | 29.1 | 38.9 | 33.6 | 110.2 | 8.7 | 0.2 | 1.4 | 0.2 |
| transit-2pt NYC-scale bus-only | 5 | 1116.2 | 1149.9 | 942.4 | 0.1 | 13.5 | 928.1 | 0.0 | 30.0 | 36.3 | 32.5 | 89.2 | 5.5 | 0.1 | 0.6 | 0.2 |
| transit-2pt warm | 10 | 77.9 | 162.5 | 1.4 | 0.1 | 0.3 | 0.7 | 0.0 | 23.9 | 15.8 | 14.7 | 16.3 | 4.6 | 0.0 | 0.6 | 0.2 |
| **nav-static 2-pt cold** | 5 | **5577.3** | 5813.0 | 2162.1 | **9.8** | **170.2** | 1971.8 | 0.0 | 505.3 | 98.6 | 35.1 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| **nav-static 2-pt warm** | 10 | **4182.3** | 4661.4 | 179.8 | **13.6** | **149.8** | 9.2 | 0.0 | 473.2 | 59.1 | 22.3 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| **nav-static NYC-scale** | 5 | **7883.1** | 8248.4 | 2509.0 | **8.8** | **553.9** | 1845.9 | 0.0 | 1886.6 | 324.7 | 102.3 | 117.2 | 9.8 | 0.2 | 18.9 | 0.4 |

Keyless rows reproduce the committed Phase-0/A2 columns: `navSnapshot` stays
0.0–0.1 ms (the keyless build makes no request), 2-point warm total 49.3 ms vs
A2's 48.0 ms, 5-point warm 1836.2 ms vs A2's 1880.1 ms, transit NYC-scale
`staticStreets` 15.1 ms vs the committed 12.6 ms homologue. The dual-server
config is what keeps that true; see "What changed" for the single-build
artifact it avoids.

Two scenarios crossed the 40% cross-pass bar on their three p50s and got the
protocol's fourth pass, quoted beside the median:

| Scenario | pass A p50 | pass B p50 | pass C p50 | median | 4th pass p50 |
|---|---:|---:|---:|---:|---:|
| 2-point warm | 49.3 | 42.2 | 62.0 | 49.3 | 46.8 |
| transit-2pt NYC-scale bus-only | 1125.1 | 1116.2 | 463.3 (outlier pass) | 1116.2 | 1107.4 |

## The new scenarios — per-pass p50s and per-run sequences

| nav-static scenario | pass A p50 | pass B p50 | pass C p50 | cross-pass spread |
|---|---:|---:|---:|---:|
| 2-pt cold | 5577.3 | 5667.6 | 5570.7 | ±1.7% |
| 2-pt warm | 4182.3 | 4880.4 | 4116.9 | ±18.3% |
| NYC-scale | 7912.7 | 7883.1 | 7795.7 | ±1.5% |

Pass totals in order (prove no new climb within a scenario):

| nav-static scenario | pass totals (ms, chronological) |
|---|---|
| 2-pt cold | A: 5460.7, 5560.5, 5639.9, 5577.3, 5856.3 · B: 5667.6, 5787.5, 6588.4, 5617.7, 5618.5 · C: 5819.1, 5570.7, 4708.5, 5647.6, 4594.9 |
| 2-pt warm | A: 4872.5, 4066.6, 4329.9, 3997.5, 4132.1, 4109.4, 4382.6, 4403.5, 4232.4, 3398.6 · B: 4711.9, 4061.4, 4401.9, 4354.7, 4885.4, 5231.8, 5698.5, 4875.3, 5244.9, 5298.6 · C: 4359.6, 4436.5, 3847.5, 4437.7, 3698.9, 3913.5, 4270.5, 4087.9, 4003.7, 4145.8 |
| NYC-scale | A: 7980.6, 6228.0, 7882.8, 7912.7, 8315.4 · B (rerun): 7361.7, 7883.1, 7140.5, 10262.2, 8267.0 · C: 7978.6, 7616.5, 7795.7, 7393.7, 8109.6 |

Per-run `staticStreets` sequences (the decision's denominator — proof no run hides
a cache miss the p50 flattens): 2-pt cold A: 194.5, 163.9, 136.6, 166.6, 177.8 ·
B: 175.8, 148.1, 245.7, 180.4, 166.0 · C: 181.1, 188.1, 139.1, 152.9, 170.2.
2-pt warm A: 166.1, 151.8, 144.4, 149.0, 139.9, 164.9, 141.7, 150.7, 148.0, 151.8 ·
B: 173.0, 150.9, 125.2, 162.5, 138.8, 213.3, 163.0, 144.7, 161.8, 168.1 ·
C: 145.9, 156.4, 148.0, 134.8, 127.0, 169.1, 156.2, 130.0, 121.5, 153.8.
NYC-scale A: 620.4, 451.7, 518.7, 971.7, 553.9 · B (rerun): 648.7, 530.0, 529.2, 761.2, 696.1 ·
C: 634.5, 476.1, 561.6, 468.2, 505.2.

`CLIMB` for the one warm nav-static scenario (mean last 3 / mean first 3):
0.91 / 1.17 / 0.97 → median **0.97**, under the 1.5 trigger.

## Evidence the static path actually served

- **Graph sizes**: every `nav-static 2-pt` run reports 4,332 nodes / 16,670
  directed edges (one shard cell plus its seam ghosts and the two virtual
  snaps) and every `nav-static NYC-scale` run reports 16,802 nodes / 66,680
  directed edges — the 16,800-node seeded city slice, never the 121-node
  Overpass stub.
- **Generation binding**: all three scenarios bind
  `nyc-2026-09-19-abcdef123456` on every run (median `staticGeneration` of
  every nav-static run of every pass), and `nyc-static` building share is
  25.1% (2-pt) / 47.2% (NYC-scale) on every run — the static building shard
  answered part of every route's shadow sampling too.
- **No fallback**: a route over the seeded shards appears in every run
  (Shortest/Balanced/Most shadowed, plus Via Subway/Via Bus on NYC-scale), so
  the static attempt never once fell back to Overpass during the protocol
  runs.

## The decision the number gates

`navSnapshot` + `staticStreets`, median of the pass p50 sums:

| Scenario | nav snapshot (ms) | static streets (ms) | sum (ms) |
|---|---:|---:|---:|
| nav-static 2-pt cold | 9.8 | 170.2 | **180.0** |
| nav-static 2-pt warm | 13.6 | 149.8 | **163.4** |
| nav-static NYC-scale (gating row) | 8.8 | 553.9 | **562.7** |

Per-pass sums on the gating row: 562.7 / 656.8 / 515.1 ms. The worst
single-run sum across all 15 gating runs is **980.5 ms** (pass A run 4 —
`staticStreets` 971.7 ms beside four 451.7–620.4 ms neighbours; a one-run spike
inside that pass's ±10.7% scenario spread, not a trend, and the worst run in
passes B/C stays 769.3 ms). Decision reads the protocol median, not the worst
run: **562.7 ms, far below the 800 ms trigger**, on a synthetic shard that
shades the real one conservatively (16,800-node selection, ~1.8 MB streets +
~0.3 MB buildings fetched, full per-request SHA-256 verification).

**Decision: no fix needed. B5 (cache street shards + the built routing graph
per generation and shard selection) stays in the magazine**, not a session.
The row the cache would shrink is visible in the data: `nav-static 2-pt warm`
re-pays ~150 ms of shard fetch + digest + adapter rebuild on every calculation
(there is no decoded graph cache), and NYC-scale re-pays ~554 ms. Shaving it
would take the warm sum from ~163/563 ms to pointer-only (~10 ms), but 563 ms
does not cross the gate that would schedule that work.

Two adjacency observations, for the next attribution round rather than A4:

1. `fieldReady` on the cold nav-static rows is ~1.9 s — the static **building**
   shard's prism materialization inside the first readiness of a generation/area
   (the A2 cold-runs-may-wait acceptance; the page-load prewarm already binds
   the generation and preloads before the first calculation). Warm is 9.2 ms,
   so it is a per-page cold cost, not a per-calculation climb.
2. The static rows' totals are dominated by `shadowSample` (~0.5 s 2-pt,
   1.89 s NYC-scale) and search (~0.1/0.3 s) on the now-city-scale graph —
   downstream costs the keyless fixtures never exposed because their graph is
   121 nodes. Those phases already have their own gating rows/magazine entries
   (B4 for `shadowSample`, A3 for the walk search).

## Manual deployed cross-check — *deployed, not CI*

Procedure from the handoff: open the deployed NYC scene, run 5 consecutive
calculations with the console read, record `window.__umbraMetrics`. Playwright
against `https://shademapnav.vercel.app` (the README demo scene:
`lat=40.754&lng=-73.984&z=17&date=2026-06-21&time=09:00`,
`a=-73.9855,40.753&b=-73.9825,40.755`), real tiles, real APIs, no stubs:

| metric | deployed (median of 5 runs) |
|---|---:|
| p50 / p95 total | 30,915.2 ms / 35,990.1 ms |
| graph fetch | 6,812.9 ms |
| nav snapshot | 0.0 ms |
| static streets | 0.0 ms |
| field ready | 0.0 ms |
| shadow sample | 19,360.8 ms |
| dijkstra | 269.8 ms |
| graph | 12,888 nodes / 32,432 directed edges (real Overpass bbox) |
| static building share / generation | 0% / none |

The deployed bundle is **not configured** for the static dataset yet —
`VITE_NAVIGATION_BASE` is unset in the production env and the pointer
publication (`navigation/nyc/current.json` promotion) is still unexecuted per
`docs/handoffs/NYC_NAVIGATION_DATA.md` Checkpoint 5. So the deployed cross-check
measures the Overpass homologue on real hardware and the static half of the
win condition stays **pending the data publication**; the bench rows above are
the static-path answer until then. (Deployed absolute numbers are
SwiftShader-trend-only where the harness's and deployed renderer's hardware
differ, as every G2 note caveats.)

## Caveats

- SwiftShader absolute numbers are trend-only (the standing G2 caveat); ratios
  and phase deltas travel.
- The street fixture is a synthetic 45 m lattice, not an OSM capture: it
  shades the real thing conservatively for byte/digest work while pinning the
  exact node counts the Node scale matrix already uses. Nodes/edges routing
  semantics are the adapter's real ones.
- Building shard geometry is deterministic random placement around the
  lattice; counts (1,000 buildings, one unknown height in eight) are pinned,
  placement is not.
- Pass B's NYC-scale row comes from a targeted rerun: a concurrent session on
  this machine killed the bench's preview servers between the last two tests
  of pass B; every other pass is a clean back-to-back full pass. Re-run
  numbers are quoted transparently above.

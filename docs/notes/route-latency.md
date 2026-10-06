# Route latency — L0 baseline (where the time goes)

**2026-10-03.** Track L's first checkpoint (`docs/tracks/TRACK_L.md`, #260): measure the whole
route calculation on current `main`, after H1/H2, before changing anything. Every later Track L
checkpoint reports its before/after against the tables here, measured the same way.

## What changed to measure it

- **A lap timer** (`createLapTimer` in `app/lib/metrics.ts`). Each `laps.lap(stage)` in
  `calculateRoute` charges the time since the previous lap to that stage, so the stages of one
  run sum to its `total` exactly. They are recorded as `phases.stages`, and the existing phase
  fields are untouched. The old named phases overlap and leave gaps; on the 2026-09-20
  measurement they covered 61–75% of a long route.
- **Lap points** go after every `await`, every `setTimeout(0)` yield (including the one inside
  the per-edge sampling loop) and every block of work. `other` collects whatever falls
  between named laps. `attributed % (min)` below is the lowest share of any run's total that
  landed in a named stage.
- **#107 fixed** in the benchmark: it waits for either `Edit trip:` or `Find the shade`, and
  clicks `Edit trip:` first when the trip bar is showing, so the warm scenarios no longer hang
  for 600 s.
- **A stage table** (p50 / p95 per stage) is added to the benchmark output.

**What each stage covers.** Names are short, so these are the boundaries:
- `fieldReady`: waiting for building/canopy readiness, plus edge enumeration
  (`routingEdgeBatch`, shed binding, `coverageEdges`), which is tens of ms on long routes.
- `shadowSample`: `field.sampleEdges` plus the per-edge loop that falls back to the canvas
  building mask for low-confidence edges. On keyless long routes it is mostly pixel sampling.
- `sweep`: H1's per-bucket `field.sweep`.
- `yield`: time spent awaiting `setTimeout(0)`. It holds the timer clamp *and* any main-thread
  work the page runs during the pause (React commits, map paints).
- `maskRead` / `mapIdleWait`: the canvas fallback's building-mask readback, and the
  re-fit/`idle` wait before it.

No behaviour change: lap calls only read the clock.

## Environment and method

WSL2 (`6.18.33.2-microsoft-standard-WSL2`), 20 cores, 15 GiB, Node `v24` (`~/.local/node24`),
Playwright 1.63.0, Chromium headless on SwiftShader, `main` at `1624fa0` plus this branch's
instrumentation. The scenarios, fixtures and fixed conditions are the Checkpoint 6 set
(`docs/notes/nyc-navigation-checkpoint6-2026-09-20.md`): midtown Manhattan, 09:00 on
2026-06-21. Keyless rows serve streets from the Overpass fixture; `nav-static` rows serve the
synthetic NYC shards. Each figure is a production build behind `vite preview`.

```bash
export PATH="$HOME/.local/node24/bin:$PATH"
LD_LIBRARY_PATH=$HOME/miniconda3/lib npm run bench:route   # ~30 min, 26 scenarios
```

The benchmark ran in three full passes. Passes 1 and 2 gave stage medians only; pass 3, the
one shown below, adds p95 and the per-run minimum attributed share. Across the three passes:
- **Yields were stable:** 2.9–3.0 s on keyless long routes in every pass.
- **Search moved by up to ~20%:**
  - cross-borough warm: 5.2–5.7 s
  - cross-borough cold: 4.5–5.4 s
  - nav-static cross-borough warm: 8.3–8.8 s
- **`maskRead` moved by about 2×:** 1.7–3.6 s on nav-static subway/bus warm.

Treat the search and yield cells as good to ~20%, and the canvas-fallback cells (`maskRead`,
`mapIdleWait`) as indicative only.

## Results — contiguous stages, p50 ms (pass 3)

The long-route rows; every scenario with p50 / p95 per stage is in the appendix.

| Scenario | total | streets | fieldReady | mapIdleWait | maskRead | yield | shadowSample | sweep | graphBuild | snap | search | transit | attributed (min) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point warm | 48 | 0 | 1 | 0 | 0 | 21 | 9 | 11 | 1 | 1 | 2 | 0 | 99.7% |
| route-long cold | 7,951 | 192 | 1,162 | 767 | 1,143 | 2,970 | 297 | 312 | 326 | 120 | 643 | 68 | 99.9% |
| route-long warm | 7,162 | 32 | 1,176 | 0 | 1,289 | 2,968 | 247 | 248 | 215 | 114 | 726 | 13 | 99.9% |
| cross-borough cold | 12,362 | 198 | 1,208 | 648 | 1,574 | 2,971 | 281 | 223 | 344 | 115 | 4,627 | 50 | 100.0% |
| cross-borough warm | 11,576 | 25 | 1,182 | 0 | 1,465 | 2,939 | 228 | 174 | 203 | 110 | 5,199 | 26 | 99.9% |
| nav-static 2-pt warm | 2,566 | 28 | 16 | 1,023 | 914 | 421 | 58 | 27 | 32 | 18 | 3 | 0 | 99.9% |
| nav-static route-long cold | 8,787 | 401 | 1,066 | 784 | 870 | 1,459 | 184 | 504 | 120 | 60 | 3,269 | 46 | 100.0% |
| nav-static route-long warm | 9,029 | 158 | 1,053 | 0 | 1,354 | 1,510 | 180 | 508 | 85 | 53 | 4,032 | 19 | 100.0% |
| nav-static cross-borough cold | 15,715 | 777 | 1,180 | 636 | 1,667 | 2,995 | 303 | 528 | 243 | 123 | 7,172 | 48 | 100.0% |
| nav-static cross-borough warm | 15,237 | 298 | 1,151 | 0 | 1,448 | 3,002 | 258 | 474 | 170 | 110 | 8,285 | 22 | 100.0% |
| nav-static subway warm | 9,328 | 144 | 1,987 | 1,485 | 3,555 | 1,512 | 190 | 180 | 83 | 61 | 12 | 26 | 100.0% |

Graph sizes: route-long and cross-borough 33,602 nodes / 133,600 directed edges (keyless) and
16,802 / 66,680 (nav-static route-long); 2-point 123 / 440.

## What this shows

1. **1.5–3 s of each long route is spent yielding.** The per-edge sampling loop yields with
   `setTimeout(0)` every 100 edges. The stage scales with edge count at ~4.4 ms per yield:
   - keyless long routes: ~66,800 undirected edges, ~669 yields, 2,970 ms
   - nav-static route-long: ~33,300 edges, ~334 yields, 1,459–1,510 ms

   That is the browser's ≥ 4 ms clamp on nested timeouts. The stage also absorbs main-thread
   work that runs during each pause, so not all of it disappears if yields get rarer; some may
   reappear in another stage. Sampling itself is much smaller: `shadowSample` (field sampling
   plus canvas-mask fallback) is 180–300 ms, and H1's `sweep` adds 170–530 ms.
2. **The search is the largest single cost on the long nav-static and cross-borough routes:
   3.3–8.3 s.**
   Compared with the 2026-09-20 measurement, before H1/H2's time-aware search with per-bucket
   fronts over up to 8 buckets, the same `walkPareto` phase is:

   | Scenario (warm) | 2026-09-20 | now | change |
   |---|---:|---:|---|
   | cross-borough | 3,099 | 5,199 | 1.7× slower |
   | nav-static cross-borough | 2,523 | 8,285 | 3.3× slower |
   | nav-static route-long | 1,316 | 4,032 | 3.1× slower |
   | route-long (keyless) | 1,632 | 726 | 2.2× faster |

   "Now" is pass 3's `search` stage (snap excluded), which spans the same `paretoRoutes` call
   that `walkPareto` times.

   Three of the four got markedly slower. The one that sped up has not been explained, and
   explaining it is part of L3's profiling.
3. **Reading shade from the canvas (`maskRead`) costs ~0.9–3.6 s, plus up to 1.5 s waiting for
   the map to redraw.** The fixtures leave 49–98% of edges below the field's confidence threshold, so
   the calculation falls back to reading the building mask. That share comes from the
   synthetic fixtures, not real NYC coverage. Re-measure on the published shards before
   acting on it.
4. **`fieldReady` (≈ 1.0–2.0 s)** waits for building data within the 2.5 s readiness budget.
   On the 2-point cold scenarios it is nearly the whole 1 s.
5. **Street data, graph build and snapping together are ≈ 0.1–0.6 s warm.** They are not the
   problem.

## Update — #266 landed (PR #268)

The sampling loop now yields only after ≥ 50 ms of work. Measured on the same bench (pass 3 above
vs a run with #268 + this instrumentation), p50 ms:

| Scenario | total before → after | `yield` before → after |
|---|---:|---:|
| route-long warm | 7,162 → 4,006 | 2,968 → 20 |
| cross-borough warm | 11,576 → 8,399 | 2,939 → 24 |
| nav-static route-long warm | 9,029 → 6,611 | 1,510 → 15 |
| nav-static cross-borough warm | 15,237 → 11,719 | 3,002 → 25 |

No yield time moved into `shadowSample`, and route options and graph sizes were unchanged. With
the yields gone:
- **`search` is the largest stage on six of the eight long-route scenarios:** 3.2–7.9 s on
  cross-borough and every nav-static run.
- **On keyless route-long it is not.** There `search` is 0.6–0.7 s, behind `maskRead`
  (1.0–1.2 s) and `fieldReady` (1.2 s).

## What it means for the Track L plan

- **New first fix: time-sliced yields** (#266): yield after ~50 ms of work instead of every 100
  edges. Expected: up to ~1.5–3 s off a long route, with no change to any answer. Its own
  before/after has to confirm how much yield time actually goes away rather than moving to
  another stage.
- **The search (L3, plus a look at H1's per-bucket fronts with Track H) moves ahead of L2.** At
  0.4–0.8 s of sampling plus sweep, precomputed shade (L2) saves less than the research
  assumed. Its case now rests on removing the canvas fallback (up to ~5 s with the map-redraw
  wait), so it needs the real-shard coverage measurement first.

## Caveats

- **The benchmark environment is not a phone.** SwiftShader under WSL, with synthetic
  fixtures. Ratios between stages are the useful part; absolute numbers are not phone numbers.
- **The yield clamp is inferred.** The ~4.4 ms per yield is derived from stage totals and edge
  counts in two route sizes, not timed per yield.
- **No in-app test of the stage sum.** `createLapTimer` is unit-tested; that a real
  `calculateRoute` records stages summing to `total` is shown by the benchmark, not a unit test.
- **The canvas-fallback share comes from the fixtures.** See point 3 above.

## Appendix — every scenario, p50 / p95 ms per stage (pass 3)

Verbatim from `npm run bench:route`. Keyless build (first table) and `nav-static` build (second). N = measured runs.

| Scenario | N | total p50 / p95 (ms) | setup+snapshot | streets | fieldReady | other | yield | exposureContext | shadowSample | sweep | graphBuild | snap | search | optionAssembly | transit | mapIdleWait | maskRead | attributed % (min) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2-point cold | 5 | 992.5 / 1027.2 | 0.3 / 0.5 | 23.4 / 28.6 | 919.1 / 922.4 | 0.2 / 0.3 | 8.1 / 17.9 | 0.2 / 0.3 | 12.9 / 23.9 | 12.9 / 44.5 | 2.5 / 7.8 | 2.2 / 4.6 | 8.6 / 16.7 | 0.2 / 0.4 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 100.0 |
| 2-point warm | 10 | 47.9 / 69.3 | 0.1 / 0.2 | 0.3 / 0.9 | 0.8 / 2.5 | 0.0 / 0.2 | 21.0 / 35.9 | 0.0 / 0.2 | 9.4 / 11.0 | 10.7 / 12.8 | 1.3 / 2.7 | 0.8 / 1.9 | 2.0 / 6.6 | 0.2 / 0.3 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 99.7 |
| 5-point cold | 5 | 1006.5 / 1048.1 | 0.8 / 1.9 | 20.8 / 24.5 | 923.1 / 930.3 | 0.4 / 0.7 | 23.0 / 42.9 | 0.2 / 0.3 | 19.6 / 41.4 | 0.0 / 0.0 | 4.2 / 7.9 | 8.7 / 10.8 | 4.4 / 9.2 | 0.0 / 0.3 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 99.9 |
| 5-point warm | 10 | 1027.8 / 1304.4 | 0.8 / 5.7 | 0.3 / 1.0 | 1.1 / 2.0 | 0.1 / 0.3 | 1007.5 / 1276.8 | 0.1 / 0.3 | 11.2 / 17.7 | 0.0 / 0.0 | 1.2 / 1.8 | 1.6 / 2.7 | 1.0 / 2.0 | 0.0 / 0.1 | 0.0 / 0.1 | 0.0 / 0.0 | 0.0 / 0.0 | 100.0 |
| transit-2pt fixture | 5 | 1052.6 / 1070.7 | 0.1 / 0.3 | 16.9 / 37.8 | 905.0 / 922.9 | 0.0 / 0.2 | 15.2 / 25.2 | 0.1 / 0.2 | 16.3 / 26.5 | 21.1 / 52.9 | 1.8 / 3.5 | 1.9 / 3.0 | 13.9 / 22.1 | 0.3 / 0.5 | 30.2 / 40.2 | 0.0 / 0.0 | 0.0 / 0.0 | 100.0 |
| transit-2pt NYC-scale | 5 | 1086.5 / 1113.0 | 0.1 / 0.2 | 11.3 / 16.3 | 918.8 / 920.0 | 0.2 / 0.3 | 9.7 / 11.8 | 0.1 / 0.2 | 16.7 / 20.5 | 26.6 / 32.8 | 2.3 / 3.4 | 1.4 / 1.8 | 14.6 / 17.1 | 0.2 / 0.5 | 95.3 / 110.8 | 0.0 / 0.0 | 0.0 / 0.0 | 100.0 |
| transit-2pt NYC-scale bus-only | 5 | 1124.4 / 1158.8 | 0.2 / 0.3 | 26.1 / 34.8 | 914.2 / 921.1 | 0.1 / 0.3 | 7.7 / 9.8 | 0.2 / 0.2 | 18.3 / 24.6 | 28.0 / 51.0 | 3.0 / 4.1 | 1.9 / 2.3 | 12.5 / 17.7 | 0.3 / 0.6 | 98.2 / 136.6 | 0.0 / 0.0 | 0.0 / 0.0 | 100.0 |
| transit-2pt warm | 10 | 109.1 / 129.9 | 0.2 / 0.5 | 0.4 / 0.8 | 1.0 / 3.1 | 0.1 / 0.3 | 24.0 / 40.2 | 0.1 / 0.2 | 10.9 / 15.1 | 19.7 / 23.1 | 1.3 / 1.8 | 0.7 / 1.4 | 5.5 / 17.3 | 0.2 / 0.4 | 33.0 / 52.6 | 0.0 / 0.0 | 0.0 / 0.0 | 99.7 |
| route-long cold | 5 | 7951.4 / 8092.2 | 0.1 / 0.3 | 192.4 / 235.4 | 1161.7 / 1194.0 | 4.2 / 4.5 | 2970.4 / 2975.2 | 0.2 / 0.3 | 297.4 / 319.8 | 311.9 / 328.2 | 326.5 / 374.1 | 119.7 / 155.7 | 643.3 / 709.8 | 1.0 / 1.5 | 67.5 / 84.9 | 766.6 / 798.3 | 1143.1 / 1178.2 | 99.9 |
| route-long warm | 10 | 7161.5 / 7329.6 | 0.2 / 0.8 | 32.1 / 174.0 | 1176.3 / 1265.4 | 1.6 / 5.8 | 2967.9 / 3030.8 | 0.0 / 0.2 | 247.3 / 274.1 | 248.1 / 273.4 | 215.1 / 257.7 | 113.5 / 143.3 | 726.5 / 848.6 | 0.8 / 1.1 | 13.0 / 30.5 | 0.0 / 0.1 | 1289.2 / 1443.0 | 99.9 |
| cross-borough cold | 5 | 12361.8 / 12412.2 | 0.1 / 0.5 | 198.5 / 225.0 | 1208.5 / 1259.8 | 4.0 / 4.3 | 2971.1 / 3028.5 | 0.1 / 0.2 | 281.1 / 288.9 | 223.4 / 247.2 | 343.8 / 405.2 | 115.1 / 121.8 | 4626.7 / 4837.1 | 1.8 / 2.1 | 49.6 / 62.6 | 648.0 / 691.5 | 1573.5 / 1703.4 | 100.0 |
| cross-borough warm | 10 | 11576.2 / 11726.9 | 0.2 / 0.6 | 25.4 / 161.2 | 1181.8 / 1236.3 | 1.3 / 9.4 | 2939.2 / 2981.3 | 0.0 / 0.1 | 228.4 / 237.4 | 174.5 / 238.1 | 203.3 / 277.9 | 109.7 / 122.8 | 5199.0 / 5399.2 | 1.3 / 1.6 | 26.3 / 33.9 | 0.0 / 0.1 | 1464.6 / 1523.8 | 99.9 |
| transit-2pt fixture warm | 10 | 104.6 / 138.6 | 0.2 / 0.3 | 0.3 / 2.4 | 1.0 / 2.8 | 0.1 / 0.2 | 24.9 / 45.6 | 0.1 / 0.2 | 10.1 / 12.3 | 20.4 / 25.1 | 1.2 / 2.7 | 0.6 / 1.6 | 9.6 / 24.3 | 0.2 / 0.4 | 28.1 / 41.0 | 0.0 / 0.0 | 0.0 / 0.0 | 99.8 |
| transit-2pt NYC-scale bus-only warm | 10 | 105.5 / 111.2 | 0.1 / 1.9 | 0.3 / 0.9 | 1.0 / 2.0 | 0.1 / 0.2 | 23.7 / 41.1 | 0.1 / 1.5 | 12.1 / 12.5 | 22.3 / 26.5 | 1.5 / 2.9 | 1.1 / 2.0 | 5.1 / 16.6 | 0.2 / 0.2 | 30.6 / 40.6 | 0.0 / 0.0 | 0.0 / 0.0 | 99.8 |

| Scenario | N | total p50 / p95 (ms) | setup+snapshot | streets | fieldReady | mapIdleWait | maskRead | other | yield | exposureContext | shadowSample | sweep | graphBuild | snap | search | optionAssembly | transit | attributed % (min) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nav-static 2-pt cold | 5 | 3800.1 / 3816.6 | 7.0 / 9.8 | 134.8 / 146.6 | 868.7 / 971.8 | 842.1 / 883.9 | 1346.6 / 1402.9 | 0.8 / 1.0 | 370.6 / 380.3 | 0.2 / 2.5 | 79.7 / 90.9 | 23.9 / 48.0 | 29.0 / 37.1 | 22.8 / 25.1 | 4.8 / 8.7 | 0.2 / 0.5 | 0.0 / 0.0 | 100.0 |
| nav-static 2-pt warm | 10 | 2565.9 / 2759.5 | 9.4 / 23.9 | 28.0 / 33.5 | 16.4 / 38.9 | 1023.2 / 1141.0 | 914.5 / 1039.7 | 0.4 / 1.0 | 420.8 / 467.6 | 0.1 / 0.2 | 57.5 / 79.1 | 26.6 / 35.2 | 31.8 / 40.1 | 17.6 / 30.5 | 3.3 / 8.1 | 0.1 / 0.2 | 0.0 / 0.0 | 99.9 |
| nav-static NYC-scale | 5 | 6262.8 / 6722.7 | 9.3 / 10.9 | 391.8 / 408.5 | 1712.5 / 1968.2 | 839.9 / 870.7 | 1143.3 / 1309.8 | 2.0 / 2.1 | 1444.9 / 1477.7 | 0.1 / 0.3 | 192.8 / 203.7 | 178.7 / 181.0 | 108.0 / 120.8 | 61.4 / 64.3 | 15.3 / 24.5 | 0.3 / 0.5 | 101.5 / 117.8 | 100.0 |
| nav-static route-long cold | 5 | 8787.3 / 9481.4 | 13.6 / 17.5 | 400.9 / 486.9 | 1066.0 / 1093.5 | 783.5 / 848.4 | 870.0 / 1182.7 | 1.6 / 2.1 | 1459.1 / 1487.9 | 0.1 / 0.2 | 183.6 / 223.4 | 504.3 / 578.3 | 119.8 / 130.8 | 59.5 / 65.8 | 3269.1 / 3496.6 | 1.5 / 2.6 | 45.9 / 65.8 | 100.0 |
| nav-static route-long warm | 10 | 9029.3 / 9351.5 | 8.8 / 16.1 | 157.9 / 181.9 | 1053.3 / 1105.5 | 0.0 / 0.1 | 1353.5 / 1429.9 | 0.9 / 3.1 | 1509.8 / 1611.3 | 0.1 / 0.4 | 179.7 / 206.6 | 507.7 / 554.5 | 84.9 / 326.6 | 52.8 / 71.8 | 4032.1 / 4307.9 | 1.1 / 1.6 | 19.0 / 33.9 | 100.0 |
| nav-static cross-borough cold | 5 | 15715.1 / 15748.5 | 8.8 / 17.4 | 777.2 / 812.9 | 1180.1 / 1206.4 | 636.4 / 656.0 | 1666.8 / 1710.1 | 4.1 / 5.1 | 2995.0 / 3050.3 | 0.2 / 0.3 | 303.1 / 334.3 | 527.5 / 590.8 | 242.9 / 280.7 | 123.0 / 154.2 | 7171.9 / 7332.0 | 2.2 / 2.6 | 48.0 / 85.5 | 100.0 |
| nav-static cross-borough warm | 10 | 15236.7 / 16332.6 | 10.3 / 15.1 | 297.5 / 321.6 | 1150.9 / 1205.8 | 0.0 / 0.2 | 1448.5 / 1661.5 | 1.6 / 5.6 | 3001.5 / 3059.1 | 0.1 / 0.2 | 258.4 / 315.4 | 474.2 / 577.5 | 170.2 / 206.1 | 110.5 / 127.2 | 8285.1 / 9205.9 | 2.0 / 2.3 | 21.9 / 30.2 | 100.0 |
| nav-static subway cold | 5 | 6288.9 / 6468.0 | 12.6 / 19.4 | 398.6 / 504.0 | 1690.7 / 1719.1 | 833.8 / 878.4 | 1182.3 / 1428.1 | 2.0 / 2.4 | 1472.8 / 1494.4 | 0.1 / 0.2 | 195.2 / 219.6 | 175.4 / 183.3 | 107.0 / 124.1 | 59.6 / 65.5 | 16.6 / 23.0 | 0.3 / 0.6 | 36.4 / 48.0 | 100.0 |
| nav-static subway warm | 10 | 9327.9 / 9892.7 | 15.3 / 41.0 | 143.5 / 177.7 | 1986.8 / 2031.3 | 1485.4 / 1918.0 | 3555.1 / 4144.3 | 0.8 / 2.9 | 1511.7 / 1568.5 | 0.1 / 0.3 | 190.1 / 229.4 | 180.4 / 212.2 | 82.8 / 130.6 | 61.3 / 73.0 | 12.1 / 15.4 | 0.2 / 0.3 | 26.2 / 32.5 | 100.0 |
| nav-static bus-only cold | 5 | 6455.9 / 6520.7 | 16.3 / 30.9 | 394.3 / 438.7 | 1717.8 / 1746.6 | 777.0 / 845.7 | 1399.6 / 1496.4 | 2.0 / 2.1 | 1485.8 / 1499.4 | 0.2 / 0.9 | 203.6 / 242.0 | 173.1 / 182.2 | 115.0 / 127.5 | 60.8 / 63.7 | 15.9 / 23.5 | 0.3 / 0.6 | 88.8 / 95.8 | 100.0 |
| nav-static bus-only warm | 10 | 9360.3 / 9658.8 | 18.5 / 38.2 | 138.2 / 164.4 | 1985.8 / 2025.0 | 1478.6 / 2128.0 | 3538.5 / 4207.5 | 0.9 / 2.4 | 1517.9 / 1589.9 | 0.0 / 3.1 | 188.9 / 239.1 | 181.8 / 196.2 | 83.0 / 121.6 | 60.8 / 74.0 | 15.1 / 21.4 | 0.2 / 0.3 | 31.8 / 40.9 | 100.0 |

## L3a — waste removed from `paretoRoutes` (#263)

Exact-semantics changes only, for finite inputs; the data layout is untouched (that is L3b).
The new early exits read a NaN coordinate differently from the old `&&` chains. Shard
nodes are rejected unless lat/lon are finite, and a NaN Overpass coordinate already makes a
NaN edge length, which never terminated in either version.

### What the profile showed

A seeded sidewalk lattice shaped like the production graph: two parallel sidewalk edges per street
direction, an 8 × 15-min `timeShadow` per edge, crossing penalty 15 m. It runs at 280 × 60
(16,800 nodes, 133,040 directed edges, a 22.9 km corner-to-corner pair). The case is committed as
`walk search — paretoRoutes, time-aware sidewalk lattice (L3)` in
`app/lib/__benchmarks__/navigationScale.bench.ts`. It was measured on Node 24 with
`--cpu-prof`, plus a counter-instrumented copy of the search.

| Count (time-aware, one search) | value |
|---|---:|
| heap pops | 842,252 (297,256 of them stale, evicted labels) |
| relaxations | 3,225,140 |
| labels created / accepted | 1,130,627 / 842,251 (~67 per node; static: ~32) |
| dominance pre-check iterations | **28,270,013** |
| destination-front scan iterations | 649,105 (88 prunes) |
| detour-budget prunes | 0 |

The per-relaxation dominance pre-check is the hot spot. The destination-front scan the L3
handoff suspected is not: it does about 2% as many iterations. Each pre-check scanned its
whole Pareto set (up to 20 labels), although the set is sorted by `distM` ascending and no
label past the candidate's `distM` can dominate it. Next came the heap: one comparator call per
sift step and one `{ labelId, f }` object per push, together ~13% of self time.

### What changed

- **Pre-check, eviction and destination-front scans stop at the sorted boundary.** All three
  sets are kept sorted by `distM` ascending.
- **`insertPareto` no longer re-runs the dominance scan.** The main loop's pre-check has just
  run the same predicate on the same set.
- **`NumericMinHeap`** (`app/lib/minHeap.ts`): keys and ids in growable typed arrays, with the
  sift logic copied line for line from `MinHeap`. Same pop order, ties included; a test
  interleaves 20k tied pushes and pops against `MinHeap`.
- **The pre-check reads its set without creating it.** An empty bucket is still created only
  when a label is inserted, so bucket creation order (and so destination-front order) is
  unchanged.

**Parity.** `paretoParity.test.ts` runs 161 seeded graphs and requires `toStrictEqual` output
from the new search and from a frozen copy of the pre-L3a search
(`paretoRoutesReference.fixture.ts`). The graphs cover static and time-aware runs, sun and
rain, walk/bike/scoot, caps 1–20, detour factors 1.1–3, `maxContinuousExposureSec`, and
integer lengths that force ties. The H4 oracle still pins 57.00 s (#246 untouched).

### Before / after

Node, the L3 lattice, median of 5 fresh-process runs:

| Lattice | static before → after | time-aware before → after |
|---|---:|---:|
| 8,400 nodes (140 × 60) | 827 → 420 ms | 2,655 → 1,943 ms |
| 16,800 nodes (280 × 60) | 1,711 → 1,038 ms | 4,315 → 2,971 ms |

`npm run bench:route` subset (`-g "route-long|cross-borough"`), same machine and environment as
above. `main` at `e0141ce` ("before") and this branch ("after") ran back to back. The `search`
stage, p50 / p95 ms:

| Scenario | before | after | change |
|---|---:|---:|---:|
| route-long cold | 687 / 701 | 438 / 497 | −36% |
| route-long warm | 741 / 816 | 517 / 599 | −30% |
| cross-borough cold | 4,465 / 4,553 | 3,627 / 4,357 | −19% |
| cross-borough warm | 5,400 / 5,870 | 3,926 / 4,724 | −27% |
| nav-static route-long cold | 3,475 / 3,567 | 2,437 / 2,481 | −30% |
| nav-static route-long warm | 3,838 / 3,979 | 2,562 / 2,637 | −33% |
| nav-static cross-borough cold | 6,850 / 7,175 | 4,542 / 4,605 | −34% |
| nav-static cross-borough warm | 8,563 / 8,779 | 5,384 / 5,462 | −37% |

Graph sizes (33,602 / 133,600 and 16,802 / 66,680) and route labels
(`[Shortest, Balanced, Most shadowed]`) are identical in both runs.

### What it means

L3a is not enough on its own: cross-borough search is still 3.6–5.4 s against L3's 100 ms.
After these fixes the profile is flat and memory-bound:
- ~1.1M label objects scattered across the heap
- five `Map` lookups and one allocation per relaxation

That is L3b's typed-array layout. The other lever is the label count itself, ~67 per node from
the per-bucket Pareto sets. That is Track H's semantics, not L's, and is recorded on #270.

## L3b — typed-array search core (#263)

`paretoRoutes` keeps its signature and now runs over `toCompactGraph` (`app/lib/compactGraph.ts`).
That is a CSR graph: offsets/targets typed arrays plus node coordinates and intersection flags.
It carries no destination or travel mode, so H3's one-to-many search and the L3c worker can use
the same form. Per search, `paretoRoutes` builds:
- per-edge mode cost, traversal seconds, and the exposure increment for each time bucket — each
  computed by the same function and in the same operand order as before, so every sum is
  bit-identical;
- struct-of-arrays labels with integer parent and edge indices;
- the Pareto sets as one array indexed by node × bucket, recording the order in which the
  destination's buckets were created, which the front's tie-breaks depend on;
- the heuristic as a precomputed array.

Result building is unchanged.

**Parity.** `paretoParity.test.ts` grows to 164 cases. The new ones cover:
- negative virtual ids, an edge target with no node record, and a destination with no record;
- a coordinate-less node on a candidate route;
- equal-length destination labels in out-of-order buckets — creation order is what breaks the
  tie.

The generator now also varies `timeShadow` length (short and empty series) and draws the static
factor independently of bucket 0. Mutating the bucket clamp, the empty-series fallback, the
static branch, the no-coordinate heuristic or the result front's bucket order fails cases; each
went unnoticed by the suite before. The H4 oracle passes.

Identical output holds for every input the app produces. Two degenerate options differ:
- `timeAware.bucketCount: 0` (the caller only sets `timeAware` with ≥ 1 bucket) returns no
  route;
- `maxLabelsPerNode: 0` returns a route where the old code threw.

### Before / after

Node, the L3 lattice, median of 5 fresh-process runs (pre-L3a reference vs this branch):

| Lattice | static | time-aware |
|---|---:|---:|
| 8,400 nodes (140 × 60) | 700 → 306 ms | 2,466 → 696 ms |
| 16,800 nodes (280 × 60) | 1,684 → 549 ms | 3,956 → 1,160 ms |

`npm run bench:route` subset, same machine and environment as above, `main` at `0fa4558`
(L3a merged) vs this branch, run back to back. `search` stage p50 / p95 ms:

| Scenario | L3a (main) | L3b | change |
|---|---:|---:|---:|
| route-long cold | 439 / 450 | 303 / 311 | −31% |
| route-long warm | 465 / 523 | 307 / 369 | −34% |
| cross-borough cold | 3,012 / 3,668 | 1,599 / 1,611 | −47% |
| cross-borough warm | 3,330 / 3,766 | 2,324 / 2,377 | −30% |
| nav-static route-long cold | 2,311 / 2,365 | 1,273 / 1,286 | −45% |
| nav-static route-long warm | 2,279 / 2,406 | 1,256 / 1,695 | −45% |
| nav-static cross-borough cold | 4,513 / 4,595 | 2,195 / 2,235 | −51% |
| nav-static cross-borough warm | 5,028 / 5,472 | 2,579 / 3,803 | −49% |

Graph sizes and route labels are identical in both runs.

Absolute numbers drift between bench sessions. Main's L3a figures here run up to ~17% (p50) below
the same code's figures in the L3a section above, with the largest drift on cross-borough cold.
Compare within one table, not across them. Chained across sessions, nav-static cross-borough
warm search went 8,285 ms (L0) → 5,384 (L3a session) and 5,028 → 2,579 (this session).

### Why it stops at ~1–2.5 s, not 100 ms

Profiled after the change, the remaining time is:
- the per-relaxation dominance scan over a Pareto set (~30%);
- the heap (~17%);
- label creation.

All three scale with the number of labels: ~1.1M on the 16.8k lattice, ~67 per node. Layout
cannot remove them. Two attempts confirmed this:
- **Pre-sizing the label columns** gained 2% and would reserve ~100 MB up front, so it was
  not kept.
- **Exact remaining-cost bounds** (reverse Dijkstras for distance and for minimum sun
  seconds), the one label reduction that might keep routes unchanged, were prototyped:

| Pair (16.8k lattice, time-aware) | labels | routes |
|---|---:|---|
| corner to corner, 22.9 km | 1,130,627 → 1,130,627 | identical |
| same column, 8 km | 825,748 → 656,233 | changed |
| diagonal, 3 km | 134,247 → 119,407 | changed |

Single-run timings moved within ±20% in either direction between repeats, so they are omitted:
the label counts and the route changes are what decide it.

Nearly every label lies inside the detour budget and is a real trade-off, and with ~40% of
edges fully shaded the best-case remaining sun is ~0 almost everywhere. Where the bounds did
prune, they changed routes: freed room under the 20-label cap let different labels survive.

So the remaining levers change routes. One is an approximate (ε-dominance) front; the other is
searching only for the three representatives shown, which is L4's shape. Both are recorded on
#270 for Track H and the owner. L's next step is L3c: the search moves to a worker, so the
remaining 1–2.5 s no longer blocks the main thread. L2 then removes ~4 s of shade work that is
not search at all.

## L3c — the search in a worker (#263)

`paretoRoutes` now runs in `app/workers/routing.worker.ts`. `useRouting` calls
`searchParetoRoutes` (`app/lib/routingWorkerClient.ts`), which:
- packs the post-snap routing graph into typed arrays (`app/lib/routingGraphCodec.ts`);
- transfers their buffers to the worker, which rebuilds the `Map` graph and runs the unchanged
  `paretoRoutes`;
- returns the `RouteResult[]`.

It is the same function on a bit-identical graph, so routes are unchanged by construction. The
codec test runs all 161 parity seeds plus the virtual-id case on the round-tripped graph. When
no worker is available (node, tests, construction failure, worker error), the search runs on
the main thread as before. The protocol (`app/lib/routingWorkerProtocol.ts`) is the one A5b and
H3 extend.

### Moving the search alone was not enough

The first bench pass after moving the search left 674–1,154 ms main-thread tasks overlapping the
search. A CPU profile and the long-task observer gave two causes:
- **The pack extended an existing task.** `graphBuild` → `snap` → pack ran with no yield in
  between, so the pack sat at the tail of a ~1 s synchronous block. A yield before the pack
  fixes that.
- **The pack is itself a long task.** Reading 134k edge objects costs ~50 ms in Node and ~130 ms
  in Chromium. The cost is spread evenly across numbers, tags and `timeShadow`, with no single
  hotspot. Two changes:
  - explicit field reads instead of keyed tag loads, and loops instead of
    `Array.from(subarray)`: Node pack 109 → 47 ms, worker unpack 206 → 49 ms;
  - the pack runs as a generator in ≤ 25 ms slices, checking the abort signal between slices, so
    a superseded calculation stops packing. Each calculation searches its own graph (Overpass and
    the static adapter both hand out fresh copies, `routingAdj` is per calculation), so nothing
    else mutates it mid-pack.

### Before / after

`npm run bench:route -g "route-long|cross-borough"`, run back to back on the same machine:
- **main** = `02ac5d7` plus only the `searchWindow` instrumentation;
- **L3c** = this branch.

`longest search task` is the longest main-thread long task (> 50 ms) overlapping the search
window, max over runs. Other cells are p50 ms.

| Scenario | longest search task, main → L3c | search, main | searchPack + search, L3c | total, main → L3c |
|---|---:|---:|---:|---:|
| route-long cold | 1,202 → **0** | 316 | 133 + 418 | 4,865 → 5,052 |
| route-long warm | 969 → **0** | 325 | 100 + 461 | 3,915 → 4,191 |
| cross-borough cold | 2,379 → **0** | 1,669 | 112 + 1,740 | 6,397 → 6,586 |
| cross-borough warm | 2,886 → **0** | 2,369 | 84 + 2,546 | 5,925 → 6,701 |
| nav-static route-long cold | 2,157 → **0** | 1,357 | 50 + 1,409 | 5,707 → 5,906 |
| nav-static route-long warm | 2,468 → **0** | 1,762 | 68 + 1,543 | 5,062 → 5,144 |
| nav-static cross-borough cold | 3,344 → **0** | 2,259 | 140 + 2,410 | 7,819 → 7,946 |
| nav-static cross-borough warm | 4,268 → **0** | 3,379 | 89 + 2,852 | 7,483 → 7,450 |

Graph sizes and route labels are identical in both runs.

- **No main-thread long task overlaps the search in any run.** Before, the main thread was
  blocked for the whole search, 1–4 s.
- **Wall time is about the same or slightly longer:**
  - total median −0.4% to +13%, mostly +2–7%;
  - the time-sliced pack adds 50–140 ms, and the worker's unpack and transfer add ~100–250 ms
    on the keyless routes.
  
  The main thread is free for all of it. The cross-borough warm +13% also includes +254 ms of
  `maskRead`, which L3c does not touch. Treat it as session noise.
- **The search itself is no faster.** 100 ms still needs route-changing options (#270).

### Browser check on real data

This used a production build (`vite build` + `vite preview`) with the staging navigation and
shadow bases, `--disable-web-security` and SwiftShader. The trip was UES → Astoria (Madison/E
77th → 40.7643, −73.9377), on a 98,180-node graph.

| | main | L3c |
|---|---|---|
| longest main-thread task during the search | **10,027 ms** (no frame painted) | ~900–1,400 ms, the same as idle |
| "Finding route choices" visible | never painted | yes |
| timeline drag during the search | impossible (main thread frozen) | URL time changed twice inside the search window |

On this machine the map alone produces ~850–900 ms long tasks with no calculation running (3–5
per 5 s idle). SwiftShader renders full-NYC shadow frames in software, and the keyless bench
avoids this by serving fixture tiles. So the L3c column reads "nothing above idle rendering",
not "no long tasks".

**Open: pack wall time depends on frame cost.** The sliced pack yields to rendering between
slices. Here each yield waits behind a ~900 ms software frame, so the pack took 2.3–10.9 s of
wall time. With a reshadow from a mid-search drag it took the longest. On GPU hardware frames
are ~16 ms and the pack should take a few hundred ms, but that has not been measured. It is the
first thing to check by hand in `npm run dev`.

**Also open:** L3c clears the search, not the whole calculation. The sweep → graphBuild → snap
block before it still runs without a yield (85–470 ms graphBuild + snap in the stage table, plus
the sweep), and `longestSearchTaskMs` starts counting at the search. That block is the next
main-thread target.

## Update — production does not match this bench (#286)

Every number above comes from `npm run bench:route`, whose fixtures carry a handful of synthetic
buildings. On **production**, with the app's own phase breakdown, a real 6 km route (UWS→FiDi,
2026-10-05) took **37.0 s**, split:

| Stage | Transit mode | Walk mode |
|---|---:|---:|
| `sweep` (H1 time-aware shadow) | **23,518 ms** | **23,387 ms** |
| `streets` | 4,682 | 5,401 |
| `search` | 3,627 | 3,670 |
| `shadowSample` | 2,339 | 2,277 |
| `transit` | 1,837 | 2,046 |
| `graphBuild` | 393 | 414 |
| **total** | **37,016 ms** | **37,843 ms** |

The sweep is **63% of the calculation**, and walk mode pays it identically, so it is not a
transit cost. It is `edges × buckets × steps × prisms-per-cell` — a shadow query every 25 m on
both sidewalks, × up to 8 buckets, ≈ 3.7M queries — so it scales with **real building density**,
which the fixtures do not have. This bench measures the same sweep at 170–530 ms, a **~50×
understatement**.

**Read this bench for relative stage movement, never for absolute shade cost.** The production
phase breakdown (`window.__umbraMetrics.history[].phases`, available in any environment) is the
one to plan L2 against: killing the sweep plus `shadowSample` takes a long route from 37 s to
about 11 s.

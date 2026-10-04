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

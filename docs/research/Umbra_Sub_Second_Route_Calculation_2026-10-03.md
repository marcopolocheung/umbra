# Precompute shade, flatten the graph, route sub-second

Production routers reach sub-second answers in two ways. Most of the heavy work happens before any query arrives, and the query itself runs over compact, cache-friendly data that is already in memory. On a continent, plain Dijkstra takes about 2 s; Contraction Hierarchies (CH), Customizable Route Planning (CRP/MLD, which Bing runs) and Customizable CH (CCH) cut that to 0.1–2 ms. Transit planners such as RAPTOR, CSA, Trip-Based, Google's Transfer Patterns and OpenTripPlanner 2 answer city queries in 1–10 ms. Each pays for that speed with a split: per-query street search to nearby stops, precomputed stop-to-stop transfers, and a timetable scan over flat arrays.

Most of that speed does not transfer to Umbra, but not for the reason it seems. Umbra's walking graphs (17k–34k nodes) are 500–1,000× smaller than the graphs that need hierarchies. A typed-array JavaScript Dijkstra crosses a graph of that size in about 3 ms. So Umbra's 8–12 s for a 5.7–11 km route is not a missing-algorithm problem, and the cost lies elsewhere:

- It recomputes building shadow for every edge on every request, which takes 1.8–3.7 s.
- It runs a bi-criteria label search over `Map`s of objects, which takes 1.3–3.1 s.
- In production it fetches the street graph live from Overpass instead of from the static shards it already has.
- About 3 s per long route is not attributed to any phase at all.

Every shipped shade router examined (shadewalker.nyc, HeiGIT's shaded openrouteservice, CoolWalks, MIT's Dubai study, ShadeWalk Singapore) precomputes shade per edge per time slot offline and runs one plain Dijkstra per preference. That is the design Umbra should copy.

The prioritized fix, in order:

1. Instrument the missing ~3 s.
2. Turn on the static shards with persistent caching.
3. Replace live per-edge shadow sampling with a precomputed per-edge, per-hour shade table.
4. Rewrite the search over CSR typed arrays, with a bounded set of preference searches instead of an open-ended Pareto search.

Each step is evidenced below. Its gain is inferred from published numbers or a Node microbenchmark, not measured in Umbra's browser.

## Road engines buy milliseconds with preprocessing tied to one cost

The reference comparison is the Bast et al. survey's Western Europe benchmark (18M vertices, single 3.33 GHz core). Dijkstra takes **2.2 s** there and bidirectional Dijkstra 1.2 s. CH answers in **0.11 ms** after 5 minutes of preprocessing, CRP in **1.65 ms** after an hour, and hub labels in **0.56 µs** using 18.8 GiB ([Bast et al. 2016](https://arxiv.org/abs/1504.05140)). The survey concludes "there is no best technique," and it observes that "in a real system, however, most queries tend to be local."

The technique families differ less in raw speed than in what happens when the cost function changes:

- **CH** bakes the metric into its shortcuts. A new metric means recontracting, which takes minutes to hours. CH is also 6–8× slower on non-travel-time metrics.
- **CRP/MLD** splits preprocessing into a metric-independent partition and a fast "customization." Customization takes **0.37 s** for Europe on 12 cores and 36 ms on a GPU, "fast enough to even support user-specific cost functions" ([Bast et al.](https://arxiv.org/abs/1504.05140)).
- **CCH** applies the same split to contraction. A city the size of Stuttgart (~110k vertices) customizes in **49 ms single-threaded** and answers in **14–23 µs** ([Bläsius et al. 2025](https://arxiv.org/abs/2502.10519)).

The industry evidence is uneven:

- **Bing.** Microsoft states CRP is "the core of the routing engine currently in use by Bing Maps" ([Microsoft Research](https://www.microsoft.com/en-us/research/publication/customizable-route-planning-in-road-networks/)). No Azure Maps architecture source was found.
- **Google** publishes on what feeds the search, not on the search itself:
  - A graph neural network predicts ETAs that rank candidate routes the existing router produces ([DeepMind 2020](https://deepmind.google/discover/blog/traffic-prediction-with-advanced-graph-neural-networks/)).
  - Its inverse-reinforcement-learning route-quality work learns per-edge rewards, then serves the highest-reward path, which "can be efficiently computed via Dijkstra's algorithm" ([Barnes et al. 2023](https://arxiv.org/abs/2305.11290)).

  The pattern for a shade router is a fast single-criterion search over a learned or weighted cost, followed by a re-ranking stage.
- **Apple Maps:** no public routing-architecture source was found.

The open-source engines follow the same split:

- **OSRM** offers CH (0.58 ms average on a Poland extract) and MLD (2.27 ms). It recommends MLD by default because MLD absorbs traffic updates through `osrm-customize`, and it supports no per-request weights ([OSRM PR #6929](https://github.com/Project-OSRM/osrm-backend/pull/6929); [OSRM wiki](https://github.com/Project-OSRM/osrm-backend/wiki/Running-OSRM)).
- **GraphHopper** must disable CH to accept a per-request custom model. Its landmark (LM) mode accepts a model only if it "cannot decrease any edge weight." With 64 landmarks, LM is 36× faster than A* on Germany ([GraphHopper custom models](https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md); [GraphHopper blog](https://www.graphhopper.com/blog/2017/08/14/flexible-routing-15-times-faster/)).
- **Valhalla** computes costs at query time with no metric preprocessing ("dynamic costing"). Per-request pedestrian knobs include `use_lit`, the nearest analogue to a shade preference. Valhalla's pedestrian routes "never transition to the arterial or highway levels," so walking in Valhalla is plain bidirectional A* ([Valhalla dynamic costing](https://valhalla.github.io/valhalla/concepts/costing/dynamic-costing/); [Valhalla path algorithm](https://valhalla.github.io/valhalla/contributing/architecture/thor/path-algorithm/)).
- **The phone engines.** Organic Maps uses A* for pedestrians over a compressed intersection ("joint") graph; it uses precomputed cross-region "leaps" for cars only ([Organic Maps index_router.cpp](https://github.com/organicmaps/organicmaps/blob/master/libs/routing/index_router.cpp)). OsmAnd's new hierarchical routing precomputes a partition based only on passability, then refines each shortcut with A* so that profile penalties still apply ([OsmAnd blog](https://osmand.net/blog/fast-routing/)).

Pedestrian networks have no highway hierarchy. None of these engines uses a hierarchy for walking.

Time dependence and multiple criteria are where preprocessing breaks down.

**Time dependence.** Time-dependent CRP stores piecewise-linear functions on its shortcuts. Exact customization ran out of 64 GiB on Europe. The approximated version takes 110–445 s to customize and 3.6–6.3 ms per query, about 300× costlier to customize than static CRP ([Baum et al.](https://arxiv.org/abs/1512.09132)). Valhalla supports time-dependent routing only as a unidirectional search.

**Multiple criteria.** Exact Pareto search stays fast only while the Pareto sets stay small, and those sets can grow exponentially. On the DIMACS NY road graph (264k nodes), bi-objective Dijkstra averages **1.47 s, with a 17 s worst case**. BOA* averages 0.22 s and BOBA* 0.08 s, in C ([Ahmadi et al. 2021](https://arxiv.org/abs/2105.11888)).

Production systems avoid true Pareto search. They either fix the weighting per query or generate alternatives with via-node rules. OSRM, for example, keeps an alternative only if it is at most 15–25% longer and shares at most 75% of its length with the best route ([OSRM alternative_path_ch.cpp](https://github.com/Project-OSRM/osrm-backend/blob/master/src/engine/routing_algorithms/alternative_path_ch.cpp)). The survey recommends optimizing a linear combination with the weight set at query time instead of a Pareto set ([Bast et al.](https://arxiv.org/abs/1504.05140)).

| Technique | Precomputes | When cost changes | Published query | Survives Umbra's per-query, sun-dependent cost? |
|---|---|---|---|---|
| Dijkstra / bidirectional A* (Valhalla walk, Organic Maps walk) | nothing | nothing | Europe 1.2–2.2 s; 120k-node city 6 ms | Yes, fully |
| ALT / landmarks (GraphHopper LM) | landmark distance tables | valid if weights only increase | Germany 33–72 ms | Yes, if landmarks are built on plain length and every query cost is ≥ length |
| CH (OSRM CH) | metric-specific shortcuts | full recontraction (minutes–hours) | 0.11 ms | No |
| CRP / MLD (Bing, OSRM MLD) | partition + overlay | customization, 0.37 s Europe | 1.65 ms | Yes, re-customized per time slot / weight |
| CCH | nested-dissection order | customization, 12–49 ms city | 14–23 µs city | Yes, the best fit if Umbra ever needed it |
| Hub labels, TNR, arc flags | metric-specific labels/tables | full rebuild | 0.25–408 µs | No |
| Bi-objective A* (BOA*/BOBA*) | heuristic searches | nothing | NY 0.08–0.22 s avg, up to 1.7 s | Yes, but with heavy-tailed latency |

All figures except OSRM's are lab benchmarks of C++ on server CPUs. OSRM's come from GitHub CI runners. None is production telemetry, and none was measured in JavaScript.

## Transit planners split street search from a timetable scan

The algorithms that power real journey planners need little or no preprocessing. Their speed comes from scanning flat timetable arrays without a priority queue.

**RAPTOR** works in rounds. Round k scans each route at most once to find the best arrival at every stop using k trips. Rounds then relax footpaths, which RAPTOR requires to be transitively closed and of constant walking time. It returns the arrival × transfers Pareto set in **7.3 ms on London** and **3.1 ms on NYC 2011** (17.9k stops, 1.83M departures) ([Delling, Pajor, Werneck 2012](https://www.microsoft.com/en-us/research/wp-content/uploads/2012/01/raptor_alenex.pdf)). Each extra criterion or departure window costs 10–40×: McRAPTOR with fare zones runs 107 ms on London, and a 2-hour range query 87 ms.

**CSA** (Connection Scan Algorithm) sorts every elementary connection by departure time and scans them once. Earliest arrival takes **1.2 ms on London**, and a full-day profile with Pareto on transfers 10.7 ms. Its fast "limited walking" pruning only works if footpaths are transitively closed ([Dibbelt et al. 2017](https://arxiv.org/abs/1703.05997)).

The preprocessing-heavy methods go faster still, but they freeze the walking metric:

- **Trip-Based** precomputes trip-to-trip transfers: 30 s on 16 threads for London. It then answers in 1.2 ms, or 70 ms for a full-day profile ([Witt 2015](https://arxiv.org/abs/1504.07149)).
- **Transfer Patterns** has run Google Maps transit "since 2010" ([Bast et al. survey](https://arxiv.org/abs/1504.05140)). On a 2010 NY instance it needed **724 core-hours** of precomputation and about 1.6 GB of patterns. Location-to-location queries then took about **50 ms** ([Bast et al. ESA 2010](https://ad-publications.cs.uni-freiburg.de/ESA_transferpatterns_BCEGHRV_2010.pdf)).
- **ULTRA** precomputes a small set of transfer shortcuts that is provably sufficient over an *unrestricted* walking graph (18 min on 16 cores for London). Door-to-door queries take 2.7–6.2 ms ([Baum et al. 2019](https://arxiv.org/abs/1906.04832)). Changing walking speed requires recomputing the shortcuts.
- **McULTRA / McTB** add walking time as a third Pareto criterion, the closest published precedent to treating walking discomfort as its own objective. The full three-criteria set takes 79 ms on London and averages 30.5 journeys. Restricted Pareto sets, which allow 1.25× slack against anchor journeys, bring that to 15.5 ms and 12.5 journeys ([Potthoff & Sauer 2021](https://arxiv.org/abs/2110.12954)).

No paper was found that runs ULTRA, Trip-Based or Transfer Patterns with a time-dependent walking cost.

Deployed planners converge on one three-part shape:

- **OpenTripPlanner 2** replaced A* with Range-RAPTOR. It searches the street network per query to at most 500 access stops within 45 minutes, precomputes stop-to-stop transfers up to 30 minutes at graph-build time, and runs a RAPTOR core ([OTP Raptor design](https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/raptor/router/src/main/java/org/opentripplanner/raptor/package.md); [OTP RouteRequest](https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/doc/user/RouteRequest.md); [OTP BuildConfiguration](https://github.com/opentripplanner/OpenTripPlanner/blob/dev-2.x/doc/user/BuildConfiguration.md)). Its own SpeedTest shows the price of each criterion: Range-RAPTOR **80 ms**, multi-criteria with a generalized cost **400 ms**, and **1,000 ms** once walking distance becomes a separate Pareto criterion. OTP recommends slack dominance (`c1 < c1' + slack`) over a true second criterion and post-filters Pareto sets that reach about 500 paths.
- **Navitia's** C++ core, Kraken, is RAPTOR-based. It publishes no latencies ([Navitia](https://github.com/hove-io/navitia)).
- **The Transit app** has planned trips offline on-device since 2019. It compresses GTFS 30–200× and precomputes walking transfers within 1 km and 20 minutes. At query time it computes walking directions only from the origin to nearby stops and from nearby stops to the destination ([Transit app blog](https://blog.transitapp.com/how-we-shrank-our-trip-planner-till-it-didnt-need-data-84984ca56663/)).
- **Citymapper:** no primary engineering source could be retrieved.

The pattern matters for Umbra because it shows where a time-varying shade cost fits without breaking anything. Access and egress walks are searched per query, so shade there can be exact and time-aware. Transfers are precomputed everywhere, so shade on transfers needs either per-hour tables or a re-score after the search.

The browser has already proven able to host this:

- **minotor** runs a TypeScript RAPTOR in a Web Worker over the full Swiss feed: 20 MB per day uncompressed, 5 MB compressed ([minotor](https://github.com/aubryio/minotor)). **SwissReach** builds on it to compute full-network isochrones "in a few milliseconds" with no backend ([SwissReach](https://github.com/filippofinke/swissreach)).
- **vulture**, a Rust RAPTOR with a ~290 KB gzipped WASM build, answers Paris queries in 0.9–19 ms natively ([vulture benchmarks](https://github.com/urschrei/vulture/blob/main/docs/cross-city-benchmarks.md)).

A current NYC MTA weekday has 1.98M stop events across subway and buses, counted from local GTFS. That is the same order as the 2011 instance RAPTOR handled in 3 ms. In typed arrays it would take roughly 20 MB per service day; that figure is an estimate, not a measurement.

## JavaScript is not the bottleneck at Umbra's graph size

The browser numbers place a well-built JS search over 34k nodes in milliseconds:

- **ngraph.path** (JavaScript) answers the 264k-node DIMACS NYC graph in **44 ms** on average with bidirectional NBA*. Dijkstra on the same graph takes 264 ms ([ngraph.path](https://github.com/anvaka/ngraph.path)).
- **Valhalla compiled to WASM**, in a browser worker, routes a warm 21.8 km route in **16.8 ms on Chromium**. A cold route takes about 0.5–1.5 s, dominated by module and tile load ([valhalla-wasm benchmarks](https://github.com/tobilg/valhalla-wasm/blob/main/docs/regional-benchmarks.md)).

A microbenchmark run for this report (Node 20, not a browser) used an Umbra-sized grid of 34,225 nodes:

| Graph representation | Time per search |
|---|---|
| Umbra-style `Map<number, edge-object[]>` with an object heap | 28.6 ms |
| CSR in typed arrays with a typed-array binary heap | 3.3 ms |

CSR means compressed sparse row: one `Uint32Array` of per-node offsets and parallel typed arrays of edge targets and attributes. It was **8.6× faster**, and the gap grew to 11× at 270k nodes.

Even the slow representation is 50–100× faster than Umbra's measured 1.3–3.1 s search phase. The search phase is therefore not slow because JavaScript is slow. It is slow because of what Umbra's search does:

- `paretoRoutes` keeps up to 20 labels per node as objects, inserting into and removing from plain arrays, inside `Map`s.
- It first runs a separate distance-only Dijkstra to set a detour budget.
- The multi-stop path loops over several shade strengths, one search each.

Source: [`app/lib/routing.ts`](../app/lib/routing.ts). The V8 team's own guidance points the same way: since pointer compression, V8 recommends "storing data in Float64 TypedArrays, or even by using Wasm" for throughput-heavy numeric code ([V8 blog](https://v8.dev/blog/pointer-compression)).

WASM is not the first lever:

- One study found WASM 8–27× faster than JS on small inputs, but *slower* on 18 of 41 medium-input benchmarks, with 3–6× more memory ([Benchmarking WebAssembly](https://benchmarkingwasm.github.io/BenchmarkingWebAssembly/)).
- `valhalla.wasm` alone is 7–11 MiB to download.

The browser constraints that actually bind are memory, storage and threading:

- **Memory.** iOS Safari killed a page at about **100 MB on an iPhone SE** and about 200 MB on an iPad, with no catchable exception ([Lapcat Software 2026](https://lapcatsoftware.com/articles/2026/1/7.html)). The routing working set has to stay well below that.
- **SharedArrayBuffer** needs cross-origin isolation (COOP/COEP). Safari still lacks COEP `credentialless` ([MDN browser-compat-data](https://github.com/mdn/browser-compat-data)), so isolation would force every MapTiler, shard and proxy response to carry CORS or CORP headers. That is a large blast radius for running a few searches in parallel. Workers can each hold their own ~1 MB copy of a CSR graph instead.
- **Transfer.** Transferred `ArrayBuffer`s cross to a worker in constant time ([Surma](https://surma.dev/things/is-postmessage-slow/)).
- **Storage.** OPFS is in every engine since Safari 15.2. Safari 17 lets an origin use up to 60% of disk ([WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)). Safari still evicts script-written storage after 7 days without interaction unless the site is installed ([web.dev storage](https://web.dev/articles/storage-for-the-web)).
- **Compression.** Brotli is missing from Chrome's `DecompressionStream`, so it must arrive as HTTP `Content-Encoding`.
- **Scheduling.** Safari has neither `requestIdleCallback` nor `scheduler.yield`, so idle prefetch falls back to `setTimeout` ([web.dev long tasks](https://web.dev/articles/optimize-long-tasks)).

## Every shipped shade router precomputes shade per edge per time slot

Umbra is alone among the comparable systems in computing shade at query time.

**shadewalker.nyc**, the closest comparable, is server-side. Its offline pipeline samples each of 488,677 NYC sidewalk edges every 5 m in three lanes against building shadows within 1 km. It does this for a 12-month × 24-hour sun table, which takes **about 4.5 hours**, and stores **288 uint8 shade values per edge**: one 54 MB export for the whole city.

At query time it works like this:

1. Blend the four slots around the requested date and minute.
2. Combine trees and buildings by union.
3. Run one igraph C Dijkstra per preset. Each takes about **10 ms for 1 km and 95–115 ms for 20 km**.

All four presets come back together in about 0.4–0.8 s ([shadewalker README](https://github.com/camrynobscura/shadewalker); [graph_store.py](https://github.com/camrynobscura/shadewalker/blob/main/server/graph_store.py)).

**HeiGIT's shaded openrouteservice** covers 136 European cities with 16 fixed shade columns (four dates × four times). It stores **one byte per column per edge** and lets the request pick a column and a factor ([HeiGIT 2026](https://heigit.org/shadow-data-for-climate-resilient-urban-planning/); [HeatStressWeighting.java](https://github.com/GIScience/openrouteservice/blob/main/ors-engine/src/main/java/org/heigit/ors/routing/graphhopper/extensions/weighting/HeatStressWeighting.java)).

The academic and hobby systems follow the same design. Each precomputes per-edge shade at fixed time steps and routes with plain Dijkstra, holding time fixed for the trip:

| System | Time resolution | Notes |
|---|---|---|
| CoolWalks | 15-minute steps | Manhattan walk network of 8.7k nodes ([Wolf et al.](https://arxiv.org/abs/2405.01225)) |
| MIT, Dubai | hourly windows, three dates | ([Wen et al.](https://senseable.mit.edu/papers/pdf/20250911_Wen-etal_WalkingSmart_CEUS.pdf)) |
| ShadeWalk, Singapore | 24 hourly rasters | ([ShadeWalk](https://github.com/Shawnzhang7829/ShadeWalk)) |

None of them publishes query latency.

The lone exception is the norain bike router. It traces horizons per edge at query time inside GraphHopper's time-dependent A*, caching the horizons across requests, and publishes no numbers ([norain PR #24](https://github.com/mnboos/norain/pull/24)).

Two design details matter for Umbra.

**The time resolution users tolerate is coarse.** These systems use hourly, four fixed times, or 15 minutes. Umbra's own A6 work explains why this matters. The irreducible cost of live sampling is the per-instant point-in-shadow query, so a 14-hour sweep costs **~21× one hour**, not less than 2× ([performance baseline, Time Sweep A6](../docs/notes/performance-baseline.md)). A table indexed by time costs the same for one hour as for fourteen.

**The cost function decides which speedups stay legal.** shadewalker's `length / (1 + w·density)` discounts shaded edges below their length, which makes a straight-line A* heuristic inadmissible. Umbra's `dijkstra` does the same: cost = length × (1 − strength × shadow × 0.7 × solarIntensity), which can fall to 0.3 × length.

That discount is algebraically equivalent to a penalty form. With k = strength × 0.7 × solarIntensity < 1, the cost is (1 − k) × [length + (k / (1 − k)) × length × sunFraction]. Dividing every edge cost, crossing penalties included, by the per-query constant (1 − k) does not change which path wins. The rescaled cost is then always ≥ length, so straight-line A* and length-based landmarks (ALT) become admissible for every strength and every hour. This is GraphHopper's "weights only go up" condition, reached without changing a single route.

## Umbra's eight to twelve seconds is mostly self-inflicted

Checkpoint 6 measured the cost on 2026-09-20, before H1/H2 added time-aware Pareto search ([checkpoint 6 note](../docs/notes/nyc-navigation-checkpoint6-2026-09-20.md)). The setup: headless Chromium on SwiftShader under WSL, synthetic lattice fixtures of 16,802 nodes / 66,680 directed edges ("route-long") and 33,600 / 133,600 ("cross-borough"), medians of three passes. Seen through the industry lens, the timings separate into four problems, not one.

**Shard transfer** (static path, cold): 1.03 s for four street shards (~7 MiB on the wire) and 3.9 s for eight (14.5 MiB). Warm it is 0 after the decoded-cache tuning. Graph merge still costs 113–279 ms warm, and production does not use this path at all: `VITE_NAVIGATION_BASE` is unset, so production fetches streets from live Overpass. There is a related cost hidden inside "graph fetch": field readiness stays at about **1.0 s even warm**.

**Shadow sampling** costs 1.8–3.7 s on every request, cold or warm. It samples every edge in the graph from building geometry *before* the search starts, so it scales with graph size, not route length.

**Search** (`walkPareto`) costs 1.3–3.1 s. That is about 400–900× the 3.3 ms a CSR Dijkstra takes on a graph this size.

**Unattributed time** is the largest single unknown. Subtracting graph fetch, sampling, search and transit fetch from the p50 total leaves:

| Scenario | Unattributed |
|---|---|
| route-long, keyless cold | ~3.0 s |
| cross-borough, keyless cold | ~3.1 s |
| route-long, keyless warm | ~4.0 s |
| nav-static route-long, cold | ~3.2 s |

These are subtractions of medians, so they are approximate. The span is unmeasured; it could be result statistics, exposure refresh, rendering or awaits.

Each technique maps onto these costs as follows:

- **Shard transfer.** The OsmAnd/Valhalla-WASM lesson applies: a long-lived worker that holds decoded tiles turns a 0.5 s cold route into a 2–17 ms warm one. Persisting decoded shards in OPFS or the Cache API and prefetching them when a destination is picked gets the same effect across sessions. Shipping the graph pre-merged as CSR columns makes "decode" a typed-array view and "merge" disappear.
- **Shadow sampling.** The shadewalker/ORS precomputed table replaces seconds of geometry with a slot blend costing well under 10 ms. That is an estimate from shadewalker's vectorized blend; Umbra has not measured it.
- **Search.** CSR and typed-array labels attack the representation. A fixed ladder of weighted searches attacks the search count, much as shadewalker runs one Dijkstra per preset, OTP prefers slack dominance, and the Pareto literature collapses correlated objectives with ε-dominance ([Halle et al. 2025](https://arxiv.org/abs/2505.22244)). Rescaled-cost A* adds the 4.8–6× goal-direction gain ngraph measured on NYC.

The heavy road machinery (CH, CRP, CCH, hub labels) and the heavy transit preprocessing (Transfer Patterns, ULTRA, Trip-Based) solve a problem Umbra does not have at 34k nodes. Each also fights a cost that changes with every query.

| Priority | Technique (industry source) | Umbra cost it attacks | Expected effect (evidence grade) |
|---|---|---|---|
| 1 | Instrument the unattributed span before changing algorithms (OTP SpeedTest-style phase accounting) | ~3 s unattributed | Unknown until measured; it is the largest single block |
| 2 | Turn on static shards in production (publish pointer, set `VITE_NAVIGATION_BASE`); persist decoded shards in OPFS/Cache API; keep them in a long-lived worker; prefetch on destination select (valhalla-wasm, Transit app) | Shard transfer 1.0–3.9 s; live Overpass in production | Warm and repeat-visit transfer goes to 0 (already measured warm); first visit stays network-bound |
| 3 | Precompute per-edge shade per (month, hour) as uint8 columns in the shard; blend 2–4 slots at query time; fetch only the needed slot columns (shadewalker, HeiGIT/ORS, PMTiles-style range reads) | Shadow sampling 1.8–3.7 s; also makes H1's traversal-time pricing a per-edge lookup, not N× a sample | Seconds → milliseconds (inferred from shadewalker); needs an offline build validated against the live `ShadowField` |
| 4 | CSR typed-array graph, typed binary heap, preallocated search state, typed-array label pool for Pareto (V8 guidance, ngraph pooling) | Search 1.3–3.1 s and merge 113–279 ms | 8.6–11× per search in Node (own microbenchmark, not browser) |
| 5 | Replace the open-ended Pareto search with a fixed weighted ladder (e.g. 3–4 strengths) or ε-/slack-bounded labels; rescale cost so it is ≥ length; use A*, later ALT on length (shadewalker presets, OTP slack, GraphHopper LM rule) | Search, and the H1/H2 search added after this measurement | A* 4.8–6× (ngraph, JS); ALT 17–36× (GraphHopper, Java, Germany); bounded latency instead of a heavy tail |
| 6 | Transit: RAPTOR over typed arrays in a worker, shade-aware access/egress per query, per-hour transfer shade tables, shade folded into a generalized cost with slack (OTP2, Transit app, minotor) | Not a measured bottleneck in the fixture bench (train search 0–5 ms) | Do it when real NYC GTFS (2M events/day) replaces fixtures; RAPTOR at 3 ms native for NYC 2011 suggests 5–50 ms in a worker (estimate) |
| — | Don't adopt: CH, hub labels, Transfer Patterns, ULTRA, Trip-Based transfer reduction, SharedArrayBuffer, a WASM rewrite | — | Each needs a fixed metric or a large platform cost; CCH stays the fallback only if Umbra moves to a whole-city graph |

The caveats are real and should travel with these numbers:

- **Lab, not production.** Every published engine latency here is a lab benchmark on server CPUs in C++, C, Java or Rust; OSRM's come from CI runners. None is production telemetry: no source was found for Google's or Apple's search, Azure's, or Citymapper's.
- **C++ versus JS.** The JS evidence is thin. ngraph is the only published JavaScript point. The 8.6× CSR figure comes from this report's own Node microbenchmark on a synthetic grid, not a browser. Mobile browsers ran 2.3–8.7× slower than desktop in the one study found.
- **Fixtures, not NYC.** Umbra's own numbers come from synthetic lattice fixtures on SwiftShader in WSL, not real NYC shards on a phone. Live Overpass in production is likely slower than the keyless fixture "twin."
- **Stale baseline.** The measurements predate H1/H2, so the current search cost is unknown and probably higher.
- **Untested resolution.** Precomputed shade trades Umbra's continuous sun position for hourly interpolation. No source tested whether users notice. Comparing slot-blended shade against the live `ShadowField` on real routes is the experiment that decides priority 3.

## Conclusion

The question "how do Google and Bing route in under a second?" has a misleading answer for Umbra. The famous techniques exist because continental graphs are big and a single metric stays fixed for hours. Umbra's situation is the opposite: a small graph and a metric that changes with every minute and every preference. The industry lessons that do transfer are architectural, not algorithmic:

- Move expensive physics offline into per-edge, per-time tables, as every shade router and every transit planner's transfer table does.
- Keep data decoded and resident in a long-lived worker.
- Fold preferences into a scalar cost and run a small, fixed number of searches instead of an unbounded Pareto search.

One under-appreciated consequence concerns Track H. Precomputing shade per edge per hour is the same move that unblocks H1. Today A6 measures a 14-hour sweep at 21× one hour; with a table, traversal-time pricing becomes a table lookup at each edge's arrival time, and Umbra's flagship time-dependent search becomes affordable in the browser. Given the evidence, sub-second *warm* routes for 5–11 km look reachable. Sub-second *cold first visits* across boroughs do not: those stay bounded by megabytes on the wire, and only smaller shards or earlier prefetch can move them.

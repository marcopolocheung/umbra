# Track L — Route Latency

> **Charter:** a walking route in under a second. Today a 5–11 km NYC route takes **8–12 s**;
> every comparable product answers in well under one. Get there by measuring first, then removing
> the work Umbra redoes on every request, not by importing a heavier algorithm.

**Class:** Flagship engineering — the user-visible speed of the core action, and a measured
before/after a reviewer can check.
**Runs alongside:** B, C, D, P, S freely; ⚠️ H and A (L2 and L4 change how exposure is priced and
searched — `routing.ts`, `ShadowField`); ⚠️ E and G on `useRouting.ts` (L0, L3).
**Source:** `docs/research/Umbra_Sub_Second_Route_Calculation_2026-10-03.md` — what Google,
Bing, OSRM, Valhalla, GraphHopper, shadewalker.nyc, openrouteservice and the transit planners do,
with sources. The decisions below cite it as "the report".

---

## Current state

- **Active checkpoint:** L3 — the walking-route search (#263), with Track H (coordination: #270).
  L3c (the search in `app/workers/routing.worker.ts`) is in review. After it, L3's remaining
  acceptance is met and the next cost is shade work (L2), not search.
- **Done:**
  - **L0 (#267):** a contiguous stage split accounting for ≥ 99.7% of every calculation;
    baseline in `docs/notes/route-latency.md`.
  - **#266 (#268):** yields on elapsed time, removing 1.5–3 s per long route.
  - **L3a (#271):** the dominance pre-check, not the destination-front scan, was the hot
    spot (28M iterations vs 0.65M); sorted-boundary early exits, one dominance pass per label,
    and a typed-array heap. Before/after in `docs/notes/route-latency.md`.
  - **L3b (#272):** CSR graph (`compactGraph.ts`) + struct-of-arrays labels; search
    −30% to −51% on top of L3a, same session (nav-static cross-borough warm 5,028 → 2,579 ms).
  - **L3c (in review):** `paretoRoutes` runs in `app/workers/routing.worker.ts`; the graph
    crosses as transferable typed arrays (`routingGraphCodec.ts`) and the protocol
    (`routingWorkerProtocol.ts`) is the one A5b and H3 extend. Main-thread fallback when no
    worker. Bench gains `longestSearchTaskMs`.
- **Open PRs:** L3c (`perf/l3c-routing-worker`), routes identical (same function on a
  bit-identical rebuilt graph; 161-case parity on the round trip).
- **Decisions made:**
  - **No heavy preprocessing.** Contraction Hierarchies, hub labels, Transfer Patterns and ULTRA
    assume a fixed cost per edge; Umbra's changes with the hour and the walker. They are out.
  - **No WASM rewrite, no SharedArrayBuffer.** At 17k–34k nodes a typed-array search in
    plain TypeScript is single-digit milliseconds (the report's Node microbenchmark: 3.3 ms vs
    28.6 ms for the current `Map`-of-objects layout). SharedArrayBuffer needs cross-origin
    isolation, which Safari supports only in the strict form that breaks every cross-origin
    tile, shard and proxy fetch.
  - **Shade is precomputed, not resampled.** Every comparable shade router stores per-edge shade
    per time slot offline (shadewalker: per hour per month, 288 B/edge, ~4.5 h for NYC);
    Umbra alone recomputes it from building geometry per request (1.8–3.7 s).
  - **Measure before optimizing.** The 2026-09-20 phase split leaves ~3–4 s of a long route
    unattributed, and predates H1/H2's time-aware search.
- **Order, revised by L0's measurement:** L3 → L2 → L1.
  - **L3 first:** `search` is now the largest stage on six of eight long-route scenarios
    (3.2–7.9 s), up to 3.3× slower since H1/H2.
  - **L2 second:** precomputed per-edge shade is justified by removing `fieldReady` (1–2 s) and
    the canvas fallback (up to ~5 s), not by sampling cost (0.4–0.8 s).
  - **L1 last.**
- **L3 parity target:** production's current output, #246 included (the H4 oracle pins 57.00 s).
  Fixing #246 is a Track H PR.
- **The 100 ms search target is out of reach without changing routes.** After L3b the cost is
  the label count (~67 per node from the per-bucket fronts), and exact pruning bounds were
  prototyped and do not reduce it (route-latency.md, L3b section). Getting under ~1 s needs an
  approximate front or L4's three-representative search — both change routes, so they are Track
  H's and the owner's call (#270). Until then L3's acceptance is measured reduction plus no
  main-thread blocking (L3c), with 100 ms as the stretch target.
- **Blocked on:** nothing. L1 still needs the owner to confirm `VITE_NAVIGATION_BASE` in the
  deployed environment.
- **Next action:** after L3c merges, either the sweep → graphBuild → snap block that still runs
  unyielded before the search (85–470 ms plus the sweep), or L2 (~4 s of shade work). Measure pack
  wall time on GPU hardware first (open item in `docs/notes/route-latency.md`, L3c).
- **Last verified:** 2026-10-05 — `perf/l3c-routing-worker` on main `02ac5d7`: lint 0 errors,
  typecheck, 2,312 tests / 158 files, build, smoke e2e; bench back to back vs main.
---

## Why this track exists

Measured 2026-09-20 (Checkpoint 6), median ms:

| Route | Total | Street data | Shade sampling | Search |
|---|---:|---:|---:|---:|
| 2-point, Overpass, warm | 50 | 1 | 22 | 19 |
| ~5.7 km, static shards, warm | 8,855 | 1,145 | 1,766 | 1,446 |
| ~11 km cross-borough, static, cold | 12,172 | 2,354 | 3,704 | 3,221 |

Three costs dominate, plus a gap nobody has measured: on the long routes the named phases sum to
roughly 4.4–9.3 s of a 8.9–12.2 s total. The report's conclusion is that the 8–12 s is **self-inflicted**:
the graph is small enough that a well-laid-out search is milliseconds, and the shade work is
being recomputed when every peer precomputes it.

**Target:** p50 ≤ 1 s for a 5–11 km walking route with data already on the device, measured in a
production build; cold first load bounded by one download and reported separately.

---

## Checkpoints

Each checkpoint publishes its own before/after in `docs/notes/route-latency.md`, measured the
same way as L0, on the same scenarios.

### L0 — Measure where the time goes (#260) *(small)*
**Goal.** A per-phase breakdown that accounts for the whole calculation, on current `main`.
**Approach.**
- Fix the bench harness first: `bench:route`'s warm scenarios hang because the trip bar hides
  "Find Shadowed Route" after the first run (#107).
- Close the unattributed gap in `RoutingPhaseMs`: time the work between the existing brackets
  (snap/building snapper, graph build, option assembly, the main-thread yields, the H1 sweep —
  today folded into `shadowSample`) so the named phases sum to the total.
- Run on a `vite build` + `vite preview` (dev mode stalls repeated calculations), on the
  existing Checkpoint 6 scenarios, after H1/H2.
**Acceptance.** For every scenario, named phases cover ≥ 90% of `total`; the note gives p50/p95
per phase, the environment, and the reproduce command. Instrumentation only — no behaviour change.
**Files.** `app/lib/metrics.ts`, `app/hooks/useRouting.ts` (timing brackets only),
`e2e/bench/routeCalc.bench.spec.ts`, `docs/notes/route-latency.md`.

### L1 — Street data once, on the device (#261) *(medium)*
**Goal.** No street-graph download on a repeat route, or after a reload.
**Approach.**
- Confirm production serves NYC from the static shards (`VITE_NAVIGATION_BASE`, published
  `current.json`); if not, that is an owner action, not code.
- Persist decoded shard bytes in the Cache API or OPFS, keyed by the immutable generation;
  evict on generation change. Mind Safari's 7-day eviction for non-installed sites.
- Prefetch the shards covering origin and destination when the destination is picked, before
  "Find Shadowed Route".
**Acceptance.** Street phase ≈ 0 on a second calculation and after a reload within coverage;
cold transfer reported separately; outside-coverage fallback to Overpass unchanged.
**Files.** `app/lib/navigationData/**`, the trip-selection seam that triggers prefetch.

### L2 — Precomputed per-edge shade (#262) *(large; ⚠️ A, H)*
**Goal.** Shade per edge becomes a lookup, not a geometry computation.
**Approach.**
- Offline, in `server/navigation-prep` (or a sibling), compute each sidewalk edge's shaded
  fraction per (month, hour) from the same building geometry and canopy the app uses — 1 byte per
  slot — and publish it beside the street shards under the same generation.
- At query time, blend the nearest slots. Track H's arrival-time pricing (H1) reads the same
  table, so the moving-sun search costs a lookup per bucket instead of a sweep.
- Keep live sampling as the fallback outside coverage and for building data newer than the
  table.
**Acceptance.** Shade phase < 100 ms on the long-route scenarios; agreement with live
`ShadowField` sampling reported as a distribution (mean, p90, worst) over the same edges and hours
— the S1 method, applied to Umbra vs Umbra; any route that changes because of the table is
counted and reported.
**Must beat.** Live sampling's cost, without losing more agreement than the note can justify.
**Files.** `server/navigation-prep/**`, `app/lib/shadowField/**` (a table-backed provider),
`app/lib/navigationData/**`. Coordinate with Track A (owns `ShadowField`) and Track H.

### L3 — Search in a worker, over typed arrays (#263) *(medium; ⚠️ H, E)*
**Goal.** The search phase in tens of milliseconds, off the main thread.
**Approach.** Build the routing graph as compressed sparse row typed arrays (offsets, targets,
lengths, per-edge attributes) with a typed binary heap and reused search state; run it in a
long-lived Web Worker that keeps the decoded graph between calculations; transfer buffers rather
than share them.
**Acceptance.** Identical routes to the current search on every committed fixture (H4's oracle
and the routing tests); search phase < 100 ms on the cross-borough scenario; no long task on the
main thread during the search.
**Files.** `app/lib/routing.ts` (graph representation + search), a new worker under
`app/workers/`, `app/hooks/useRouting.ts`.

### L4 — A goal-directed shade objective (#264) *(medium; ⚠️ H)*
**Goal.** Let the search aim at the destination.
**Approach.** Today's cost discounts shaded edges to as little as 0.3× their length
(`MAX_SHADOW_SAVING = 0.7`), which makes a straight-line A* bound invalid. Rescale to a penalty
form (`length × (1 + penalty·sun)`), which preserves the ranking for a fixed strength and admits
A* (and later landmarks). Replace any open-ended trade-off search with a fixed set of 3–4
strengths if L0–L3 show the Pareto search is still the cost.
**Acceptance.** Same chosen routes as before per strength on the fixtures (H4's oracle); measured
speedup; Track H agrees in an issue before H's objective changes.
**Files.** `app/lib/routing.ts`. Take only if L3 alone misses the target.

### Later — transit
RAPTOR over typed arrays (no preprocessing, so walking legs can carry time-varying shade) once the
real NYC timetable replaces the fixtures. Transit search measured 1–11 ms in Checkpoint 6, so it
waits until L0 shows otherwise.

---

## Risks

- **Precomputed shade is coarser than the live render.** Hourly slots blur fast-moving shadow
  edges. L2's agreement figure is what decides whether the table ships, and the note states it.
- **Parity.** A faster search that returns different routes is a regression. L3 and L4 gate on
  H4's oracle and the committed fixtures, not on "looks right".
- **Benchmarks lie in WSL.** SwiftShader and synthetic shards are not a phone. Report the
  environment with every number, and add one real-device measurement before claiming the target.

## Out of scope / hand-offs

- The time-aware objective itself and the Sun Budget → **Track H**. L changes how fast it runs,
  not what it optimizes, except L4 with H's agreement.
- `ShadowField` semantics and canopy → **Track A**.
- Publishing the before/after → **Track P**.

## Owns

`docs/tracks/TRACK_L.md`, `docs/notes/route-latency.md`, the bench harness
(`e2e/bench/routeCalc.bench.spec.ts`), the routing worker, and the per-edge shade table's build
and loader.

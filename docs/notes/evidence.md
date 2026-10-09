# Evidence

Every measurement this project has made, with the method that produced it and the case where it
did worst. Nothing here is rounded in the flattering direction, and where a figure is *not* a
measurement — a prior, an assumption, a target, or in three cases a literal typed into a
component — it says so in the same breath.

**Stamped at commit `6a4b58f`, 2026-09-09; status rows revised at `8e5f463`, 2026-10-09.**
Every figure below names the commit or fixture it came from, because a published number that a later PR invalidates is a lie with a timestamp.
This page is written once and *revised* — sections that say "not measured" are not placeholders
waiting for a launch, they are the current honest state.

## How to read this page

Three rules govern it.

1. **No number appears without its method.** What was measured, on what data, on what
   hardware, and what it does not say.
2. **The evaluation layers stay separate.** Geometry, routing, agent and systems have different
   oracles and different failure modes. Merging them is how a portfolio number becomes a lie —
   a rendering agreement figure quoted as routing quality would be exactly that.
3. **An empty row stays empty.** Where there is no measurement, this page says so rather than
   borrowing a neighbouring one. Several rows below are empty. That is the point.

## Status at a glance

| Layer | Oracle | What exists today | State |
|---|---|---|---|
| **Geometry** | synthetic analytic fixtures; NYC LiDAR; independent observation | shadow-field ↔ pixel-sampler agreement, 150 cases, CI-gated; per-segment error against a LiDAR shade raster | ⚠️ **geometry against geometry — no observed-shadow number exists** |
| **Routing** | tiny exact fixtures; independently checked constraints | brute-force oracle over small fixtures, with one published gap | ⚠️ **gap measured on fixtures only — no real-graph bound, no violation rate** |
| **Agent** | final app state + task graders | 36 orchestrator scenarios + a sabotage suite, scripted model; one live-model run | ⚠️ **live groundedness measured once — no task-completion number** |
| **Systems** | documented hardware, fixed snapshots | shadow-index microbenchmark, bundle sizes, CI suite, one browser smoke test | ⚠️ **Node microbenchmark and build sizes only — no browser latency budget** |

---

## 1. Geometry

### 1.1 Shadow field vs pixel sampler — agreement

Routing used to read shadow off the map canvas. It now samples building geometry
(`app/lib/shadowField/ShadowField.ts`) and falls back to the canvas per edge. This harness measures
how far the two disagree, so that the swap was a number rather than an opinion.

**Source.** `app/lib/shadowField/__tests__/agreement/` — `fixtures.ts` builds the corpus,
`harness.ts` runs it, `agreement.test.ts` holds the ceilings.
**Reproduce.** `npx vitest run app/lib/shadowField/__tests__/agreement/agreement.test.ts` — the report
line prints on every run, passing or failing. Deterministic: no network, no key, no clock.
**Measured at** `6a4b58f`.

| Metric | Measured | Committed ceiling |
|---|---:|---:|
| Cases | 150 | ≥ 100 |
| Sidewalk readings | 300 | — |
| Mean absolute disagreement | **2.6 pp** | ≤ 4.0 pp |
| p90 | **0.0 pp** | ≤ 5.0 pp |
| Worst single reading | **62.5 pp** | *(not gated)* |
| Severe share (> 25 pp) | **3.3 %** — 10 of 300 readings | ≤ 4.0 % |
| Exact agreement | 271 of 300 readings (90.3 %) | — |

Per city, mean absolute disagreement, 50 cases each:

| City | Morphology | Mean | Ceiling |
|---|---|---:|---:|
| Madrid | dense mid-rise grid with courtyards, 40.4°N | 2.2 pp | ≤ 8.0 pp |
| Singapore | sparse towers, 1.4°N, sun near overhead | 2.3 pp | ≤ 8.0 pp |
| Kent, WA | low-rise suburb, 47.4°N, long winter shadows | 3.4 pp | ≤ 8.0 pp |

The ceilings are set just above what the corpus currently reports, so a regression trips them.
They are meant to be *lowered* as the field improves, never raised to make a failure go away —
raising one is a product decision, because it means accepting more divergence between what the
map paints and what routing believes.

**The worst case, described.** One sidewalk reading differed by 62.5 pp, and the severe tail is
almost entirely one situation: a shadow boundary running *parallel* to a street and landing
within a pixel of the sidewalk line, so every sample along that edge flips together instead of
scattering. The harness argues from mechanism that the field is the better-behaved side there,
because it samples the true ±4 m offset while the canvas path rounds to the nearest pixel — but
**that is reasoning, not a measurement**, and §1.2 is why it cannot be more than that. The
renderer is what the user believes either way, so the count is gated rather than footnoted. p90 cannot see this at all: nine readings in ten agree
exactly, which is why the severe share is a separate gate.

**What this does not say.**

- **It is not physical accuracy.** Two models are compared *to each other*, on the same
  synthetic geometry. Neither is ground truth. There is no measurement anywhere in this project
  of how either compares to a real shadow in a real street — see §1.2.
- **It does not measure geometry disagreement.** Both sides see identical buildings by
  construction. The disagreements it can see are the ±4 m sidewalk offsets landing on different
  pixels, quantization at shadow edges, the blue-dominant predicate round-trip, and sample-count
  differences. The disagreements it cannot see are the ones from MapTiler's tile geometry versus
  Overpass's, missing OSM heights, and hidden landmark buildings. Those need the pixel sampler's
  answers recorded from a real browser over real tiles, and **that corpus does not exist.** The
  fixture format is already the format such a recording produces, so it drops in without
  changing the metric — the harness names issue #121 as the blocker, and that reason is now
  stale (see [`browser-verification.md`](./browser-verification.md)); the corpus is simply
  unrecorded.
- **150 cases are not 150 independent scenes.** They come from **3** synthetic city layouts
  (a 3×3 block grid each), 10 street edges per city, and 2 dates × 5 hours per city — paired by
  parity so every edge and every hour is used. Adjacent cases share buildings and share a sun
  position. Read it as broad coverage of one *kind* of geometry, not as a sample of the world.
- **The footprints are rectangles.** Real footprints are not, and irregular rings are where a
  triangulation-based field and a rasterised one have the most room to differ.

### 1.2 Physical accuracy — **against LiDAR geometry only**

There is **no measurement in this project of how well its shadows match observed reality.** No
comparison against observed shadow boundaries, no photographs, no survey, no independent
irradiance data. §1.1 is agreement between two of our own models, and it must never be quoted
as accuracy.

The closest thing is the S1 audit, [`shade-accuracy.md`](./shade-accuracy.md): Umbra's shade
against a shade raster built from NYC's 2017 LiDAR, over 8 blocks × 3 dates × 5 hours. The mean
per-segment shade-fraction error is **34.7 pp** with canopy (p90 100, worst 100). It is still
geometry against geometry, and that page says what it does and does not measure.

### 1.3 Confidence values are priors, not measurements

`ShadowField.ts:198` says so in the source, and it is repeated here because it is the kind of
thing that quietly gets promoted:

> Neither is measured ground truth — these are priors, and A3's agreement harness is what turns
> them into calibrated numbers.

The per-edge confidence the field attaches to a shadow answer is a hand-set prior over source
quality and sun-altitude conditions. It has not been calibrated against outcomes. The route
provenance line the UI shows (`app/lib/shadowProvenance.ts`) is derived from these priors, so it
reports *where a number came from* — building geometry, the map view, mixed, or unknown — and
deliberately not how right it is.

---

## 2. Routing

### 2.1 Approximation gap — **measured on fixtures**

The route search is Pareto label-setting with dominance pruning (`app/lib/routing.ts`).
`app/lib/__tests__/routingOracle.test.ts` compares it against a brute-force oracle that
enumerates every simple path on small fixture graphs. Method and result:
[`sun-budget-model.md`](./sun-budget-model.md).

- **Static (one time bucket):** exact on the line and grid fixtures.
- **Time-aware:** on the one merge fixture, the search drops a Pareto option and its least-sun
  route is **2.00 s (3.6%) worse** than the true optimum.

**No bound on a real city graph exists.** Whether the loss compounds across several merge
points is unproven, so the search must still not be described as optimal.

### 2.2 Time-dependent exposure — **implemented; discretization error not measured**

Each edge is priced at the 15-minute bucket the walker reaches it in, not at departure
([`time-aware-routing-h1.md`](./time-aware-routing-h1.md),
[`exposure-objective-h2.md`](./exposure-objective-h2.md)). Via-stop legs, transit walk legs,
sketches and pixel-fallback edges still use one instant. The error from 15-minute buckets
against continuous time has not been measured.

### 2.3 Constraint-violation rate — **not measured**

---

## 3. Agent

### 3.1 Orchestrator eval — scenarios plus a sabotage suite

*At `8e5f463` the suite holds **36** scenarios (`scenarios/index.ts`), adding authority and
budget cases to the 18 measured below. The table is the original measurement.*

**Source.** `app/lib/agent/__tests__/` — `harness.ts` replays scripted model turns and tool
results through the real `runAgent` and records a trace; `scenarios/` holds the cases.
**Reproduce.** `npx vitest run app/lib/agent/__tests__/agentScenarios.test.ts`.
**Measured at** `6a4b58f`. **28 vitest tests, all green** — the 18 scenarios below, 3 sabotage
tests, 2 corpus-level tests and 5 focused sub-tests. The `expect` count is several times that.

| Group | Cases | What it pins down |
|---|---:|---|
| Planning | 6 | tool order, the fallback plot when the model forgets, no duplicate plot when it doesn't, locate-then-search, time set before shadow is read, route endpoints becoming pins |
| Grounding | 6 | a tool error is fed back rather than swallowed, an empty search plots and names nothing, an off-topic turn spends no tools, an unlocated map asks instead of inventing, the pin cap, coordinate de-duplication |
| Budget | 3 | the 8-step research cap still plots before the write call, the 8-pin cap, the shared-model fast path skipping the write call |
| Degradation | 3 | a safety block ends the turn with no tools and no pins, an empty research turn still reaches the write call, an empty write returns a plain retry message |
| **Sabotage** *(not scenarios)* | 3 | the harness's own teeth: pins that never reach the map, an answer naming a place no tool returned, and a plan left half-plotted must each turn the suite red |

The first four rows are the 18 scenarios. The sabotage row is three separate tests that
deliberately break the loop and assert the checks above go red — a grounding suite that cannot
fail is decoration.

**Broken out rather than folded into a rate.** Three of the eighteen scenarios assert that the
agent *declines* — no pins, no invented place, a request for an area it does not have. Counting
those as successes alongside completed plans would make conservative behaviour look falsely
perfect, so **no headline pass rate is published at all**; each scenario asserts its own trace.
(They are not a separate file: all three sit in `scenarios/grounding.ts` beside three cases that
do act. The separation is in what is reported, not in how the code is filed.)

**What this does not say.**

- **The model is scripted.** Every model turn is a fixture we wrote. This measures the
  orchestrator's decisions — which tools ran, in what order, which pins reached the map, what
  the write call was told — under known model output. It says nothing about how a live model
  behaves.
- **It is not task completion.** No scenario asks whether the resulting plan is a good plan, or
  whether a user's day worked out. There is no task grader and no live-model eval in this
  project.
- **Fluency is never scored.** The suite asserts the loop's decisions, not the quality of its
  words: which tools ran, in what order, which pins reached the map, and what the write call was
  told. It does make string assertions — `groundingViolations` (`harness.ts:137`) scans the
  answer for every place name a tool returned and every decoy it did not, and further checks
  cover the research prompt, the write prompt including exact pin coordinates, and tool error
  text. What is never asserted is that the prose is good, and fluent output is never counted as
  success.

### 3.2 Live-model groundedness — **measured once**; recovery, revision minimality — **not measured**

`npm run eval:agent` replays the scenarios against the real model. On the default Gemini pair
(3.5-flash-lite research, 3.1-flash-lite write) **25 of 25** turns were grounded, in 156
requests: [`agent-live-eval-2026-09-11.md`](./agent-live-eval-2026-09-11.md). It is one run on
one day, with stubbed tools, and it grades groundedness, not whether the plan was good.

---

## 4. Systems

### 4.1 Shadow-index speedup — a Node microbenchmark

**This is a synthetic Node microbenchmark of `ShadowField.sampleEdges` in isolation. It is not
end-to-end browser route time, and it must not be quoted as one.** (Issue #207 exists to keep
that qualification attached wherever the number appears.)

**Source.** `app/lib/shadowField/__benchmarks__/shadowField.bench.ts`, committed in **#166**.
**Reproduce.** `npm run bench`
(`UMBRA_BENCH_FULL=1` adds the city-scale case).
**Measured 2026-09-04.** Before: `main` at `c2821f7`. After: `shadow/shadow-index` at `c6b21a1`
(PR #164). **Hardware:** WSL2 Linux `6.18.33.2-microsoft-standard-WSL2`, Node `v20.20.1`.
8 iterations each, 3 for the last; margins are Tinybench's relative margin of error.

| Case | Before (mean) | After (mean) | Change |
|---|---:|---:|---:|
| 400 prisms × 200 edges | 691.5 ms ±0.9% | 0.66 ms ±2.3% | ~1,050× |
| 800 prisms × 200 edges | 1282.6 ms ±1.5% | 0.91 ms ±26.9% | ~1,410× |
| 1600 prisms × 200 edges | 2347.4 ms ±0.8% | 1.40 ms ±13.8% | ~1,670× |
| 400 prisms × 400 edges | 1366.8 ms ±1.2% | 1.27 ms ±13.8% | ~1,075× |
| 2000 prisms × 1000 edges | 13899.5 ms ±1.4% | 6.31 ms ±22.0% | ~2,200× |

**What this does not say**, in the benchmark's own four caveats:

1. **These are warm-JIT, steady-state figures.** The first `sampleEdges` call in a real session
   is slower than the table suggests on *both* sides. A cold single-shot pass on the same
   fixtures measured 773 ms → 16 ms for 400 × 200 — the same change viewed cold.
2. **The wide margins in the "after" column are timer noise, not instability.** Those operations
   now run in about a millisecond, where GC and clock granularity dominate in relative terms.
   The before column is stable to ~1% and reproduced within 1% across two runs.
3. **The footprints are squares**, which makes `earcut` nearly free. This understates
   triangulation cost against real tile or Overpass geometry. It affects both columns, so the
   ratio holds; the absolute numbers are optimistic.
4. **A full route graph is not measured.** ~5,400 edges takes minutes per iteration on the
   pre-index code and reports nothing. The 200-vs-400 edge pair is in the table to show scaling
   is linear in edges.

Full method: [`performance-baseline.md`](./performance-baseline.md).

### 4.2 Bundle size

**Measured 2026-09-08**, Node `v20.20.1`, clean `npm ci`. Before: `main` at `4180e02`; after:
`feat/d0-real-timezones` (#204). Recorded because replacing a longitude offset estimate with an
IANA zone lookup is the kind of change that quietly costs 30 kB on the entry path. (The work
closed issue **#204**; the number refers to the issue, not to a pull request.)

| Artifact | Before (gzip) | After (gzip) | Change |
|---|---:|---:|---:|
| `index-*.js` | 65.55 kB | 66.22 kB | +0.67 kB |
| `MapView-*.js` | 17.39 kB | 17.41 kB | +0.02 kB |
| `agentLoop-*.js` | 6.63 kB | 6.67 kB | +0.04 kB |
| `tz-*.js` *(new, async)* | — | 29.60 kB | +29.60 kB |

**The entry path grew by 0.67 kB gzip, not 30.** The boundary dataset sits behind a dynamic
`import()`, so it is fetched after first paint and nothing blocks on it. Total `dist/` was
1.6 MiB at `dca020d` (2026-08-15). There is **no enforced bundle budget** — these are recorded
numbers, not a gate.

### 4.3 Test suite and CI

**Measured at `6a4b58f`**: `npm test` → **550 tests across 48 files, all passing**, in ~5 s.
CI runs lint → typecheck → test → build on every PR and every push to `main`, then the browser
smoke test. It needs no secrets: the suite is hermetic — no network, no env, no clock.

**What this does not say.** `npm test` never opens a browser. A green suite says nothing about
rendering, about WebGL, or about anything the user sees.

### 4.4 Browser smoke test — one path

`npm run e2e` (`e2e/smoke.spec.ts`) loads the built app in Chromium and asserts, in order:
blue-dominant shadow pixels appear on the map canvas and then stop changing on their own;
dragging the timeline lands within ±2 minutes of the expected clock time and moves the shadow
mask; and a two-point route calculates and its line reaches the canvas.

It runs as two projects. `smoke` serves a synthetic basemap style, so it needs no API key and
runs on every PR including from forks. `smoke-live` repeats the same assertions against real
MapTiler tiles and appears only when a key is present — it is the only check that the app still
parses MapTiler's real `building` schema.

**What this does not say.** It is **one path**. It is not a performance measurement, not a
visual regression test, and it covers no other screen, mode, or interaction in the app.

### 4.5 Browser latency, memory and throughput — **not measured**

No time-to-interactive, no published route-calculation timing from a real browser, no memory
ceiling, no throttled-network figure. Route instrumentation does exist — `app/lib/metrics.ts`
records per-phase timings and computes p50/p95 in-session, and the browser smoke test polls
`window.__umbraMetrics.latest` as a liveness signal — but **no figure from it is recorded,
published or gated**. Note also that `metrics.ts:46-48` states latency *targets* (< 3000 ms
typical, < 500 ms on a cache hit). Those are targets. **No measurement anywhere in this project
says whether they are met.** A browser *is* now runnable locally (see
[`browser-verification.md`](./browser-verification.md)), so the old "no browser binary" reason
is stale — the measurements are simply missing.

---

## 5. Numbers the app shows, and where each one comes from

Every numeral the interface renders, swept from `app/components/`. Placeholders like `<n>` stand
for the value; the strings are otherwise as they appear on screen.

### 5.1 Route figures

| The app shows | Computed by | Method | Standing |
|---|---|---|---|
| `<n>% shadow` on a route card | `routing.ts:530` and `:803` — shadowed distance ÷ total distance | §1.1 is the only evidence about how right the underlying per-edge shadow calls are | agreement-checked, **not accuracy-checked** |
| `from building geometry` / `from the map view` / `mixed sources` / `low confidence` | `shadowProvenance.ts:156` | §1.3 — aggregated over the walked path, weighted by distance | provenance, not quality |
| `<d> km` / `<n> m` | summed edge lengths (`RouteCard.tsx:8`) | — | direct measurement of the graph, not of the ground |
| `<n> min total` | distance ÷ a constant **1.4 m/s** (`travelMode.ts:16`) | there is no timing model beyond that constant: no crossings, no signals, no elevation, no fatigue | **an assumption, not a measurement** |
| `<n> min in sun · longest stretch <n> min` | `routeTradeoff.ts:65,83` — sunlit metres ÷ 1.4 m/s | same shadow evidence as `% shadow`, same speed assumption | derived from both rows above |
| `+<n> min, +<n>% sun exposure` / `Shortest baseline, <n>% shadow` | `routeTradeoff.ts:36` — relative change in sunlit **metres** against the shortest route | a ratio between two routes, **not** the `% shadow` ratio | comparison, valid only within one calculation |
| `<n>m shadow` (longest unbroken run), `<n>×` detour, `<n> breaks` / `continuous` | `RouteCard.tsx:21-23`, from `longestContinuousShadowM`, `detourRatio`, `shadowTransitions` | same shadow evidence as `% shadow` | derived |
| `Turns <n>` | `routing.ts:529` — a count of bearing changes over 30° | a **proxy** for turns: it counts geometry, not junctions, so a curved street can read as several turns | proxy, presented as a count |
| `<n>% in sun` per hour, `most shadowed around <label>` | `HourlyExposureStrip.tsx:41,51` from `bestTime.ts:54` (`1 − shadowCoverage`) | inherits §1.1 in full | agreement-checked, **not accuracy-checked** |

### 5.2 Weather and heat figures

| The app shows | Computed by | Method | Standing |
|---|---|---|---|
| `UV <n.n>` | Open-Meteo hourly forecast (`app/services/weather.ts:157`) | a third-party forecast, passed through unmodified | **not ours, and not verified by us** |
| `Strong heat stress · Heat <n> vs <m>` | `app/lib/heat/score.ts`, method version `shadow-radiation-v1` | [`heat-score.md`](./heat-score.md) | **experimental**, labelled so in the UI; ordinal, comparable only between the routes on screen at that hour |
| `feels about <n> °C walking this` / `about <n> °C — air temperature only` | `heat/score.ts` (`feltC`) | [`heat-score.md`](./heat-score.md); the second wording is the degraded rung, where humidity and wind are absent from the number | **experimental** |
| `<n>% of this walk is in sun` (in the heat slot, with no forecast) | `RouteConditionsLine.tsx:65` | a shadow figure standing in for a heat score when none can be computed | a **different quantity** in the same slot, worded to say so |
| `About 4–6 min of full sun (<lo>–<hi> SED)` | `app/lib/heat/dose.ts`, method version `sed-uvi-v1` | [`heat-model.md`](./heat-model.md) | **experimental**, labelled so in the UI |
| the hour every solar figure is computed for | `app/lib/timezone.ts`, `tzLookup.ts` | [`timezone.md`](./timezone.md) — and see §5.5, it carries a real measured error rate | measured |

The app links [`heat-model.md`](./heat-model.md) directly, under a **How these are estimated**
link beside the two experimental numbers; that page links the other two. All of them resolve
on the public repo.

### 5.3 Transit figures mean something narrower than they look

On a **Via Transit** card the same labels carry different content, and this is not surfaced in
the interface:

- `<n> min total` includes a train leg timed at a hardcoded **30 km/h with no dwell, no headway
  and no schedule** (`useNavigation.ts:1500`).
- `<d> km` is the **walking legs only** (`useNavigation.ts:1553`).
- `<n>% shadow` is the walk-weighted average of the two walking legs; the train leg is not in it.
- `underground` / `mostly shadowed` comes from `trainGraph.ts:81` — hand-set constants
  (`subway 0.0`, `light_rail 0.25`, `monorail 0.1`) with no measurement behind them.

None of those is wrong as an internal quantity. All of them are labelled as if they were the
walking equivalents, so a user comparing a walking card against a transit card is comparing two
different measurements. Filed as **#236** rather than fixed here — this page publishes, it does
not change application code.

### 5.4 Numbers with no method behind them

The acceptance criterion for this page is that **every number the UI shows traces to a row
here**. Three do not trace to anything, and naming them is the only honest way to meet it:

| The app shows | Where | What is actually behind it |
|---|---|---|
| `4.4 ★` *(#235)* | `PlaceDetail.tsx:40` | **A hardcoded literal.** When Foursquare returns no rating, the app prints `4.4` in the same position, weight and colour as a real one. Nothing distinguishes the two on screen. |
| `$$` *(#235)* | `PlaceDetail.tsx:10` | The same, for price level. |
| `shadowFraction: 0.73` to the assistant *(#237)* | `app/lib/agent/tools.ts:369,380` | A shadow probe rounded to **two decimals** and handed to a language model, which renders it as prose. Two decimals on a quantity whose worst agreement reading is 62.5 pp, with none of §1.1's caveats travelling with it. |

The same file already knows how to decline: `PlaceDetail.tsx:45` prints
`(reviews unavailable)` when the review count is zero, and `:119` labels its review histogram
`Showing placeholders`. The rating and the price are the two that do not.

**These are open defects (#235, #237), not published figures.** They are listed here because a
page that claims to trace every UI number and quietly skips the fabricated ones would be worse
than no page at all.

### 5.5 Timezone lookup — a measured error rate

The one shipped quantity in the app with a real, published error rate, and it belongs on this
page rather than only on its own. The zone lookup is approximate, measured by its authors
against [`geo-tz`](https://github.com/evansiroky/node-geo-tz/), which uses full boundary
polygons:

| Sample | Zone name disagrees |
|---|---|
| A random point on earth | ~30% |
| A point likely to be inhabited | ~10% |
| Inhabited, counting zones that share an offset year-round as equal | **~5%** |

The last row is the one that binds, because the app displays an **offset**, not a zone name:
`Europe/Vienna` and `Europe/Berlin` are the same clock. So roughly **one inhabited point in
twenty gets an offset that is wrong**, and the errors cluster along zone borders away from
population. Every solar figure in the app is computed for that hour. Full method:
[`timezone.md`](./timezone.md).

**What this does not say.** It is the *authors'* measurement of their dataset, not ours. We
have not independently reproduced it.

## 6. Corrections this page carries

A project that publicly corrects its own overclaim is doing the thing this page exists to prove.

**The novelty claim was overstated (#206).** Advancing the sun along a walk is not
unprecedented. Fujiwara et al., *Building and Environment*, 13 Sep 2024, §6.2 integrates
accumulated irradiance over a walk using departure time, walking speed and position-specific
timestamps — over **three predefined routes**. That is prior art for traversal-time exposure and
is cited here as related work, not as a threat. What is ours is what comes after: traversal-time
exposure as the *cost function of a constrained search*, inverted into a reachability question,
in a browser, with the gap published. Evaluating three fixed routes is not that. §2.1 now carries
the gap, measured on fixtures.

**The speedup was unqualified (#207).** ~1,000–2,200× is a Node microbenchmark of one function,
not end-to-end browser route time. §4.1 carries the qualification wherever the number goes.

**A shipped dependency carried a critical advisory (#211) — resolved.** `maplibre-gl` was pinned
at exactly `5.9.0` for the shadow simulator (hard invariant #1), which held GHSA-jrc7-96c5-q579
(critical XSS, affecting `<= 6.4.0`). The simulator was no longer imported, so the pin went with
it and the app moved to `maplibre-gl` 6.12.0; `npm audit` reports no vulnerabilities. There was
never a demonstrated exploit path: every `setHTML` call (`MapView.tsx:429`, `:461`, `:466`)
renders through one escaping helper in `placePopup.ts`. That helper still matters —
`Popup.setHTML` does not sanitise in 6.x either.

**The shadow source was described wrongly.** Routing is not "a pixel sampler". It is a
geometry-backed `ShadowField` with a per-edge canvas fallback, and §1.1 is the measurement that
made the swap defensible. An earlier research pass got this wrong and the impression persisted;
it is corrected here.

---

## 7. What would have to happen for this page to say more

Named so the empty rows have owners rather than looking like oversights:

- **A physical accuracy number** (§1.2) needs an independent observation of real shadows. The
  LiDAR audit is its geometric baseline, not a substitute.
- **A recorded real-city agreement corpus** (§1.1) needs the pixel sampler's answers captured
  from a real browser over real tiles. The fixture format already matches, and a browser now
  runs locally, so nothing but the recording is missing.
- **A real-graph approximation bound** (§2.1) needs either a proof that the bucket-boundary loss
  does not compound, or an oracle that scales past fixtures.
- **A task-completion agent eval** (§3.2) needs task graders, not only a groundedness check.
- **Browser latency budgets** (§4.5) need the existing `window.__umbraMetrics` captured from
  a real session and given a CI-enforced ceiling. Until then `metrics.ts`'s < 3000 ms and
  < 500 ms are targets nobody has checked.
- **The three numbers in §5.4 need removing from the app, not documenting better** (#235, #237).
  A hardcoded `4.4 ★` is not a figure this page can qualify into honesty; it has to stop
  rendering.
- **The transit card's labels (§5.3) need to say what they cover** (#236) — a walk-legs-only
  distance under the same word as a walking route's total distance is a labelling defect, not a
  measurement gap.

Until then those sections stay empty, and no number from an adjacent section is allowed to
stand in for them.

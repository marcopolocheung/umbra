# The exposure model, and its oracle (H4)

**2026-10-03.** H1/H2 gave the routing search a time-dependent, exposure-aware
objective: minimise cost metres under a detour budget, and on the front minimise
**sun seconds**. This note is the correctness evidence for that search — an
exhaustive oracle it is compared against — and the gap the comparison found.

## The model the search implements

For a walk from `start` to `end`:

- **Cost metres** accumulate `modeAdjustedDistanceM(edge)` plus the crossing
  penalty at interior intersections; the search may not exceed
  `shortestCost + shortestDistance·(maxDetourFactor − 1) + DETOUR_FLAT_M·speedRatio`
  (`DETOUR_FLAT_M = 250`, `maxDetourFactor = 2.0`).
- **Sun seconds** accumulate `edgeTraversalSeconds(edge) · (1 − shadowFactor)`,
  where the shadow factor is read at the arrival bucket when H1's `timeAware` is
  set (`timeShadow[bucketOf(arrival)]`, the arrival at the edge's **end**) and
  from the static `shadowFactor` otherwise. Fewer is better.
- **The sun-streak** tracks the longest unbroken sunlit run for the
  `maxContinuousExposureSec` cap, and is part of the dominance comparison.

## The oracle

`app/lib/__tests__/routingOracle.test.ts` enumerates **every simple path**
start→end on a small fixture graph, computes each one's exact
(cost metres, sun seconds) with the same per-edge rules, and takes the Pareto
front. It is exhaustive and obviously correct, so it is slow — but a fixture is
a handful of nodes, not a city, so the whole file runs in **under a second**.

Fixtures must place node coordinates consistently with their edge distances: the
search's straight-line heuristic reads coordinates, so arbitrary positions give
it an inadmissible bound and it can mis-prune the optimum. (This bit the first
draft — the search "missed" the shortest path because the heuristic
overestimated it.)

The oracle shares the production's *per-edge* cost functions
(`modeAdjustedDistanceM`, `edgeTraversalSeconds`). That is deliberate: it tests
the **search** — dominance pruning and the bucket bookkeeping (the detour
budget is modelled but never binding on these fixtures) — not the cost model. An oracle that re-derived the cost model would conflate two
questions.

## What it found — the published gap

**The search is exact on the static fixtures (one time bucket), and loses a
Pareto point where routes merge at an interior node and the next edge crosses a
bucket boundary.**

The mechanism is the dominance rule. Within one time bucket, a label is dropped
when another label at the same node is no later, no longer and no sunnier
(`routing.ts` `dom`, the per-bucket Pareto set). But the dropped label's *next*
edge can land in a different bucket, where the shadow is different — so its
continuation can be cheaper in sun, and dropping it loses a Pareto-optimal
option. This is the residual the H2 note handed to H4 ("the within-bucket
boundary residual … remains H4's oracle's job to measure").

**The fixture and the number.** Two routes reach a node in the same bucket: A at
50 s with 50 s of sun, B at 55 s with 55 s of sun. A drops B. The next edge is
9.8 m; A's finishes at 57 s (still open), B's at 62 s (inside the shaded next
bucket). The truth:

| path | metres | sun seconds |
|---|---|---|
| 0-1-3-4 (the old rule returned this) | 79.8 | 57.00 |
| 0-2-3-4 (the old rule dropped it) | 86.8 | **55.00** |

So on this fixture the search's least-sun option was **2.00 s worse than the
true optimum (3.6% of it)**, and a non-dominated option was missing from the
front entirely. **Fixed on the front in #246:** a label now prunes a later one
only when every continuation is priced alike (the same arrival, or both in the
last bucket), and the test asserts the front returns 0-2-3-4 at 55 s. The
shipped ladder (`searchStrategy: "direct"`) kept one label per (node, bucket),
so it still returned 57 s; since #369 each rung keeps two per (node, bucket),
prunes a later one only under the same rule, and returns 0-2-3-4 at 55 s.

**Where it is exact.** On the *static* fixtures — a single time bucket, so the
defect cannot occur by construction — the production's shortest equals the
oracle's least-distance path, its least-exposed option equals the oracle's
minimum sun seconds, and no returned option is dominated; that holds on the line
fixture and on a fixed-seed 2×3 grid. In time-aware mode the oracle has no
positive exactness evidence: the merge fixture above is the only time-aware case,
and it shows the gap. (Both static fixtures do contain interior merges — a
cross-link and a shared grid node — but with one bucket there is no boundary to
cross.)

## What this does not claim

- **Small graphs only.** Exhaustive enumeration does not scale; the oracle is a
  fixture test, not a runtime check.
- **The cost model itself is untested here.** `shadowFactor`, the traversal
  clock and the crossing penalty are inputs, not subjects.
- **The bound on the loss is unproven.** The fixture shows a 2 s miss at one
  merge point; whether the error compounds across several merge points, and by
  how much, is not established.
- **The ladder is not exact.** #369 gave each rung two labels per (node,
  bucket), which closes this fixture's gap, but a third distinct future at one
  slot still loses its label, and a weighted sum still misses a least-sun route
  in a concave dent of the front (`directRoutes.test.ts`).
- **The bucket discretization error against continuous time is not measured.** The
  oracle uses the same buckets as production, so it measures *search* error only.
  The H1 note's pointer ("H4's oracle publishes it") is not satisfied here; a
  continuous-shadow oracle is a separate piece.

## H3 — Sun Budget reachability (H3a: the search)

**The question.** From one start, which streets can a walker reach on at most *S* seconds of
direct sun and *T* seconds of walking? One way: there is no return leg, waiting or dwell yet,
because H5 owns those. Sun is priced exactly as above, `seconds × (1 − shade)`, with shade read
at the bucket of arrival at the edge's end. An edge is **reachable** when some walk from the
start traverses it within both budgets. Walks may revisit nodes, because a loop can carry a
walker into a shadier bucket. Code: `app/lib/sunReach.ts`. It runs in the routing worker as the
`reach` command.

**The search.** Label-setting over `(node, arrival, sun)`, popped by arrival, with one Pareto
set per (node, arrival bucket). Label *a* prunes *b* when *a* arrives no later and
`sun(a) + slack ≤ sun(b)`.
- **Why slack is needed.** Two labels in one bucket arrive less than a bucket apart (Δ), so on
  any continuation *a* is priced at most one bucket earlier. That only happens on edges whose
  end lands within Δ before a bucket boundary. The first such edge adds at most the largest
  one-bucket sun jump on the graph, and the rest span less than Δ of walking. Summing over the
  boundaries still inside *T* bounds the extra sun *a* can pay.
- **Edge cases.** With static shade or both labels in the last bucket, the slack is 0, which
  is #370's `sameFuture` (#246 is the fixture where pruning without it is wrong).
- **Soundness.** Every kept label is a real walk, so **`reachable` is always sound**. A label
  that prunes another can follow every continuation of it no later and no sunnier.

**Three outcomes, never conflated.**
- Each Pareto set is capped at 8 labels, and the search is capped at 2,000,000 labels.
- An outer bound marks an edge *undecided* unless its least-time prefix exceeds *T* or its
  least optimistic sun prefix (every edge at its shadiest bucket) exceeds *S*.
- The least-time tree is itself a set of real walks, so it also proves edges the capped search
  dropped.
- The outcomes:
  - `exact` means `reachable` is the whole truth on the bucketed model.
  - `approximate` means the cap dropped labels; the gap is the `undecided` set.
  - `budget-exhausted` means the work cap stopped the search.
- **An undecided edge is not an unreachable one.** Nothing may present it as unreachable.

**Evidence (`app/lib/__tests__/sunReach.test.ts`).**
- **Exhaustive oracle.** It enumerates every walk bounded by *T*, de-duplicating only identical
  states. On 60 seeded lattices (static and 2–6 buckets, walk and scoot) plus the #246 fixture,
  the region is `exact` and equals the oracle's.
- **Capped search.** With slots of 1, `reachable ⊆ truth ⊆ reachable ∪ undecided` holds on all
  60 lattices.
- **Unlimited sun.** With sun unbounded, the result is exact even with slots of 1.
- **Monotonicity, for `exact` results only.** Widening either budget never shrinks an `exact`
  region. An `approximate` one can shrink: a wider sun budget admits labels that evict others
  from a capped slot (the verifier found 90 shrinks in 4,800 widenings at slot caps 1–2, none at
  the default 8). H3b must not paint `reachable` alone as if it only grows.
- **The tests can fail.** Dropping the slack term fails the #246 fixture and one lattice.
  Summing it over the first boundary only, or dropping its short-edge term, each fails a
  dedicated fixture.

**Measured on NYC** (generation `nyc-2026-09-18-393d4cd24a30`, the 12 `routeCompare` graphs and
departures, *S* = 8 min, *T* = 20 min, walk, Node on the SwiftShader WSL box; street km count each
segment once; run with `npm --prefix server/navigation-prep run audit:shade -- routeCompare -t "sun budget"`):

| start | outcome | search | reachable | undecided |
|---|---|---|---|---|
| LES → Kips Bay 12:43 | approximate | 393 ms | 353.7 km | 3.6 km |
| UES → Murray Hill 16:03 | exact | 216 ms | 230.7 km | 0 |
| UWS → FiDi 15:12 | approximate | 438 ms | 219.5 km | 0.3 km |
| Chelsea → Union Sq 10:00 | approximate | 237 ms | 252.6 km | 6.0 km |
| Harlem → UWS 08:30 | approximate | 281 ms | 260.2 km | 0.8 km |
| Park Slope → Bklyn Hts 14:00 | approximate | 317 ms | 230.6 km | 17.8 km |
| Williamsburg → Greenpoint 17:30 | approximate | 340 ms | 286.2 km | 10.6 km |
| Astoria → LIC 11:15 | approximate | 352 ms | 286.7 km | 23.2 km |
| Midtown → Central Park 13:00 | approximate | 367 ms | 294.6 km | 10.2 km |
| FiDi → Chinatown 09:00 | approximate | 379 ms | 228.6 km | 0.3 km |
| Bed-Stuy → Crown Hts 15:45 | approximate | 302 ms | 260.8 km | 8.0 km |
| Inwood → Washington Hts 12:00 | approximate | 218 ms | 95.7 km | 15.8 km |

Slot cap sweep on four starts: 1 → 8 → 32 → 128 labels per slot.
- **Reachable** grows by about 1% from 1 to 8 and 0.2–1.1% more at 32, at 2–3× the time.
- **At 128** every start hits the work cap (3–6 s).
- **Most of what stays undecided** is the outer bound's looseness, not missed streets:
  Inwood's barely moves with the cap.
- **The sun budget binds weakly at these settings.** With sun unbounded, the region is the
  same on 7 of 12 starts and 5–27% larger on the rest. The slider will matter most at shorter
  times or tighter sun budgets.

**What H3a does not claim.**
- It is one way.
- It uses the same 15-minute buckets as routing, so the discretization error is unmeasured,
  as above.
- It does not wait or dwell.
- `approximate` on real data is the normal case, not a failure.
- These are Node timings, not browser ones. H3b measures the slider in the browser.

## H3b — Sun Budget on the map

**What the user gets.** "Sun budget" on the idle screen opens a panel. Tap a start, set the most
direct sun (0–20 min) and a walk of 10, 20 or 30 min, and the streets a walk from that start
reaches are drawn: solid where proven, dashed where neither proven nor ruled out. Walking pace
only (1.4 m/s): the panel speaks in walking minutes. NYC only — outside the published shade table
the panel says so and draws nothing (no live-sampling fallback; owner decision 2026-10-22).

**Never shrinking, soundly.** A wider budget can return a smaller `approximate` region (H3a,
above). `mergeRegion` paints the union of `reachable` over every cached result for the same graph
whose sun and walk budgets are both ≤ the current ones — each of those streets still has a witness
walk within the current budgets. Results are bound to the graph object they came from; a search
for an earlier start that lands late is never read (`useSunBudget.test.tsx`, which fails on the
first version of the hook).

**Measured in the browser** (production preview, SwiftShader in WSL, 390×844, real generation
`nyc-2026-09-18-393d4cd24a30`, Midtown, June 21 15:00, before the review fixes moved the layer):

| step | result |
|---|---|
| tap → first region drawn | 3.3 s (shard load + graph build + one search) |
| main-thread long tasks, idle page | none |
| main-thread long tasks, tap → first region | 2, longest 826 ms — the graph build, on the main thread |
| main-thread long tasks, 7 slider steps | 5, longest 113 ms (merge + redraw; the search is in the worker) |
| outcome, 8 → 20 min of sun | `approximate` at 8–12, `exact` at 15–20 |

G2 committed no main-thread long-task budget, so these are stated, not checked against one.
The 826 ms first-tap task is the one material cost; moving the graph build into the worker is
filed as a follow-up.

**What H3b does not claim.**
- The proven walk to a solid street can loop and switch sidewalks; the map shows the street, not
  the walk.
- The departure is rounded to the nearest 15-minute clock slot; the shade is clear-sky geometry.
- Walk time has no stops at crossings.
- The browser figures are SwiftShader, roughly 2× slower than the owner's machine, and predate
  the review fixes (lines above the shadow, one per street) — the look after them is unverified
  in a browser.

## H5a — waiting at a corner

**The model.** With `allowWaits` (time-aware shade only), a walker standing at a corner may wait
until the next shade bucket begins. While waiting they stand on the corner's shadiest sidewalk:
the largest shade, in the current bucket, of any street leaving the corner. A wait costs
`seconds × (1 − that shade)`. Waits end only on bucket boundaries. Within a bucket the shade
cannot change, so a shorter wait buys nothing. This keeps the state space finite and the oracle
exact. A walk reports its waits (`SunReachWalk.waits`, an index into `nodeIds` and a length).
No UI calls it yet.

**Earlier arrival no longer dominates.** The committed fixture ("the earlier arrival is the
worse one") reaches a corner at 20 s. Walking on at once crosses the next street in full sun, at
22 s of sun in total. Waiting 40 s in the shade for that street's shadow costs 2 s in total, and
only the wait fits a 3 s budget.

**Pruning, re-proved.** H3's rule lets *a* prune *b* (same corner and bucket, *a* earlier by
Δ) when `sun(a) + slack ≤ sun(b)`. With waits, *a* follows *b*'s walk Δ early (the slack covers
the extra sun) until *b*'s first wait. *a* then waits to the same boundary, which is Δ more
seconds of standing and at most Δ more sun. From that boundary on, the two are the same walk.
So with waits the slack gains a `+ Δ` term (`covers` in `sunReach.ts`). Without waits nothing
changes.
- **This term may be looser than needed.** A fuzz of 24,000 random graphs (sunny corners, shade
  arriving in small steps) found no case where the plain H3 slack is wrong with waits on. Often
  *a* can just skip the wait and stay within the old slack. That argument is not a proof, so
  the provable term ships, and no committed fixture fails without it.
- **Cost.** More labels survive pruning. The seeded oracle suite needs 256 labels per slot (not
  64) to stay `exact` with waits on. The H3 NYC timings are not re-measured with waits.

**Evidence (`app/lib/__tests__/sunReach.test.ts`, "H5").**
- The search with waits equals the exhaustive oracle (which also waits) on every seeded
  time-aware lattice, and waiting opens streets on some of them.
- Turning waits on never shrinks a region.
- Every witness with waits re-prices exactly: walking sun + waiting sun = the reported sun.
- A wait in the sun is priced. A sunny corner can't buy free shade by standing.
- The search waits at the start when that's where the shade is.
- Mutants: removing the wait move, or making waits free, each fails the oracle and witness tests.

**What H5a does not claim.**
- There is no dwell, and no return leg. Those are H5b, below.
- The waiting walker crosses to the corner's shadiest sidewalk for free, the way the search
  already switches sidewalks for free.
- Opening hours are not modelled.

## H5b — the round trip: out, a stay, and home

**The question.** With `roundTrip: { dwellSec }`, a street counts only if some whole outing
walks it within both budgets: out from the start (waiting where `allowWaits` lets it), a stay
of `dwellSec` at one corner, then home. Sun and time count the whole outing, so a route's sun
is walking sun + waiting sun + dwell sun. The stay is spent on the corner's shadiest sidewalk,
as a wait is, and **priced bucket by bucket**: a 30-minute stay spanning two shade buckets pays
each its share.

**How it proves a street.** The H3 search runs one way and tries each street it walks as a
turnaround: stay at its far corner, then walk home along one of two fixed walks, the fastest or
the shadiest (each a least-cost tree to the start over the reversed graph), priced at the
buckets it is actually walked in. A success proves every street that outing walks, out and
back. Each street gets 4 tries before it is left to the bound. Labels that cannot get home even
on the best case (least time home plus the stay, least optimistic sun home) are not kept.

**Never more than the truth.** A round trip proves only what a walk home from that corner
shows, so it can miss a street that only a cleverer walk home (one that waits, or loops for the
shade) would reach. That street stays **undecided**, never unreachable, because the outer bound
adds the stay and the best case home to H3's bound. The outcome is `exact` only when that bound
leaves nothing undecided.

**Evidence (`app/lib/__tests__/sunReach.test.ts`, "H5b").**
- **Oracle.** An exhaustive two-phase oracle enumerates every outing (out, waits, stay, home) on
  the 60 seeded lattices (with stays of 0, 15 or 40 s, and waits on half the cases). On every
  case `reachable ⊆ truth ⊆ reachable ∪ undecided`, and `exact` results equal the truth (36 of 60).
- **Coverage.** Proofs find 962 of 996 true streets (96.6%).
- **Every reported outing adds up.** It starts and ends at home, includes the street, and
  re-priced from scratch, its walking + waiting + dwell sun equals the reported sun and its
  arrival equals the reported time. This is the brief's acceptance test, on every proven street
  of every case.
- **Hand fixtures.**
  - 20 s of walking sun + 10 s of dwell sun = 30 s.
  - A stay spanning a sunny and a shaded bucket pays for both.
  - A street reachable one way but not there and back is neither proven nor undecided.
- **Mutants.** Each of these fails at least one test:
  - a free stay;
  - a stay priced at its end bucket only;
  - a stay that takes no time;
  - ignoring the sun or the time of the walk home;
  - a bound that forgets the way home;
  - claiming `exact` from a complete search;
  - pruning outings that could still get home (coverage drops to 94.5%; the test needs 96%).

**Measured on NYC** (the H3 setup above: 12 starts, *S* = 8 min, *T* = 20 min, walk; run
with `REACH_WAITS=1` and/or `REACH_DWELL=<minutes>` on the same audit command; street km).

| start | one way (H3) | + waits | round trip, no stay | round trip, waits + 10 min stay |
|---|---|---|---|---|
| LES → Kips Bay 12:43 | 353.7 km / 574 ms | 352.2 / 624 | 75.1 / 611 | 17.2 / 533 |
| UES → Murray Hill 16:03 | 230.7 / 318 | 230.7 / 413 | 59.4 / 483 | 11.7 / 391 (exact) |
| UWS → FiDi 15:12 | 219.5 / 557 | 219.4 / 692 | 62.2 / 737 | 13.3 / 654 |
| Chelsea → Union Sq 10:00 | 252.6 / 304 | 250.6 / 440 | 53.3 / 375 | 10.9 / 329 |
| Harlem → UWS 08:30 | 260.2 / 388 | 259.8 / 474 | 58.6 / 456 | 11.2 / 414 |
| Park Slope → Bklyn Hts 14:00 | 230.6 / 382 | 229.1 / 529 | 57.5 / 548 | 11.2 / 495 |
| Williamsburg → Greenpoint 17:30 | 286.2 / 422 | 284.9 / 547 | 71.4 / 468 | 17.0 / 467 |
| Astoria → LIC 11:15 | 286.7 / 375 | 283.3 / 1803 | 57.8 / 478 | 12.0 / 471 |
| Midtown → Central Park 13:00 | 294.6 / 419 | 293.2 / 1830 | 66.7 / 508 | 17.4 / 525 |
| FiDi → Chinatown 09:00 | 228.6 / 445 | 228.4 / 748 | 93.3 / 511 | 25.8 / 383 |
| Bed-Stuy → Crown Hts 15:45 | 260.8 / 327 | 259.6 / 363 | 51.5 / 407 | 11.3 / 405 |
| Inwood → Washington Hts 12:00 | 95.7 / 243 | 95.4 / 361 | 30.3 / 320 | 10.6 / 360 |

- **Waits do not pay on NYC at the default cap.** They roughly double the labels and make
  every region the same or *smaller*: waiting labels evict others from full slots
  (`approximate` can shrink; see H3). Turning waits on in the UI needs a larger cap, or a cap
  for waits of their own, and should be re-measured first.
- **A round trip covers about a quarter of the one-way street km**, as halving the walk radius
  should. Undecided stays small: ≤ 8.5 km with no stay, ≤ 3.8 km with a 10-minute one.
- Round trips cost about what one way does: 320–740 ms. The two 1.8 s figures ran alongside
  the full test suite and are load, not the search.

**What H5b does not claim.**
- The walk home is one of two fixed walks, so a street that only a waiting or looping way home
  reaches is undecided, not proven.
- There is no UI yet. The panel's round-trip toggle and stay length are H5c.
- Directions routes ignore a stop's dwell (#391).

## H5c — round trips in the Sun Budget panel

**What the user gets.** A "One way / Round trip" switch, and with a round trip a stop of none,
10 or 30 minutes. The walk time stays walking time: a 20-minute round trip with a 10-minute stop
searches a 30-minute budget with `roundTrip: { dwellSec: 600 }`, and the stop's sun counts against
the sun budget. The headline names the trip ("there and back, with a 10-min stop"). A tapped
street shows its whole outing: out, the stop (where the marker sits), and home, with the time
home, the minutes at the stop and all the sun. Waiting stays off in the UI (H5b: on NYC it
shrinks regions at the default cap).

**The graph's shade covers the whole outing.** Streets are fetched for the longest walk
(30 min), but shade buckets for the longest outing: walk + the longest stop, 60 min (4 buckets,
`horizonSec`). Built for the walk alone, a 30 + 30 round trip would price its last half hour
at the second bucket's shade, which the search clamps to (found in review). The first region
still draws in 4.1–4.7 s.

**Trips never mix.** The map merges results for the same graph *and* the same trip only. A
one-way street is never proof of a round trip (`useSunBudget.test.tsx`; the mutant that merges
across trips fails it). The worker replays a walk only for the trip on screen
(`sunBudgetWorkerProtocol.test.ts`).

**Checked in the browser** (production preview, SwiftShader in WSL, real generation
`nyc-2026-09-18-393d4cd24a30` served locally behind `VITE_NAVIGATION_BASE`, a plain background
in place of MapTiler, Midtown, July 1 15:00).
- Desktop: the first one-way region drew in 4.4 s (graph build + search). Switching to a round
  trip, then a 10-minute stop, then back to one way redrew in 0.3–1.2 s each, and the right
  region showed each time.
- A tapped street showed its round trip ("30 min home, 10 of them at the stop, 3 min of direct
  sun in all"; at 30 + 30, "57 min home, 30 of them at the stop").
- Phone (390×844): the round trip with a 30-minute stop drew. Every control in the panel is at
  least 44 px tall.
- **Not checked:**
  - with real MapTiler tiles, or at night;
  - the panel's look inside the phone's bottom sheet: the scripted drag couldn't open the sheet,
    so the controls were measured, not seen.

## H4 — properties, figures and the published gap

The four property tests the brief asks for. Three are new (`app/lib/__tests__/sunBudgetProperties.test.ts`);
the fourth is H3's one-way monotonicity, extended here.
- **Widening a budget never removes a street.** H3 proved it one way. It now covers waits,
  round trips, and both together, on every `exact` result along a sun-then-time widening
  ladder.
- **The region under *B − ε* is inside the region under *B*, as painted.** A single capped
  result can shrink when the budget grows by 1 s; the test finds such shrinks (at slot caps
  1–2) and requires that `mergeRegion`, which is what the map paints, never does.
- **Zoom and basemap never change geometry exposure.** Three tests, each failing on a mutant that
  passed the first version (which checked only argument counts and determinism):
  - **Values, not just determinism.** The table graph carries each sidewalk's own column at each
    bucket's own slot, so a swapped side or slot fails.
  - **Directions never reads the canvas when the table covers the route.**
    `routeNeedsCanvas` (`useRouting.ts`) is the one gate on the pixel path. It is false whenever
    the table covers every edge, whatever the coverage, and still true off the table at low
    coverage (rain never falls back).
  - **No map API on the table path.** `reachGraph.ts`, `shadeTable.ts`, `sunReach.ts` and
    `mergeRegion.ts` call no map, canvas or style API.
  - **Limits.** These cannot catch a value smuggled in through a global, or a canvas read that
    bypasses `routeNeedsCanvas`. No hook test runs the full Directions table path, which would
    need the published-snapshot pipeline mocked end to end.
  - **Not true of the live tile provider:** below zoom 15 MapTiler serves a decimated building
    layer. That path is zoom-dependent by design and guarded instead: it reports completeness
    0.5 there, so its answers fall under the routing confidence floor
    (`providers.test.ts`, "reports full completeness only where the tile layer is complete").
- **A start time reaches every leg and every stay.** Two halves:
  - a departure 15 min later reads every bucket one table slot later
    (`shadeSlotsForDeparture`). Shifts that are not a whole bucket round to the nearest slot, so
    "exactly" holds per bucket only;
  - on that later sky, every proof the search returns (one way, with waits, round trip)
    re-prices exactly on the original sky with its clock started one bucket in, streets, waits,
    the stop and the walk home alike.
  - For Directions this needs #391: routes with stops are priced at one instant today.
  - **What this is and isn't.** Half (b) checks that each witness costs what it reports on a
    shifted sky. No test chains the two halves, for example `buildReachGraph` at two departures.
- **The tests can fail.** Each of these breaks at least one test:
  - pricing a street at its start bucket;
  - pricing a stop at its first bucket only;
  - painting without the merge;
  - reading every bucket at the departure slot.

**Figures** are in `docs/notes/evidence.md` §2.4: the gap, runtime, memory and cache. Reproduce
the NYC ones with `REACH_REPEAT=6` (plus `REACH_WAITS=1` or `REACH_DWELL=10`) on the audit
command in "H3", above.

**CI budget.** Actions is off on `umbra`, so these timings come from local runs:
- `sunReach.test.ts`: 22.8 s for 82 tests (the exhaustive oracles);
- `sunBudgetProperties.test.ts`: 0.4 s;
- `routingOracle.test.ts`: under 0.1 s.

The whole suite ran in 33 s wall time (3,034 tests). No flake has been seen in these files across the H5 runs.
The oracles and their seeded cases now live in `app/lib/__tests__/sunReachOracle.fixture.ts`,
shared with H7.

## H6 — "is this outing possible?" for the assistant

**The question.** From a start, walk to a target, stay `stayMin` **at the target**, and be home
within `timeMin` (stay included) on at most `sunMin` of direct sun. The target is snapped into the
street graph exactly, so a café mid-block is half a block away, not a whole street. Both ends keep
**both sidewalks**:
- `splitStreetsAt` splits every parallel sidewalk edge at the target, choosing the finest split
  piece, so a start on the same block is a direct neighbour.
- `widenVirtualNode` re-wires the snapped start the same way.

`snapToEdge`, which routing uses, copies one sidewalk and never splits a virtual edge. The final
review showed that made a "Not possible" bound too high: a shaded sidewalk was missed, and a café
on the start's own block was reached via a corner.

*An earlier version asked H5b's round trip of the street nearest the target. The review of the H6
PR showed that was wrong in both directions: the round trip lets the stay happen at any corner (a
false "Possible"), and "not reached" was not a proof for the user's question (a whole street
instead of the café, a disconnected path or the data's edge read as "time binds").*

**The answer is a typed certificate** (`app/lib/reach/feasibility.ts`), never prose.
- **`feasible` is constructive.** A walk the search kept that arrives at the target (`arrivalsAt`,
  waits allowed), the stay at the target's shadiest sidewalk priced bucket by bucket
  (`stayExposure`), and a walk home (the fastest or the shadiest fixed walk), all within both
  budgets. The certificate carries that outing and the sun and time it used.
- **`infeasible` is proved, per budget.** Each lower bound holds for every outing:
  - time binds when least walking time out + stay + least walking time home > *T*;
  - sun binds when least possible sun out (every street at its shadiest bucket) + least possible
    stay sun + least possible sun home > *S*.
  - Both bounds are in the certificate, and both flags can be set.
- **`unknown` is never a no.** It means the bounds fit but no kept walk plus a fixed walk home
  does. It is also the answer for any "infeasible" on a graph cut at the data's edge (#380),
  because streets past the edge could change the answer.
- **`unreachable`.** No path in the street data joins the start to the target, for example a
  park path the streets don't reach. This is not a budget question.
- **`too-far` / `uncovered` / `cancelled` / `superseded`.** No answer, and why. `superseded` means
  a newer check of the same target in the same turn.
- **Every certificate cites** the question (with the app's name for the target), its input
  version, the model version and the shade generation.

**How the assistant uses it** (`check_sun_budget`, `app/lib/agent/tools.ts`):
- **Inputs.** The start and target must be places the app produced, or the call is refused. Budgets
  are bounded: up to 60 min each.
- **The target's name** comes from the tool result that produced the target, sanitised; the model
  cannot supply it.
- **Where it runs.** In the Sun Budget worker, on a graph of its own sized to the question, so the
  panel's graph is left alone.
- **When a verdict verifies.** A `feasibility` receipt verifies only if:
  - it cites a check from **this turn**;
  - the check passed envelope validation and is not an error;
  - the claimed status equals the certificate's;
  - no newer check of the same target replaced it.
- **What is shown.** The words come from the certificate (`feasibilityLabel`, which names the
  destination and, for "not possible", the bound that rules it out). A model that claims
  "feasible" against an infeasible certificate is rejected, and the loop rebuilds the answer from
  the evidence.
- **The evidence link.** Each verified verdict links to `evidence.md` §2.4. The link is static:
  it explains how the search is checked (H4) and the independent integer program (H7), not this
  certificate's own walk.

**Evidence.**
- **Unit tests** (`app/lib/reach/__tests__/feasibility.test.ts`), including the review's probes:
  - the stay must be at the target;
  - a mid-block café is half a block;
  - sun binds even when the search is capped;
  - a disconnected target is `unreachable`;
  - an "infeasible" at the data edge is `unknown`;
  - the walk home's sun counts.
- **Loop and verifier tests** (`app/lib/agent/__tests__/feasibilityLoop.test.ts`):
  - every status;
  - two sabotage cases;
  - a missing status, a failed check, a malformed certificate, and an earlier turn's certificate,
    all rejected;
  - café A then café B in one turn both answer;
  - the executor passes the question through as asked.
- **The panel** shows the evidence link on verified verdicts only. A stored verdict keeps the
  checks of its own turn when the app re-verifies answers on each render (`useAgent`); a reset
  clears them. The browser run caught this: without it, every verdict rendered as "unverified".
- **In a browser** (production preview, the real worker on generation `nyc-2026-09-18-393d4cd24a30`
  served locally, the model scripted):
  - home → Bryant Park Cafe with a 15-min stop, 45 min, ≤ 8 min of sun: *"Possible … a walk found
    does it in 35 min with 2 min of sun"*, in 4.3 s;
  - 6 min with a 5-min stop: *"Not possible … any such outing takes at least 11 min, and any such
    outing gets at least 1 min of sun"*, in 2.0 s. The sun bound was 2 min before both sidewalks
    were kept;
  - 12 min with a 2-min stop on ≤ 1 min of sun: *"Not confirmed either way"*;
  - a scripted model claiming "feasible" against that certificate showed the same "Not possible".
- **Mutants.** Every one tried is caught, including the five the review found surviving:
  - envelope validation skipped;
  - the worker radius;
  - the horizon;
  - the stay doubled;
  - the link shown on rejected verdicts.

**Not done here.**
- The live comparison against a text-only or single-pass baseline under C13 needs the real model
  (`npm run eval:agent`, run by the owner).
- NYC only (#380).
- `superseded` and `cancelled` rarely occur in practice, because a turn runs one check at a time
  and a reset clears the evidence.

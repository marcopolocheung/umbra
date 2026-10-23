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
- **Monotonicity.** Widening either budget never shrinks the region.
- **The tests can fail.** Dropping the slack term fails the #246 fixture and one lattice.

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

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
tens of nodes, not a city, so the whole file runs in **under a second**.

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
Pareto point where routes merge at an interior node across a bucket boundary.**

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
| 0-1-3-4 (production returns this) | 79.8 | 57.00 |
| 0-2-3-4 (production drops it) | 86.8 | **55.00** |

So on this fixture the production's least-sun option is **2.00 s worse than the
true optimum (3.6% of it)**, and a non-dominated option is missing from the front
entirely. The test asserts both: the oracle's minimum is 55 s, the production's
is 57 s, and the dropped node-path is absent from the result.

**Where it is exact.** On the *static* fixtures — a single time bucket, so the
defect cannot occur by construction — the production's shortest equals the
oracle's least-distance path, its least-exposed option equals the oracle's
minimum sun seconds, and no returned option is dominated; that holds on the line
fixture and on a randomized 2×3 grid. In time-aware mode the oracle has no
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
- **The fix is not here.** Correcting the bucket-boundary dominance belongs to
  H1/H2's search (`routing.ts`); H4 measures the gap and publishes it.

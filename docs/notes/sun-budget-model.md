# The exposure model, and its oracle (H4)

**2026-10-03.** H1/H2 gave the routing search a time-dependent, exposure-aware
objective: minimise cost metres under a detour budget, and on the front minimise
**sun seconds**. This note is the correctness evidence for that search — an
exhaustive oracle it is compared against — and the one number the comparison
publishes.

## The model the search implements

For a walk from `start` to `end`:

- **Cost metres** accumulate `modeAdjustedDistanceM(edge)` plus the crossing
  penalty at interior intersections; the search may not exceed
  `shortestCost + shortestDistance·(maxDetourFactor − 1) + DETOUR_FLAT_M·speedRatio`
  (`DETOUR_FLAT_M = 250`, `maxDetourFactor = 2.0`).
- **Sun seconds** accumulate `edgeTraversalSeconds(edge) · (1 − shadowFactor)`,
  where the shadow factor is read at the arrival bucket when H1's `timeAware` is
  set (`timeShadow[bucketOf(arrival)]`) and from the static `shadowFactor`
  otherwise. Fewer is better.
- **The sun-streak** tracks the longest unbroken sunlit run, for the
  `maxContinuousExposureSec` cap, and is part of the dominance comparison.

## The oracle

`app/lib/__tests__/routingOracle.test.ts` enumerates **every simple path**
start→end on a small fixture graph, computes each one's exact
(cost metres, sun seconds) with the same per-edge rules, and takes the Pareto
front. It is exhaustive and obviously correct, so it is slow — but a fixture is
tens of nodes, not a city, so it runs in the normal suite in **under a second**.

Fixtures must place node coordinates consistently with their edge distances: the
search's straight-line heuristic reads coordinates, so arbitrary positions give
it an inadmissible bound and it can mis-prune the optimum. (This bit the first
draft of the fixture — the search "missed" the shortest path because the
heuristic overestimated it.)

The oracle shares the production's *per-edge* cost functions
(`modeAdjustedDistanceM`, `edgeTraversalSeconds`). That is deliberate: it tests
the **search** — dominance pruning, the budget bound, the bucket bookkeeping —
not the cost model. An oracle that re-derived the cost model would conflate two
questions.

## What it found — the published gap

**The search is exact on the discretized model: gap 0.** On every fixture the
production's shortest option equals the oracle's least-distance path, its
least-exposed option equals the oracle's minimum sun seconds, and no returned
option is dominated by an enumerable path. The three representatives the app
shows are a *sample* of the front, not the whole front — that is a UI choice, not
a search gap.

**The bucket sampling is where the approximation lives.** The production reads
shadow at bucket boundaries; when the real shadow changes inside a bucket, the
sampled value misprices the edge. The pinned fixture: a walker reaches a shaded
edge at 181.4 s, inside bucket 3 ([180, 240)), where the shadow has just turned
on; the bucket's boundary sample still reads "open", so the whole edge is charged
as sun. **The gap is up to one edge's traversal seconds** — 71.4 s on the 100 m
fixture edge — and it is a property of how the caller fills `timeShadow`, not of
the search, which is exact given the buckets it is handed.

## What this does not claim

- **Small graphs only.** Exhaustive enumeration does not scale; the oracle is a
  fixture test, not a runtime check.
- **The cost model itself is untested here.** `shadowFactor`, the traversal
  clock and the crossing penalty are inputs, not subjects.
- **The continuous shadow is synthetic.** The bucket-gap fixture uses a step
  shadow to pin the mechanism; a real shadow sweep's intra-bucket variation is
  the caller's (H1's `field.sweep`) to characterise.
- **Not the whole front, only its extremes and optimality.** The oracle checks
  that the returned options are Pareto-optimal and that its extremes are the true
  extremes; it does not assert the app shows the full front (it does not, by
  design).

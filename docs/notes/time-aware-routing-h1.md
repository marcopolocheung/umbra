# H1 — traversal-time exposure (time-aware routing)

Date: 2026-10-02 · Branch: `feat/h1-traversal-time-exposure` · Brief: `docs/tracks/TRACK_H.md` §H1

## What changed

`paretoRoutes` gained an optional `timeAware: { bucketMs, bucketCount }`. When
set, every label carries **arrival seconds since departure**, and each edge's
shadow is read from `GraphEdge.timeShadow[bucket]` — the bucket the walker
*arrives* in — instead of the frozen `shadowFactor`. Omitted, the search is the
static frozen-time baseline, unchanged (the entire pre-existing routing suite
passes byte-identically). Production (`useRouting.ts`) enables it for the sun
objective behind `TIME_AWARE_ROUTING`; rain, sketch and exposure-refresh paths
stay static (below).

## The parameters, stated

- **Bucket width: 15 minutes** (`TIME_BUCKET_MS` in `useRouting.ts`). A
  documented parameter, not a magic number. Finer buckets cost almost
  linearly (below); coarser ones blur the morning/evening transitions this
  exists to catch.
- **Walking speed: the mode's cruise speed** from `TRAVEL_MODE_POLICIES`
  (`travelTimeSeconds(distanceM, mode)` — walk 1.4 m/s, bike 4.5, scoot 3.0).
  Crossing and surface penalties are *search cost*, not clock minutes; pricing
  them into arrival would push walkers into later buckets for reasons no clock
  explains.
- **Edge pricing semantics: at end-of-edge arrival.** An edge spanning buckets
  is priced wholly at the bucket containing the arrival at its far node — the
  walker is on the edge *before* that instant, so this prices the last, not
  the first, moment of the leg. First-order honest; a per-edge midpoint or
  sub-edge split is H2/H4 territory if the gap measures badly.
- **Horizon: the detour budget, capped at 8 buckets** (2 h at 15 min).
  `bucketCount = ceil(travelTimeSeconds(straightLineDistM × 2.0 + 250 m))`,
  clamped to `[1, 8]`. Arrivals past the horizon clamp to the last bucket.
  Rationale: A6's measurement (`docs/notes/performance-baseline.md` § Time
  Sweep) says a sweep costs ≈ one `sampleEdges` per bucket (the batch plan
  saves 0–11%), so bucket count multiplies sampling cost nearly linearly.
- **Sampling resolution: one `field.sweep(edgeRefs, bucketDates)`** — the same
  batch, same route-scoped snapshot pin, per bucket. Geometry version and
  bucket index are bound at sweep time inside one calculation; the table is
  local to that calculation, so a stale answer from another geometry
  generation or a different bucket cannot be served merely because
  coordinates match (the brief's cache-key invariant holds structurally
  here). Edges whose sweep confidence is low keep the static answer the
  existing gating already chose — **pixel-fallback edges are frozen in
  time**, a stated limitation: canvas sampling is per-instant and the
  canvas is not re-rendered per bucket.

## The comparison the acceptance wants

Committed as `app/lib/__tests__/timeAwareRouting.test.ts` — two equal-length
branches, each leg 1200 m (≈857 s on foot), bucket width 15 min:

- **Branch X** (north): shadowFactor 0.9 at departure, `timeShadow [0.9, 0.0]`
  — shadowed when the sample froze, bare by the time the walker's second leg
  arrives (bucket 1).
- **Branch Y** (south): shadowFactor 0.1, `timeShadow [0.1, 0.9]`.

**Static run:** most-shadowed = X (coverage 0.9 — the frozen sample's view).
**Time-aware run:** X's second leg is priced bare, so X carries 0.9·1200 +
0.0·1200 shadowed metres at equal distance — strictly dominated, dropped from
the front entirely; every surviving option goes south (Y, coverage 0.5). The
difference is attributable to specific edges: X's 2→4 leg, priced at bucket 1.

Three more properties are pinned: a one-bucket horizon degenerates exactly to
the static answer; arrivals past the horizon clamp to the last bucket; edges
the caller never swept fall back to the frozen factor rather than reading a
bucket that was never computed.

## Dominance, revalidated for the time dimension

A label now carries `(distM, exposureM, arrivalSec)`, and the Pareto state is
**(node, time bucket)** — labels that reach a node in *different buckets* are
incomparable. That is the load-bearing decision, and it corrects the first
version of this change: a dominance rule that lets an earlier-arriving label
prune a later one (even "no longer, no less shadowed, and earlier") throws
away routes whose remaining edges are the shaded ones — the exact trap H5's
brief names ("do not assume an earlier arrival dominates a later one"). A
committed regression test pins it: two all-sun paths reach a junction, the
shorter in bucket 1 and the longer in bucket 2, and the final edge is shaded
only in bucket 2 — the slow path must survive the junction and win.

**Residual, stated:** inside one bucket, dominance still includes "no later",
so two arrivals in the *same* bucket whose next edge straddles a bucket
boundary can in principle mis-prune. That error is bounded by the bucket width
and is exactly what H4's brute-force oracle must measure. For walk, cost ≈
time, so the same-bucket rule is nearly implied; for bike/scoot the surface and
crossing penalties break cost≈time, which is why arrival is part of the label
at all.

## Known gaps (deliberate, for later checkpoints)

- **Via-stop legs and transit walk legs are still priced at one frozen
  instant** — they call `dijkstra`, which does not read `timeAware`. The sweep
  is skipped on those routes so they don't pay for it. H2/H3 consume them.
- The sketch pipeline (`useSketch.ts`) and condition-only refresh
  (`routeExposureRefresh.ts`) still sample at one instant. H2/H3 consume them.
- Bucket factors are piecewise-constant in time; the discretization error is
  not yet measured. H4's oracle publishes it.
- The horizon is sized from the *straight-line* distance while the search
  budget uses the shortest path, so it can run short on detour-heavy O-D
  pairs; arrivals past it clamp to the last bucket (coarser, never wronger in
  structure).
- Waiting/dwell are not modelled — H5.

# Track H — Sun Budget

> **Charter:** make the sun *move while you walk*. Price every segment at the time the walker
> actually reaches it, make exposure duration the objective instead of shadowed metres, and turn
> the result into the question no other maps product answers: **"where can I even go?"**

**Class:** Flagship — and the only track whose output nothing else in the market has.
**Runs alongside:** B, C, D, F freely; ⚠️ A and E (all three edit `routing.ts`); ⚠️ G (H4 shares
G's fixture and benchmark infrastructure).

---

## Current state

- **Active checkpoint:** H1 — **not started, and correctly blocked.**
- **Gate:** do not start until **A6 (time sweep)** and **G2 (route benchmark)** have landed.
  H1 without A6 costs one full shadow evaluation per time bucket per edge and will not run at
  interactive speed; H3 without G2 has no committed baseline, and this track's central claim is
  a *comparison* against the static method. Starting early produces a demo that cannot be
  defended, which is the one outcome this track exists to avoid.
- **Done:** nothing in H1–H4. One prerequisite cleared: **#208** — `parallelSidewalkEdges`
  rebuilt each sidewalk edge from scratch and silently dropped the five OSM access tags
  `overpass.ts` had filled in, so H2/H3's "hard constraint" had nothing to read. It now
  returns the source edge with only `shadowFactor` and `side` replaced.
- **Open PRs:** none.
- **Decisions made:** none yet. The design notes below are the starting position, not
  decisions — record real ones here as they are made.
- **Blocked on:** A6, G2. Track A owns both; file against `track-a` / `track-g` rather than
  building either here.
- **Next action:** H1 — traversal-time exposure, behind a flag, with the H4 oracle written in
  the same PR or the one immediately after.
- **Last verified:** 2026-09-08 — #208 fixed; access tags now survive the sidewalk split.

---

## Why this track exists

`docs/ROADMAP.md` §2 states the differentiator in five clauses. This track owns the first two.

**Corrected 2026-09-08 (#206) — do not restate the old version.** Advancing the sun along a walk
is *not* unprecedented: Fujiwara et al., *Building and Environment*, 13 Sep 2024, §6.2 already
integrates accumulated irradiance over a walk using departure time, walking speed and
position-specific timestamps. They evaluate **three predefined routes**. What is ours is
everything that follows from making it a *cost function*: a constrained search over
`(node, arrivalTime, accumulatedExposure)`, inverted into a reachability question, in a browser,
repaired by an agent, with the approximation gap published. Cite the paper as related work in
`sun-budget-model.md` (H4) — a track that names its prior art and still has a contribution is
more credible than one that claims there is none.

Today `useNavigation.ts` samples every edge of the graph at a single `dateRef.current`
(`:633`, `:1154`). A 40-minute walk is priced as if it happened in an instant. That is fine for
a 400 m route at noon and wrong in exactly the cases the product is *for*: a long trip in the
late afternoon, when the most shadowed street at departure is the sunniest by the time you reach it.

Worse, the objective is measurably pointed at the wrong quantity. `paretoRoutes` finds the
front of **(distance, shadowed distance)** (`routing.ts:544`) under a detour budget of
`shortestDist × 2.0 + 250 m`. Maximizing shadowed metres inside a budget that generous means the
"Most Shadowed" option can accumulate **more absolute exposed metres** than "Shortest":

```
Route A: 1,000 m total,   800 m shadowed →  200 m exposed
Route B: 1,500 m total, 1,000 m shadowed →  500 m exposed   ← "more shadowed", 2.5× the sun
```

B is inside the default budget and wins the "most shadowed" slot. `longestContinuousSunM` is
already computed (`routing.ts:481`) and `sunExposure` already exists on legs — but both are
display-only. Neither enters the search.

**So this track is not speculative new capability.** H1 and H2 are a correctness fix to
something the app already claims to do, and H3 is the product that becomes possible once the
fix is in.

---

## Checkpoints

### H1 — Traversal-time exposure
**Goal.** Every edge is evaluated at the time the walker reaches it, not at one frozen instant.
**Approach.** Extend the routing state from `node` to `(node, arrivalTime)`. Compute arrival
time from the existing `travelTimeSeconds` (`travelMode.ts`, already imported by
`useNavigation.ts`). Discretize time into buckets — start with 15 minutes; the bucket width is
a documented parameter, not a magic number — and use **A6's `sweep(edges, times[])`** so all
buckets cost far less than N separate `sampleEdges` calls. Store the shadow answer against
**versioned geometry *and* time bucket**: never serve a value computed for a different geometry
snapshot or a different bucket merely because the coordinates match. Ship behind a flag with
the static path intact for A/B comparison — H2 and H4 both need to run both.
**Acceptance.** On a fixture where the most shadowed departure-time path is measurably worse by
arrival, the time-aware run picks a different route than the static run, and the difference is
attributable to specific edges in a written-down comparison. Bucket width, walking speed
assumption, and sampling resolution are all documented. The static path still passes every
existing routing test.
**Files.** `app/lib/routing.ts`, `app/lib/shadowField/ShadowField.ts` (consumer only — A owns it),
`useNavigation.ts` (⚠️ contested), new fixtures under `app/lib/__tests__/`.
**Size.** Large. **Depends on A6.**

### H2 — Exposure as the objective
**Goal.** Optimize the thing the user cares about: minutes in the sun, not metres of shadow.
**Literature (2026-09-09, ROADMAP §5c) — read #241 before writing the note.** Ma et al. 2025
enumerated 2.2 M routes and found that minimising *unshadowed metres* — **exactly this
checkpoint's corrected objective** — scored **worse than the plain shortest route in 24% of 1200
O-D pairs** (41% at 08:00). H2 still lands: maximised `shadowM` is a real defect. But the note
must say that minimised exposure is *better than* maximised shadow and *still not* the comfort
objective, with that bound attached. Also **#243**: `maxDetourFactor = 2.0` is ~10× the detour
any of three studies finds useful — measure it through G2 rather than editing the constant.
**Approach.** Replace the maximized `shadowM` criterion with **minimized exposure duration**,
computed from H1's per-edge traversal times. Keep the front bi-criteria — (travel time, exposure
time) — so the three route representatives still mean something, and re-derive the "balanced"
knee in the new normalized space. Add `maxContinuousExposureS` as an optional hard constraint,
since `longestContinuousSunM` already proves the data is there. Re-validate the dominance rule
explicitly: a rule that was sound for (distance, shadowM) is **not automatically sound** once a
label carries time and accumulated exposure, and this is the single most likely place for a
silent correctness bug in the track.
**Acceptance.** The Route-A/Route-B fixture above is committed as a regression test and the new
objective picks A. Every route option reports exposure duration alongside coverage. A written
note explains what changed and why the old objective was wrong — this is **P5** (design notes) material, so
write it properly the first time.
**Files.** `app/lib/routing.ts`, `routeTradeoff.ts`, `app/lib/__tests__/routing.test.ts`.
**Size.** Medium. **Depends on H1.**

### H3 — Sun Budget reachability
**Goal.** *"Show me everywhere I can reach on ≤8 minutes of estimated direct sun, round trip."*
**Approach.** A bounded label-setting search over `(node, arrivalTime, accumulatedExposure)`
producing a reachable set rather than a path, rendered as a region. Inputs: exposure budget,
time budget, optional dwell at a stop, optional return deadline, travel mode (Track E's).
Runs in **A5's worker** — this must never block the main thread while the budget slider moves.
Reuse the streaming-progress plumbing that already exists so the region fills in progressively
instead of appearing after a freeze.
**Distinguish three outcomes and never conflate them:** an exact result on the discretized
model, a bounded approximation with a stated gap, and *a search that hit its budget*. **A capped
search that returns nothing has not proved the request is impossible**, and the UI must not say
it did.
**Acceptance.** The region renders and updates interactively on a neighbourhood-sized graph
with the budget slider moving; main-thread long-task time stays within **G2's** committed
budget; each of the three outcomes is visually and textually distinct; widening the budget
never shrinks the region (property test, H4).
**Files.** `app/workers/routing.worker.ts` (A5's, extended), `app/lib/routing.ts`, a new
reachability layer module in `MapView.tsx` (⚠️ contested — after G6 this is one layer module).
**Size.** Large. **Depends on H1, H2, A5.**

### H4 — Correctness oracle and the published gap
**Goal.** Turn H into evidence instead of a demo.
**Approach.** Brute-force enumeration over small time-expanded graphs as ground truth — tens of
nodes, exhaustive, obviously correct, slow. Compare the production search against it. Then
property tests:
- widening an exposure budget never removes a previously feasible path (exact model);
- map zoom and basemap styling never change geometry-based exposure (this one guards the
  invariant-#5 pixel-fallback path from leaking back in);
- a start time propagates through every leg and every dwell;
- the region under budget *B* contains the region under budget *B−ε*.

Publish the approximation gap on the exact fixtures, the runtime distribution, memory, and cache
hit behaviour.
**Acceptance.** The oracle is committed and runs in CI within G's flake and runtime budget; the
gap is a number in `docs/notes/` and reaches the evidence page (**P4**). If the gap is bad, the
number ships anyway — that is the point.
**Files.** `app/lib/__tests__/` oracle + fixtures, `docs/notes/sun-budget-model.md`.
**Size.** Medium. **Coordinate with Track G** — G owns fixture and benchmark infrastructure.

### H5 — Waiting, dwell, and the return leg
**Goal.** Model the parts of a real outing that are not walking.
**Approach.** Treat waiting as an **explicit action with its own exposure** — waiting in the sun
costs, waiting in shadow does not. Add per-stop dwell (Track E's `Trip` carries it; consume,
don't reinvent) and an exposed-destination-dwell term. Then the subtle part: **do not assume an
earlier arrival dominates a later one.** Arriving early may require waiting, and that wait may
itself violate the exposure budget or a venue's opening hours. Any pruning rule must be shown
valid for the chosen waiting model, not assumed from the no-waiting case.
**Acceptance.** A fixture where the earlier arrival is genuinely worse is committed and passes;
the total exposure a route reports equals walking exposure + waiting exposure + dwell exposure,
checked by test; the model's assumptions are in `docs/notes/sun-budget-model.md`.
**Files.** `app/lib/routing.ts`, `app/lib/trip/**` (E's — consume via the contract).
**Size.** Medium. **Depends on H3; coordinate with E5.**

### H6 — Feasibility answers for the assistant
**Goal.** Close the loop with Track C: the agent asks "is this possible?" and gets a real answer.
**Approach.** Expose H3's search behind a tool that returns feasible / infeasible / *unknown,
budget exhausted*, with the violated constraint named when infeasible. This is what makes the
§1 request ("90 minutes, coffee, ≤8 minutes of sun, home by 5:30") answerable rather than
narrated. **Depends on Track C's C4 job contract** — a feasibility query that returns "started" is
useless.
Return a typed certificate: input/plan version, model and geometry versions, terminal status,
constraint ledger, exposure/time totals, bound or approximation gap where available, and the
edges/observations that explain the limiting constraint. C5 receipts cite this certificate; the
agent never derives feasibility from prose.
**Acceptance.** Held-out scenarios cover feasible, proven infeasible, budget-exhausted unknown,
partial, cancelled, and stale/superseded results. The final answer and application state agree
with the certificate; injected prose claiming success cannot override it. At least one browser
flow follows a tool receipt into the H4/H7 evidence explaining the answer. Compare typed-tool
agent success with a text-only/single-pass baseline at equal budgets under C13.
**Size.** Medium. **Depends on H3, H4, C4, C5. Track C owns the tool wrapper; H owns the search
and certificate.**

### H7 — Optimization formulation, relaxation, and bounds
**Goal.** Make the optimization claim inspectable in a second, independently implemented form,
and add real linear/convex optimization evidence without replacing the interactive label-setting
search with an inappropriate solver.
**Approach.** Formulate small, time-expanded Sun Budget instances with decision variables for
edge/time traversal and waiting, flow conservation, time propagation, exposure and return-budget
constraints, and the same objective H2/H5 use. Solve the integer form offline as a reference and
its LP relaxation as a convex lower bound. State where time discretization or non-linear comfort
terms prevent equivalence rather than hiding them. Compare the production bounded-label search,
H4 brute-force oracle, integer optimum, and LP bound on identical versioned fixtures. Report
runtime, memory, optimality/approximation gap, and integrality gap.

Use the solver only in evaluation and explanation unless measurement proves it fits the product
budget. H6 may return the stored bound/certificate for a fixture or completed offline job, but a
model never invents or certifies an optimum.
**Acceptance.** A design note derives variables, objective, and every constraint; at least one
fixture exposes a loose relaxation and one catches a deliberately incorrect production dominance
rule. Brute force and integer results agree on their common small domain. Report distributions and
worst cases, not a single favorable example. Claims use “optimal” only when the integer/exact
certificate supports it and otherwise name the measured gap or unknown. The formulation and
reproduction command are versioned and linked from the agent receipt/evidence page.
**Files.** Offline solver/eval under `scripts/` or `server/`, H fixtures, model note and exported
certificates; no solver dependency in the default browser bundle. **Size.** Large. **Depends on
H2, H4, H5; coordinates with C13/P4.**

---

## Design notes (starting positions, not decisions)

- **Time discretization is the central tradeoff.** Finer buckets mean more accuracy and a larger
  state space. Start at 15 minutes, measure, and make the number a documented parameter. State
  the resulting error bound rather than implying exactness.
- **This is a discretized model, not physiology.** The formula is
  `Σ(segment duration × unshadowed fraction during traversal) + exposed waiting + exposed dwell`.
  It is not a claim about heat load — Track D owns dose and heat score, and H supplies it the
  exposure *minutes* to work from.
- **Cache keys carry geometry version and time bucket.** The most likely subtle bug in this
  track is serving a stale shadow answer because the coordinates matched.
- **Keep the static path alive** until H2 ships and H4 has published the comparison. The whole
  claim is "better than the static baseline"; you cannot make it after deleting the baseline.

## Subagent plan

- **H1 and H2 are solo and sequential.** H2's dominance rule depends on H1's state definition;
  swarming them lands H2 unverified. This is the anti-pattern `docs/tracks/README.md` names.
- **H4's property tests are swarm-able** — each is an independent test file. Write the oracle
  yourself, then fan out `builder`s on test batches in worktrees.
- **H7's formulation is solo; fixtures may parallelize after it is frozen.** An independently
  coded solver is useful only if nobody copies the production recurrence into it.
- **`verifier` on H2, without exception.** A changed objective function that silently still
  optimizes the old quantity would pass every existing test and invalidate the entire track's
  claim. Cold review is the only thing that catches it.
- **`scout`** before H1 for "every current caller of `sampleEdges` and every read of
  `dateRef.current` in the routing path" — bounded, and it keeps `useNavigation.ts` out of
  context.
- **`grounding-auditor`** on H3's UI: "reachable in 8 minutes of sun" is a user-facing number
  and the three-outcome distinction is exactly the kind of thing that gets flattened into a
  confident claim.

## Risks

1. **State-space explosion.** `(node, time, exposure)` is three dimensions where there was one.
   Bounded label search with a validated dominance rule, budget pruning, and a hard cap — plus
   an honest "budget exhausted" state — or it will not run in a browser.
2. **Claiming optimality for a heuristic.** A bounded search on a discretized model is not a
   globally optimal route, and H4 exists to keep that distinction in writing.
3. **Starting before A6.** Sampling N time buckets without the sweep is N× the cost. This is
   why the gate at the top of this file exists.
4. **`routing.ts` contention.** A, E and H all edit it. Until G6, say so in the PR's first
   sentence, keep the diff minimal, and reformat nothing.
5. **Deleting the static path too early.** See the last design note.
6. **Calling an LP bound a feasible route.** The relaxation is a bound, not necessarily an
   executable itinerary. Only an integer/exact certificate or a validated production plan may be
   presented as feasible.

## Out of scope / hand-offs

- The shadow field, the sweep API, canopy → **Track A**. Consume `ShadowField`; never fork it.
- UV dose, heat score, thermal comfort → **Track D**. H supplies exposure minutes; D converts.
- Mode policies, `Trip`, dwell as a data model → **Track E**. Consume the contract.
- The assistant's tool wrapper and the job contract → **Track C** (H6 needs C4 first).
- Worker infrastructure → **Track A** (A5). Extend it; don't create a second one.
- Fixture and benchmark infrastructure → **Track G**.

## Owns

`paretoRoutes` and the time-dependent search inside `app/lib/routing.ts`, the reachability layer
module, `docs/notes/sun-budget-model.md`, and the H fixtures.

# Sun Budget as an integer program (H7)

A second, independently built version of the Sun Budget question, so the optimization claim can be
checked, not just asserted. It runs offline only: `app/lib/sunBudgetFormulation/` is imported by tests
and `npm run eval:h7`, never by the app, and the solver (`highs`, HiGHS compiled to WASM, MIT) is a
devDependency. The production search stays the bounded label search in `app/lib/sunReach.ts`.

## The formulation

**Data.**
- A directed street graph *G = (V, E)*.
- A start *s*, a time budget *T* and a sun budget *S*, both in seconds.
- For each street *e*:
  - its traversal time *dₑ*, in whole seconds;
  - its shade *fₑ(b)* in each 15-minute (here: fixture-sized) bucket *b*.
- For each corner *v*, the shade of its shadiest sidewalk, *gᵥ(b) = maxₑ₌₍ᵥ,·₎ fₑ(b)*.
- The bucket of second *t* is *β(t)*.

**Network.** Time-expanded over *t = 0..T*.
- **Nodes:** a node *(v, t)* per corner and second.
- **Walk arc:** *(u, t) → (w, t + dₑ)* for each street *e = (u, w)* and each *t* with *t + dₑ ≤ T*.
  It costs *cₐ = dₑ · (1 − fₑ(β(t + dₑ)))*: priced at the bucket the walker reaches the street's
  end, as the search and the oracle price it.
- **Wait arc** (only with `allowWaits`): *(v, t) → (v, t + 1)*, costing *1 − gᵥ(β(t))*.
- **Round trip** (with `roundTrip`, the return budget): every node and arc above again in a
  "coming back" phase, and a **stay arc** *(v, t, out) → (v, t + D, back)* at every corner. The stay
  costs the sun of standing *D* seconds on *v*'s shadiest sidewalk, bucket by bucket (as
  `stayExposure` and the search price it).
- **Sink:** a free arc *zᵥ,ₜ ≥ 0* where the walk may end: at every node one way; only at the
  start's "coming back" copies on a round trip.

**Variables.** *xₐ ∈ {0, 1}* for every arc, and *zᵥ,ₜ ∈ [0, 1]*.

**Constraints.**
1. **Flow conservation:** at every node *n*, *Σ out xₐ − Σ in xₐ + z_n = [n = (s, 0)]*. One unit
   leaves the start and ends at exactly one sink. Time strictly increases along every arc, so the
   network is acyclic and integer flow is a single walk.
2. **Through the street:** *Σ xₐ ≥ 1* over *e*'s walk arcs (on a round trip, in either phase:
   the oracle counts a street walked out or back).
3. **The time budget**, stay included, holds by construction: no arc reaches past *T*.
4. **The return budget** (round trip): the walk can only end at the start after the stay, so the
   single unit of flow goes out, stays once, and comes home within *T*.

**Objectives.**
- **Least sun** (`streetProgram`, the default): minimise *Σ cₐ xₐ*. Street *e* is reachable iff the
  optimum is ≤ *S*.
- **Earliest arrival under the sun budget** (`"earliest"`): minimise the end second of *e*'s arc,
  subject to constraint 2 as an equality and *Σ cₐ xₐ ≤ S*. This is the resource-constrained
  shortest path.

**The LP relaxation** replaces *xₐ ∈ {0, 1}* with *0 ≤ xₐ ≤ 1*. It is a lower bound on each
objective, and *integer − LP* is the integrality gap.

## Where it is equivalent to the search, and where it is not

- **Whole seconds.** The network needs integer *dₑ*. Exact comparison therefore uses
  `integerSecondsGraph`, which snaps every distance to a multiple of 1.4 m (walking pace).
  - The production lattices have fractional seconds.
  - **What rounding moves** is measured below, as the number of streets whose reachability changes
    between the real and the snapped graph, both searched by the label search.
- **Waits: the model's region contains the search's, and can be larger.** The search and the
  oracle wait only until the next bucket boundary. The model waits in 1-second steps, which covers
  that wait and every shorter one.
  - With waits on, equality with the oracle is a measured fact on the fixtures below, not a theorem.
  - A committed fixture shows it failing: a 10 s partial wait proves a street within a 40 s budget
    that the boundary-only search and oracle cannot.
- **The least-sun LP is not always tight.** *An earlier version of this note said it was, wrongly*
  (review of the H7 PR).
  - Constraint 2 sums every time-copy of the street. Half a unit on a walk that crosses the street
    twice counts as one use at half the sun.
  - Committed fixture: integer 10 s, LP 5 s.
  - It is tight whenever no walk within *T* can cross a street twice. That holds on the eval
    lattices (every edge ≥ 36 s, *T* ≤ 100 s), which is why they measure a zero gap.
  - A second resource loosens it as well, as the earliest-arrival form shows.
- **Round trips are modelled** (the return budget above). The search's round trip proves streets
  only through two fixed walks home (H5b), so it can prove fewer streets than the model; the report
  checks that it never proves more.
- **Non-linear comfort terms** (heat stress, a cap on the longest unbroken stretch in the sun) are
  outside this model. A cap on one unbroken stretch is not linear in arc flows without a
  per-stretch state.

## What it found

The tests are in `app/lib/sunBudgetFormulation/__tests__/formulation.test.ts`, which runs in CI.
- **Three implementations, one region.**
  - The integer program, the exhaustive oracle and the label search return the same reachable
    streets on the CI fixtures. No walk there can cross a street twice, so the least-sun LP is
    tight on them.
  - Round trips: the integer program equals the round-trip oracle, and the search's proven
    streets fall within it.
  - The integer program and the oracle share no code: one is a flow model handed to HiGHS, the
    other a recursive enumeration.
- **The least-sun relaxation, loose.** A 10 s street that is sunny before 15 s, with a shaded way
  back. Any real walk crosses it at *t = 0*, paying 10 s of sun. The LP splits a unit across two
  crossings and counts it as one use for 5 s.
- **A partial wait the search can't make.** A 20 s street, sunny before 30 s, with a 40 s budget.
  The model waits 10 s and proves the street; the boundary-only search and oracle cannot.
- **The earliest-arrival relaxation, loose.** *0 → 1* can be reached two ways: fast and sunny (10 s, full
  sun) or slow and shaded (40 s). Then comes the street *1 → 3*, with a sun budget of 5 s.
  - The only real walk arrives at 41 s.
  - The LP blends half of each and "arrives" at 26 s, a gap of 15 s (37%) that no walk achieves.
  - The label search reports 41 s, the integer answer.
- **A wrong dominance rule, caught, and only by a crafted fixture.**
  - On the #246 bucket-boundary fixture, pruning "earlier and no sunnier" without H3's slack loses
    the street *3 → 4*. The integer program proves that street.
  - The test fails if the shipped search ever disagrees with the integer program there.
  - **The random lattices cannot catch this bug.** With the production slack set to zero, the
    search still matched the oracle on all 24 eval lattices (checked by hand). Crafted fixtures
    are the guard for this class of bug, not random ones.

**The full distribution** comes from `npm run eval:h7`, over 24 seeded whole-second lattices (3×3
and 3×4, 2–4 buckets, waits on a quarter). Its output is `docs/notes/h7/summary.json`, plus every
street's integer and LP optimum in `docs/notes/h7/certificates.json`.

**Measured** (24 one-way fixtures plus 12 round trips; Node 24 on the WSL box; 135 s for the whole
run; HiGHS with `mip_rel_gap = 0`, so "optimal" means optimal within its numerical tolerances):

| | result |
|---|---|
| integer program = exhaustive oracle | **24 / 24** fixtures |
| label search = integer program | **24 / 24** (all searched `exact`, slots of 256) |
| streets the model proves and the search doesn't (the waiting restriction) | **0** |
| least-sun integrality gap | 0 on all 342 streets: no walk crosses a street twice at these sizes (a committed fixture shows 10 vs 5 s) |
| round trip: integer program = round-trip oracle | **12 / 12** |
| round trip: search's proven streets ⊆ integer program | **12 / 12**; LP gap 0 on all 64 streets |
| earliest-arrival integrality gap | 0 on 202 of 204 streets; **2 loose, worst 4 s** |
| program size | 1,420–5,180 arcs (median 2,756) |
| integer solve | median 16.3 ms, p90 28.9 ms, max 86 ms |
| LP solve | median 14.8 ms, p90 25.2 ms, max 44 ms |
| solver memory | the WASM heap stayed at its initial **21 MB** through every solve: an upper bound on HiGHS's use, not a measurement of it |
| streets whose reachability changes from rounding to whole seconds | **0** on all 24 lattices |

**What this does not show.**
- **Small graphs only.** A 3×4 lattice at 100 s already gives 5,000-arc programs. A city graph
  at 20 minutes is about 10⁸ arcs: out of reach for an exact integer program, which is why the
  app uses the label search.
- **No real-graph bound.** Nothing here bounds the label search's gap on NYC. There the search is
  `approximate`, and the bound remains the undecided street km (`evidence.md` §2.4).
- **Loose cases are rare and small** on these lattices: 2 of 204 under the earliest-arrival form,
  none under least sun. The committed hand fixtures show the large gaps: 37% for earliest arrival,
  50% for least sun.
- **With waits, equality is empirical.** The six waits-on fixtures happened not to reward a partial
  wait; the committed one does.
- **Discretization:** rounding to whole seconds changed nothing here. The 15-minute bucket error
  against continuous time is a separate question, still unmeasured.

## Reproduce

```bash
npx vitest run app/lib/sunBudgetFormulation     # the CI subset, ~3 s
npm run eval:h7                                  # the full report, writes docs/notes/h7/
```

`highs` is pinned at `1.15.4`.

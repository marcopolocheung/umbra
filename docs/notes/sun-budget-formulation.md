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
- **Sink:** a free arc *zᵥ,ₜ ≥ 0* at every node, where the walk may end.

**Variables.** *xₐ ∈ {0, 1}* for every arc, and *zᵥ,ₜ ∈ [0, 1]*.

**Constraints.**
1. **Flow conservation:** at every node *n*, *Σ out xₐ − Σ in xₐ + z_n = [n = (s, 0)]*. One unit
   leaves the start and ends at exactly one sink. Time strictly increases along every arc, so the
   network is acyclic and integer flow is a single walk.
2. **Through the street:** *Σ xₐ ≥ 1* over *e*'s walk arcs.
3. **The time budget** holds by construction: no arc reaches past *T*.

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
- **Waits.** The search waits only until the next bucket boundary. The model waits in 1-second
  steps, which covers that wait and every shorter one. The model can therefore never be tighter
  than the search: a street it proves and the search doesn't would expose the search's restriction.
  The report lists any such street.
- **The least-sun LP is always tight.** That program is a min-cost flow with one forced set of
  arcs, so its LP is integral and the gap is 0 on every street (measured, below).
  - This is a property of the question, not a weakness of the bound.
  - The relaxation becomes loose only once a second resource binds, as in the earliest-arrival form.
- **Round trips are not modelled here.** They would need a second commodity (or a two-phase copy of
  the network) for the walk home, and stay a stated gap. The round-trip search is checked against
  its own exhaustive oracle (H5b).
- **Non-linear comfort terms** (heat stress, a cap on the longest unbroken stretch in the sun) are
  outside this model. A cap on one unbroken stretch is not linear in arc flows without a
  per-stretch state.

## What it found

The tests are in `app/lib/sunBudgetFormulation/__tests__/formulation.test.ts`, which runs in CI.
- **Three implementations, one region.**
  - The integer program, the exhaustive oracle and the label search return the same reachable
    streets on the CI fixtures, and the least-sun LP is tight on each.
  - The integer program and the oracle share no code: one is a flow model handed to HiGHS, the
    other a recursive enumeration.
- **A loose relaxation, committed.** *0 → 1* can be reached two ways: fast and sunny (10 s, full
  sun) or slow and shaded (40 s). Then comes the street *1 → 3*, with a sun budget of 5 s.
  - The only real walk arrives at 41 s.
  - The LP blends half of each and "arrives" at 26 s, a gap of 15 s (37%) that no walk achieves.
  - The label search reports 41 s, the integer answer.
- **A wrong dominance rule, caught.** On the #246 bucket-boundary fixture, a search that prunes
  "earlier and no sunnier" without H3's slack loses the street *3 → 4*. The integer program proves
  that street, and the shipped search keeps it.

**The full distribution** comes from `npm run eval:h7`, over 24 seeded whole-second lattices (3×3
and 3×4, 2–4 buckets, waits on a quarter). Its output is `docs/notes/h7/summary.json`, plus every
street's integer and LP optimum in `docs/notes/h7/certificates.json`.

**Measured** (24 fixtures; Node 24 on the WSL box; 90 s for the whole run):

| | result |
|---|---|
| integer program = exhaustive oracle | **24 / 24** fixtures |
| label search = integer program | **24 / 24** (all searched `exact`, slots of 256) |
| streets the model proves and the search doesn't (the waiting restriction) | **0** |
| least-sun integrality gap | **0 on all 342** streets with a finite optimum |
| earliest-arrival integrality gap | 0 on 202 of 204 streets; **2 loose, worst 4 s** |
| program size | 1,420–5,180 arcs (median 2,756) |
| integer solve | median 15.8 ms, p90 27.9 ms, max 83 ms |
| LP solve | median 14.4 ms, p90 24.2 ms, max 38.1 ms |
| streets whose reachability changes from rounding to whole seconds | **0** on all 24 lattices |

**What this does not show.**
- **Small graphs only.** A 3×4 lattice at 100 s already gives 5,000-arc programs. A city graph
  at 20 minutes is about 10⁸ arcs: out of reach for an exact integer program, which is why the
  app uses the label search.
- **No real-graph bound.** Nothing here bounds the label search's gap on NYC. There the search is
  `approximate`, and the bound remains the undecided street km (`evidence.md` §2.4).
- **Loose cases are rare and small** on these lattices: 2 of 204 under the earliest-arrival form.
  The committed hand fixture is the one with a large gap (37%).
- **Discretization:** rounding to whole seconds changed nothing here. The 15-minute bucket error
  against continuous time is a separate question, still unmeasured.

## Reproduce

```bash
npx vitest run app/lib/sunBudgetFormulation     # the CI subset, ~3 s
npm run eval:h7                                  # the full report, writes docs/notes/h7/
```

`highs` is pinned at `1.15.4`.

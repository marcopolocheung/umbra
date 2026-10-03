# H2 — exposure duration as the objective

Date: 2026-10-02 · Branch: `feat/h1-traversal-time-exposure` (stacked on H1, PR #222) ·
Brief: `docs/tracks/TRACK_H.md` §H2. Literature: read **#241** and **#243** before this
note — both are honored below.

## What was wrong with the old objective

`paretoRoutes` maximized **shadowed metres** inside a `2.0× + 250 m` detour budget.
That budget is generous enough for the "Most Shadowed" option to carry **more absolute
sun than "Shortest"** — the brief's committed fixture:

```
Route A: 1,000 m total,   800 m shadowed →  200 m exposed
Route B: 1,500 m total, 1,000 m shadowed →  500 m exposed   ← "more shadowed", 2.5× the sun
```

B is inside the default budget and won the most-shadowed slot. The user's question is
*minutes in the sun*, and the old objective answered it in the wrong currency: a detour
can buy shade-metres while raising sun-minutes. Committed as a regression test
(`app/lib/__tests__/exposureObjective.test.ts`): under the new objective A wins and B —
strictly dominated on both criteria — leaves the front entirely.

## What changed

- **The label criterion is `exposureCrit`**: sun accumulates **sun seconds** —
  `Σ traversal seconds × unshadowed fraction` — and fewer is better; rain keeps
  sheltered metres (more is better), unchanged.
- **One honest clock** (`edgeTraversalSeconds`, `travelMode.ts`): physical
  distance over the mode's cruise speed, except that a steps edge costs a
  bike/scoot rider the dismount — the steps penalty is a metres-at-speed time
  surrogate (the same convention the crossing penalty uses, "a crossing costs
  the same *time* in every mode"), so 100 m of steps is not 22 s of riding.
  Without this, the duration objective would have priced the E1 stairs
  shortcut as the *least*-sun bike route — the E1 test caught exactly that
  before it shipped. **Only the steps penalty enters the clock**: the
  scooter's rough-surface penalty (1000 m) is a documented *deterrent*, not a
  duration — pricing it as time turned 20 m of cobbles into 340 s of sun.
  Crossing waits stay off the clock: the crossing penalty is search cost and
  unmodelled waiting is H5's.
- **Representatives re-derived**: shortest (min cost-metres), the exposure extreme
  (min sun seconds; rain keeps max sheltered metres), and the knee re-derived in the
  new normalized space — both axes "smaller is better", knee closest to the ideal
  corner.
- **`maxContinuousExposureSec`** optional hard constraint (sun only): an unbroken
  sunlit run above the cap prunes the edge outright. An edge is sunlit below
  `SHADOW_THRESH` (the streak metrics' own cut). Pinned by test: a 286 s sunny
  crossing vs a shaded detour — capped, every survivor takes the detour.
- **Every route option reports exposure duration alongside coverage**:
  `RouteOption.exposure` (already typed) is now populated on the pareto walk options,
  with `exposedDurationSec`/`shelteredDistanceM` from segments that carry the mode's
  traversal clock. Displaying the number in the cards is a Track U design-pass
  hand-off, recorded in the brief.

## Dominance, revalidated for the duration objective

Within one H1 time bucket, both criteria (cost metres, sun seconds) are **additive and
non-negative per edge**, so the label-setting dominance argument holds with the sun
comparison flipped to "fewer is better" — the classic bi-criteria case — **plus the
sun-streak**: a label that has already walked a long unbroken sun run is the one the
`maxContinuousExposureSec` cap will cut, so it must not prune a shade-broken-streak
rival that is marginally longer. Without the streak in the comparison, the cap can
eliminate *every* path to the destination (a fixture where the search returned nothing
is pinned as a regression test). What does *not* hold is comparing labels across
buckets (H1's per-bucket Pareto sets), and the within-bucket boundary residual (two
arrivals in one bucket whose next edge straddles a boundary) is unchanged and remains
H4's oracle's job to measure. The committed H1 regression test was re-derived for the
new objective: the slow path now wins *because its late legs are shaded* (less sun
time), which is what the duration objective should reward.

Two more correctness notes from the verifier's pass, both fixed and pinned:

- **Destination candidates are sorted by cost** before representative selection.
  destFront's order is bucket-iteration order in a time-aware run — not distance
  order — so "first candidate = shortest" was false, and the true shortest route
  could lose its slot (it did, on a fixture).
- **The knee normalizes per objective**: rain's "best exposure" is the *most*
  shelter, so normalizing it as smaller-is-better made the shortest route its own
  knee and collapsed rain's three representatives to two (the Balanced option
  vanished). Regression-tested with a three-route rain fixture.

## The bounds on what this objective may claim (#241, verbatim requirement)

Minimised sun exposure is **better than maximised shade, and still not the comfort
objective.** Ma et al. 2025 (*Sustainable Cities and Society* 131:106697, Hong Kong,
2.2 M routes over 1200 O-D pairs, ENVI-met-simulated) compared the **least-unshaded**
route — exactly this objective — against the plain shortest route on PET: **better in
56% of pairs, identical in 20%, and worse in 24%** (41% at 08:00; worst case −472%).
Their conclusion: *"shade alone is an inadequate proxy for thermal comfort in summer."*
The mechanism is mostly outside this model — PET varies among *shaded* locations with
air temperature, wind and longwave re-radiation. The citation is kept honest: one
summer day (21 Aug 2020), one district, one climate, simulated, no measured ground
truth for the cases where shade-routing lost. It bounds our claim; it does not
contradict that sun-minutes is the right *exposure* objective for a tool that models
shadow geometry and nothing else. Track D owns the conversion of exposure minutes
toward comfort, and Wave 4 Option D owns the breadth comparison.

## The detour budget is deliberately untouched (#243)

`maxDetourFactor = 2.0` explores ~10× the detour any of three published studies finds
useful (Wen: +1.3%; Buo: <3%; Ma: plateau at 110%). The constant was **not** edited
here: tightening it belongs to G2's factor sweep with a measured quality/runtime
trade-off ("I tightened a search bound and measured the win against published
detour-tolerance data" is the artifact worth having). `DETOUR_FLAT_M = 250` stays for
the same reason it exists: very short routes still get a shadier parallel street.
Filed as **marcopolocheung/umbra#223**.

## Known gaps (deliberate, for later checkpoints)

- `maxContinuousExposureSec` is plumbed through `paretoRoutes` and tested, but
  `useRouting` passes no value yet — nothing in the UI asks for a cap. H3's budget
  slider is the intended caller.
- Via-stop legs and transit walk legs still price one frozen instant (H1 gap,
  unchanged); the sketch and refresh pipelines likewise.
- The bucket-boundary dominance residual is unmeasured — H4.

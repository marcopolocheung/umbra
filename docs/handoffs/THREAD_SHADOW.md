# Handoff — the shadow thread: ~~G2~~ → ~~A6~~ → ~~A7a/A7b~~ → A7c/A8 → A5 → H1–H5

**Mission.** Build the differentiator. `ROADMAP.md` §2: everything else is table stakes or
catch-up; **this is the part nobody else has.**

**Verified 2026-09-09 at `f159b25`; A6 section rewritten 2026-09-09 against its own measurement.**
Briefs: `TRACK_G.md`, `TRACK_A.md`, `TRACK_H.md`.

> **One checkpoint per PR.** This is a long thread — do not batch. A change that grows past its
> checkpoint stops being reviewable, and the reviewer is one person reading a four-sentence
> description.

---

## G2, A6 and A7's first two slices are done — start here: A7c/A8 (or A5a)

**Landed 2026-09-09 as #260 into #258.** Both halves shipped: the instrument fix (#182, #183 —
`p50TotalMs`, a percentile that does not degenerate, `clearMetrics` on the window, and the first
tests `metrics.ts` ever had) and the benchmark itself (`npm run bench:route`, `e2e/bench/**`,
baseline committed to `docs/notes/performance-baseline.md`, #243's detour sweep folded in). Every
decision this section used to spell out was honoured — keyless, local machine named, no CI gate,
no production code changes, not TTI, variance stated. Full record: `TRACK_G.md` → *Current state*.

### What G2 changed about the rest of this thread

**A5 was aimed at the wrong phase, and is re-scoped in `TRACK_A.md`.** It was written as a worker
offload. The benchmark says Dijkstra is **3–18 ms** of a ~3 s 2-point calculation while the
**canvas read is 1136–2164 ms** — a third to well over half of route latency. Offloading a 15 ms
search to a worker buys nothing a user can perceive.

**A4's acceptance criterion is measured and not met (#259).** A4 says
*"`window.__umbraMetrics` shows `canvasRead` at ~0 on the field path"*. It is over a second, on
**90 of 90 runs**, while `shadowFallbackShare` is **0.0% on all 90** — the canvas is read in full
every time and the pixel sampler it feeds then answers no edges. A4 closed on test evidence;
nothing had measured it. `TRACK_A.md`'s Current state already predicted the geometry path was
dormant, so this is that prediction with a number. **A5 already owned the fix**, and is now split:
**A5a** wakes the geometry path (acceptance = A4's criterion finally met and measured), **A5b**
offloads whatever is left and re-measures before assuming #38 is still worth doing.

**H3 has a curve instead of a citation.** The `maxDetourFactor` sweep is published: 1.25 → the
current 2.0 buys **5.8 pp of shadow for 61 pp of extra walking** and roughly triples search time.
The constant is unchanged — that is H3's call against the numbers.

**Every before/after on this thread now has a noise floor.** Across-session spread is **~2–25% on
every scenario**, so a claimed win under ~25% needs the repeat counts raised first (**#263**,
which blocks on **#262**). Do not quote a per-row reproducibility figure: two sessions of three
runs produced near-opposite orderings of which scenario is tightest.

### A6 is done — and it disproved the premise this thread stated for it

**Landed 2026-09-09 as PR #271.** #245 was decided in the same PR: **declined**, in writing, at
`docs/notes/one-hour-shadow-window.md`.

This section used to say *"without the sweep that is N× a full sample and will not run at
interactive speed."* **A6 measured that, and with the sweep it is still about N× a sample.** Read
this before writing H1, because the gate's rationale no longer holds even though the gate itself
is discharged:

- A 3 km route's 14-hour sweep went **34.4 ms → 21.9 ms**, and a single-hour `sampleEdges` went
  **1.96 ms → 1.04 ms** — which route calculation collects directly, and which is the win the app
  actually ships today.
- The acceptance criterion — *"a 14-hour sweep costs < 2× a single-hour sample"* — is **not met**.
  It costs ~21×; on `main` it was ~17×, so **the ratio got worse while every absolute number
  improved**, because the denominator sped up more. A ratio like that is optimised by making a
  single sample slower, which is why the absolute figures are the ones to quote.
- **The waste is gone and what remains is real work.** Everything sun-independent is now shared
  once — prism preparation, the sun-cell partition, per-edge offsets. The remainder is the
  point-in-shadow queries, and those are per-instant because the shadow moves. At graph scale
  `sweep` beats N separate `sampleEdges` calls by only **0–11%**, and that margin is the batch
  plan, which does not grow with the number of times.
- Beating N× needs a **different predicate**, not more sharing — **#267** has the design (per-
  (point, prism) angular intervals) and what it trades. Three cheaper wins were measured and
  declined: **#268** (~40%, blocked on **#163**), **#269** (~25%, helps every path equally so does
  nothing for the ratio), and a far-cap triangulation reuse (~11%) that **no test in this repo can
  distinguish from the correct version** — which is why it was not taken.

**What this changes for H1 (#270).** The gate is discharged: `sweep` exists, it is exact, it is
1.6× faster. But H1 must budget **N time buckets at roughly N× a sample**, scaling linearly in
edges and buckets, and pick its bucket count from that number rather than from an amortisation
that does not exist. Do not wait for a faster sweep; #267 is a checkpoint of its own.

**What this changes for D6.** `TRACK_D.md` says *"switch the sampler to `sweep()` so a 14-hour
answer is instant"*. It is not instant — 22 ms on a desktop with synthetic square footprints, and
materially more on a phone with real geometry. `useHourlyExposure.ts` already computes one hour
per frame for exactly that reason and should keep doing so. Filed as **#272**.

**One thing to know before building on it:** `useHourlyExposure.ts:93` is still the only `sweep`
call site in `app/`, and it passes a **single** time. The N-time sharing has no consumer in
shipped code yet; it is built for H1.

Full record — per-phase split, the alternative design, the declined wins, and the sub-hourly
cost that decided #245: `docs/notes/performance-baseline.md` § Time Sweep (A6).

### A7a/A7b are done — and the census is the part to read

**Landed 2026-09-09.** Canopy is fetched (`fetchCanopyAround`), modelled (`canopy.ts`) and
blended into `ShadowField` as a fractional `"canopy"`/`"mixed"` contribution. **#276 is fixed**
— footprint exclusion is now a property of the caster, and an elevated one sweeps its shadow
from its base rather than its footprint. **#244 is honoured without being applied**: the 0.5
weight is published with its citation for Track E's cost model, and the field keeps `shadow`
physical. The full decision list is in `TRACK_A.md` → *A7 — canopy v1*.

**The measurement is the finding, and it is worse than the checkpoint assumed.** A tagged-canopy
census over the three corpus cities (`docs/notes/canopy-coverage-2026-09-09.md`, reproduce with
`node scripts/canopy-census.mjs`):

- OSM holds **at most ~23% of Madrid's inventoried street trees** and **~1.0% of Singapore's**.
  In the framing that motivated the census: on a forty-tree street, Madrid has about ten and
  Singapore about half of one.
- `diameter_crown` is tagged on **0.14% of Madrid's trees and 0% of Singapore's and Kent's**;
  `height` on **0.33% / 0% / 0%**. **The crown model is its own defaults**, applied to a bare
  point, essentially always. That is where the honesty has to live — in the confidence, not in
  a better transmittance figure.
- The A3 corpus centre in **Singapore has zero tagged canopy of any kind in 2 km²** — no trees,
  no rows, no woodland, not even a park polygon — in the city where the 0.5 weight was measured.
  Never claim Umbra "routes around tree shadow" in a city without checking its number first.

**What this decides for #275 (painting canopy): not on this data.** #275 was explicitly to be
decided against A7's measured coverage, and the answer is no for now. Painting 23% of a street's
trees makes the map *visibly* wrong in a new way; painting none reads as "the map does not draw
trees". A number can carry a confidence; a paint stroke cannot. Revisit against **A8's raster**,
which does not depend on anyone having tagged a point — which also makes A8 the better next
canopy checkpoint than A7c.

**What this changes for the Wave 4 residual.** Whatever A7 fails to close will be mostly
*missing tags*, not a wrong crown model. 1% coverage cannot be fixed by better physics. Measure
the residual as the roadmap asks, but expect it to point at A8 before it points at a photo corpus.

### Next: A7c/A8, or A5a's diagnostics first

**A5a's two diagnostic steps are small, cheap and optional now.** Pure Node, no browser, no key:
reproduce the `coverage()`/`sampleEdges()` bbox mismatch in a test, and surface `EdgeShadow.source`
in `metrics.ts` so it is visible which provider actually answered. They are what makes A5a
writable, and #259 carries the arithmetic. Take them if you want A5 sized properly before A7/A8;
they unblock nothing, so the thread order does not require them yet.

## The dependency chain, and why it is this order

```
G2 ──► A5 ──┐
            ├──► H3 ──► H4 ──► H5
A6 ──► H1 ──► H2 ──┘
A7/A8 ─────────────► (better inputs to all of it)
```

| Step | Why it is here, not later |
|---|---|
| ~~**G2** route benchmark~~ ✅ | A5's acceptance is literally *"no benchmark → no claim"*, and H's central claim is a **comparison**. Building the measurement before claiming the improvement is the senior-shaped decision in this whole thread. **It paid immediately: the first thing it measured was A4 not meeting its own acceptance criterion (#259).** |
| ~~**A6** time sweep~~ ✅ | Gate discharged — but **not** for the reason stated here. A6 measured that N time buckets still cost roughly N× a sample even with the sweep; what it bought was ~1.6–1.9× in absolute terms. H1 budgets linearly. See the A6 section above and **#270**. |
| ~~**A7a/A7b**~~ canopy ✅ | Landed 2026-09-09 with #276 and #244. The census it carried is the part that matters: OSM holds ~23% of Madrid's street trees and ~1% of Singapore's, and the crown model is its own defaults. **A8 now outranks A7c** — see the A7 section above and `docs/notes/canopy-coverage-2026-09-09.md`. |
| **A5** worker offload → **A5a/A5b** | H3's budget slider must never block the main thread — and G2 measured *which* thing blocks it. **A5a** wakes the dormant geometry path and deletes the canvas read; **A5b** offloads what remains, if anything still justifies it. Re-scoped in `TRACK_A.md`. |
| **H1–H5** | The track. |

**Prerequisite from Wave 0: #204 (D0, real timezones) must land before H1.** An hour of clock
error is ~15° of sun. H1 would price every edge against a wrong sky and H4 would publish a gap
measured on a bad input. Also **#208** (access tags), or H2/H3 cannot enforce the access
constraints they declare. ✅ **#204 merged 2026-09-08** (PR #222); **#208 merged** (PR #221).

---

## Addendum 2026-09-09 — five findings from the literature pass

Three frontier papers were read in full and reconciled into `ROADMAP.md` §5c; the detail lives in
`docs/research/shadow-thermal-comfort-literature-2026-09-09.md`. **Nothing below changes the order
of this thread.** Four items are context you want *before* writing a checkpoint's note, and one is
a new, optional, high-value piece of work.

| # | Lands on | What it changes |
|---|---|---|
| **#241** | **H2** | Minimising unshadowed metres — H2's corrected objective — scored **worse than the plain shortest route in 24%** of 1200 O-D pairs (41% at 08:00). H2 still lands; maximised `shadowM` is a real defect. But the note must say the corrected objective is *better than shadow* and *still not comfort*. Read before writing it. |
| **#243** | **G2 → H2/H3** | `maxDetourFactor = 2.0` (+250 m flat) is ~10× the detour three independent studies find useful (+1.3%, <3%, plateau at 110%). **Measure it in G2's sweep**; do not edit the constant on the strength of a citation. Cheapest available win for H3's frontier. |
| ~~**#244**~~ | ~~**A7/A8**~~ | **Honoured 2026-09-09, deliberately without applying it.** 0.5 is *perceived* intensity and belongs in a route cost model; `ShadowField.shadow` is a physical fraction, so `canopy.ts` applies transmittance and exports `CANOPY_PREFERENCE_WEIGHT` with the citation and caveat for **Track E**. It cannot be applied until `EdgeShadow` says how much of a blended fraction was canopy — **#277**. |
| ~~**#245**~~ ✅ | ~~**A6/A7**~~ | **Declined in writing**, 2026-09-09, at `docs/notes/one-hour-shadow-window.md`. Its case was that A6 would make a window nearly free; the sweep is **linear in times**, so 10-minute steps cost ~6.9× the hourly sweep against a 6.0× floor. It also biases *towards* reporting shadow with no instrument able to measure the bias — A3 compares against a pixel reading at an **instant** — and H1 is about to price shadow far finer than an hour. |
| **#242** | **H1 + H4** *(new work, optional)* | Wen et al. publish a distance-dependent shadow reward that makes edge cost **path-dependent**, then solve it with Dijkstra keeping **one label per node**. A label carrying more distance is *advantaged* downstream, so cost-only pruning can drop the optimum. **This is H1's stated open question, unresolved, in print** — and `paretoRoutes` is already the right machinery. Implementing it and publishing where the two searches diverge is H4's oracle-and-gap against an *external, citable* model. |

**If you take one thing into H2:** #241, because it is a claim you would otherwise have to walk
back after publishing. **If you take one thing into A7:** #244, because it is free.

**Not on this thread:** #246, #247 (Track D), #248, #249 (Track P).

---

## A7/A8 — promoted into Wave 1 on 2026-09-08, and why it matters twice

> **A7a and A7b landed 2026-09-09.** The three fiddly things below were all real, and the
> section above records what the measurement did to them. Read this for the *why*; read the
> A7 section above and `docs/notes/canopy-coverage-2026-09-09.md` for what is now known.

**The app reports "exposed" on a tree-lined street in July.** `ROADMAP.md` §2 concedes Geuneullo
already models street trees, so this is the gap between us and the *consumer* state of the art —
not a stretch goal.

**Nothing structural was preventing it.** The A2 contract already reserved the slot:

```
ShadowField.ts:36   type ShadowSource = "tiles" | "overpass" | "canopy" | "mixed" | ...
ShadowField.ts:39   /** 0 = full sun, 1 = fully shadowed. */
ShadowField.ts:40   shadow: number;          ← already a fraction, not a boolean
```

`canopy.ts` does not exist and `overpass.ts:399` fetches `way["building"]` alone. A7/A8 were in
"not yet prioritized" by accident, not by dependency.

**Three things that are fiddly — all are design decisions already in A7's acceptance, none is a
blocker:**
1. **Tag sparsity is the real one.** OSM street-tree coverage is wildly uneven. A canopy provider
   must report its own coverage honestly, the way `PrismProvider`'s doc comment demands —
   *"'no buildings here' and 'I haven't loaded this area' produce the same shadow number and very
   different confidence."* — **This was the right thing to worry about, and it is worse than
   "uneven": ~23% in Madrid, ~1% in Singapore, 0% of crown diameters tagged anywhere.**
2. **A tree is not a prism.** Modelling a crown as an opaque solid **overstates** shadow, which is
   the dangerous direction — you would route someone into sun while promising shadow. The
   fractional `shadow` field is what saves you.
3. **Seasonality.** ~10% transmittance leaf-on vs ~70% leaf-off. Document the month window per
   hemisphere.

**It is also the experiment that decides Wave 4.** A7+A8 are ~2–3 weeks and zero fieldwork.
**Measure the residual afterwards** — free canopy data may close most of the routing-decision
gap, and what it cannot close (transmittance, eye-level sky view factor, awnings and
scaffolding, physical ground truth) is the entire remaining case for a photo corpus. Decide
Option A against a measured number, not an assumption.

**Sequence it before H3** — "routes around tree shadow" is a materially better flagship than
"routes around building shadow", and the A2 contract means H never has to know a canopy source
exists.

---

## Track H — the traps, in the order they will bite

Full detail in `TRACK_H.md`. The three that cause silent, hard-to-find bugs:

1. **H2 — re-validate the dominance rule.** A pruning rule that was sound for
   `(distance, shadowM)` is **not automatically sound** once a label carries time *and*
   accumulated exposure. `TRACK_H.md` calls this "the single most likely place for a silent
   correctness bug in the track." State precisely which rule is valid under your waiting model.
2. **H5 — earlier arrival does not dominate later arrival.** Arriving early may require waiting,
   and the wait may itself break the exposure budget or hit a closed venue. Prove the rule; do
   not inherit it from the no-waiting case.
3. **H3 — three outcomes, never conflated.** An exact result on the discretized model; a bounded
   approximation with a stated gap; and *a search that hit its budget*. **A capped search that
   returns nothing has not proved the request is impossible**, and the UI must not say it did.

**H2 is also P5 material** — *"I found my own objective was measuring the wrong thing and proved
it with a fixture"* is a self-caught defect, which reads better than a caught bug. Write the note
properly the first time.

**H4 is what upgrades H from a demo to an algorithm you can defend.** Brute-force oracle on tiny
time-expanded graphs, property tests, then publish the gap, the runtime distribution and the
memory. **If the gap is bad, the number ships anyway — that is the point**, and it flows back
into P4.

---

## Invariants that bite this thread

- **#1** retired: `maplibre-gl` moved to 6.x with the simulator gone, which also cleared #211.
- **#2** `suncalc` stays on **1.x**, imported directly, single copy.
- **#3** `preserveDrawingBuffer: true` — shadow sampling reads the canvas back.
- **#5** shadow detection couples to shadow colour via `isBlueDominantShadowPixel`. H4 has a
  property test guarding the pixel-fallback path from leaking back in — keep it.
- `useNavigation.ts` and `MapView.tsx` are **contested files**. Keep diffs surgical; coordinate
  with Track E if E1 is in flight.

## Done when

`/gates` green per PR with the real output, `/checkpoint` before each PR is reviewed, and every
brief's `## Current state` block updated in the same PR as the work. **UI/map changes also need
`npm run dev` and a human look** — `npm test` never opens a browser, and `npm run e2e` covers
one path only. If you cannot look, say the check is outstanding rather than letting four green
gates imply it.

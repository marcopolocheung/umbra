# Track S — Shade Evidence

> **Charter:** add the evidence no shade router publishes: **a measured shade-accuracy figure, a model Umbra trains and evaluates
> itself, and an assistant memory that changes the route.** Then run the sprint that lands those
> beside Tracks H, A, C and B in parallel.

> **Scope narrowed 2026-10-03 (owner):** the track continues with **S1 and S4 only**. S2b and
> S3b/S3c are dropped; S2a and S3a stay merged as standalone modules with their notes, and nothing
> in the product calls them. See "Current state".

**Class:** Flagship evidence. **Runs alongside:** B, C, D, E, G, H, P freely (the C/H/E overlaps
were S2b and S3b, both dropped); ⚠️ A (S1 measures A8's canopy, so take A8's numbers from `main`,
never from an open PR); ⚠️ the shell for S4b's mount point.
**Source:** `docs/research/ml-prior-art-2026-10-02.md` — read its
ranking table and "do not build" list before taking any checkpoint here. Every claim below about
prior art comes from it, with links.

---

## Current state

- **Active checkpoint:** S4 — first the S4a ground-geometry fix (#235), then S4b, then the
  photo evaluation (#217). The first wave is all merged (S1 #219, S3a #221, S2a #215, S4a #216).
- **Scope decision (2026-10-03, owner):** Track S is **S1 + S4**. S2b and S3b/S3c are dropped as
  weak evidence for their cost: S2's model is a one-parameter-per-person logit that does not
  beat the pooled baseline, and S3's memory is commodity without an eval that would likely tie
  full-history-in-prompt. Their issues (#226–#234) are closed as not planned. The unmerged S2b
  wiring stays on `feat/s2b-learned-preference` for reference.
- **S1 (merged #219):** shade reality audit vs NYC LiDAR (`studies/shade-audit/` +
  `docs/notes/shade-accuracy.md`). First published shade-error figure, against a 2017 LiDAR
  highest-hit truth over 8 blocks × 4 boroughs × 3 dates × 5 hours. Corrected 2026-10-02:
  the first version's canopy numbers were a double-mask harness artefact.
  - **Mask IoU:** 0.561 mean, 0.090 worst (unchanged).
  - **Per-segment error:** 34.7 pp mean; p90 100, because 13% of segment-sides are wholly
    wrong.
  - **Misses:** tree canopy 38%, building 35%, neither within 3 m 27% (unchanged).
  - **CHMv2 canopy:** +9.5 pp mean, +22.3 June, in every borough (was +3.7, Manhattan-only).
    It cuts tree-segment error from 41.7 to 33.5 pp.
  - **Buildings-only residual:** 35.1 pp.
  - **Staleness:**
    - Dropping 358 post-2017 buildings removes 10% of false shade, but segment error rises
      (35.1 pp).
    - Excluding the 44% of sides crossing 2017→2021 canopy change does not reduce error.
    - May (the flight date) vs June agree within 0.7 pp.
    - CHMv2's NYC imagery is 2019-11 / 2020-03.
  - **Shipping bug found:** the same mask bug very likely blanks raster canopy on NYC routes;
    filed as #220 (Track A, p2).
- **S3a (merged #221):** `app/lib/memory/` — six typed slots with bi-temporal validity, provenance,
  supersede-not-delete history, deterministic resolution in code, and a write policy that refuses
  provider text and unknown tools; 13 unit tests; contract note `docs/notes/assistant-memory.md`.
  A scoped replacement for #214, whose branch was cut from the wrong lineage and carried 138
  unrelated files against `umbra/main`; the store's five files are the only content there.
  **Final:** S3b/S3c dropped 2026-10-03; the store stays merged and unused.
- **S2a (merged #215):** `app/lib/preference/` + `studies/shade-preference/` +
  `docs/notes/shade-preference.md`. The refit reproduces β̄ = 1.205 (paper ≈ 1.16) and ρ = 0.414
  (≈ 0.5), and beats the population-mean α and shadewalker's fixed ladder online at every k —
  but **does not beat the non-hierarchical pooled logit on held-out log-likelihood** (9 picks per
  person is too few), reported as a partial negative result. The module ships as prior + note;
  nothing in the product calls it. OSF data is individual-level and unlicensed — cached, never
  committed. **Final:** S2b dropped 2026-10-03; the note is the deliverable.
- **S4a (merged #216):** `app/lib/chronolocation/` + `docs/notes/chronolocation.md` — the solver
  turns pinned photo marks into two date windows and a time band, or abstains. 15 tests on
  geometric fixtures (round trips through the real sun model, abstention, timezone labels, the
  ShadowField cross-check); the real-photo field evaluation is outstanding and filed as **#217**.
  The `ShadowMarks`/`PhotoFrame`/`solveChronolocation` interface is the contract S4b builds on.
  **Defect (#235, found 2026-10-03):** `observeShadow` takes the shadow's azimuth from the
  image-bearing difference, not a ground-plane direction; on 221 synthetic photos the true time
  fell inside the answer 0 times. The sweep is sound (true sun angles solve every case). Fixing it
  needs camera pitch (device tilt or a marked horizon) to project marks onto the ground.
- **S4b (built, held):** `feat/s4b-chronolocation-panel` — photo intake, three marks, heading/hFOV,
  windows-or-abstain; gates green. Held because it would surface #235's wrong answers; its own
  follow-ups are #236–#245 (#245: the cross-check never receives a `ShadowField`).
- **Done:** S0, both halves — the 2026-10-02 desk research, then the hands-on recheck on
  2026-10-02: five fixed NYC pairs × three departure times through shadewalker.nyc and Umbra,
  plus ORS/Google reachability checks. `docs/notes/competitors.md` holds the method, the raw
  tables and the corrections; `docs/ROADMAP.md` §2 now links every competitor claim to an
  observation or a dated source. S1 merged as #219; S2a #215, S3a #221 and S4a #216 followed the
  same day.
- **Open PRs:** none — the first wave is merged (#215, #216, #219, #221) and #214 is closed as
  superseded by #221.
- **Decisions made:** the track exists (2026-10-02, owner). S1, S2a, S3a and S4a own disjoint new
  paths and **may run as parallel `builder` worktrees**. The integration slices (S2b, S3b, S4b)
  touch shared files and stay sequential. S0 carried forward: ORS's Shaded Edition covers 44
  European countries and no US city, so NYC is unreachable there; Google still ships no shade
  toggle in walking route options; shadewalker's Arrive-by also collapses to one frozen instant,
  so **no observed product advances the sun** (the H1/H4 gap is intact); ~15 pp of one Village
  route's shade at 09:00 is tree shade — A8's gap, field-quantified, and S1 now measures it
  block-wide. S1's method decisions:
  - **Truth:** highest-hit and class-2 bare-earth surfaces built locally from the 2017 1-ft
    LAZ (not the city's bare-earth DEM).
  - **Attribution:** 2021 6-in TNC/UVM land cover (CC BY-NC-SA 4.0, cached, aggregate numbers
    only), taking the dominant building/canopy class within 3 m of the blocker. A
    single-pixel first pass misread facades as "other" and over-filed #218, since corrected
    to p3.
  - **Building-only truth:** the march with trees removed.
  - **Umbra side:** the app's own bundled modules over the deployed generation
    `nyc-2026-09-18-9f2924750af1`.
- **Open question from S1 (narrowed):** new construction is ruled out as the source of the
  35.1 pp buildings-only residual (set (b) does not reduce it). What remains is shard
  height/footprint-part error versus demolitions and same-lot replacements. Bound: 16% of tall
  LiDAR building area lies under no Umbra footprint. The next measurement is a per-building
  height audit against the LiDAR; no post-2017 city surface is public.
- **Blocked on:** nothing. S4b's shell mount point is the only shared-file touch.
- **Next action:**
  1. **#235** — ground geometry in `observeShadow`; turn the 221-case synthetic projection check
     into a regression test (no photos needed).
  2. **S4b** — rebase `feat/s4b-chronolocation-panel` onto the fixed solver; close #236–#245.
  3. **#217** — the photo evaluation. The solver is location-agnostic (only the `ShadowField`
     cross-check is NYC-bound), so the set may include non-NYC photos; the note must say how
     many are NYC.
  4. Track P publishes S1's figure and, once measured, S4's.
  A10 consumes S1's residual as its geometric baseline.
- **Last verified:** 2026-10-03 — S2a/S3a/S4a merged (gates green on each merged tree: 1904–1916
  tests); S1's own verification stands from 2026-10-02 (study self-tests 9/9, note cross-check
  84/84 against `_summary.json`).

---

## Why this track exists

The 2026-10-02 research pass changed the competitive picture §2 of `docs/ROADMAP.md` was written
against:

- **shadewalker.nyc** (AGPL-3.0, 2026) routes shade over 488,677 NYC sidewalk and path edges,
  all five boroughs, with hourly building shadow and monthly leaf-on/off canopy. It prices the
  whole route at departure time and validates only against its own fixtures.
- **openrouteservice / HeiGIT** shipped shaded routing for 136 European cities in Sept 2026, from
  four fixed daily slots, with no published metrics.
- **Google Maps** carries an unlaunched "Prefer shade" walking toggle (APK teardown, Nov 2025),
  and **Ask Maps** already remembers saved places, past conversations and Gmail reservations.

So "shade routing", "trees in the shade model" and "the assistant remembers my hotel" are all
table stakes now. What nobody publishes, and what this track exists to produce:

1. **How wrong the shade is.** No shade router reports an error figure. Umbra's README admits it
   has none against reality either.
2. **A model Umbra owns.** Today Umbra trains nothing; the assistant's intelligence is a hosted
   model. §2's completion bar and the research both reward *"trained a small
   model, beat a baseline on held-out data, shipped it"* far above *"called an API"*.
3. **Personalization that changes a decision.** Every shade product uses a fixed preference
   ladder (shadewalker's 0/5/15/40). None learns how much *this* walker minds the sun.

This track does **not** own traversal-time routing (Track H), trees in the shade model (Track A,
A7/A8), the assistant's eval program (Track C, C13), or the Reality Check field corpus (Track A,
A10). It measures the first two, feeds the third, and gives the fourth a geometric baseline.

---

## Checkpoints

Each checkpoint names **what it must beat**. A model that does not beat its non-ML baseline is
reported as a negative result in its note, and does not ship to users.

### S0 — Competitor recheck, hands-on *(small, docs only)*
**Goal.** Replace desk claims about competitors with observed ones.
**Approach.** Run five fixed NYC origin-destination pairs at three departure times through
shadewalker.nyc and through Umbra. Record each one's route, its shade figure, and how the figure
is computed. Check whether openrouteservice's shaded profile and Google's "Prefer shade" are
reachable. Write `docs/notes/competitors.md`; feed corrections into `docs/ROADMAP.md` §2.
**Acceptance.** Every competitor statement in §2 links to an observation or a source, dated.
**Files.** `docs/notes/competitors.md`, `docs/ROADMAP.md` §2.

### S1 — Shade reality audit against NYC LiDAR *(the error bar)*
**Goal.** Publish how often Umbra's shade is right, and where it is wrong, against the best
geometric truth NYC has, with no fieldwork.
**Approach.** A study under `studies/shade-audit/` (follow `studies/README.md`: a study imports
from `app/`, never the reverse, and every study has a note).
1. Build a direct-beam shade raster from NYC LiDAR **surface** data, buildings plus trees, for
   sample blocks across at least three boroughs. Use the 2017 1-ft LiDAR, or the 2021 6-inch
   TNC/UVM land cover (Zenodo 14053441). **Trap:** the city's bare-earth DEM strips buildings
   and trees, so it is not a shadow model.
2. For the same blocks and a grid of dates and hours, read Umbra's answer two ways: through
   `ShadowField` per sidewalk edge (what routing uses), and from the rendered mask.
3. Report mask IoU and per-sidewalk-segment shade-fraction error **as distributions**, split by
   building-only vs with canopy (A8), hour, solar elevation and borough. Name the worst blocks
   and say why (missing trees, wrong heights, scaffolding, sidewalk sheds).

**Acceptance.** `docs/notes/shade-accuracy.md` gives the method, data versions and licences, the
reproduce command, mean, p90 and worst case, and the building-only vs canopy delta. The note says
plainly that this is geometry against geometry: it measures Umbra's data error, not physical
truth. A10's field calibration set is still what measures physical truth.
**Must beat.** Nothing; this is the measurement every later claim inherits. It also gives A10
its geometric baseline, and gives Track P the number for the README.
**Files.** `studies/shade-audit/**`, `docs/notes/shade-accuracy.md`. Cache every download.
**Size.** 1–2 weeks.

### S2 — Learned shade preference *(the model Umbra owns)*
**Goal.** Learn how much each walker minds the sun, from published human choices first and from
their own route picks second, and let that change which route Umbra recommends.

**S2a — prior and model (disjoint, parallel-safe).**
- Refit Melnikov et al., *Scientific Reports* 2022 (408 choices from 46 people, data and code at
  osf.io/aj4vk) as a hierarchical logit. **Reproduce the population mean β̄ ≈ 1.16** before
  extending anything; the tree-shade factor ρ ≈ 0.5 is already cited in ROADMAP §5c.
- Turn it into a pure TypeScript module, `app/lib/preference/`. Inputs are the population prior
  and a list of observed picks, where each pick is a chosen Pareto option against the rejected
  ones, with their (distance, sun-exposure) pairs. Output is the per-user sun aversion α with an
  uncertainty band. Use a conjugate or Laplace update, with no training loop in the browser.
- Model card in `docs/notes/shade-preference.md`.

**Eval.** Held-out choice log-likelihood and accuracy with **participant-blocked** splits (never
random rows from one person). A calibration curve. A simulated-user recovery curve: how many
picks until α is within ±20% of the truth.
**Must beat.** The population-mean α, shadewalker's fixed ladder, and a non-hierarchical logit.
**Files.** `studies/shade-preference/**`, `app/lib/preference/**` + tests,
`docs/notes/shade-preference.md`.

**S2b — wiring. Dropped 2026-10-03 (owner); spec kept for the record.** Record which route card a user picks into
`localStorage`, beside saved routes. Feed α into the default route selection, and into H2's
exposure objective once H2 lands. Add a visible, resettable line on the route card in the
redesign voice, stating the learned trade in metres of detour per minute of sun. The stated
sun-tolerance memory slot from S3 is the user's own override and wins over the learned value.
**Acceptance.** A fixture where two users with different pick histories get different default
routes for the same request, and the difference traces to α.
**Honesty.** One user makes few picks, so until real usage exists, online learning is validated
**in simulation only**, and the note says so. Singapore courtyard choices are a domain shift from
Manhattan in July, and the note says that too.

### S3 — Assistant memory that changes the route *(evaluated, not commodity)*
**Goal.** The assistant remembers what matters for planning a walk (where you are staying, where
you last were, your sun tolerance, places to avoid, trip dates), never invents it, and lets it
change the plan.

**S3a — the store (disjoint, parallel-safe).** `app/lib/memory/`: typed slots, not free text and
not a vector store (ROADMAP anti-goal).
- Each value carries the time it is valid from and until, the time it was recorded, and its
  provenance (which turn wrote it).
- Deterministic code, not the model, resolves the current value. A superseded value is closed,
  not deleted.
- **Write policy:** only a direct user statement or a confirmed tool result may write. Text from
  third-party results never can. This is how memory gets poisoned (ChatGPT's 2024 memory exfil,
  the July 2026 email-borne false-memory attack). Align with C10's trust boundary.
- `localStorage` only; accounts stay declined (ROADMAP "Not doing").

**S3b — integration. Dropped 2026-10-03 (owner), with S3c; spec kept for the record.** Memory reaches the loop through a
tool call, so every use appears in the existing receipts (C5). A memory panel lets the user see,
edit and delete entries, with an incognito toggle. A stated sun tolerance sets S2's prior.
**Eval (S3c, in Track C's harness).** 30–50 scripted cases, graded deterministically: plain
recall, update, contradiction, a "just for today" override, temporal questions, an expired hotel,
abstention when nothing is stored (it must ask, not invent), an injected-memory attempt, and
leakage into unrelated answers. Report slot-write precision and recall, latest-value accuracy,
and false-use rate, plus a small live run with variance.
**Must beat.** The no-memory baseline and the **full-history-in-prompt** baseline. On LoCoMo the
full-history baseline (72.9%) beat Mem0's own published score, so a tie at a few dozen facts is
likely. Report it if it happens.
**Files.** `app/lib/memory/**` (S3a), `app/lib/agent/**` edits (S3b, ⚠️ C),
`app/lib/agent/__tests__/scenarios/**` cases.

### S4 — When was this photo taken? *(semi-automatic shadow chronolocation)*
**Goal.** Date and time a photo from its shadows by running Umbra's own sun model in reverse.
This automates a workflow journalists do by hand with ShadeMap, and no open, automated tool
exists. The gap is real but narrow, so keep the claim narrow.

**S4a — the solver (disjoint, parallel-safe).** `app/lib/chronolocation/`:
1. The user pins where the photo was taken, then marks an object's top, its base and its shadow
   tip on the photo.
2. Sweep dates and times with suncalc to find where predicted shadow azimuth and length match.
   Cross-check against `ShadowField` for building shadows in frame.
3. Return **two date candidates** (every sun position occurs on two dates a year) with a time
   band, or **abstain**: overcast, no measurable shadow, or ambiguous geometry.

**S4b — the panel (sequential).** Photo intake and point marking, in the redesign. Mounting it
touches the shell.
**Eval.** A self-collected photo set (60 or more; NYC preferred, others allowed since the solver
is location-agnostic — report the split) with trusted EXIF times, stratified by solar elevation
and season, including overcast shots that must abstain. Report median minutes of error,
% within 15 and 30 minutes, the date-candidate hit rate, and abstention accuracy.
**Must beat.** A Gemini vision time guess on the same photos (same key, cheap), GT-Loc's published
2.72 h mean error, and a human doing the manual ShadeMap workflow on a subset.
**Hand-off.** C12 (native images) may later call S4a as a tool. S4 does not wait for C12.
**Files.** `app/lib/chronolocation/**` + tests, a new component, `docs/notes/chronolocation.md`.

### Lower priority — specified so nobody starts them believing they are higher
From the research ranking. Take one only when S4 has landed and its baseline is in hand.
- **Per-edge exposure surrogate** (gradient-boosted trees on canyon geometry, orientation,
  canopy and sun position, labelled from S1). Must beat a **precomputed lookup table**, and
  probably will not.
- **Browser radiant-heat (Tmrt/UTCI) emulator** of SOLWEIG over NYC LiDAR. Overlaps Wave 4
  Option D. NYC has no measured Tmrt, so it can only report agreement with SOLWEIG.
- **Learned Pareto pruning** scored against H4's exact oracle. Exact search is already fast at
  NYC scale.
- **Photo → street-block location** (OrienterNet against OSM). The user's phone GPS usually
  beats it.

### Do not build
Each of these is mature, published and open, with error bars. The report has the links.
- A learned replacement for the WebGL shadow renderer.
- A shadow detector trained on SBU/ISTD.
- A canopy-height, green-view or building-height model for NYC (the city's LiDAR beats them all
  locally).
- Planet-scale photo geolocation (PIGEON and GeoCLIP exist).
- Learned walking ETA.
- A vector-DB memory layer.
- Any heat model presented as validated.

---

## Running the sprint — every lane at once

The owner wants all of this moving in parallel, with background agents. The rule from
`docs/tracks/README.md` still holds: **parallel writers need disjoint files**. Here is the lane
plan that respects it.

| Lane | Session | Takes, in order | Shares files with |
|---|---|---|---|
| 1 | **Track H** | H1 → H2 → H4 → H3 → H5 → H7 → H6 | ⚠️ A, E on `routing.ts` |
| 2 | **Track A** | A8f → A5 → A10 (after S1 publishes the residual) | ⚠️ H on `routing.ts` |
| 3 | **Track C** | C10 → C11 → C13 (pass^k reporting) → C12 | ✅ (S3b dropped) |
| 4 | **Track B** | B2 → B6 | ✅ |
| 5a | **Track S, `builder` worktrees** | S1 · S2a · S3a · S4a, all at once | ✅ disjoint new paths |
| 5b | **Track S, session** | S0, then #235 → S4b → #217 (S2b/S3b dropped) | ⚠️ shell (S4b mount) |
| 6 | **Track P** | Publish S1's figure, then H4's gap, as each lands | ✅ |

**Lane 5a is the only place inside one track where fan-out is allowed**, because S1, S2a, S3a and
S4a write to four directories that did not exist before this track: `studies/shade-audit/`,
`studies/shade-preference/` + `app/lib/preference/`, `app/lib/memory/`, and
`app/lib/chronolocation/`. None of them may edit `page.tsx`, `MapView.tsx`, `routing.ts` or
`app/lib/agent/**`. Anything that needs those is a b-slice.

**Launch prompt for one lane-5a builder** (swap the checkpoint id):

```
You are a builder for Umbra Track S, checkpoint S2a. Read, in order: .claude/CLAUDE.md,
docs/tracks/README.md, docs/tracks/TRACK_S.md (all of it), and the ranking and "do not build"
sections of docs/research/ml-prior-art-2026-10-02.md. Work only inside
the files S2a lists; never edit page.tsx, MapView.tsx, routing.ts or app/lib/agent/**. Branch
from main, implement with tests, write the note, run all four gates (/gates), open a PR with gh
against main, and never merge. In the PR, state what the checkpoint must beat and whether it
did. Update TRACK_S.md's Current state in the same PR.
```

**Launch prompt for any other lane:** use the paste-in prompt in `docs/tracks/README.md`, naming
the track.

**What stops the sprint from eating itself:**
- Rebase on `main` before opening a PR. Never branch from another open PR.
- Lanes 1 and 2 agree in an issue who edits `routing.ts` first.
- Track P publishes only numbers that are on `main`.

---

## Risks

- **Overclaiming the audit.** LiDAR-vs-Umbra is geometry against geometry. Call it physical
  accuracy and it becomes the overclaim §2 was written to prevent.
- **A model nobody needs.** Realised: S2b was dropped for it (2026-10-03). The prior and its
  honest note are the whole deliverable; do not invent a user study.
- **Memory as a vector store.** The anti-goal stands. Typed slots and deterministic resolution
  are the design, and the eval is what makes it signal.
- **Licences.** Check and record the licence for every dataset S1–S4 touch: Zenodo 14053441, Ma
  et al. 2023, Melnikov OSF. Google Street View imagery is off limits for training or evaluation
  under its terms.

## Out of scope / hand-offs

- Traversal-time exposure, the exact oracle, Sun Budget reachability → **Track H**.
- Trees in the shade model, the A10 field calibration set and learned correction → **Track A**.
- The assistant's held-out, repeated evaluation program → **Track C** (C13). (S3c, which would
  have added memory cases to it, is dropped.)
- README, numbers page and demo → **Track P**.

## Owns

`docs/tracks/TRACK_S.md`, `docs/notes/{competitors,shade-accuracy,shade-preference,chronolocation}.md`,
`studies/shade-audit/**`, `studies/shade-preference/**`, `app/lib/preference/**`,
`app/lib/memory/**`, `app/lib/chronolocation/**`, and the S4 panel component.

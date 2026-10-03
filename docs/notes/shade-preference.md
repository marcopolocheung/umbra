# Shade preference — the model Umbra owns (S2a)

**2026-10-02.** This is the model card for `app/lib/preference/`, the first model Umbra
fits and evaluates itself. Prior: **Melnikov et al., "Pedestrian Path Choice … Solar
Insolation", *Scientific Reports* 2022** ([PMC8844002](https://pmc.ncbi.nlm.nih.gov/articles/PMC8844002/)) —
46 participants, 408 binary route choices with sun visible at the decision point, made in
a Singapore courtyard in 2019. Data and analysis notebook public on OSF
([osf.io/aj4vk](https://osf.io/aj4vk), `behaviour_analysis/behavioural_data.csv` +
`analysis_final.ipynb`).

## What the model is

A walker's utility for a route, in the source's units of 100 m:

> Δc = **α** · (Δ open sun) + (Δ building shade), with tree metres split by **ρ**:
> sun_effective = sun + (1−ρ)·tree, shade_effective = shade + ρ·tree

**α is the learned quantity — "sun aversion": how many metres of distance one metre of
open sun is worth to this walker.** α is hierarchical across walkers:
**α ~ Gamma(shape, rate)** fitted to the population; **τ** is the choice temperature;
**ρ** is the tree-shade effectiveness (already cited in ROADMAP §5c as ≈ 0.5). The paper's
per-walker β is this α.

## The refit — and the reproduction gate

`node studies/shade-preference/refit.mjs` reproduces their PyMC model deterministically:
joint MAP of (shape, rate, ρ, τ) with each walker's α **integrated out by Gauss–Legendre
quadrature** over the Gamma prior — the same posterior structure as their MCMC, no
sampler. The notebook's own hyperpriors (on the Gamma's shape/rate and on τ) are part of
the objective; without them the marginal likelihood alone is degenerate — ~9 trials per
person drives shape → ∞, collapsing to one shared α (verified on the LL surface before
fitting).

One stated deviation: the notebook fits a τ per task-set booklet; this fit pools one τ
(the shipped module has one τ). The groups' separate fits give τ = 0.359 / 0.165; the
pooled τ = 0.229 sits between them.

**The reproduction, before anything was extended:**

| quantity | this refit | paper |
|---|---|---|
| population mean β̄ = ᾱ | **1.205** | ≈ 1.16 |
| tree-shade factor ρ | **0.414** | ≈ 0.5 (ROADMAP §5c) |
| per-walker α spread | 0.85 – 1.86 | ≈ 0.37 – 1.84 |

β̄ within 4% of the paper's figure; ρ within 0.09; the individual spread matches at the
top and is tighter at the bottom (expected: 9 trials per person shrinks extremes toward
the mean).

These constants ship in `app/lib/preference/prior.ts`
(`POPULATION_PRIOR = { alphaShape: 9.14, alphaRate: 7.587, rho: 0.414, tau: 0.229 }`).

## The shipped module

`app/lib/preference/` is pure TypeScript, no sampling, no training loop, no network:

- `types.ts` — `Pick` (a chosen Pareto route option against the rejected ones, each with
  `{distanceM, sunM, treeM, shadeM}`), `PopulationPrior`, `PreferenceFit`.
- `model.ts` — the logit likelihood, its gradient and Hessian in α, a bounded MAP ascent
  in log(α) space with backtracking, and the Laplace band (observed information at the
  mode). `updatePreference(picks)` is the whole entry point: prior + picks → α with a
  ±1σ band. Cold start (no picks) = population mean with the population's spread.
- `update.ts` — the browser-facing API; `detourPerSunM(fit)` is the number S2b's route
  card will state as "your learned trade: N m of detour per minute of sun".

Cost: single-digit milliseconds for realistic histories (≤ 200 ascent steps × picks);
bounded by construction.

## Evaluation — and the negative result

`node studies/shade-preference/eval.mjs`. **Participant-blocked** throughout: 10-fold
leave-participants-out, every model's prior refit on train participants only; splits are
never random rows from one person.

**Held-out log-likelihood per pick** (cold = no own picks; k = own first-k picks seen):

| model | cold | k=1 | k=2 | k=3 | k=4 | k=5 | k=8 |
|---|---|---|---|---|---|---|---|
| hierarchical (ours) | −0.5313 | −0.5151 | −0.5778 | −0.5800 | −0.5929 | −0.6155 | −0.6595 |
| population-mean α | −0.5313 | −0.5625 | −0.5810 | −0.6045 | −0.6106 | −0.6406 | −0.6660 |
| shadewalker ladder (fixed α rungs) | −0.4498 | −2.1144 | −2.0478 | −1.0175 | −1.0465 | −0.8851 | −0.9819 |
| non-hierarchical (one pooled α) | −0.5250 | −0.5224 | −0.5102 | −0.4949 | −0.4889 | −0.4942 | −0.4293 |

**Held-out accuracy:**

| model | cold | k=1 | k=2 | k=3 | k=4 | k=5 | k=8 |
|---|---|---|---|---|---|---|---|
| hierarchical (ours) | 0.8153 | 0.8232 | 0.7531 | 0.7643 | 0.7552 | 0.7402 | 0.6810 |
| population-mean α | 0.8153 | 0.7928 | 0.7750 | 0.7607 | 0.7676 | 0.7598 | 0.7241 |
| ladder | 0.8596 | 0.6961 | 0.5281 | 0.7107 | 0.7095 | 0.6912 | 0.6034 |
| non-hierarchical | 0.7709 | 0.7790 | 0.7781 | 0.7821 | 0.7759 | 0.7745 | 0.8190 |

**What it must beat, and whether it did:**

- **Population-mean α — beaten** online at every k ≥ 1 on both LL and accuracy (the one
  comparison where the hierarchical update earns its keep: a user's own picks carry
  signal the population mean doesn't). Cold they tie by construction.
- **shadewalker's fixed ladder — beaten** at every k ≥ 1, decisively on LL (the ladder's
  best-rung-on-picks is a high-variance discrete update; it can't do smooth per-user
  learning). The ladder's cold LL is slightly better because its cold α = 1.0 is closer
  to this dataset's pooled optimum than the population mean is — with zero per-user data,
  a fixed rung and a prior mean are both single numbers, and the rung happens to sit
  nearer the loss minimum.
- **Non-hierarchical pooled logit — NOT beaten.** It wins held-out LL at every k (it
  exploits all 408 trials to place one α optimally) and accuracy from k=2 up. This is
  reported as a **partial negative result**: with only ~9 picks per person, a real
  individual's own picks do not outweigh what the other 45 people already know. The
  hierarchical model wins where personalization is actually the question (LL and accuracy
  vs population-mean; α recovery in simulation, below), and loses where "one number fit
  on everyone" is the alternative and the test population is the same 46 people.

Per TRACK_S: a model that does not beat its baseline does not ship to users. The module
therefore ships as **prior + honest note**: `updatePreference` is exported, tested, and
is the shape S2b wires in, but nothing in the product calls it yet, and its online half
is not claimed to beat the pooled logit on this dataset.

**Calibration (hierarchical, held-out, P(A-chosen) binned vs observed):** ECE = 0.131
cold, 0.114 online — the model is roughly calibrated; mid-probabilities are slightly
overconfident (0.55-bin observed 0.86, 0.45-bin observed 0.24), which is what τ's
single pooled value buys.

**Simulated-user recovery (300 sims per α\*, history 20, ±20% of truth held to the end):**

| α\* | recovered-and-held | median picks to recover |
|---|---|---|
| 0.5 | 21/300 | 17 |
| 0.8 | 167/300 | 8 |
| 1.2 | 222/300 | 6 |
| 1.6 | 233/300 | 8 |
| 2.0 | 194/300 | 11 |

The population-median walker (α ≈ 1.2) is recovered from **~6 picks**; extreme walkers
(0.5, 2.0) take 11–17 and often never fully land inside ±20% — the Gamma prior pulls
against the extremes, honestly reported.

## Reproduce

```bash
node studies/shade-preference/refit.mjs   # the fit and the β̄ reproduction
node studies/shade-preference/eval.mjs    # held-out LL/accuracy, calibration, recovery
npm test -- preference                     # the shipped module's unit tests
```

Both scripts download the OSF CSV once into `node_modules/.cache/umbra-shade-preference/`
(sha256 `9ae281d97090040d42dbff5ab812cd8a2658f42a9b353b26b08c10fa75927950`) and never
re-hit OSF. `studies/shade-preference/hierfit.mjs` is shared study machinery;
`prior-const.mjs` mirrors the shipped constants by copy so drift is loud in review.

## Data and licence

The OSF component carries **no explicit licence** on the data file (the paper text is CC
BY 4.0; the OSF project lists none), and the CSV is individual-level human behavioural
data. It is therefore **downloaded, not committed**: the cache path is gitignored under
`node_modules/`, the URL and checksum are in `hierfit.mjs`, and the CSV never enters the
repo. The fitted *constants* (four numbers, not person-level data) ship in the app.

## The two required honesty statements

- **Online learning is validated in simulation only.** Until real Umbra usage exists,
  no claim is made that per-user updating improves any real user's routes. The recovery
  curve is simulated walkers drawing from the fitted logit on the real trials' geometry —
  it says the update *converges*, not that real behaviour is this well-modelled.
- **46 Singaporeans in a courtyard are a domain shift from Manhattan in July.** The
  prior is equatorial, 2019, a courtyard with offered route pairs — not NYC sidewalks in
  a heat wave with Umbra's Pareto cards. The prior's *shape* is carried over; its
  calibration to NYC walkers is unknown and unfounded until real picks exist. S0's
  observation also applies: shadewalker's fixed ladder buys almost nothing on the
  Midtown grid, so a learned α matters most exactly where trees and side-streets give
  real alternatives — the Village, Brooklyn, the crosstown.

## S2b — the wiring (2026-10-03)

The model now changes which card Umbra shows first.

- **Picks are recorded where the user chooses.** `app/lib/preference/pickStore.ts`
  keeps the chosen card against the others the same request offered, in
  `localStorage` under `umbra:routePicks`, bounded to the last 50. A card's
  `shadowCoverage` gives only the shaded share of its length, not the tree/building
  split, so all shade is filed as building shade; nothing is lost, because the model's
  cost `α·sun + shade` is invariant to that split (effective sun + effective shade =
  length at any ρ).
- **α sets the default card.** `app/lib/preference/routeChoice.ts` minimises the
  model's cost over the options H2's search returned. In the source's metres that cost
  is `α·sun + shade`; with H2's clock it is `travelSeconds + (α−1)·exposedSeconds`,
  which is the same ordering because both scale by the mode's speed. `α−1` is the
  detour rate: `distance + (α−1)·sun` is the same cost, so the extra metres a walker
  accepts per metre of sun removed is `α−1`. **Cold (no picks, no stated tolerance) α is
  the population mean 1.205**, so the default is the least-cost card under *that* prior —
  the shortest route when nothing is close, but a slightly longer, partly shaded option
  can win (1000 m open costs 1205, 1030 m at 50% shade costs 1136). That is a deliberate
  change from the pre-S2b "always shortest" default, not a no-op.
- **Only walking cards are priced.** The model is a pedestrian one (Melnikov et al.); it
  is applied when the visible mode is walk *and* the travel mode is walk. Transit cards
  (whose `shadowCoverage` is only their walk legs, and whose ride time is ignored) and
  bike/scoot routes keep the pre-S2b default of index 0 and show no trade line. Only a
  walking card selection is recorded as a pick.
- **The stated sun-tolerance slot wins over the learned value.** The S3a `sunTolerance`
  slot (low/moderate/high → α 2.0/1.205/0.5) is read at calculation time; when set it
  replaces the picks outright. Nothing writes the slot yet — S3b's panel is its editor.
- **The card states the trade and can forget it.** The selected card carries
  "Learned from your N route picks: about M m of detour per minute of sun", where
  `M = round((α−1)·60·1.4)` — one minute of walking is 84 m of sun at 1.4 m/s. A Reset
  link clears the picks and re-selects on the prior.
- **The manual "Fastest/Balanced/Most shade" slider is untouched.** It stays an explicit
  per-request override that moves the selection directly; the learned α only sets the
  *initial* default after a calculation.

**Acceptance.** `app/lib/preference/__tests__/routeChoice.test.ts` gives two walkers
one request: a shade-picking history and a sun-picking history produce different α, and
that difference alone changes the default index (1 vs 0) — the fixture the brief asks
for. The same file pins the cost model, the tolerance override and the trade figure.

**Honesty, unchanged from S2a and now load-bearing.** With one user and a handful of
picks, online learning is still validated **in simulation only** — S2b ships the wiring,
not a claim that it improves any real walker's route. And the prior is still 46
Singaporeans in a courtyard, a domain shift from Manhattan in July. Both statements
carry into the product: the card says "population default" until picks exist.

**Not in this slice.** α selects among the Pareto front H2 already computed; it does not
re-price the search itself (a `routing.ts` change, Track H's file). The manual slider and
the learned default can disagree until the user drags one — the learned value is a
starting point, not a lock.

**Known limits, filed not fixed.** Tapping a card to compare it is the same action as
choosing it, so browsing A→B→A→B records four picks; the prior regularizes but a
"settled selection" signal (on save, or on start-navigation) is the better event. After
Reset the button unmounts, so keyboard focus falls to the body even though the row's
`aria-live` announces the change. `applyLearnedPreference` and `selectRoute` are thin
wiring over the tested `routeChoice`/`pickStore` pure functions but are not themselves
hook-tested. All three are filed against Track S.

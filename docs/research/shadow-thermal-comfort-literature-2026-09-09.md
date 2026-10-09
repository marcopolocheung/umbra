# Three frontier papers, reconciled — 2026-09-09

Reconciliation of `docs/research/shadowstudy{,2,3}.pdf` against `docs/ROADMAP.md` and the code
at `main`. Written in the shape §5 expects: what each paper claims, what was verified, and
which checkpoint it goes to.

**The one-line verdict: yes — but the value is evidence and adversaries, not code.** None of
the three ships software, all three withhold data behind "on request", and two of them describe
architectures this roadmap has already correctly declined. What they supply is the set of
numbers that let this project state what its model is worth and where it breaks — which §2 says
is the strongest thing in the repository.

---

## 1. The three papers

| | **P1 · Wen et al. 2025** | **P2 · Buo et al. 2026** | **P3 · Ma et al. 2025** |
|---|---|---|---|
| Title | Walking smart in the heat | Cool routes: real-time human thermal exposure routing | Active route choice to minimize pedestrian thermal discomfort |
| Venue | *Comput. Environ. Urban Syst.* 122:102337 | *Building & Environment* 298:114622 | *Sustainable Cities & Society* 131:106697 |
| Group | MIT Senseable City + AUS + NUS | **ASU (Middel) — this is "ASU Cool Routes"** | Tsinghua SIGS + Sydney + PolyU + NUS |
| Where | Dubai, 4 metro stations | ASU Tempe campus, 7.01 km² | Hong Kong, Yau Ma Tei |
| Climate | hot-arid | hot-arid | humid subtropical |
| Comfort model | street-view panoramas → Detectron2 panoptic seg (sky/tree/building) → fisheye + sun position → **binary shadow** | **SOLWEIG MRT @ 1 m** from LiDAR BSM/CDSM/DEM + weather API | **ENVI-met @ 4 m → PET** (MEMI two-node) |
| Search | Dijkstra, **distance-dependent sigmoid shadow reward** | Dijkstra, edge weight = MRT × length | **exhaustive DFS**, all routes ≤120% of shortest (2.2 M routes) |
| Headline | most shadowed path **+1.3%** length, **+8.9%** building shadow, **−8.8%** sun | **>70%** rerouted, **<3%** longer, up to **−3.8 °C** mean route MRT | **81%** of pairs improve, up to **−96%** discomfort |
| Validation | none against measured shadow; reward calibrated on *Singapore* behavioural data | **MaRTy cart, 319 edges: d = 0.73, RMSE 8.4 °C, MAE 6.2, MBE −2.0** | ENVI-met validated in prior work: *T*air R² 0.81 / RMSE 0.91 °C; MRT R² 0.80 / RMSE 4.70 °C |
| Code | none | none | none |
| Data | *"No data was used"* (despite a GoPro survey) | on request | **abstract says "open-access dataset"; the data statement says "on request"** |

**Nothing here is a dependency.** Treat all three as methods-and-numbers sources. In particular
do not plan any checkpoint around P3's 2.2 M-route corpus arriving.

---

## 2. The finding that matters most is a threat to the premise

**P3 §4.2.2 / §5.1 — shadow is not a reliable proxy for thermal comfort.** Over 1200 O-D pairs:

| Least-unshadowed route vs. the plain shortest route | Share of pairs |
|---|---|
| lower thermal discomfort (PetL) | 56% |
| identical | 20% |
| **higher — the shadow-optimal route is *worse*** | **24%** |

At 08:00 it is worse for **41%** of pairs, with a worst case of **−472%**. Their conclusion is
stated flatly: *"shade alone is an inadequate proxy for thermal comfort in summer."*

**Why this lands on Track H specifically.** P3's `ushadeL = Σ(uS_i × l_i)` is *minimised
unshadowed metres* — which is exactly the objective **H2** plans to adopt in place of today's
maximised `shadowM` (`routing.ts:544`). So P3 is not evidence that H2 is unnecessary; H2 fixes a
real defect and should still land. P3 is evidence that **H2's corrected objective is still not
the comfort objective**, and that the residual is large enough to change the sign of the
benefit in roughly a quarter of trips.

The mechanism is plausible and mostly outside our model: PET among *shadowed* locations varies
with air temperature, wind, and longwave re-radiation from hot façades. P3's own numbers show
the saturation directly — at 18:00 Yau Ma Tei is **0% unshadowed** and still sits at **38.57 °C**
mean PET.

**Keep the citation honest.** This is one summer day (21 Aug 2020), one district, one climate,
simulated in ENVI-met, with no measured ground truth for the cases where shadow-routing lost. It
is a well-quantified hypothesis, not a settled fact. Cite it as a bound on what H2 may claim —
not as a refutation of shadow routing, which P1 and P2 both support in arid climates.

→ **H2's design note (P5 material) must state this before the PR opens.**

---

## 3. Three papers converge on one number, and our code is ~10× off it

The useful detour is small, and all three found it independently:

| Paper | Detour that captures the available benefit |
|---|---|
| P1 (Dubai) | most shadowed path is **1.3%** longer on average |
| P2 (Tempe) | **<3%** longer; median detour <50 m cold season, <25 m hot |
| P3 (Hong Kong) | benefit **plateaus at 110%** of shortest; beyond that, "little effect" |

`routing.ts` allows `maxDetourFactor = 2.0` plus `DETOUR_FLAT_M = 250` — a budget of **200% +
250 m**. Every label-setting expansion inside that budget beyond ~1.1× is, on this evidence,
searching a region where essentially no additional comfort exists.

This is a **performance** finding before it is a correctness one, and it should be taken as one:
it is the cheapest available win for **H3**'s reachability search, whose whole difficulty is
that the frontier must stay interactive under a moving budget slider. Do not change the constant
blind — **G2's benchmark should measure it**, because "I tightened a search bound and measured
the win against published detour-tolerance data" is a much better artifact than a constant edit.

→ **File against H2/G2. Evidence-gated, not a blind change.**

---

## 4. P1's dynamic reward is the one directly implementable idea — and it is subtly broken

**The model** (P1 §2.3.3), calibrated on Melnikov et al. 2022 (*Sci. Rep.* 12:2441, Singapore,
the only open route-choice behavioural dataset any of the three papers has), R² = 0.84:

```
θ(L_past) = 0.3961 / (1 + e^(−0.0111·(L_past − 859.5746))) + 0.1958

cost(e) = L_sun + (1 − 0.5θ)·L_tree + (1 − θ)·L_building + (1 − 1.5θ)·L_indoor
```

Shadow is worth more the further you have already walked — tree shadow at half the weight of
building shadow, indoor at 1.5×. Backed by an ENVI-met thermal-walk simulation showing a turning
point in skin-temperature *rate of change* at ~300 m.

**The flaw.** θ depends on distance already travelled, so **the same shadowed edge is cheaper the
later you reach it**. Edge cost is a function of the path, not the edge — the exact structural
analogue of time-dependent routing. P1 solves it with plain Dijkstra keeping **one label per
node**, ordered on discounted cost. But the label needs two dimensions — discounted cost *and*
physical distance walked — because a label carrying *more* physical distance is **advantaged**
downstream (larger θ → cheaper shadow). Pruning on discounted cost alone can discard the eventual
optimum. Non-overtaking is asserted nowhere and does not obviously hold.

**A second, smaller flaw.** Their sensitivity grid (P1 §2.5.2) sweeps `A ∈ {0.2,0.3,0.5,0.6}`
and `y₀ ∈ {0.10,0.15,0.25,0.30}`. The top corner gives θ → 0.90, so `(1 − 1.5θ) = −0.35` —
**negative edge weights** on indoor segments, which breaks Dijkstra outright and admits a
negative cycle (loop inside a mall to reduce cost). Their *published* parameters stay safe
(θmax ≈ 0.592 → 0.112), so the headline result stands; the sensitivity corners do not.

**Why this is the strongest opportunity in all three PDFs.** H1's brief already names this exact
question — *"does non-overtaking hold … what does dominance mean once a label carries time and
accumulated exposure"* — and here it is, unresolved, in a peer-reviewed paper. And the correct
machinery already exists in this repo: `paretoRoutes` (`routing.ts:566`) is label-setting with
dominance pruning and multiple labels per node.

The artifact writes itself: implement P1's published cost model, run it under both plain
Dijkstra and label-setting on a committed fixture, and publish where they diverge. That is
**H4's oracle-and-gap applied to an external, citable model instead of a self-invented one** —
strictly stronger, because a reviewer can check the source.

→ **H1 (dominance analysis) + H4 (the gap). A7/A8 take the 0.5 tree weight.**

---

## 5. P2 confirms two roadmap decisions and corrects one roadmap fact

**Confirmed — declining in-browser SOLWEIG was right, and now there is a number.** P2 §3.1:
**four hours** of compute for 24 h of MRT over 7.01 km² on a 32 GB / 2.9 GHz Xeon, requiring
LiDAR-derived BSM + CDSM + DEM. Query time after precompute: ~2 s. §3 NOT DOING already says
*"ASU needed lidar and a campus"*; that is now citable rather than asserted.

**Confirmed — §7 Tier 1 is independently the same architecture.** P2's own scaling proposal is
per-city offline SOLWEIG on dedicated resources with a central routing API. Both P2 and P3 point
at NN surrogates as the way out (P2 cites UHTC-NN at ~10⁶× faster than the process model). That
is Tier 1 — expensive inference offline, versioned artifacts, fast online graph search.

**Corrected — §2 says "with no app" and that is false.** P2 §2.1–2.3: Cool Routes *is* a web
application — Flask backend, interactive map UI, 171 POIs, date/time selection up to 3 days
ahead, ~2 s responses. The accurate framing is narrower and still favourable to us: it is
**single-user (no concurrency), campus-only, and POI-to-POI rather than arbitrary points**.

→ **#206 already exists to correct an overclaim in §2. This belongs in it, and must be corrected
before P4 transcribes §2 onto a public page.**

---

## 6. The differentiator survives — and two of the three name it as their own future work

§2's load-bearing clause is *"the sun advances while you walk"*. Checked against all three:

| Paper | Temporal treatment | Their own words |
|---|---|---|
| P2 | the MRT map **closest to the user-defined time**, one frozen timestamp per route | §4.4: temporal exposure dynamics *"not explicitly captured in this formulation"*; coupling to time-resolved exposure models *"remains an important direction for future research"* |
| P3 | hourly snapshots, routes evaluated per hour | §5.4: *"based on the stationary PET index, which did not consider the dynamic thermal conditions along the routes"* |
| P1 | a one-hour **max-shadow** window (a point counts as shadowed if shadow exists anywhere in the hour) | no advancement along the walk |

None of the three does traversal-time exposure. Two list it as future work. Fujiwara 2024
remains the honest prior art per **#206** — that does not change — but the frontier as of these
three papers has not closed the clause.

P1's one-hour max-shadow smoothing is also worth borrowing as a *deliberate* choice: it encodes
"a pedestrian will step a few metres to find shade", which is a defensible answer to sampling
jitter and a much better story than silently averaging.

---

## 7. Coverage against the stated feature chain

| Link in the chain | Covered by | Our position |
|---|---|---|
| shadow | P1, P2, P3 | competitive |
| canopy | P1 (tree ≠ building, 0.5×), P2 (CDSM) | **behind** until A7/A8 — as §3 Wave 1 already says |
| weather | P2, P3 (both as model forcing) | D2 exists; ours is forecast-driven like P2's |
| **UV** | **none of the three mentions UV at all** | **uncontested.** `heat-model.md`'s SED/UVI dose model has no counterpart in this literature |
| thermal comfort | P2 (MRT), P3 (PET) | behind on physics, and structurally cannot catch up client-side |
| route-quality benchmark | P3's 2.2 M exhaustive routes are an oracle by construction | validates **H4's** brute-force-oracle method at scale |
| fast environmental routing | P2 (precompute → 2 s), both point at NN surrogates | Tier 1 is the same answer |
| **mobile navigation** | **none.** All three are desktop research tools; P2 is explicitly single-user | **uncontested — Track B has no competitor here** |
| **real-world route-choice telemetry** | **the shared gap, and all three admit it** | uncontested |

On that last row: P1 calibrates *Dubai* on *Singapore* data for want of local behaviour data.
P3 §5.3 says *"before applying thermally-driven route choice to practice, evidence of improved
satisfaction from subjective tests is needed"*. P2 §4.4 wants a "detour tolerance" parameter it
does not have. **Every one of them routes back to Melnikov et al. 2022** — one experiment, one
city, 13 tasks. The behavioural foundation under this entire field is thinner than the physics
on top of it.

---

## 8. What to actually do

Ordered by cost. Nothing below adds a track, and most of it is citations and notes — which §7's
stopping rules explicitly count as artifacts.

| # | Action | Where | Cost |
|---|---|---|---|
| 1 | Add "with no app" to the **#206** claim corrections — P2 *is* a web app; the true limits are single-user, campus-only, POI-to-POI | §2, #206 | a sentence |
| 2 | Give **P4** external calibration anchors: P2's d = 0.73 / RMSE 8.4 °C / MBE −2.0, with only 72% of edges under RMSE and the ISO 7726 ±5 °C band exceeded | `TRACK_P.md`, P4 page | two sentences |
| 3 | Write P3's 24%-regression bound into **H2**'s design note before its PR | `TRACK_H.md` H2 | a paragraph |
| 4 | File the detour-budget finding (2.0× + 250 m vs. a 1.1× plateau) against **H2/G2**, to be *measured* not assumed | issue, `track-h` | small |
| 5 | Take Melnikov's **0.5× tree-vs-building** shadow weight into **A7/A8** instead of inventing one | `TRACK_A.md` A7 | free |
| 6 | Add a PetL-shaped **thermal dose** companion to `score.ts`'s intensity — `Σ(felt − threshold)⁺ × length`, with `SCORE_ANCHORS`' 32 °C as the threshold. Closes the limitation `heat-score.md` names itself (a 90-min shadowed walk vs. a 10-min exposed one) | Track D | small–medium |
| 7 | **The correctness result:** implement P1's sigmoid cost, run Dijkstra vs. label-setting on a committed fixture, publish the divergence | **H1 + H4** | medium — **highest value per hour on this list** |
| 8 | Record that **D8 as written is blocked**: it plans a comparison against published SOLWEIG output, and P2's rasters are "on request", not public | `TRACK_D.md` D8 | a line |

**Not recommended.** Do not chase MRT or PET as a routing objective (that is P2/P3's ceiling and
it needs LiDAR plus hours of offline physics per city — §3 already declined it, correctly). Do
not reopen Wave 4 on this evidence. Do not treat P3's dataset as available.

**The one genuinely research-grade opening**, recorded but *not* recommended for now: P2 §4.4
names *"systematically compare shade-based and MRT-based routing"* as the field's open question,
and P3 answered it for exactly one district on exactly one day. Doing it at breadth, in a
browser, is a real contribution. It is gated on having a comfort reference to compare against —
i.e. on **D8/A9** — so it is not startable today, and saying so is the point.

---

## 9. So: can this become the world's best comfort-aware routing engine?

**Not on physics.** P2's SOLWEIG-on-LiDAR is better physics than a browser can do, and that gap
does not close client-side. Any claim in that direction is false.

**On everything else, the field is emptier than it looks.** Between them these three papers cover
four metro stations, one campus and one district; they ship three static research tools, zero
mobile experiences, zero lines of released code, zero published worst-case-inclusive accuracy
figures for the shadow-based approach, and three separate admissions that exposure along the walk
is future work.

The defensible claim is narrower than the question and still worth making:

> the best comfort-aware routing engine that runs **anywhere**, in a **browser**, with the sun
> **advancing as you walk**, and its **own error published, worst case included**.

Which is §2's claim, unchanged — now with the frontier checked against it rather than assumed.

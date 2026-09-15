# Umbra — the golden roadmap

# Northstar:
## Can this become the world's best comfort-aware routing engine?

**This file owns one thing: what to work on next, and why it is worth doing.** It does not
duplicate state, and it does not explain how to build anything — briefs do that, and a second
copy would drift. If you want implementation detail, every line here points at the brief that
owns it.

Two questions decide whether anything appears on this roadmap at all:

1. **Does it prove a skill a SWE or AI/ML hiring manager is actually looking for?**
2. **Is it interesting — because nobody else ships it, or because how it works is worth asking
   about?**

An item failing both is cut regardless of how sensible it sounds. An item passing both outranks
an item passing one.

| Where to look | For |
|---|---|
| **This file** | **priority, sequencing, and why an item exists** |
| `docs/tracks/TRACK_<X>.md` | current state, checkpoints, contracts, how to build it |
| `docs/notes/AUTONOMOUS_GOAL.md` | mission, landscape, the session loop (§5), guardrails |
| `docs/tracks/README.md` | how a session runs, subagents, handoff |
| `docs/research/*.md` | the outside evidence this roadmap was reconciled against (§5) |
| the code | anything factual. Always. |

Last reconciliation: **2026-09-14** (§5d — agent/Geo hiring-evidence pass). **Current state lives in the briefs** — the session-start
hook prints every track's active checkpoint, and that is the only state worth trusting.

---

## 1. The promise

> **Tell it how you want to spend time outside. It finds a plan around the sun, shows its work,
> and adapts when the day changes.**

The request the finished product answers:

> *"I have 90 minutes. Find coffee and somewhere shadowed to read for 20, keep me under 8 minutes
> of direct sun including the walk back, and get me home before 5:30."*

---

## 2. The portfolio thesis

A hiring manager gives a portfolio project about ninety seconds. In that window they must
conclude four things, and each needs an artifact they can click.

| They must conclude | Proved by | Status |
|---|---|---|
| **Can do real algorithms** | A time-dependent, constraint-aware routing search checked against a brute-force oracle, with a published approximation gap. Not a wrapper around a routing API. | ⚠️ Half — Pareto label-setting with dominance pruning exists (`routing.ts:566`); the time dimension does not → **Track H** |
| **Can ship applied AI that works** | A tool-using agent with typed contracts, a job/result protocol, deterministic validation, and an eval program **whose failures are reported**. | ⚠️ Strong core, incomplete proof — bounded loop, 7 tools, 34 scenarios and live-model runs exist; terminal results, typed claim receipts, held-out/real-tool evaluation, releases/rollback and accessibility remain → **C4, C5, C10–C15** |
| **Understands systems and performance** | Measured wins in CI: worker offload, a bundle budget, a browser smoke test that runs — and the ~1,000–2,200× shadow-index speedup **stated as what it is, a synthetic Node microbenchmark of the index in isolation, not end-to-end browser route time**. | ⚠️ Half — G1 landed, index win measured (#166) and now qualified **both here and in `docs/notes/evidence.md`**, so **#207 can close**; A5 and G2/G3 are not → **G2, A5** |
| **Is honest about what they measured** | The agreement harness publishing `mean 2.6pp · worst 62.5pp · severe 3.3%` — worst case included. Confidence values labelled in code as *priors, not measurements*. UI numbers linking to their own method. | ✅ The strongest signal here — and **invisible to anyone outside the repo** → **Track P** |

**That last row is the whole argument.** Almost every portfolio project claims; almost none
measures; essentially none publishes its own worst case. `ShadowField.ts:199` already says
*"Neither is measured ground truth — these are priors"* in a source comment. That instinct is
the most hireable thing in this repository and no recruiter can currently see it. **Track P
exists to fix exactly that, and it is cheaper than any feature on this list.**

### The agent/Geo hiring-evidence completion bar *(added 2026-09-14)*

The four rows above remain the product portfolio thesis. For the narrower goal of making Umbra an
exceptionally complete identifier for applied-AI and Geo engineering candidates, “agent works” is
not enough. The completed artifact must expose these independent proofs:

| Proof | Owned by | Completion evidence |
|---|---|---|
| Terminal actions and claim-level grounding | C4, C5, C11 | Versioned terminal job results; typed receipts for place, shadow, time, route and accessibility claims; deterministic repair validation |
| Evaluation that estimates generalization | C13 | Leakage-checked held-out tasks, repeated live trials, a controlled real-tool tier, equal-budget baselines, intervals and raw traces |
| Production LLM/agent operations | C14 | Immutable model/prompt/tool releases, server-owned policy, durable quotas, monitored canary, exercised rollback and privacy/retention tests |
| Genuine multimodal reasoning | C12 | Actual images reach Gemini; region-linked receipts; image-required tasks; offline, metadata and fixed-sampling baselines at equal budgets |
| Full learned-model lifecycle | A10 | Owned/licensed data, geographic/date holdouts, baselines, optional segmentation justified by data, versioned artifact, drift test and rollback |
| Defensible Geo optimization | H1–H7, exposed by H6 | Time-dependent constrained search, brute-force oracle, integer reference, LP/convex relaxation, published gaps and agent-visible certificates |
| Code-enforced safety and accessible use | C10, C15, G5 | Adversarial trust-boundary tests and a keyboard/screen-reader-complete plan/evidence journey |

This is intentionally a higher bar than “good personal project.” It does not pretend a repository
proves years of employment, credentials, teamwork, adoption at Google scale, or interview
performance. Those are assessed elsewhere. It does ensure the implementation itself no longer
depends on a hiring manager generously interpreting a hosted-model call as ML infrastructure, a
pin match as complete grounding, an initiated route as success, or precomputed captions as
multimodality. Full acceptance lives in the owning track briefs.

### The novelty claim, stated precisely

From `AUTONOMOUS_GOAL.md` §2 — the honest competitive picture. **Google Maps** ships a shadow
*toggle*; it is commoditized. **ASU Cool Routes** routes on mean radiant temperature at 1 m —
the academic ceiling, and better physics than anything here — as a **single-user web tool over
171 fixed points on one campus**, built from LiDAR that does not exist for most cities.
**Shadehopper / Geuneullo** ship consumer shadow routing, and Geuneullo already models street
trees, so our buildings-only model is behind the consumer state of the art, not ahead of it.

So the differentiator is **not** "shadow routing". It is this combination, which nobody ships:

> **The sun advances while you walk** — exposure priced at each segment's *traversal* time, not
> one frozen timestamp — **turned into a reachability question** ("everywhere I can reach on ≤8
> minutes of sun, round trip"), **anywhere OSM and vector tiles reach**, **with an assistant
> that plans and repairs against that same model**, and **with the accuracy numbers published,
> worst case included.**

Each clause carries weight. Drop the time dimension and it is Google's toggle. Drop the reach
and it is ASU's research tool. Drop the published numbers and it is every other portfolio.

**One clause was retired on 2026-09-09, and what it was actually doing is worth recording
(#248).** The list used to include *"entirely in a browser"*, and the sentence above used to read
*"drop the browser and it is ASU's research tool."* That was never quite right. The browser
clause was doing two jobs — a difficulty signal, and a stand-in for the real competitive contrast
— and the second job is done better by a clause that was already in the list. **ASU's limitation
is not that they have a server. It is that they need LiDAR for one campus.** *"Anywhere OSM and
vector tiles reach"* is the sharper statement of that same advantage, and unlike the browser
clause it survives the §7 decision intact. What is genuinely lost is the difficulty flex, and it
was traded deliberately for accuracy headroom — do not pretend it cost nothing.

**The clause that is not ours, stated so no session re-claims it.** Advancing the sun along a
walk is *not* unprecedented: Fujiwara et al., *Building and Environment*, 13 Sep 2024, §6.2
integrates accumulated irradiance over a walk using departure time, walking speed and
position-specific timestamps. They compare **three predefined routes**. What survives as ours is
everything after the first clause — traversal-time exposure as the *cost function of a
constrained search* over `(node, arrivalTime, accumulatedExposure)`, inverted into reachability,
repaired by an agent, with the gap published. Evaluating three fixed routes is not that. Cite the
paper as related work in `sun-budget-model.md`, not as a threat.

**And it is not contested by the 2026-09-09 pass (§5c) — recorded because all three papers were
checked for exactly this.** None of Wen 2025, Buo 2026 or Ma 2025 advances the sun along the
walk: Buo prices a route against the MRT map *"closest to the user-defined time"*, and Ma is
explicitly *"stationary PET … did not consider the dynamic thermal conditions along the routes"*.
**Two of the three name it as their own future work.** Fujiwara remains the honest prior art; the
frontier has not closed the clause since.

### Anti-goals

Impressive to a keyword filter, padding to a good engineer. Named so nobody adds them believing
they help:

- **Kubernetes on a client-side static site.** Deploying a web app to a cluster is not evidence
  of infrastructure skill. Defensible only behind a real bursty workload.
- **Spark/Sedona in the request path.** One machine handles this data. Benchmark the simple
  thing first; the distributed version is a labelled study, never the product.
- **A second LLM provider or a paid model.** Breaks the free-tier guardrail, proves nothing.
- **Multi-agent orchestration** before a controlled comparison shows the bounded loop is the
  bottleneck. "I added more agents" is the opposite of the restraint signal.
- **A vector DB / RAG** with no defined retrieval problem.
- **A badge wall in the README.** Every badge is a claim a reviewer can test.

---

## 3. The order of work

Every item below is a **real checkpoint in a real brief**. There is no separate roadmap ID
namespace — if it is not a checkpoint someone can take with `/track`, it does not belong here.

### NOW — Wave 0: truth · blocks new checkpoints

Unglamorous, small, and currently false in production. These are the difference between
"measured" and "claimed", which is the entire thesis of §2.

| Item | Track | Why it blocks | Issue |
|---|---|---|---|
| ~~**P1** Mirror `public` on every merge~~ **✅ done 2026-09-08** | P | Was blocking D3/D4's "method linked from the UI" acceptance. Merged as #203; the mirror at `marcopolocheung/shademapnav` is public and current. **P4 and P2 are unblocked** | #199 |
| **D0** Real timezones (IANA + DST) | D | `Math.round(lng / 15)` is off 30 min across India, an hour across half of China. **The time axis is this product's entire differentiator**; every "most shadowed at 7 PM" claim inherits the error. **This is a Track H prerequisite, not only a Track D one** — an hour of clock error is ~15° of sun, so H1 would price every edge's traversal against a wrong sky and H4 would publish a gap measured on a bad input | #204 |
| **G8** Nominatim policy + the dropped `User-Agent` | G | `SearchBar.tsx:150` does prohibited keystroke autocomplete and bypasses the queue in `nominatim.ts`; `User-Agent` is a **forbidden header name**, silently dropped, so invariant #6 holds nowhere on the client | #205 |
| **#208** OSM access tags dropped rebuilding sidewalks | H | `GraphEdge` carries `highway/surface/cycleway/bicycle/foot` (`routing.ts:21`) and `overpass.ts:220` fills them, but `parallelSidewalkEdges` (`routing.ts:400`) returns four fields and silently loses all five. **H2/H3 declare access exclusions a hard constraint and cannot enforce one**; E1/E3/E4's mode profiles have the same dependency. Small fix, large unblock | #208 |
| **#206 · #207** Two claim corrections | P | The novelty claim overstated its prior art, and the shadow-index microbenchmark is unqualified. **Both must land before P4 transcribes them onto a public page** — a corrected overclaim is an asset, a published one is a liability | #206, #207 |
| **G7** LICENSE, `.env` vs `.env.local`, README refs | G | The repo's own map of itself is wrong; a reviewer who finds that stops trusting the rest. **#50 is mostly stale — read G7's re-scope before working it; three of its four bullets are already resolved and one would have you create six files `.claude/rules/` replaced** | #52, #53, part of #50 |

**Standing rule, not a checkpoint:** a track that opens a second PR before its first is
reviewed is manufacturing queue, not progress. Merging is the owner's call — sessions never
merge — so what a session owes is making each reviewable: rebased, gates green, ready or closed.

**The feature queue cleared on 2026-09-08.** #181 (B1), #189 (D3), #191 (C1), #196 (D4) and
#203 (P1) all merged; #161 was closed. `main` is green and the public mirror at
`marcopolocheung/shademapnav` is live and current, so **P1's dependency is discharged and P4/P2
are unblocked today.** What remains open is **#165** (Track G docs, no conflict) and **seven
Dependabot PRs**, which are a different problem — see below.

**Dependabot is now the queue, and it carries the repo's only open vulnerabilities.** Five alerts
(1 critical, 1 high, 3 moderate) all sit in **dev dependencies** — a Vitest UI file-read, Vite
`server.fs.deny` bypass and path traversal, an esbuild dev-server issue, a launch-editor NTLM
disclosure. **None of them ships in `dist/`**; this is a static client-side app and none of that
tooling is in the bundle. So the security exposure is a developer running the dev server or
`vitest --ui`, not a deployed-app risk — say it that precisely and do not inflate it. But the
public mirror shows *"5 vulnerabilities"* to anyone who opens the repo, which is a **P2/G7
credibility problem** and cheap to retire. Fixing them means dev-dep **majors** (`vitest` 2→4,
plus `vite`/`esbuild`), which per `.github/dependabot.yml` arrive as individual PRs and need the
gates run, not a blind merge. Neither invariant pin is involved: every open Dependabot PR
touches only `package.json`/`package-lock.json` dev entries, and none goes near `maplibre-gl`
or `suncalc`.

### NOW — Wave 0.5: **P4 + P2, promoted out of Wave 3** *(2026-09-08)*

**Every other item on this roadmap adds work. These two are the only ones that convert work
already done into signal a reviewer can see.** P4 was already marked "startable immediately";
this makes the promotion structural instead of a parenthetical nobody acts on.

**Priority correction, 2026-09-14:** publication drift is not an agent-implementation blocker.
Do not interrupt C4/C5/C10/C13–C15, H, or A10 to repeatedly polish the public surface while the
underlying contracts are still changing. Already-written P2/P4 work may merge when convenient;
the definitive README, demo, scorecards, and ledger refresh happen after the capstone evidence is
implemented. Track P remains responsible for that final pass.

Take them **as a pair**. P4 alone recreates the problem it exists to solve one level down: a
numbers page nobody navigates to is as invisible as a number nobody published. P2 is the door.

| Item | Why it moved | Depends on |
|---|---|---|
| **P4** Publish the numbers | The measurements exist. This is transcription and framing, not engineering, and #206/#207 must be transcribed *corrected* | P1 merged; #206, #207 landed |
| **P2** README as the human entry point | The only page a reviewer actually opens. Also where A4b's "not merely a pixel sampler" correction has to land | P1 merged |

P4 is written once and **revised** — G2/G3's budgets and H4's gap flow back into it as they
land. Waiting for a complete page is how it stays unpublished. P3 (demo) and P5/P6 stay in
Wave 3: they still want two finished Wave-1 tracks and H3 rendering.

### NOW — Wave 1: finish the flagships

Five tracks sit at roughly 60%. **A hiring manager cannot be impressed by 60% of anything.**
This wave adds almost no new ideas on purpose.

| Order | Checkpoints | Why this, why now |
|---|---|---|
| 1 | **G2** benchmark, then **G6** seams | A5's acceptance is literally *"no benchmark → no claim"*, and Track H's central claim is a *comparison*. G6 permanently removes the ⚠️s from the parallelism table. "Built the measurement before claiming the improvement" is a senior-shaped decision. |
| 2 | **A5** worker, **A6** sweep | A5 gets routing off the main thread (#38). A6 exploits that a prism's shadow is an affine function of sun azimuth/altitude — an exactness criterion, not a vague speedup. **A6 gates Track H.** |
| 2.5 | **A7** Overpass trees, **A8** canopy raster *(promoted 2026-09-08)* | **The app says "exposed" on a tree-lined street in July.** `ShadowSource` already declares `"canopy"` and `"mixed"` and `ShadowSample.shadow` is already a fraction (`ShadowField.ts:36,39`) — the contract reserved the slot and nothing filled it; `canopy.ts` does not exist and `overpass.ts:399` fetches `way["building"]` alone. §2 concedes Geuneullo already models street trees, so this is the gap between us and the *consumer* state of the art, not a stretch goal. Closes **#46**. **Take it before H3** — "routes around tree shadow" is a materially better flagship than "routes around building shadow", and the A2 contract means H never has to know a canopy source exists. **It is also the experiment that decides Wave 4**: A7+A8 are ~2–3 weeks and zero fieldwork, so measure what is *still* wrong before committing to Option A's season-locked corpus. |
| 3 | **B2 → B7** | The app is called navigation and does not navigate. **B6 is the reason Track B exists**: *"cross to the shadowed side"* — an instruction no competitor can generate. B7 unparks F and supplies P3's demo. |
| 4 | **C1 → C5**, then **C7 → C10 → C11** | Eval harness first, then probes on `ShadowField`, then **C4 — the terminal plan job contract**, claim-level receipts, honest degradation, the code-enforced trust boundary, and **C11 — the Living Itinerary**. This is the dependable core. C12–C15 are deliberately sequenced later as the capstone evidence layer; putting native images or release machinery on top of an unverifiable action contract would create a larger demo, not a stronger agent. |
| 5 | **D3, D4** + the mobile strip fix | Turns a unitless fraction into UV dose and a heat score, with ranges, documented assumptions and graceful degradation. **Not done until P1 lands.** #197 — the D1 strip never renders on mobile — is a shipped feature nobody on a phone can see. |
| 6 | **E1**, then **E5** | E1 is the cheapest large win on the board: the policies, the edge tags and the Overpass ingest all exist and nothing is wired to cost. E5 (`Trip`) is the structural half of the Living Itinerary and H5 consumes it. |

### NOW, gated — Wave 2: Track H, the differentiator

**Everything above is table stakes or catch-up. This is the part a hiring manager asks a second
question about.** Gate: **A6 and G2 must land first** — H is unaffordable without A6 and
unprovable without G2. Full brief: `docs/tracks/TRACK_H.md`.

| Checkpoint | Why it earns its place |
|---|---|
| **H1** traversal-time exposure | A genuine time-dependent shortest-path problem with the traps intact: does non-overtaking hold, is waiting an action, what does dominance mean once a label carries time *and* accumulated exposure. The novelty is the *constrained search*, not the sun advancing — see §2's prior-art note (#206) before writing this up. |
| **H2** exposure as the objective | The current front is (distance, shadowed distance) under a 2.0× detour budget, so "Most Shadowed" can carry **more absolute exposed metres** than "Shortest" — a demonstrable defect, not a hypothetical. *"I found my own objective was measuring the wrong thing and proved it with a fixture"* is a self-caught defect, which reads better than a caught bug. |
| **H3** Sun Budget reachability | The flagship interaction, and it **inverts the product**: every other maps app needs your destination first; this answers *"where can I even go?"* Forces the honesty split between an exact result, a bounded approximation, and *a search that ran out of budget* — a capped search returning nothing has not proved impossibility. |
| **H4** oracle + published gap | What upgrades H from a cool feature to an algorithm you can defend. Without it H3 is a demo. |
| **H5** waiting, dwell, return leg | The subtle correctness point: earlier arrival does **not** dominate if the wait it implies breaks the budget. Noticing that before it bites is the difference between a student implementation and an engineered one. |
| **H6** feasibility for the agent | Where Track C and Track H become one product. Returns a typed feasibility certificate that C5 can cite. Needs C4 first — a feasibility query returning "started" is useless. |
| **H7** optimization formulation and bounds | An independently implemented integer formulation and LP/convex relaxation cross-check the production label search, publish optimality/integrality gaps, and prevent “algorithm exists” from turning into an unsupported optimality claim. |

### NEXT — Wave 3: Track P, the rest of it

**P4 and P2 left this wave on 2026-09-08 — they are Wave 0.5 now.** What remains genuinely
needs finished work to point at: P3 wants two completed Wave-1 tracks and H3 rendering, P5's
best note is H2's objective correction, and P6 cannot be filled before H4 produces a gap.

`docs/tracks/TRACK_P.md` — ~~P1 mirror~~ *(in review)* · ~~P2 README~~ *(Wave 0.5)* · P3 demo
recording · ~~P4 publish the numbers~~ *(Wave 0.5)* · P5 design notes · P6 the ledger.

### NEXT — Wave 3.5: agent capstone evidence

This wave exists for the hiring-evidence bar in §2; none of it substitutes for the dependable
core or H's domain algorithm.

1. **C13 ShadowBench** after C4/C5: freeze the held-out split, then add repeated live and
   controlled real-tool evaluation with equal-budget baselines and raw traces.
2. **C14 release operations** after C13: server-owned release manifests and limits, durable
   quotas, canary/monitoring, privacy tests, and an exercised rollback.
3. **G5 + C15 accessibility** after C5/C7, in parallel with C13 where file ownership permits:
   the keyboard and screen-reader journey is an acceptance contract, with G5 supplying
   automation and C15 owning remediation.
4. **C12 native multimodality** after C10 and the C13 split format: actual images reach Gemini;
   claims cite regions; image-required tasks and offline/metadata/fixed-sampling baselines run at
   equal budgets. The earlier Cerebras-era offline-only premise is retired.

### LATER — Wave 4: learned-model specialization

**A10 Reality Check is selected for the agent/Geo hiring-evidence goal as of 2026-09-14.** C12
proves native multimodal agent behavior; A10 independently proves data, modeling, evaluation,
artifact deployment, monitoring, and rollback. Combining those two adjacent proofs is more
valuable for the saved AI/ML roles than adding an unrelated platform. The full acceptance criteria
now live in Track A rather than only in this options list.

Do not accumulate the alternatives below. Option C's optimization evidence is now covered more
naturally by H7's integer reference and LP/convex bound over the real route problem. Option D
remains the strongest product-science follow-up after the hiring bar. Option B remains a valid
offline product choice, not a prerequisite.

**Two of these moved on 2026-09-09 without new evidence, purely because the client-side-only
constraint was lifted (#248).** Record why, so it is not re-litigated: **Option B weakened** —
"keep planning with no network" draws its portfolio interest from the constraint that no longer
binds, and offline remains a real user need but a thinner *story*. **Option C strengthened** — its
weakest section now has published method (see #209).

**Option A — Reality Check (the perception-ML story) → selected as A10.** Users flag where predicted shadow
disagrees with what they observe; a learned correction improves on the geometry baseline.

> **Decision corrected 2026-09-14.** A10 is still not needed merely to call C12 a multimodal
> agent: Gemini now accepts images directly. It is required for the higher hiring-evidence bar
> because native Gemini inference does not demonstrate an owned dataset, learned artifact,
> leakage-safe training/evaluation, serving parity, drift handling, or rollback. A10 and C12
> therefore remain separate implementations joined by a typed tool boundary.
- **Stop at the achievable rung** unless the data justifies more: logistic regression or GBTs
  over geometry confidence, solar altitude, street orientation, canopy features, observation
  conditions. ~90% of the MLE story for ~10% of the cost of a vision model.
- **Non-negotiable:** geographic *and* temporal holdouts (not random frames from one walk),
  calibration fit separately from training, an untouched final test set, reliability diagrams, a
  dataset card, a documented rollback to the geometry baseline.
- **A crowd tap is evidence, not ground truth**, and A3's harness measures model-vs-model
  agreement, not physical accuracy. The code already says so; that distinction must survive into
  any README claim.
- **Two different corpora, and only one is expensive** *(clarified 2026-09-08)*. Do not
  conflate them:
  - **The calibration set — small, cheap, and needed even if Option A is never chosen.**
    ~100–200 timestamped *"I am standing here at this time and I am in sun / in shadow"*
    observations. A phone and a notebook. No pose precision, no masks, no seasons, no model.
    **This is what upgrades P4 from method-agreement to physical accuracy** — A3 compares two
    models to each other, and A7/A8 will ship *unvalidated* without it. Weeks.
  - **The training corpus — large, expensive, season-locked.** Pose-accurate panoramas with
    reviewed sky/canopy/building masks, revisited leaf-on and leaf-off. Only required to claim a
    *learned* component improved a decision. Months, and the calendar cannot be compressed.
- **Honest cost:** the training corpus is the expensive part. Months, for one person.
- **Precondition (added 2026-09-08):** ship **A7 + A8** first and measure the residual. Free
  canopy data may close most of the *routing-decision* gap for none of the fieldwork. What it
  cannot close: canopy **transmittance** (a height raster cannot tell a dense evergreen from a
  bare ginkgo), **sky view factor from eye level** (top-down data cannot answer an upward
  question), **awnings, arcades and scaffolding** (in no raster and no reliable tag), and
  **physical ground truth** (you cannot validate a shadow model against another shadow model).
  Those four are the entire remaining case for imagery — decide against them, with the residual
  measured, not against an assumption.
- **Trap:** USGS bare-earth DEMs strip buildings and vegetation. A terrain DEM is not a shadow
  model.
- **Prerequisites:** opt-in, minimized location retention, deletion support, no medical data.

**Option B — City Capsules (the systems story).** Download a neighborhood; keep planning with no
network. Versioned local graph + shadow representation + permitted assets behind a worker
boundary, with an **atomic manifest swap** so a half-downloaded update cannot replace a working
capsule; checksums validated on install; interrupted downloads, eviction and restart handled.
Demonstrate on a **named device**: install, kill the network, route, retime, restart, resume —
then publish size, cold/warm latency, memory and online/offline parity. PMTiles is a tile
archive, not a routing graph or a caching policy; a PWA manifest is not offline coverage.
Rust/WASM only after profiling proves a kernel is the limit, with a reference implementation
kept for parity. Overlaps Track F's F4.

**Option C — Shadow Design Studio (the optimization story).** *"Where would two shadow structures
most improve this walking loop between noon and 3 PM?"* Inverse spatial design over a **finite,
hand-authored candidate set**: union-coverage precompute, a max-coverage integer program under a
budget, exhaustive enumeration as the oracle on small instances, offline OR-Tools CP-SAT for the
integer model, a greedy baseline in a worker for the interactive path, and an LP relaxation for
the upper bound. Full model in **#209**.
- **Why it is the cheap one:** the "candidate set" is 20–60 placements you author in a JSON file
  in an afternoon. No corpus, no fieldwork, no permissions, no new provider, no calendar
  dependency. Contrast Option A, whose corpus is months and is season-locked.
- **It replaces the Shadow Lab slot below** rather than adding to it — same interaction, posed as
  optimization instead of a toy.
- **Prerequisite it exposes:** `shadowIndex.ts:227` returns `false` inside a footprint (a roof is
  not shadowed). Correct for buildings, wrong for an elevated canopy where the *ground beneath*
  must read as shadowed. Overhead structures need an elevated-occluder / ground-receiver test;
  solid obstacles shading adjacent ground work with today's primitives.
- **Honesty:** demand weights are scenarios unless a real pedestrian dataset exists. Maximizing
  modeled coverage ≠ maximizing benefit after users reroute — re-run the planner to check that
  separately. Models shadow; not validated urban cooling, not structural engineering.

**Option D — The Comfort Engine (the applied-science story).** *(added 2026-09-09 from §5c)*
*"Is shadow actually a good proxy for thermal comfort — and where isn't it?"* Answered at breadth,
across climates, and published including the part that makes this product look worse.

> **Why this is the frontrunner.** It is the only option that answers a question the literature
> **explicitly poses and leaves open.** Buo et al. 2026 §4.4: *"Future work should systematically
> compare shadow-based and MRT-based routing approaches to evaluate trade-offs between
> computational efficiency and physiological accuracy."* Ma et al. 2025 answered it for **one
> district on one summer day** and found shadow-optimal routing *worse than the plain shortest
> route in 24% of trips*. Nobody has done it across climates, and nobody who **ships** shadow
> routing has published evidence about when shadow routing is wrong. That last clause is §2's
> honesty thesis at full strength, and it is not available to any other option on this list.

- **What it is, in four steps.** (1) Build the MRT approximation — **A6**'s shadow geometry +
  **A9**'s sky view factor + a radiation balance from the live forecast (**#247**; Tier 1
  geometry, Tier 2 radiation, per §7). (2) Route on it, as a third objective beside distance and
  sun-minutes — this is where **H** and **D** finally become one engine. (3) Run the comparison at
  breadth: several cities across climate types × O-D pairs × hours, scoring shadow-optimal vs.
  comfort-optimal vs. shortest, and publish where shadow routing **wins, ties and loses**.
  (4) Validate against what is actually publishable — Buo et al.'s MaRTy statistics, ISO 7726's
  ±5 °C band, and Option A's *cheap* calibration set.
- **Why it is affordable.** No training corpus, no fieldwork, no season lock, no permissions, no
  new provider. Open-Meteo is already integrated; the one genuinely expensive input is canopy,
  which is **A8 and already on Wave 1**. Contrast Option A, whose corpus is months and
  season-locked. Its prerequisites are the only ones on this list that Wave 1 was going to build
  anyway.
- **It subsumes D8** rather than adding to it, and it makes **Option A's calibration set a
  prerequisite rather than optional** — you cannot validate a comfort model against another
  model, which is the same trap **A3** already documents.
- **Honesty, and this is the whole discipline of the option.** Ours is an approximation *of an
  approximation*: SOLWEIG itself misses ISO 7726's band on transient walks (RMSE 8.4 °C), so
  nothing here may be presented as MRT-grade. Comparing our shadow model against our comfort model
  is **model-vs-model agreement**, exactly what `ShadowField.ts:199` already refuses to call
  accuracy — physical validation needs the calibration set and nothing else substitutes.
  Ma et al.'s 24% is **one district, one day, simulated**; reproducing it is the point,
  assuming it is not.
- **The result may partially devalue the product, and it ships anyway.** If shadow routing turns
  out to be a poor comfort proxy in humid climates, that is the finding. §7's stopping rules
  already say a note explaining what you did *not* ship is itself an artifact; this is the
  version of that with a number attached.
- **Trap:** this balloons into "build SOLWEIG" if unmanaged. Stop at the rung where the
  comparison is answerable, not at the rung where the physics is complete.
- **Prerequisites:** A6, A8, A9, #247, #248. **H is not a prerequisite** — it is the consumer.

### LATER — playful, one PR each, after Wave 3

Each reuses Track H's planner rather than adding a system, and each is what makes someone want
to *use* the thing: **Shadow Lab** (drop a hypothetical tree, watch routes change — a
counterfactual tool; label the assumptions — **superseded by Wave 4 Option C if that is
chosen**), **Find the Light** (invert preference per stop:
sunny breakfast, shadowed reading, sunset viewpoint — **and the natural second multimodal item**:
posed as image-text retrieval over ~20–50 curated micro-locations with *hard* spatial and
temporal filters, it shows judgment about when **not** to use a generative model, which
complements C12 rather than repeating it), **Golden-Hour Rendezvous** (two people, one
pleasant meeting point; minimizing the *worst* individual burden is arguably fairer than the
average — expose the tradeoff), **Shadow Chase** (an outing that reorders as the sun moves;
lawful paths only, never reward unsafe crossings).

### NOT DOING — and why

Recorded so no session re-litigates them. Carried from `AUTONOMOUS_GOAL.md` §7 plus the research
proposals that were considered and declined.

| Proposed | Verdict | Reason |
|---|---|---|
| PostGIS + object storage + an agent-gateway backend | **Declined for now** | Contradicts the local-first decision that keeps this free, private and deployable from one repo. Sun Budget does not need it. Revisit only if Wave 4 Option A needs a corpus — and scope it to that, not the app. |
| Kubernetes, Spark/Sedona, Kafka, service mesh, vector DB | **Declined** | §2 anti-goals. A labelled study behind a real workload, never the request path. |
| A second LLM provider or a paid model | **Declined** | Free-tier guardrail. |
| Accounts / sync | **Declined** | Local-first; `localStorage` holds profiles and saved trips. |
| Driving navigation | **Declined** | Out of mission — under own power only. |
| In-browser SOLWEIG/CFD microclimate | **Declined** *(reason sharpened 2026-09-09)* | Still declined **in the browser**. But the blocker was misdiagnosed: ASU's four hours per 24 h of MRT is dominated by redoing *geometry* every hour, which A6 exists to avoid, and their real constraint is **LiDAR — a data problem, not a compute one**, with a free global substitute (OSM heights + Meta/WRI 1 m canopy + Copernicus DEM). §7 Tier 1 always permitted precomputed physics; #248 permits the weather-conditioned half. **CFD (ENVI-met) stays declined outright** — commercial, licensed, hours per domain. See #247. |
| A native app | **Deferred** | PWA first; revisit only if background location or notifications block D7. |
| A 50–100 task agent benchmark | **Rescoped** | Free-tier live runs with repeats take hours. C1 has grown from ~15 to 34 recorded, network-free scenarios; C13 adds a smaller leakage-safe holdout and repeated tiers rather than chasing a vanity task count. **Grow from real failures, not to a target number.** |
| Chasing Google's feature list | **Declined** | The answer to "Prefer shadow" is not a better toggle. It is §2's five clauses. |

---

## 4. The checklist

Every line is a checkpoint in a brief. Tick only when its acceptance criteria are met and the
gates are green — `docs/tracks/README.md`'s definition of done applies to all of them.

**Wave 0 — truth**
- [x] **P1** Mirror `public` on merge · #199 — merged as #203, mirror live 2026-09-08
- [ ] **D0** Real timezones, IANA + DST · #204 *(also gates H)*
- [ ] **G8** Nominatim policy + reachable `User-Agent` (with #32, #33) · #205
- [ ] **#208** Preserve OSM access tags through the sidewalk split *(unblocks H2/H3, E1/E3/E4)*
- [ ] **#206** Novelty claim vs. Fujiwara 2024 · [ ] **#207** Label the index win a microbenchmark
- [ ] **G7** LICENSE · README refs · `.env.example` · #50 cluster
- [x] ~~Six open PRs rebased, green, ready or closed~~ — cleared 2026-09-08
- [ ] **Dependabot backlog** — 7 PRs, 5 alerts, all dev-only and none in `dist/`; retire the
  `vitest`/`vite`/`esbuild` majors so the public mirror stops showing a critical (**#81, #82,
  #112, #139, #140, #141, #142**)

**Wave 0.5 — make the existing work visible** *(promoted from Wave 3 on 2026-09-08)*
- [ ] **P4** publish the numbers *(after #206/#207)* · [ ] **P2** README

**Wave 1 — flagships**
- [ ] **G2** route benchmark  · [ ] **G6** seam work *(runs alone)*
- [ ] **A5** worker offload · [ ] **A6** time sweep *(gates H)*
- [ ] **A7** Overpass trees *(#46)* · [ ] **A8** canopy raster + height fallback — *promoted from "not yet prioritized" 2026-09-08; run before H3 and before any Wave 4 decision*
- [ ] **B2** · [ ] **B3** · [ ] **B4** · [ ] **B5** · [ ] **B6** *(the reason B exists)* · [ ] **B7** *(unparks F)*
- [ ] **C1** *(PR #191)* · [ ] **C2** · [ ] **C3** · [ ] **C4** *(terminal plan job contract)* · [ ] **C5** *(typed claim receipts)* · [ ] **C7** *(honest degradation/cancellation)* · [ ] **C10** *(tool authority — gates C12)* · [ ] **C11** *(repair — the Living Itinerary)*
- [ ] **D3** *(PR #189)* · [ ] **D4** *(PR #196)* · [ ] #197 mobile strip
- [ ] **E1** mode cost model · [ ] **E5** `Trip`

**Wave 2 — Track H** *(gated on A6 + G2)*
- [ ] **H1** · [ ] **H2** · [ ] **H3** · [ ] **H4** · [ ] **H5** · [ ] **H6** · [ ] **H7** *(integer/LP reference and bounds)*

**Wave 3 — Track P, the rest** *(P2/P4 moved to Wave 0.5)*
- [ ] **P3** demo recording · [ ] **P5** design notes · [ ] **P6** ledger

**Wave 3.5 — agent capstone evidence**
- [ ] **C13** held-out/repeated/end-to-end eval · [ ] **C14** releases/monitoring/rollback ·
  [ ] **G5 + C15** accessible agent journey · [ ] **C12** native Gemini images + equal-budget baselines

**Wave 4 — selected learned-model specialization**
- [ ] **A10 Reality Check** — data/model/deploy/drift/rollback lifecycle; selected 2026-09-14
- Alternatives after the bar, not concurrent prerequisites: Option B City Capsules · Option C
  Shadow Design Studio *(optimization portion superseded by H7)* · Option D Comfort Engine

**Conditional** — not on a wave, but required the moment a precondition is met:
- [ ] **C10** untrusted content and tool authority — **required before any tool returns
  third-party prose.** Today the surface is narrow (a truncated OSM place name; Foursquare is
  not imported by the agent at all), so this is a *constraint on future work*, not a live
  vulnerability — but #67 (Foursquare place details) or any server-side fetch tool makes it live.

**Not yet prioritized** — in their briefs; pull one up when it earns its place against §2's two
questions, not because it is next in a list:
A9 · B8–B9 · C6, C8–C9 · D5–D8 · E2–E4, E6–E8 · F1–F6 · G3. *(C7 moved to the agent core; G5, C12–C15 and A10 now have explicit waves; G4 is already delivered.)*

---

## 5. Reconciliation with the research

`docs/research/` holds three independent passes (2026-09-05 market research, 2026-09-07
recruiter-focused roadmap, 2026-09-08 Google-roles feature recommendations) that converge on the
same priorities — real signal. The 2026-09-08 pass is reconciled in §5b. Every
source-level claim in the 2026-09-07 document was **re-verified against the code**; all seven of
its "most consequential gaps" hold. Recorded so no session re-audits them:

| Research claim | Verified | Went to |
|---|---|---|
| Every edge sampled at one `dateRef.current` | ✅ `useNavigation.ts:633`, `:1154` | **H1** |
| Timezone from longitude, whole-hour, no DST | ✅ `timezone.ts:8` | **D0** |
| Pareto maximizes shadowed distance → more shadow can mean more sun | ✅ `routing.ts:544`, `maxDetourFactor = 2.0` | **H2** |
| `plan_shadowed_route` returns "started", never awaits | ✅ `tools.ts:470-478` | **C4** |
| Source confidences are priors, not measurements | ✅ `ShadowField.ts:199` says so in-source | Wave 4 Option A; **P4** publishes the distinction |
| Public Nominatim behind a browser-local queue | ✅ **understated** — `SearchBar.tsx:150` bypasses the queue entirely, and `User-Agent` is silently dropped as a forbidden header | **G8** |
| `api/agent.js` per-IP limiter is a process-local `Map` | ✅ `:39` | **G8**, **C6** |
| Not merely a pixel sampler — geometry field with pixel fallback | ✅ A4b landed | Corrects a stale impression; keep it corrected in **P2** |
| README thin, `api/` inventory stale | ✅ 19 lines | **G7**, **P2** (`CLAUDE.md` half fixed 2026-09-07) |

**Where the research was incomplete:** it called exposure entirely unrepresented, but
`longestContinuousSunM` and `sunExposure` already exist as *outputs* (`routing.ts:481`) — they
just never enter the search, which is precisely H2. It also missed that `plan_shadowed_route`
already accepts `via` stops, which is why C4 needed re-scoping rather than building.

**Restored 2026-09-07 after an audit found them dropped.** A first pass at this file was 775
lines; cutting it to an index dropped three things from the research doc that had no other home.
They now live in the briefs that own them: **prompt injection / untrusted provider content →
C10**; **the plan as a versioned data object, its deterministic validator, and repair
minimality → C11**; **the separate-evaluation-layers table → P4's approach.** Recorded here
because a roadmap that silently loses source material is the failure this section exists to
prevent.

**Where its plan was declined:** the backend, Kubernetes and Spark sections — see §3's NOT DOING
table. Its own §13 says those "should not delay the central experience"; this roadmap takes that
sentence over the pages above it.

### 5b. The 2026-09-08 Google-roles pass

`Umbra_Google_Maps_GenAI_Feature_Recommendations_2026-09-08.pdf` — six proposed features
ranked against two Google job descriptions, audited at `f61371c`. **Every repository citation in
it was re-verified line by line and all of them hold.** Recorded so no session re-audits it.

| Its claim | Verified | Went to |
|---|---|---|
| The "nobody advances the sun along a route" claim is too strong — Fujiwara 2024 §6.2 does traversal-time irradiance over three predefined routes | ✅ overclaim confirmed | **#206**, §2 |
| The index speedup is a synthetic Node microbenchmark, not browser route time | ✅ | **#207**, §2, **P4** |
| OSM access tags are lost rebuilding sidewalk edges | ✅ `routing.ts:400` returns four fields; `GraphEdge:21` declares nine | **#208** |
| `shadowIndex.ts:227` excludes points inside footprints, so an overhead canopy would shadow nothing | ✅ correct for buildings, wrong for canopies | **Option C** prerequisite |
| Timezone still longitude-rounded; fix before claiming temporal plans | ✅ | **D0**, already Wave 0 |
| `plan_shadowed_route` returns "started"; `via` already supported | ✅ (agrees with the 09-07 pass) | **C4** |
| At the 2026-09-08 pass: 7 tools and 18 recorded scenarios, model and tools mocked — replay is not model competence | ✅ then-current counts; the suite is now 34 and a live runner exists | **P4**'s layer table; **C13** for independent evaluation |
| Confidences are hand-set priors; the harness measures method agreement, not physical accuracy | ✅ `ShadowField.ts:193` | **P4**, Option A |

**Its ranking is a keyword ranking, not a value ranking.** It optimizes for matching two JD
requirement lists; this file optimizes for one coherent product with published numbers. Where
they diverge, this file wins — six features half-built reads worse than two finished. Its own
last page agrees: *"build one evaluation and debugging workbench rather than counting tests as a
seventh product feature"*, which is Track P.

**What was adopted:** the three corrections above; **Feature 6 → Wave 4 Option C** (#209);
**Feature 3 → C12** (see below); Feature 2 needed nothing — it *is* Track H, which it
independently ranked 2nd of 6.

**Two constraints found while acting on it, verified at `f61371c`.** The first still shapes C12;
the second is retained as historical context and was superseded by the Gemini migration:

| Finding | Consequence |
|---|---|
| `llmClient.ts:25` — `LlmPart` is `{ text?, functionCall?, functionResponse? }`, **no image part** | Small, clean addition; that is what the neutral IR is for. Ship it before anything needs it. |
| At `f61371c`, both allowlisted models (`gpt-oss-120b`, `zai-glm-4.7`) were **text-only** | **Superseded 2026-09-11:** the allowlist now uses image-capable Gemini models. C12 requires native image-conditioned requests and retains offline perception as a baseline/fallback, not as proof of multimodality. |

**And one correction to the report's own framing.** Native C12 multimodality does not require a
trained segmenter: it needs permitted images, direct Gemini image input, region receipts, and a
fair evaluation. **A10 remains a separate dependency only for the higher, ML-lifecycle hiring
bar.** Keeping the boundary explicit prevents either checkpoint borrowing the other's claim.

**What was declined or deferred, and why:**

| Proposed | Verdict | Reason |
|---|---|---|
| Features 1 & 4 — Visual Shadow Field, Active Survey Planner | **Selected → A10 after A7/A8** | It is Option A with a stronger lifecycle protocol: pose rejection, geographic and temporal holdouts, leaf-season slices, reliability diagrams, dataset/model cards, drift checks, and rollback. The expensive segmentation corpus is still conditional on baseline residuals; the learned-model lifecycle is not. |
| Feature 3's **visual** half — live VLM route scout | **Adopted as revised C12** | The provider migration removed the old text-only constraint. C12 requires native Gemini image input, retains offline observations as a measured baseline/fallback, and does not add an unmeasured local model path. |
| Feature 5 — Find the Light w/ SigLIP retrieval | **Kept where it is** | Already in the playful list. The retrieval framing is a real upgrade; the 20–50 curated micro-locations and photo permissions are the actual cost. |
| Street View as a training corpus | **Prohibited** | Maps Platform Terms §3.2.3 restricts extraction and model training/testing/validation and building a tree-location index. Own photographs only. Not a judgment call. |
| Offline Python training + versioned derived artifacts | **Adopted with a boundary** | This is the one real architecture change it proposes and it does not flag it as one. Permitted as a **build step producing versioned static assets**, never as a request-path service — see §7. |

### 5c. The 2026-09-09 frontier-literature pass

Three peer-reviewed papers, read in full and reconciled in
`docs/research/shadow-thermal-comfort-literature-2026-09-09.md` (which holds the detail, the
caveats and the citations — this is the index):

| | Paper | What it is |
|---|---|---|
| **P1** | Wen et al. 2025, *CEUS* 122:102337 | MIT Senseable, Dubai. Street-view segmentation → binary shadow; **distance-dependent sigmoid shadow reward** |
| **P2** | Buo et al. 2026, *Build. Environ.* 298:114622 | **This is "ASU Cool Routes."** SOLWEIG MRT @ 1 m from LiDAR; MaRTy-validated |
| **P3** | Ma et al. 2025, *Sustain. Cities Soc.* 131:106697 | Tsinghua, Hong Kong. ENVI-met → PET; 2.2 M routes exhaustively enumerated |

**None is a dependency.** No code released, all data "on request" (P3's abstract claims an
open-access dataset; its data statement does not). They are **evidence and adversaries**, not
software. Do not plan a checkpoint around P3's corpus arriving.

| Finding | Verified | Went to |
|---|---|---|
| **Shadow is not a reliable proxy for comfort.** Minimising *unshadowed metres* — exactly H2's corrected objective — scored **worse** than the plain shortest route in **24%** of 1200 O-D pairs (41% at 08:00; worst −472%) | ✅ P3 §4.2.2, §5.1 | **#241** — bounds H2's claim; H2 still lands |
| **P1's dynamic reward makes edge cost path-dependent, and their Dijkstra keeps one label per node** — a label carrying more distance is *advantaged* downstream, so cost-only pruning can discard the optimum. This is H1's stated open question, unresolved, in print | ✅ P1 §2.3.3 | **#242** — the highest-value new item, and entirely client-side |
| **The useful detour is ~1.1×, not 2.0×** — three climates, three methods, converging: +1.3%, <3%, plateau at 110% | ✅ all three | **#243** — measure via G2, do not blind-edit |
| **Tree shadow ≈ 0.5 × building shadow** (indoor 1.5×), and tree shadow dominates at midday precisely when building shadow collapses | ✅ P1, via Melnikov 2022 | **#244** — A7/A8 gets a published weight; supports A7/A8-before-H3 |
| P1 takes a **one-hour max-shadow window** on behavioural grounds — "a pedestrian will step a few metres" | ✅ P1 §2.3.2 | **#245** — adopt deliberately or decline in writing |
| **PetL** = `Σ (PET − 33)⁺ × length` — a threshold-excess *dose*, the companion our intensity score documents itself as lacking | ✅ P3 §3.3.2 | **#246** — Track D |
| **SOLWEIG splits into expensive geometry (once per area) + cheap radiation balance (per query).** A6 + A9 already are the first half; ASU's blocker was **LiDAR, not compute**, and it has a free global substitute | ✅ P2 §2.3.1, §3.1 | **#247** — D8 is no longer a stretch; §3, §7 |
| **§2's "ASU … with no app" is false** — Flask web app, interactive map, 171 POIs, 3-day forecasts, ~2 s. True limits: single-user, campus-only, POI-to-POI, LiDAR-bound | ✅ P2 §2.1–2.3, §4.4 | **#206**, **#195** (which also corrects −4.5 °C → −1–2 °C mean, −3.8 °C best case) |
| **P2's validation gives P4 an external scale**: d = 0.73, RMSE 8.4 °C, MBE −2.0, only 72% of edges under RMSE, **ISO 7726's ±5 °C band exceeded** — and their tail is dominated by sun–shadow misclassification, structurally the same failure as our `worst 62.5pp` | ✅ P2 §3.2, §4.2 | **#249** — P4 |
| **Option C's weakest point has published method**: derive demand from the *optimiser's own* chosen routes, not the shortest-path network, because pedestrians avoid the streets you would otherwise renovate | ✅ P3 §5.2, P2 §4.3 | comment on **#209** |

**The differentiator survives, and two of the three name it as their own future work.** None of the
three advances the sun along the walk: P2 uses the MRT map *"closest to the user-defined time"*
and lists temporal exposure dynamics as not captured; P3 is explicitly *"stationary PET … did not
consider the dynamic thermal conditions along the routes"*; P1's one-hour window does not advance
either. Fujiwara 2024 remains the honest prior art (**#206**) — that does not change.

**Two areas are uncontested and worth knowing are uncontested.** **UV**: none of the three
mentions it at all, so `heat-model.md`'s SED/UVI dose model has no counterpart in this
literature. **Mobile navigation**: all three are desktop research tools and P2 is explicitly
single-user with no concurrency, so Track B has no competitor here.

**The shared gap under all of it is behavioural, and servers do not fix it.** P1 calibrates
*Dubai* on *Singapore* data; P3 says subjective validation is needed before practical use; P2
wants a detour-tolerance parameter it does not have. Every one routes back to Melnikov et al.
2022 — one experiment, one city, 13 tasks. The behavioural foundation under this field is
thinner than the physics on top of it.

**What was declined.** MRT/PET *as a routing objective* (P2/P3's ceiling; needs LiDAR plus
offline physics per city — §3's row, reason now sharpened). ENVI-met in any form (commercial
CFD). Reopening Wave 4 on this evidence — P1's street-view segmentation is superficially Option
A's method, but they performed **no validation against measured shadow**, only a visual
sun-position check, so it is weak support and the demotion stands.

**Changed nothing in the 2026-09-09 literature pass:** Wave 0 (D0, G8, #208, G7), **Track C
entirely** — there is no agent, tool-use or evaluation content in those papers — and Track B.
The later hiring-evidence pass below changes Track C for different evidence.

### 5d. The 2026-09-14 agent/Geo hiring-evidence pass

The two saved Google Geo descriptions and the current SWE/AI/ML hiring market were compared with
the implemented agent, its tests/live eval, the wider repository, and the public evidence. Full
assessment: `docs/research/Umbra_Track_C_Hiring_Assessment_2026-09-14.md`.

The implementation already provides strong applied-agent evidence: bounded orchestration,
provider adaptation, retries, deterministic state reconciliation, failure scenarios, live-model
runs, and measured request/latency work. The decisive implementation gaps were narrower and more
specific than “add more AI”:

- the route tool reports initiation instead of a terminal outcome → **C4**;
- place/pin agreement is not claim-level factual grounding → **C5**;
- development scenarios are not a leakage-safe held-out/end-to-end evaluation → **C13**;
- hosted inference lacks a versioned promotion/monitor/rollback lifecycle → **C14**;
- external text/image authority needs code enforcement → **C10**;
- assistant keyboard/screen-reader operation is incomplete → **C15 + G5**;
- the C12 brief retained an obsolete text-only-provider premise after Gemini arrived → **C12
  now requires actual image-conditioned Gemini requests**;
- the project did not independently demonstrate a learned-model lifecycle → **A10**;
- the Maps-facing optimization story lacked an LP/convex artifact → **H7**, attached to the real
  time-dependent route problem rather than a keyword-only toy.

Experience duration, credentials, solo ownership, and final public packaging were deliberately not
turned into implementation checkpoints: a repository cannot prove the first two, solo ownership is
not a code defect, and Track P already owns publication after the underlying evidence exists.

---

## 6. The resume-line ledger

Fill in **only from measured results**. A number nobody can reproduce is worse than no number,
and a hiring manager who finds one stops reading. Tick only when the artifact is live on the
public mirror.

| | Line | Earned by |
|---|---|---|
| ⬜ | "Built a time-dependent pedestrian planner with exposure and arrival constraints; reduced [error] by [measured] versus a static baseline on [versioned fixtures]." | H1–H4 |
| ⬜ | "Developed a tool-using itinerary agent with terminal job contracts, deterministic claim validation and repair; improved valid-plan rate from [A] to [B] over [N] held-out tasks at [cost] per successful task." | C1, C4, C5, C11, C13, P4 |
| ⬜ | "Built and evaluated an image-conditioned Gemini agent over [N] held-out Geo tasks; improved [task metric] over metadata, offline-extraction and fixed-sampling baselines at equal budgets, with [visual-claim escape rate]." | C10, C12, C13 |
| ⬜ | "Versioned model/prompt/tool releases behind server-owned policy; detected a degraded canary on [metric] and rolled back in [time], with cross-instance quota and privacy-retention tests." | C14 |
| ⬜ | "Formulated Sun Budget routing as an integer program with an LP/convex relaxation; measured production-search and integrality gaps over [N] fixtures and exposed verified feasibility certificates to the agent." | H4, H6, H7 |
| ⬜ | "Shipped a keyboard- and screen-reader-complete agent planning flow with zero serious/critical axe violations and a documented manual assistive-technology run." | C15, G5 |
| ⬜ | "Cut per-edge shadow sampling by [measured]× by precomputing and indexing shadow geometry per sun cell." | **Already measured (#166) — needs only P4** |
| ⬜ | "Published a shadow-model agreement harness across [N] cases and 3 cities, reporting mean, p90 and worst-case error against committed regression ceilings." | **Already true (A3) — needs only P4** |
| ⬜ | "Implemented offline neighborhood routing with atomic snapshot updates; [latency and size], verified online/offline parity on [device]." | Wave 4 Option B |
| ⬜ | "Trained and calibrated a geospatial shadow-correction model with neighborhood and date holdouts; measured [metric] and [route impact], with versioned deployment, drift checks and rollback." | A10 |

**Two of six are already earned and merely unpublished.** That is the cheapest value available
anywhere in this document.

---

## 7. Scope notes

**Design is out of scope here** and is never a reason to delay an item above. Two exceptions,
because they are correctness rather than taste and are already filed: **#197** (the hourly strip
never renders on mobile — a feature nobody can see) and **#198 / #158** (9px uppercase
disclaimers; 1.63:1 shadowed-vs-lit contrast against a 3:1 floor). An app used one-handed in
bright sun has legibility as a functional requirement. When design gets its own pass, it gets
its own document.

**Where off-client compute is allowed** *(decided 2026-09-08)*. Three tiers; the middle one is
the answer for everything heavy, and it is free.

| Tier | What runs there | Verdict |
|---|---|---|
| **0 — client** | shadow render, shadow sampling, graph search | Already interactive. The complaint is main-thread blocking, and **A5 fixes that for free**. Needs no service. |
| **1 — offline batch → versioned static artifacts** | SAM masks, model training, embeddings, canopy field tiles, Option C's coverage matrices | **Adopted.** Runs on a laptop or free Colab/Kaggle; ships compact versioned files over the CDN already in use. Zero marginal cost, zero new service, no request-path latency, scales to any number of users. It is also the architecture the 09-08 research cites from Google's own routing work — expensive inference offline, stored, fast online graph search. |
| **2 — request-path service** *(what Cerebras is)* | per-request inference that cannot be precomputed | **Reopened 2026-09-09 — #248.** Was: *"justified only when work can be neither precomputed nor run on the client; for this app that is close to nothing."* The owner has lifted the client-side-only constraint, so the test is now **"does it buy accuracy that cannot be precomputed?"** — which admits weather-conditioned radiant load (a live forecast cannot be baked into a static tile) and personalised thermal comfort. It does **not** admit moving shadow geometry off the client: that is deterministic, the client already holds the inputs, and Tier 1 covers it. |

**The half of this that still holds.** Moving *shadow geometry* server-side remains wrong: it adds
a round trip per route and a per-user cost to compute something deterministic from inputs the
client already has. Tier 1 gets that heavy work off the user's machine without either. Nothing
below repeals that.

**The half that changed on 2026-09-09 (#248).** The old text argued Tier 2 was unjustifiable
*because* it would delete *"entirely in a browser"* from §2. The owner has now traded that clause
away deliberately, so the argument no longer decides anything and §2 must be restated (see the
warning in §2). What Tier 2 buys is narrower than "run the physics", because **Tier 1 already
permitted precomputed physics** — the genuinely new capability is work that depends on **today's
weather or this user** and therefore cannot be baked into a static artifact. Worked example, and
the shape to copy (#247):

| Half of an MRT model | Depends on | Cost | Tier |
|---|---|---|---|
| **Geometry** — sky view factor, shadow volumes per sun position | buildings, canopy, terrain | expensive, **once per area** | **1** — and A6 + A9 already are this |
| **Radiation balance** — six-directional fluxes → MRT | air temp, humidity, wind, shortwave | **cheap per query** | **2** — needs a live forecast |

**Three guardrails on the new tier, so it does not become the thing §2's anti-goals warn about.**
The anti-goals are **re-affirmed, not repealed** — they were about *unjustified* infrastructure,
and a small service behind a real workload is not that, while Kubernetes on this still is.
Second: server-side buys **accuracy, not responsiveness** — ASU's tool takes ~2 s per route on a
*precomputed* campus, our client routing is already interactive, and the jank that actually
exists is main-thread blocking that **A5 fixes for free** (#38). Do not justify a service on
speed. Third, the free-tier guardrail survives with a new boundary: **a fixed monthly floor is
acceptable; per-user marginal cost that scales with traffic is not.**

The other case that would earn Tier 2 is unchanged: live segmentation of **user-submitted**
photos, which cannot be precomputed; the curated-corpus-first approach in Option A specifically
avoids needing it.

**Stopping rules.** Stop or redirect any item when it adds maintenance without improving an
agreed outcome, when the data cannot support the claim, or when a simpler baseline wins. **A
note explaining why you did not ship Spark, Rust, a learned model or multi-agent is itself a
portfolio artifact** — arguably better than shipping it would have been.

**If you read nothing else:** finish Wave 0 — it is six small things now, and two of them are
corrections to claims this file used to make. Then **publish the numbers you already have
(Wave 0.5)**, because it is the only item that adds signal without adding work. Then finish what
is already 60% done. Then build Track H — not because nobody else advances the sun, but because
nobody else turns it into a constrained, inverted, published search.

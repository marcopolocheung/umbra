# Handoff — Shade signatures (per-sidewalk shade "fingerprints" and street types)

> Compress every NYC sidewalk side's year of shade, already in the published shade table, into
> a short vector (a **signature**) and a coarse **type**. Ship both as a static per-cell artifact
> next to the shade table.
>
> **Where this is going (decided 2026-10-12):** the signature pipeline is done. The next work is two
> ML-focused plans, both built on the exact shade table and both written out in full below:
> - **Plan A:** a `find_shade_spots` assistant tool, with a real agent evaluation.
> - **Plan B:** a study that uses the exact table as ground truth for whether image models can see shade.
>
> Read [§ Next: the two plans](#next-the-two-plans) before starting new work here.

**Verified 2026-10-12**, `umbra/main` at `11acdf4`. If this handoff disagrees with the code, the
code wins. Update this file in the same PR that changes a stated contract.

**Status:**
- **Phases 0–3 are done.**
  - Phase 0: qualified GO, issue **#321**.
  - Phase 1: the pipeline stage (#323/#324).
  - Phase 2: the client read side (#341).
  - Phase 3: a route street-type layer (#343).
- **Published:** generation **`nyc-2026-09-18-e6718823bbb3`**, with signatures, is published and the delivery Worker serves `signatures/` (deployed 2026-10-11).
- **Next:** the old phases 4–6 sketch is replaced by **Plan A** then **Plan B** below. Take one step per PR.

---

## Decision in one paragraph

The idea came from an Epicure (arXiv 2605.22391, food-ingredient embeddings) discussion, but almost
none of Epicure's machinery transfers. Epicure trains skip-gram embeddings on sparse co-occurrence
graphs; Umbra already has **exact dense physics per sidewalk**, the shade table, so plain **PCA +
k-means** on that table is the right tool. It's deterministic, cheap and checkable. Two things do
carry over:
1. **Mean-centre before compressing.** The independent audit of Epicure (github
   `incrediblecrab/llmmm`, `prior-study/docs/REPLICATION.md`) showed uncentred aggregate vectors
   collapse onto the corpus mean.
2. **Test clusters against size-matched random groups scored the same way.** Epicure's headline
   coherence claim was overstated 6–8× for lack of that control.

There is **no model to serve**: everything is precomputed offline in `server/navigation-prep` and
shipped as bytes. The browser only reads vectors and runs brute-force nearest-neighbour search,
which is under 3 ms over 100k segments and CPU-only. **Routing never uses signatures**: the shade
table stays the exact source of truth for routes.

---

## What exists today (read these, don't rediscover them)

### The input: the shade table (Track L, L2a), already published
- **Producer:** `server/navigation-prep/src/shade.ts` (`shadeExecute`, `computeShadeCell`, `writeShadeCell`, `loadBuiltShadeShards`), run as `npm run … shade --execute [--concurrency N] [--cells a,b]` (`src/cli.ts`, `command === "shade"`). `build` folds the built cells into the generation (`src/build.ts`, `shadeShards`, `assembleManifest`, budget check `MAX_SHADE_SHARD_BYTES`).
- **Slot contract:** `app/lib/navigationData/shadeSlots.ts`.
  - 12 months, the 15th of each.
  - 64 fifteen-minute slots from 05:00 `America/New_York`, so **768 slots**.
  - 2 bytes per segment per slot, `[left, right]`, each 0–255 (`shadeByteToFraction` = byte/255).
  - **255 = fully shaded, and also night.**
- **Shard contract:** `app/lib/navigationData/shardContract.ts` (`NavigationShadeShardRef`, `NavigationShadeShard`).
  - Per z14 cell there's a JSON **index**: `segments: [lo, hi][]`, canonical undirected node-id pairs, ascending, giving column order.
  - A **binary payload** sits alongside, **slot-major**: for slot `s`, a block of `segments × 2` bytes.
- **Client read side:** `app/lib/navigationData/shadeTable.ts` (`createShadeTableView`, `QUARANTINED_SHADE_GENERATIONS`) and `remoteNavigation.ts` (`loadNavigationShadeShard`, `loadShadeSlotBlocks`, HTTP range reads), consumed in `app/hooks/useRouting.ts`.
- **Published generation:** `nyc-2026-09-18-393d4cd24a30`. That's 386 street cells, **1,608,171 segments**, 2.4 GB of shade payload. Locally at:
  `~/shade-prep-data-nyc-navigation/normalized/nyc-2026-09-18-393d4cd24a30/navigation/nyc/nyc-2026-09-18-393d4cd24a30/{shades,streets,buildings}/`.
- **Street shards** (`streets/z14-*.json`) give `nodes: {id, lat, lon, isIntersection}[]` and `edges: {from, to, id, distanceM, tags.highway…}[]`. They're the way to place a segment on a map.
- **Publishing** is R2 via `npm run publish:execute` (credentials are env-only; see `server/navigation-prep/README.md` § Publishing to R2). The client reaches it through the existing delivery Worker. **Publishing is an owner decision. Never publish without explicit OK.**

### Phase 0 analysis: outside the repo, in `~/umbra-phase0/`
| File | What |
|---|---|
| `signatures.py` | Load all cells, drop night slots, stratified 200k sample, centre, PCA, fidelity test, k-means, size-matched random control, auto-naming, stability |
| `maps.py` | Label every side with the fitted model; draw maps; Midtown orientation cross-tab; profile strips |
| `sides.py` | How often the two sidewalks of one segment land in different types |
| `model.npz` | `mean` (581), `components` (16×581), `centers` (8×16), `day` (581 daylight slot indices) |
| `results.json`, `log.txt`, `report.md` | Numbers and the written verdict |
| `maps/midtown.png`, `maps/parkslope.png`, `maps/profiles.png` | Visuals (OSM-derived renders; **not published**, ask before attaching anywhere) |

Rerun: `~/miniconda3/bin/python -W ignore signatures.py` (~3 min, 2.3 GB peak), then `maps.py`
(~2 min), then `sides.py`. numpy 2.2 / scikit-learn 1.9 / Pillow are in `~/miniconda3`. The seed is fixed (20261008).

---

## Phase 0 results (the facts phase 1 is built on)

**Setup:**
- **581 of 768 slots are daylight.** That's the union over cells of slots not all-255; sunrise shifts slightly across the city.
- **Rows are sidewalk *sides*,** about 3.2M rows.
- **Fitted on a 189k-side sample stratified by cell**, centred per slot.

**1. Does a 16-number signature preserve the year of shade?** Usable for similarity search, not exact.

| k | variance kept | exact recall@10 | signature neighbours within 1.1× of true 10th-NN distance | median ratio of signature-neighbour distance to true top-10 |
|---|---|---|---|---|
| 4 | 0.706 | 0.08 | 0.18 | 1.44 |
| 8 | 0.799 | 0.23 | 0.46 | 1.19 |
| **16** | **0.866** | 0.41 | **0.72** | **1.07** |
| 32 | 0.913 | 0.56 | 0.86 | 1.03 |

Exact recall misses the planned 0.6 bar. With 1.6M segments, many of them near-identical neighbours on one block, the exact top 10 is decided among near-ties. The practical measure passes: "similar streets" are on average 7% farther than the true best ten. **Use k = 16**; k = 32 only if exactness is needed (64 B/side).

**2. Are the clusters real?** Yes, as bins, not natural categories.
- **Silhouette by K:** 8 → 0.210, 12 → 0.192, 16 → 0.178, 20 → 0.169. Low and monotone, so the space is a **continuum**.
- **At K = 8, every cluster is far tighter than 200 random groups of the same size**, scored on the full centred row: margins +1.1 to +6.8, **z = 17–114**.
- **Stability ARI 0.73 / 0.95** on two refits. One is below 0.8, so some boundaries between neighbouring types move. **Centroids must be frozen and versioned** (see phase 1).

**3. Readable and physical?**

| id | Auto-generated name (numbers only; first and last daylight hour ignored) |
|---|---|
| 0 | 8% shaded overall; nearly always sunny |
| 1 | 70% shaded overall; summer shade 6:30am–7:30pm (all day) |
| 2 | 41%; summer shade 6:30–9:15am; summer sun 11am–6pm (**morning shade**) |
| 3 | 44%; summer shade 5–7:30pm; summer sun 8:30am–3:15pm (**afternoon shade**) |
| 4 | 41%; summer sun 8am–6:15pm; much shadier in winter (66% vs 25%) |
| 5 | 49%; summer shade 6:30–7:30am (partial all day) |
| 6 | 75%; summer shade 6:30–9:45am and 4:15–7:30pm (**canyon, sunny at midday**) |
| 7 | 23%; summer sun 7:45am–6:15pm |

**On the maps:**
- **Midtown is dominated by type 6:** 70% of street sides and 60% of avenue sides. Physically right, but the type label alone barely discriminates within Midtown.
- **Prospect Park paths are almost entirely type 1**, which is the canopy raster working. Wide plazas come out sunny.
- **Opposite sidewalks of one segment land in different types 36–53% of the time**, so **types are per side, not per segment.**
- **"One side morning shade, the other afternoon shade" is rare: 0–5%.** Don't build copy or features on that pattern.

**Caveat to carry everywhere:** these describe the shade **model**. They inherit its limits: no
sidewalk sheds, canopy only where the raster covers. Present types as **bins with their hours**,
never as "kinds of street".

---

## Phase 1: the pipeline stage (merged, #323/#324)

**Goal.** A deterministic `signatures` stage in `server/navigation-prep` that reads the built shade
cells and writes one small signature artifact per cell, folded into the generation like shades.

**Contract (settled):**
- **Per z14 cell:** `signatures/<cell>.bin`. Rows follow `shades/<cell>.json` `segments`, `[left, right]` per segment, **17 B/side**: 16 int8 components (`z = q × scales[c]`), then the type byte. City-wide: **54.7 MB** of payload over 386 cells.
- **One `signatures/index.json`** (208 KB) carrying the whole frozen model (`daySlots`, `mean`, `components`, `scales`, `centers`, `types` with names and summer shade/sun clock windows, fit provenance) and the per-cell list (`key`, `shadeKey`, `segments`, `payloadKey`, `bytes`, `sha256`).
- **Manifest:** one optional `signatures` ref (`key`, `bytes`, `sha256`, `model`, `cells`, `payloadBytes`) and an optional `budgets.signatureBytes`. Per-cell refs stay out of the manifest: it is at 478 KB of its 512 KB cap. `MAX_SIGNATURE_SHARD_BYTES` = 1.5 MB per cell (densest is 448 KB). Both fields are absent without the stage, so older generations parse and verify unchanged.
- **All of it is hashed into the generation id** through the same label-free digest loop as the shade shards. The verifier, the publish plan (`signatureIndex`/`signaturePayload` objects) and the unclaimed-file guard all cover it.
- **Pipeline:** `npx tsx src/cli.ts signatures` projects every built shade cell into `work/signatures/` (52 s for the city, single process). `build` folds them in, and refuses a cell whose shade sha or model sha changed since projection.

**Decisions phase 1 must make, with the recommended default:**
1. **Freeze the model.** Fit PCA and centroids **once** on a fixed stratified sample with a fixed seed, and commit the fitted parameters (small: ~40 KB as JSON) as a versioned input. **Don't refit per build.** That fixes stability (ARI 0.73) and keeps type ids meaningful across generations. Refit only on a deliberate version bump.
2. **Where the fit runs.** The build must be TypeScript and deterministic, so **projection** (centre → multiply by the frozen components → nearest centroid) happens in TS. The **fit** can stay a documented Python script committed under a new `server/navigation-prep/tools/` directory, or be ported. Recommended: commit the Python fit plus its output JSON, and have TS only project. Document the exact sample, seed and library versions.
3. **K.** Silhouette doesn't pick one. Recommend **K = 8** for readability unless the owner wants finer bins.
4. **Night slots.** Use the frozen `daySlots` list from the model, not a per-build recomputation.

**Tests to write (hermetic, `server/navigation-prep/test/`):**
- **Projection parity:** the TS projection equals the Python reference on a committed tiny fixture, within the int8 quantization step.
- **Determinism:** same inputs give byte-identical outputs and the same generation id (pattern: `buildDeterminism.test.ts`).
- **Shape and budget:** payload bytes = segments × 2 × 17; a budget constant like `MAX_SHADE_SHARD_BYTES`.
- **Row alignment:** a cell's signature rows line up with its shade index's `segments` (pattern: `shade.test.ts`).

**Decisions as taken:** all four defaults. `models/signatures-v1.json` is fitted by the committed
`tools/fit_signatures.py` (phase 0's fit step for step, K = 8, seed 20261008, numpy 2.2.3,
scikit-learn 1.9.0), and TS only projects. One change from phase 0: the fit is pinned to **one
thread**. Phase 0's multithreaded k-means moved centroids ~3e-7 run to run, so its model could not
be reproduced. The single-threaded refit is byte-identical across runs; its centroids sit up to
0.019 from phase 0's, and 0.125% of Midtown sides change type. Names and hours are identical. The
int8 scale per component is the largest |z| any input can reach, so nothing clamps.

**Verification beyond tests (done):** `tools/check_signature_types.py <generation>` labels Midtown
from the **built bytes** with phase 0's orientation logic. It equals the frozen model's own
cross-tab exactly (derived independently in Python from the published shade bytes):
- **Midtown streets:** `[299, 185, 326, 306, 204, 949, 6347, 414]` (phase 0: `[299, 184, 325, 306, 208, 950, 6345, 413]`)
- **Midtown avenues:** `[128, 250, 411, 526, 182, 816, 3808, 211]` (phase 0: `[128, 250, 411, 524, 185, 814, 3809, 211]`)

The TS build and the Python model agree on all 46,224 sides of four Midtown cells. `verify` accepts
the new generation (1,851 objects) and still accepts the published `393d4cd24a30`.

**Not in phase 1:** any client loader, any publish. The one `app/` change is the shared manifest
parser in `shardContract.ts`, because it rejects unknown keys: without it the client would refuse
any generation that carries signatures.

---

## Phase 2: the client read side (merged, #341)

Nothing in the app calls these yet; phase 3 is the first caller.
- **Contract** (`app/lib/navigationData/shardContract.ts`): `NavigationSignatureIndex` / `NavigationSignatureModel` / `NavigationSignatureType`, `SIGNATURE_COMPONENTS`, `SIGNATURE_BYTES_PER_SIDE`, and the strict `parseNavigationSignatureIndex(value, ref, generation)`. The producer's `verify` uses the same parser, so both sides reject the same indexes.
- **Loaders** (`remoteNavigation.ts`):
  - `loadNavigationSignatureIndex(snapshot)` returns `null` for a generation without signatures.
  - `loadNavigationSignatureShard(snapshot, index, cellKey)` fetches a whole cell payload.
  - Both check exact bytes and SHA-256, share in-flight requests, and use `force-cache`, like the shade loaders. There is no decoded cache.
- **View** (`signatureView.ts`): `createSignatureView(index, [{ shard, payload }])`, where `shard` is the cell's shade index (its `segments` are the row order).
  - `typeOf(key, side)` and `type(id)` return a side's frozen type and that type's name and hours.
  - `nearest(key, side, k)` is a brute-force search over the cells passed in, with an early exit.
  - Measured on four real Midtown cells (46,224 sides): 0.64–0.69 ms per query, ~1.4 ms per 100k rows (Node, WSL). Building the view takes ~60 ms.
  - Its type counts equal the Python projection from raw shade bytes exactly.
- **Worker** (`cloudflare/shadow-data-worker/src/index.ts`): `navigationShardKey` admits `signatures/index.json` and `signatures/<cell>.bin`. Deployed 2026-10-11.

## Phase 3: route street-type layer (merged, #343) — to be hidden

A sun walk's sidewalks are coloured beside the route in four **summer**-shade groups. A Settings
legend lists every type with its hours, and the selected route card gives the walked shares.

It earns little:
- **It's coarse.** One type covers 70% of Midtown street sides.
- **It doesn't respond to the time slider.**
- **It's unreadable in shade.** It must sit beneath the shadow layer (invariant #5), so it turns
  navy wherever shadow is painted.
- **It duplicates the "Sun by hour" strip.**

**Hide the Settings toggle in the first Plan A PR** (or move it behind a dev flag as a QA view).
Keep the code: `signatureRoute.ts` and the card line are reused below.

---

## Next: the two plans

**Why these two.** The research is in [`docs/research/ml-direction-shade-signatures-2026-10-12.md`](../research/ml-direction-shade-signatures-2026-10-12.md), which builds on
[`docs/research/ml-prior-art-2026-10-02.md`](../research/ml-prior-art-2026-10-02.md). Its conclusions:

1. **PCA + k-means is already the right model.** The data is exact, smooth physics with no noise
   and no labels, which rules out the things learned embeddings depend on:
   - **Autoencoders and contrastive methods** (TS2Vec, TNC) need augmentations an exact table doesn't have.
   - **Time-series foundation models** (MOMENT, Chronos) normalise each input, which discards the absolute shade level.
     They also lost to hand-crafted features on comparable data.

   Two cheap fixes replace a new model:
   - **Re-rank:** recall@10 = 0.41 is near-ties (distance ratio 1.07). Shortlist ~100 in PCA space, then re-rank by exact distance.
   - **Relabel:** the 8 clusters are bins (silhouette 0.21), not "street types".
2. **The interview story is the evaluation, not the embedding.** Reviewers reward a baseline to
   beat, error analysis, leakage-safe splits and measured with/without comparisons.
3. **The questions users can't already answer are time-window questions**, and the raw table
   answers them exactly with no embedding:
   - "Where can I wait in the shade near X from 2–4pm?"
   - "When is this block shaded in July?"

   Competitors already ship "which side is shaded now" and shady routes: Stay Cool (39 cities incl.
   NYC), inShade, shadewalker.nyc.
4. **Novel ML exists in one place:** using the exact table as **ground truth** to test whether image
   models can see shade in street photos. No study validates image-derived shade against dense,
   exact, time-resolved shade. Global Streetscapes ships 18,420 NYC images (CC BY-SA 4.0) with
   capture times.

**Order:** Plan A first (about 2–3 weeks; a user feature plus the AI-engineering story), then Plan B
(about 3–5 weeks; the applied-ML centrepiece). A learned shade emulator was considered and
**rejected**: NYC already has the exact answer, so it has no user. Keep it only as a fallback if
Plan B stalls on imagery.

**What happens to the old phases 4–6:**

| Old phase | Verdict |
|---|---|
| 4, route explanations | **Folds into Plan A** (step A4): phrases quote table hours with a receipt, never type names. |
| 5, "streets like this one" | **Demoted** to a mode of `find_shade_spots` (step A3). No product or paper offers it, so demand is unproven. |
| 6, city-scale Find the Light | **Becomes Plan A's area mode.** Candidates come from the raw table. SigLIP stops being the judge and becomes Plan B's test subject. |

---

## Plan A — `find_shade_spots`: a shade-window tool the assistant calls, with a real evaluation

### What it is

**What users get.** They ask the assistant (or, later, a panel) for shade in a **time window** or
on **another date**, and get specific sidewalks with their hours:
- "Where can I wait in the shade near Bryant Park between 2 and 4 today?"
- "Shadiest spot to sit near the Met at noon on July 4?"
- "When is the north side of W 42nd St shaded in August?"
- "Find me somewhere **sunny** to sit near Union Square this afternoon in March." Sun-seeking matters:
  in Hiroshima the preferred side of wide streets flipped between summer and fall.

**Why a task-shaped tool, not raw vector search.** Every vendor's guidance says to build tools
around a user task and never hand the model raw vectors (Anthropic "Writing effective tools for
agents"; OpenAI and Gemini function-calling guides). Umbra has its own reason too: the happy path
already uses ~5 of `MAX_STEPS` 8. A raw chain (geocode → signature → kNN → check each → plot) would
exceed the budget, and success compounds downward with every step.

**The ML content, stated honestly.** The ML content is thin: a filter, a sort, and a PCA shortlist
with exact re-ranking. What makes this an ML/AI-engineering artifact is the **evaluation**:
- exact grounding receipts;
- pass^k reliability;
- a tool-selection confusion matrix;
- a with/without-tool ablation;
- a product baseline;
- a borough holdout.

### The tool contract

```ts
find_shade_spots({
  lat: number, lng: number,            // the area centre (from geocode_place or the map)
  from: string, to: string,            // local times, e.g. "2:00 PM", "4:00 PM"
  date?: string,                       // ISO date; default today. Snapped to the representative day.
  radiusM: 200 | 400 | 800,            // enum: the model must not invent radii
  mode: "shade" | "sun",
  street?: string,                     // "when is <street> shaded": both sides of one street
  likeCandidateId?: string,            // "shade like this one": a previous result to match
})
```

**Returns** at most **4** results, ranked. Each one has:
- `candidateId`, accepted by `plot_points` and `plan_shadowed_route`;
- `label`, for example "W 42nd St, north side, between 5th and 6th Ave";
- `meanShade` over the window, 0–1;
- `hours`, as `[{ time: "2:00 PM", shade: 0.92 }, …]` in 15-minute slots, collapsed to the hour if the window is longer than 2 hours;
- `basis`, for example "typical day, July 15 (the table's representative day for July)";
- `lat`/`lng`.

Plus a top-level `note` for degraded answers: out of NYC, no data loaded, or night.

**Rules the description must state** (overlap with `check_shadow` is the real selection risk, not the tool count):
- "Use `check_shadow` for *right now* at spots already on the map. Use `find_shade_spots` for a **time window**, a **future or past date**, or 'when is X shaded'."
- "Never state a shade value or time that this tool did not return."

### Implementation notes (reuse, don't rebuild)

- **Cells:** `selectNavigationShards(manifest, zoneAround(lng, lat, radiusM))` in
  `app/lib/navigationData/remoteNavigation.ts`.
- **Shade bytes:**
  - `loadNavigationShadeShard` plus `loadShadeSlotBlocks`, for only the window's slots: one month, ≤ 64 slots.
  - `shadeSlotIndex`, `shadeMonthIndex` and `shadeSlotForLocalMinutes` in `shadeSlots.ts`.
  - Read the clock in `SHADE_ZONE`, as `useRouting` does.
- **Candidates:** sidewalk sides whose segment midpoint is within `radiusM`.
  - Segment geometry comes from the street shards, which `routingGraphSource` already loads.
  - Drop sides shorter than ~15 m (they're crossings).
- **Labels:** street name from the edge tags. The side ("north side") comes from the canonical side
  and the segment bearing, through the same frame logic as `swapSideAgainstCanonical` in `routing.ts`.
- **Ranking:**
  - Shade mode: by `meanShade`.
  - Sun mode: by `1 − meanShade`, excluding night.
  - Break ties by distance.
  - Then de-duplicate so that no two results come from the same block face.
- **`likeCandidateId` mode:**
  1. Shortlist 100 by PCA distance (`signatureView.nearest`).
  2. Re-rank by **exact** L2 distance on the daylight slots from the raw table.
  3. Return the reference side's `hours` beside each match, so similarity is *shown*, not asserted.
- **Where it runs:** client-side in the agent's tool executor (`app/lib/agent/tools.ts`), like
  `check_shadow`. No server.

### Grounding (slots into what exists)

`verifyAnswer()` in `app/lib/agent/receipts.ts` already rejects a shadow claim unless the fraction
equals the tool's observation. Plan A adds three things:
1. **A `shade_window` claim kind.** It references `{candidateId, from, to}` and carries `meanShade` and hour values, each checked against the tool result.
   - Rounding to the displayed precision is allowed.
   - **State the tolerance rule in code.** Numeric graders fail on rounding: Anthropic's CORE-Bench score went from 42% to 95% once grader bugs were fixed.
2. **A regex sweep over free `text` blocks** that rejects any percentage, clock time or shade number not inside a verified claim. The answer schema already forbids them there; this enforces it.
3. **An explicit `unknown` block** when the tool returns a degraded `note`. Out-of-NYC questions must say "no shade data here", not guess.

### Steps (one PR each)

| Step | What | Acceptance |
|---|---|---|
| **A1** | Pure core: `shadeSpots(view, query)` in `app/lib/navigationData/shadeSpots.ts`, plus its hermetic tests. Hide the street-type Settings toggle (§ Phase 3). | Hour values equal the table bytes exactly; results sorted; window clipped at sunset; sun mode excludes night; ≤ 4 results with no duplicate block face; side labels correct on an E–W and an N–S fixture (the frame bug class from #343). |
| **A2** | The tool: schema and executor in `tools.ts`, the `shade_window` claim kind and free-text sweep in `receipts.ts`, and the `unknown` degradation. | Unit tests: the executor returns the contract; `verifyAnswer` accepts exact claims, rejects off-by-one values, and rejects a stray "73%" in free text. |
| **A3** | `likeCandidateId` mode: PCA shortlist plus exact re-rank. | **Recall@10 of shortlist+re-rank against brute-force exact search** on ≥ 1,000 query sides from spatially spread cells. Target ≥ 0.95, which replaces phase 0's 0.41. Report the shortlist size vs recall curve. |
| **A4** | The evaluation (below), plus route explanations: a `plan_shadowed_route` answer may cite "shaded until 9:45am" only through a `shade_window` receipt. | The eval report is checked in at `docs/notes/shade-spots-eval-<date>.md` with every number below. |

### Evaluation (A4) — the interview artifact

1. **Hermetic tool tests** (A1–A3). These are deterministic and run in `npm test`.
2. **10–15 new `eval:agent` scenarios** in `app/lib/agent/__tests__/scenarios/` (the format is in `grounding.ts`):
   - shade window today; another date; sun mode; "when is <street> shaded"; "like this one";
   - **3–4 should-not-call cases**: "is it shaded right now" (that's `check_shadow`); a Boston address (must degrade to `unknown`); a pure geocoding question;
   - one or two multi-tool flows, e.g. find a spot, then plan a shaded route to it.
3. **pass^k at k = 3.** Run every scenario three times and report the share that pass **all** runs.
   On τ-bench, GPT-4o fell from 61% at pass^1 to ~25% at pass^8. Report pass^1 and pass^3 side by side.
4. **A tool-selection confusion matrix** (expected tool vs called tool), plus invalid-parameter and incorrect-value rates.
5. **An ablation.** Run the same scenarios with `find_shade_spots` removed, so the agent must fall back
   to `search_places` + `check_shadow`. Report the change in task success, steps, latency and grounding
   failures. If removing the tool costs nothing, the tool shouldn't exist (Huyen).
6. **A product baseline.** Over 200 random (origin, window) queries, compare "nearest sidewalk side"
   with "`find_shade_spots` top result": shade gained per extra metre walked.
7. **A borough holdout.** Tune the tool description on Manhattan scenarios only, and report the other
   boroughs separately, so the description isn't overfitted to Midtown.
8. **A temperature A/B, as a side result.** Google's Gemini 3 guide now strongly recommends temperature 1.0 and
   warns that lower values may loop. Umbra runs at 0. Compare pass^3 at 0 and at 1.0 on the same
   scenarios, and change the default only if 1.0 is no worse.

**Interview framing:** "I built a task-shaped tool over an exact physics table. Every number the
assistant says is verified in code against the tool's output. I measured what the tool adds with an
ablation and reliability with pass^k, and found the embedding needed exact re-ranking to be usable
(recall 0.41 → ≥ 0.95)."

---

## Plan B — Can image models see shade? The exact table as ground truth

### What it is

**The question.** Researchers score streets as "shady" or "pleasant" from photos, using
segmentation-based sky view and greenery indices or CLIP/VLM prompts (UrbanCLIP, WalkCLIP, SAGAI).
These scores have only ever been checked at point weather stations or field sites. Umbra has
something none of those studies had: **exact, dense, time-resolved shade for every NYC sidewalk
side**. Plan B uses it as ground truth to measure, with proper baselines and leakage-safe splits,
whether image models see shade, and what they add beyond cheap geometry.

**Why it's good.**
- **It's novel.** No study was found validating image-derived shade against dense exact shade.
- **It's a complete applied-ML project:** a self-built dataset, a model ladder from a physics baseline
  up, spatial cross-validation and error analysis.
- **The check runs both ways.** Where the photo and the table disagree, the table may be wrong, for
  example trees missing from the canopy raster. The error analysis can find bugs in Umbra's own data.

**What users get, honestly: nothing directly, at first.** It's a study. The product hook comes only
if the probe works (B5): an image score then becomes an optional re-rank inside `find_shade_spots`
("leafy", "quiet"), evaluated as "did re-ranking cost any shade?".

### Data

- **Images:** [Global Streetscapes](https://huggingface.co/datasets/NUS-UAL/global-streetscapes),
  **18,420 New York images**, CC BY-SA 4.0, built on Mapillary.
  - Each image carries a local capture datetime, lighting and glare labels, and camera position and heading.
  - **No scraping:** use the published dataset.
- **Licensing:**
  - **Google Street View is out.** Its terms forbid caching it and using it to train or evaluate models.
  - **Mapillary's own terms** forbid unapproved data mining and reportedly restrict "real-time navigation" use; that clause's exact wording was not confirmed.
  - **Keep the study offline.** No image-derived score drives live routing until the owner has read the terms in full.
- **Matching:** project each image to the nearest sidewalk side within ~15 m.
  - Use the camera position and heading.
  - Skip images facing along the street with no visible kerb on the matched side.
  - Record the match distance and drop the worst decile.

### Labels (in order of value)

1. **Instantaneous: was this sidewalk side in shade at the photo's capture time?**
   - Take the table value at the capture month and 15-minute slot.
   - Threshold it at 0.5 for a binary label, and keep the continuous value too.
   - **This is the novel label.** Cast shadows are visible in the pixels, so it can be checked by eye
     on a sample, and disagreements are inspectable.
2. **Summer-midday shade fraction:** June–August, 11:00–15:00.
3. **Annual shade fraction.**
4. **Signature archetype**, from the frozen 8 types.

**Filter:** drop night images, heavily overcast images (the dataset's lighting label), and leaf-off
images for canopy-dominated labels. Report how many survive each filter.

### Model ladder (cheapest first; each must beat the one above)

1. **Analytic canyon baseline:** the infinite-canyon shade fraction from height-to-width ratio, bearing,
   side, latitude and sun position. No image.
2. **Segmentation indices:** sky-view factor (SVF) and green-view index (GVI) from a semantic
   segmentation model, then a one-feature regression. This is the literature standard.
3. **Zero-shot SigLIP/CLIP:** a prompt score such as "a sidewalk in shade" vs "a sunlit sidewalk",
   with no training.
4. **Linear probe on frozen SigLIP or DINOv2 embeddings.**
5. **Gradient-boosted trees on geometry plus image features.**

**The question that matters:** does the image add anything beyond cheap geometry (rung 5 vs rung 1)?

### Evaluation (where the result is believed or not)

- **Metrics:**
  - AUROC for the instantaneous label;
  - Spearman ρ for zero-shot scores, which are uncalibrated;
  - R² for probes on the continuous labels;
  - nDCG@10 for within-neighbourhood ranking;
  - AUROC for top-vs-bottom shade quartile.
- **Splits:**
  - **Spatially blocked folds of ≥ 500 m.** This size is an inference from winter tower-shadow length, not a sourced figure.
  - Both sides of a segment, and every image from one capture sequence, go in the **same fold**.
  - **Leave-one-borough-out** as a second, harder test.
  - **Report random CV next to blocked CV.** The gap is itself a finding. Ploton et al. (Nature
    Communications 2020) showed an apparent R² > 0.5 collapse to near zero under spatial CV.
  - kNNDM is the principled fold design. Add one sentence noting that Global Streetscapes is not a
    probability sample (Wadoux et al. 2021).
- **Error analysis (required):**
  - Pick the 50 worst disagreements by hand.
  - Classify each as image wrong, match wrong, or **table wrong**, e.g. a missing tree, a scaffold or a new building.
  - File table bugs as issues.
- **Known biases to report:** volunteer imagery clusters on local roads, a few heavy contributors and
  certain times of day; leaf-off season under-states canopy.

### Steps (one PR each; code lives in a new `research/shade-vision/`, Python, outside the app bundle)

| Step | What | Acceptance |
|---|---|---|
| **B1** | Dataset build: download the NYC subset, match images to sidewalk sides, attach labels 1–4 from the published table, apply the filters. | A versioned parquet with a datasheet: counts per filter step, match-distance histogram, per-borough and per-hour coverage. A 50-image hand check of the instantaneous label, reporting its agreement rate. |
| **B2** | Baselines (rungs 1–2) plus the CV harness (random, ≥ 500 m blocked, leave-one-borough-out). | Metrics table; the random-vs-blocked gap reported. |
| **B3** | Zero-shot SigLIP/CLIP (rung 3) plus prompt ablation (3–5 prompts). | Spearman ρ and AUROC with bootstrap CIs; prompt sensitivity reported. |
| **B4** | Linear probe and GBT (rungs 4–5), plus error analysis. | Full ladder table under blocked CV; the 50-case error analysis written up; any table bugs filed as issues. |
| **B5** | *(Only if B4 shows image > geometry under blocked CV.)* Optional image re-rank inside `find_shade_spots`. | An `eval:agent` comparison: re-ranking costs ≤ 2 percentage points of mean shade, and its sensitivity to the "leafy" and "quiet" prompts is reported. |

**Write-up:** `docs/notes/shade-vision-study-<date>.md`, structured as a short paper: question, data,
labels, ladder, splits, results, errors, limits. The negative result ("image models can't see
instantaneous shade beyond geometry") is publishable and worth stating plainly.

**Interview framing:** "I found that nobody had validated image-derived shade against real ground
truth, so I built that ground truth from exact physics. I evaluated a model ladder from a physics
baseline to SigLIP probes under spatially blocked CV, showed how much random CV inflated the result,
and the error analysis found bugs in my own canopy data."

---

## What is deliberately *not* planned

- **A new embedding model** (autoencoder, contrastive, time-series foundation model). The data doesn't justify it; see the research report.
- **Learning-to-rank or GNNs:** every ranking Umbra does is exact arithmetic over the table, and shade is local geometry, not graph topology. A learned *preference* model needs choice data Umbra doesn't have; see `docs/research/ml-prior-art-2026-10-02.md` for the Bayesian preference option, if accounts ever exist.
- **A learned shade emulator.** It would have no user while the exact table exists, so it's a fallback only if Plan B stalls.
- **Approximate nearest-neighbour search (HNSW, FAISS) in the browser.** Brute force over the loaded cells is ~0.65 ms. HNSW at city scale would be ~1 GB.

---

## Practical notes (things that cost this session time)
- **Repo lineage:** work on `marcopolocheung/umbra`; branch from `umbra/main` in a worktree:
  `git -C ~/ShadeMapNavigation worktree add -b <branch> ~/umbra-<name> umbra/main`.
  - Local `main` is a stale lineage.
  - `gh` defaults to another repo, so always pass `-R marcopolocheung/umbra`.
- **Worktree setup:**
  - Symlink `node_modules` from `~/umbra-ml6/node_modules` if `package-lock.json` matches (`cmp`).
  - Symlink `server/*/node_modules` from an existing worktree (e.g. `~/umbra-ladder/server/*/node_modules`), or root `tsc` fails on `@aws-sdk/client-s3` / `@duckdb/node-api`.
- **Gates** (GitHub Actions is disabled on umbra; only Vercel checks run):
  `PATH=~/.local/node24/bin:$PATH npx biome lint --max-diagnostics=none .` (check the **exit code**; plain `npm run lint` truncates), then `npm run typecheck`, `npm test`, `npm run build`. Also `npm --prefix server/navigation-prep test` for the pipeline.
  - **Never leave a copied `.env` in the worktree when running tests:** it breaks `useNavigation.test.tsx`.
- **Browser checks:** dev servers wrapped in `npx` survive `kill $!` and keep the port, so a "branch" run can silently hit the previous server.
  - Kill by matching `node … vite … --port N`.
  - Before measuring, `curl` the served module for a marker unique to your branch.
  - SwiftShader can't show GPU cost; ask the owner for a Chrome Performance trace for anything frame-rate related.
- **PR style:** the description is at most four sentences (finding, change, measured result, what's unverified). Labels `track-a`, `perf` or `enhancement`, priority `p2`/`p3`. **Never merge**; the owner merges.
- **Findings you don't fix become issues**, not just notes.

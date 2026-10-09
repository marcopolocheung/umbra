# Handoff — Shade signatures (per-sidewalk shade "fingerprints" and street types)

> Compress every NYC sidewalk side's year of shade, already in the published shade table, into
> a short vector (a **signature**) and a coarse **type**. Ship both as a static per-cell artifact
> next to the shade table. The app then gets "streets like this one", a street-type map layer,
> plain-language route explanations ("shaded until 9:45am, sunny midday, shaded after 4:15pm"),
> and Find the Light at city scale instead of 20–50 hand-curated spots.

**Verified 2026-10-08**, `umbra/main` at `b25d700`. If this handoff disagrees with the code, the
code wins. Update this file in the same PR that changes a stated contract.

**Status:** phase 0 (go/no-go analysis) is **done: qualified GO**, issue **#321**. Phase 1 (the
pipeline stage) has not started. Take one phase per PR; the first session does **Phase 1** and stops.

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

## Phase 1: the pipeline stage (next session: do this, then stop)

**Goal.** A deterministic `signatures` stage in `server/navigation-prep` that reads the built shade
cells and writes one small signature artifact per cell, folded into the generation like shades.

**Contract (proposal; settle it in the PR):**
- **Per z14 cell:** `signatures/<cell>.bin` plus an entry in the manifest (or a field on the existing shade ref; keep the manifest small).
- **Row order:** the shade index's segment order, `[left, right]` per segment. Payload is `segments × 2 × (16 × int8 + 1 × uint8 type)`, 17 B/side, about 55 MB city-wide. Quantize each component to int8 with a per-component scale stored once.
- **A small generation-level JSON** carrying `mean` (per daylight slot), `components` (16 × D), the int8 scales, `centers` (K × 16), `daySlots`, per-type names and hour summaries, and the model version.
- **All of it hashed into the generation id**, like the shade shards (`canonical.ts` `sha256Hex`, `jsonBytes`).

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

**Verification beyond tests:** rerun `~/umbra-phase0/maps.py`-style labelling from the **built
artifact** (not the Python model) on Midtown and Park Slope. The type shares must match phase 0's
cross-tab (`~/umbra-phase0/orientation.json`):
- **Midtown streets:** `[299, 184, 325, 306, 208, 950, 6345, 413]`
- **Midtown avenues:** `[128, 250, 411, 524, 185, 814, 3809, 211]`

These differ only if the frozen fit changes.

**Not in phase 1:** any `app/` change, any publish. Build locally, verify, open the PR, stop.

---

## Later phases (sketch; one PR each, after the owner reviews phase 1)
- **Phase 2, client loader.** `loadNavigationSignatureShard` next to `loadNavigationShadeShard` in `app/lib/navigationData/remoteNavigation.ts`, with the same hash and bounds checks and the same disk-cache behaviour. Add a pure `nearestSignatures(view, key, k)` (brute force, < 3 ms / 100k rows; run in the routing worker if it ever shows on the main thread).
- **Phase 3, street-type map layer** in `app/components/MapView.tsx`. That file is contested (see `.claude/rules/components-and-map.md`), so do it in the main session, not a builder.
  - Colour the existing street lines by type with one expression; it's not new geometry.
  - Show it at zoom ≥ 15, off by default, legend from the frozen names.
  - It never changes with the time slider, so it costs ~0 frames per tick.
  - Check it on a real GPU; SwiftShader in WSL hides GPU cost.
- **Phase 4, route explanations** (Track C claim-grounding, C5). Every phrase must trace to table values; quote hours, not type names.
- **Phase 5, assistant tool** "streets like this one" in `app/lib/agent/tools.ts` (current tools: `locate_user`, `geocode_place`, `search_places`, `check_shadow`, `set_time`, `plot_points`, `plan_shadowed_route`). Add eval scenarios via `npm run eval:agent`.
- **Phase 6, Find the Light at city scale** (`docs/ROADMAP.md`, Find the Light; feature 5 of the 2026-09-08 feature-recommendations PDF). Signatures generate candidates; the planned SigLIP image-text retrieval judges vibe on the shortlist.

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

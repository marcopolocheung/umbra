# Shade accuracy — Umbra vs NYC LiDAR (S1)

**Measured 2026-10-02; corrected the same day** (see "Corrections" at the end: the first
version's canopy numbers were a harness artefact). This is the shade-reality audit. It asks how often Umbra's shade is
right, and where it is wrong, against the best geometric truth NYC publishes, without
fieldwork. S0 found that none of shadewalker.nyc, openrouteservice's Shaded Edition or Google
publishes an error figure (`docs/notes/competitors.md`), so this appears to be the first one.

**This is geometry against geometry.** Both sides are models of where a shadow falls. The
truth side is built from NYC's 2017 LiDAR point cloud: the richest published geometry of the
city's surface, but a May 2017 snapshot at roughly 50% leaf-off, with its own classification
noise and no buildings newer than 2017. So the audit measures how far Umbra's data disagrees
with the LiDAR. It does not measure physical truth (whether a person on a sidewalk was in the
sun). That needs A10's field calibration set; this audit is its geometric baseline.

## Headline numbers

Pooled over 8 blocks in 4 boroughs (Manhattan, Brooklyn, Queens, Bronx) × 3 dates (June
solstice, March equinox, December solstice 2026) × 5 local hours (08–16): 120 block-hours,
69,120 sidewalk-side samples.

| Metric | Mean | p50 | p90 | Worst |
|---|---|---|---|---|
| Rendered-mask IoU, buildings-only vs LiDAR (per block-hour) | **0.561** | 0.512 | 0.983 | 0.090 |
| Per-segment shade-fraction error, full field with canopy (pp) | **34.7** | 25 | 100 | 100 |
| Per-segment error, buildings-only field vs trees-removed truth (pp) | **35.1** | 25 | 100 | 100 |
| Per-segment error on tree-shaded segments, buildings-only field (pp) | **41.7** | 25 | 100 | 100 |
| Same tree-shaded segments, full field with canopy (pp) | **33.5** | 25 | 95.7 | 100 |
| Canopy delta: field with the CHMv2 raster minus without (pp) | **+9.5** | 0 | +30 | +90 |

Per-segment error is |Umbra − truth| on one sidewalk side of one edge. The distribution is
coarse because short edges carry only 4–5 sample points, so error comes in 20–25 pp steps.
That is why p90 sits at 100: **13% of segment-sides (9,030 of 69,120) are entirely wrong**,
with the model calling the side fully sunlit where the LiDAR calls it fully shaded, or the
reverse.

**What the numbers say:**

- **The rendered mask matches the LiDAR's shade on just over half the walkable ground** (mean
  IoU 0.561). It is nearly exact at low sun (IoU 0.838 below 20°, where long building shadows
  dominate) and poor at high sun (0.346 at or above 40°, where the ground is left to tree
  shade the mask cannot draw).
- **Most of the disagreement is shade Umbra misses, not shade it invents.** Over the whole
  grid the mask misses 534,191 shadowed cells and adds 165,989 the LiDAR does not see, about
  3.2 misses per false alarm.
- **The misses split three ways, roughly evenly** (by the caster nearest the ray's blocking
  point, see Method): **tree canopy 38%, building 35%, neither 27%.** "Neither" means no
  building or canopy pixel within 3 m. These are casters no footprint or canopy layer
  holds: elevated roadway, sheds, poles, and residual misregistration.
- **The CHMv2 canopy raster (A8, read from `main`) adds +9.5 pp of shade per segment-side on
  average, and +22.3 pp at the June solstice. It does so in every borough:** Queens +12.5,
  Bronx +11.2, Manhattan +8.2, Brooklyn +7.9. On the segments that carry tree shade it cuts
  the error from 41.7 to 33.5 pp, so it recovers about a fifth of what the buildings-only model
  misses there. The first version of this note reported +3.7 pp, Manhattan-only; that was a
  harness bug (Corrections), and the shipping app very likely has the same bug (#220).
- **With the trees taken out, the buildings-only model is off by 35.1 pp per segment.**
  This audit cannot say how much of that is wrong building geometry (heights, footprints,
  alignment, casters no footprint holds) and how much is the 2017 truth being out of date. The
  test it could run was dropping buildings dated after 2017, and that test does not settle it
  (next section). The residual is smallest at low sun (21.6 pp), where long shadows are robust
  to a few metres of height error.

## What is staleness, what is error

The truth and the model describe different years:

- **Truth geometry:** LiDAR flown May 3–17, 2017.
- **Truth labels:** 2021 land cover.
- **Umbra's buildings:** 2026-09-13 footprints.
- **Umbra's canopy:** CHMv2 imagery dated **2020-03-11** at six of the eight block centres and
  **2019-11-04** at Harlem and Concourse. Read from the CHMv2 metadata footprints for quadkeys
  0320101101 and 0320101103; latest date wins where footprints overlap.

No public post-2017 point cloud of NYC exists to remove the gap. The audit measured the three
parts of it that it can.

**New buildings: a small share, and the proxy is noisy.**

- **What was run:** every comparison again with set (b), the 2017-era building set. It drops
  the 358 footprints whose `CONSTRUCTION_YEAR` (live `BUILDING_view` layer, joined on DOITT ID,
  100% of shard buildings matched) is after 2017. One Vanderbilt is among them: 427 m in
  Umbra, 1.6 m median in the LiDAR.
- **What set (b) changes:**
  - It removes 16,231 of the 165,989 cells of false shade, about 10%. Most of the removed cells
    are in Concourse (11,200).
  - Segment error does not fall: it rises from 34.7 to 35.1 pp. The buildings-only residual
    goes from 35.1 to 35.4 pp, and mask IoU from 0.561 to 0.557.
  - **The 2017 snapshot accounts for none of the 35.1 pp residual that this test can detect.**
- **Why the proxy is weak:** of the 169 excluded footprints the LiDAR fully covers, 53 were
  already standing in May 2017 at half their Umbra height or more, and 59 were absent (under
  3 m). Towers dated 2018 were mostly topped out before the flight. A replacement building
  dropped from (b) also takes away the only footprint for the older building the LiDAR saw.
- **What it still cannot see:** demolitions. Truth buildings demolished since 2017 have no
  counterpart in Umbra.
  - **Rough bound:** of the 77,330 m² of LiDAR cells that stand over 20 m on building land
    cover across the eight blocks, 12,155 m² (16%) lie under no Umbra footprint.
  - **What that bound includes:** demolitions, facade misregistration, and parts the shards
    lack. It does not separate them.

**Canopy change 2017→2021: a large share of segments, and not where the error comes from.**

- **The data:** the TNC/UVM change raster (same Zenodo record, CC BY-NC-SA 4.0) marks every
  0.5 ft of gain and loss.
- **How it was applied:** a sidewalk side is flagged when any of its truth rays crosses a
  gain or loss cell while still under 35 m. That is above every CHMv2 canopy top in these
  blocks.
- **Size:** 30,552 of 69,120 sides (44%) are flagged.
- **Result:** dropping them does not reduce the error. Tree-shaded segments go from 41.7 to
  43.1 pp buildings-only, and from 33.5 to 34.9 pp with canopy. The canopy delta goes from
  +9.5 to +8.5 pp.
- **Conclusion:** the tree error is not concentrated where the canopy changed.

**Season: the June figures are not a leaf-state artefact.**

- **The question:** the truth was flown in May at roughly 50% leaf-off, and the first version's
  June numbers compared it against a leaf-on model.
- **The test:** a May 10 grid, the flight date, at the same five hours.
- **What the comparison isolates:** Umbra's canopy model treats April through October as
  leaf-on (`LEAF_ON_MONTHS_NORTH`), so May and June get the same crown opacity. The truth's
  leaf state is the flight's in both. The comparison therefore isolates sun position.
- **Result:** May and June agree within 0.7 pp on the tree-shaded segments: 56.0
  vs 56.2 pp buildings-only, 37.8 vs 38.1 pp with canopy, +21.6 vs +22.3 pp canopy delta.
- **What it does not test:** whether a leaf-off truth undercounts summer tree shade. That
  would show up as model shade the truth lacks, which A10's field set can measure and this
  audit cannot.
- **Excluded from the headline:** the May instants appear only in this comparison, not in any
  other figure in this note.

## Method

**Umbra's answer, read two ways over the geometry routing uses:**

1. **Per sidewalk edge (what routing reads):** the app's own `ShadowField`
   (`createGeometryShadowField`, bundled from `app/` with the repo's esbuild), with:
   - a static prism provider over the NYC navigation building shards, generation
     `nyc-2026-09-18-9f2924750af1` (the exact generation the deployed `current.json` points
     at, SHA-256 verified per shard);
   - the CHMv2 raster canopy provider, read through the app's own `canopyTileStore` from
     source.coop.

   Edges come from the same generation's street shards and are sampled at the field's own
   ±4 m sidewalk offsets and step count. A buildings-only twin drops the canopy provider; the
   difference between the two is the canopy delta.

   **The raster is masked once.** Footprint subtraction runs with only the prisms the canopy
   patch fully contains. The field then receives a raster whose `masked()` is the identity,
   so its own re-mask with every caster prism is a no-op. Every prism still casts building
   shadow. Without this, a footprint lying wholly west of the patch's top row zeroes the
   raster (#220).
2. **Rendered mask:** the app's own `buildShadowIndexFor` over the same shard prisms, which
   are the triangles the WebGL renderer rasterizes, sampled at 1 m over each block's central
   250 × 250 m. Buildings only, which is what the renderer paints.

**Truth.**

- **Source:** the 2017 1-ft classified topobathymetric LiDAR LAZ tiles (NYC OTI, served from
  `finder.nyc.gov`), selected per block through the city's own tile-grid FeatureServer.
- **Surfaces:** per block, at 1 m cells over ±675 m (wide enough for the 400 m march from
  every receiver), two grids are built locally:
  - a **highest-hit surface** (the maximum Z of every non-noise return in the cell;
    LAS class 7 dropped);
  - a **bare-earth surface** (mean of the class-2 ground returns, with nearest-ground fill).

  The city's published bare-earth DEM is not used: it strips buildings and trees, so it casts
  no shadow.
- **The march:** a receiver at bare earth + 1.0 m, walked cell by cell (a grid DDA) toward
  the sun, up to 400 m. 400 m is the same cap as the app's canopy march and query padding.
- **Receivers:** cells more than 2 m above bare earth (roofs, crowns) are excluded from the
  mask comparison; nobody walks there.

**Attribution (the building-vs-canopy split).** The cell that stops a truth ray is labelled
from the **2021 6-in TNC/UVM land cover** (Zenodo 14053441). It takes the dominant class among
building (5) and tree canopy (1) pixels within 3 m, and "neither" if no such pixel is near.

The radius matters. The 2017 LiDAR and the 2021 land cover disagree by a metre or two at every
facade. A first pass that read only the blocking cell's own pixel put about 74% of misses in
"neither", and 70–82% of those blockers sat within 3 m of a building pixel. That pass is
superseded, and the issue it produced (#218) carries the correction.

**Building-only truth** is the same march with the trees removed: a ray that meets a canopy
cell marches on to whatever stands behind it. Dropping every point whose first blocker is a
tree would undercount building shade at low sun, where long rays almost always pass a street
tree before the tower behind it.

**Grid:**

- **Dates and hours:** June 21, March 20 and December 21, 2026, at 08, 10, 12, 14 and 16 local
  time (America/New_York).
- **Sun positions:** from the same suncalc 1.9.0 the app pins.
- **May 10:** a fourth date, the LiDAR flight date, at the same hours. It feeds only the season
  comparison above.

**Blocks:** 8 blocks of 250 m, centred on street corners and chosen to echo S0's observed pairs:

- **Manhattan:** Midtown, Village, Harlem
- **Brooklyn:** Williamsburg, Greenpoint
- **Queens:** Astoria, Jackson Heights
- **Bronx:** Concourse

**Reproduce.** Every download is cached under the gitignored `studies/shade-audit/cache/`,
about 2.5 GB, so re-runs re-hit no public host:

```sh
node studies/shade-audit/10-download.mjs       # LAZ, land cover + canopy change, nav shards, construction years, CHMv2 dates
node studies/shade-audit/20-lidar-surface.mjs  # truth surfaces
node studies/shade-audit/30-eval.mjs           # the audit, both building sets, 4 dates
node studies/shade-audit/40-report.mjs         # distributions → cache/results/_summary.json
node studies/shade-audit/50-check-note.mjs     # every number in this note against _summary.json
node --test studies/shade-audit/30-eval.test.mjs  # 9 tests: truth march, change flag, single mask
```

**Requirements:**

- python3 with `laspy[lazrs]`, `rasterio` and `scipy`.
- The local navigation generation under `~/shade-prep-data-nyc-navigation/normalized/`
  (override with `NAVIGATION_LOCAL_ROOT`), produced by `server/navigation-prep`.
- `npm ci` in the repo root, for the esbuild bundle of the app modules.

The repo's four CI gates do not see `studies/`, so the `node --test` line is the study's only
check. Zenodo throttles burst range reads with HTTP 429; stage 1 retries with backoff.

## Distributions

All rows are means. IoU is the rendered mask; error columns are percentage points per
segment-side.

**By season**

| | June solstice | March equinox | December solstice |
|---|---|---|---|
| IoU | 0.414 | 0.524 | 0.744 |
| error, full field | 35.2 | 41.0 | 28.1 |
| error, buildings-only vs trees-removed truth | 33.0 | 41.2 | 31.1 |
| error on tree-shaded segments, buildings-only | 56.2 | 46.0 | 27.5 |
| canopy delta from CHMv2 | +22.3 | +5.4 | +3.7 |

**By solar elevation**

| | IoU | full field | buildings-only | tree-shaded segments | canopy delta |
|---|---|---|---|---|---|
| low (<20°) | 0.838 | 17.7 | 21.6 | 17.2 | +2.4 |
| mid (20–40°) | 0.597 | 39.7 | 43.0 | 45.4 | +8.2 |
| high (≥40°) | 0.346 | 41.9 | 37.5 | 61.4 | +17.7 |

**By hour (local)**

| | 08 | 10 | 12 | 14 | 16 |
|---|---|---|---|---|---|
| IoU | 0.840 | 0.543 | 0.396 | 0.378 | 0.648 |
| error, full field | 15.2 | 40.6 | 43.3 | 45.2 | 29.4 |

**By borough**

| | IoU | full field | buildings-only | canopy delta |
|---|---|---|---|---|
| Manhattan | 0.616 | 32.4 | 33.3 | +8.2 |
| Queens | 0.584 | 34.5 | 32.0 | +12.5 |
| Brooklyn | 0.513 | 38.7 | 38.8 | +7.9 |
| Bronx | 0.444 | 38.2 | 40.8 | +11.2 |

**By block.** "Miss shares" split the cells the mask missed by caster. "False/miss" is cells
the mask adds that the LiDAR does not see, per missed cell. "Post-2017" is footprints with a
later `CONSTRUCTION_YEAR`, dropped in set (b).

| Block | Worst IoU | Mean error (pp) | Miss shares: canopy / building / neither | False/miss | Post-2017 |
|---|---|---|---|---|---|
| Williamsburg | 0.090 | 40.8 | 0.27 / 0.49 / 0.24 | 0.22 | 113 |
| Greenpoint | 0.142 | 35.0 | 0.38 / 0.35 / 0.27 | 0.25 | 81 |
| Harlem | 0.144 | 38.1 | 0.34 / 0.35 / 0.31 | 0.36 | 38 |
| Village | 0.172 | 34.2 | 0.38 / 0.34 / 0.27 | 0.28 | 26 |
| Astoria | 0.172 | 34.9 | 0.44 / 0.34 / 0.22 | 0.19 | 46 |
| Concourse | 0.188 | 38.2 | 0.43 / 0.15 / 0.42 | 0.47 | 17 |
| Jackson Heights | 0.281 | 34.3 | 0.63 / 0.26 / 0.11 | 0.09 | 10 |
| Midtown | 0.328 | 21.7 | 0.16 / 0.59 / 0.25 | 0.87 | 27 |

## The worst blocks, and why

1. **Williamsburg (IoU 0.090 at June noon), the worst block-hour.**
   - **Scale of the miss:** of the 5,698 cells the LiDAR shades, the mask catches 641 and
     misses 5,057 (89%). It also adds 1,408 cells the LiDAR does not see.
   - **Mostly building shade:** about half the misses are building-attributed (2,356), the
     largest building share of any block outside Midtown. The rest is trees (1,705) and
     casters near neither class (996).
   - **New buildings don't explain it:** Williamsburg has the most post-2017 footprints of any
     block (113, none over 100 m), and dropping them leaves its error at 40.8 pp and its mean
     IoU at 0.476 against 0.469.
   - **Cause not resolved here.** Shard heights or footprint parts that cast less than the
     LiDAR's roofs would fit the misses, but no per-building height check was run.
2. **Greenpoint, Harlem, Village and Astoria (IoU 0.14–0.17).** Street trees at summer noon
   account for roughly a third to two-fifths of each block's misses, with building misses of
   similar size. CHMv2 adds shade in all four (+4.8 to +18.5 pp canopy delta). Greenpoint's is
   the smallest.
3. **Concourse (IoU 0.188).** It has the largest "neither" share (0.42) and the highest
   false-to-miss ratio outside Midtown. It is also the one block where set (b) matters:
   - **False shade:** dropping its 17 post-2017 footprints removes 11,200 of its 34,822
     false-shade cells.
   - **Segment error:** it rises from 38.2 to 40.0 pp, so those buildings also cast shade the
     2017 truth sees.

   The rest of the block was not investigated.
4. **Midtown (worst IoU 0.328, the best of the eight).** Tall buildings dominate and trees are
   few. It has the most post-2017 towers: 12 of its 27 excluded footprints are over 100 m.
   - **Some false shade is staleness, confirmed.** Its false-to-miss ratio (0.87) is far the
     highest. Shard building 1284912 at (−73.97855, 40.75297) is One Vanderbilt
     (`CONSTRUCTION_YEAR` 2021): 427 m in Umbra and 1.6 m median in the LiDAR, which saw a
     construction site.
   - **Not all of it.** Dropping all 27 removes only 1,859 of 28,381 false-shade cells, and
     error rises from 21.7 to 22.7 pp. Several excluded towers already stood near full height
     in the 2017 surface.
   - **Some towers run the other way.** A few stand up to 130 m taller in the LiDAR than in
     the shards (footprint parts with partial heights, or a neighbour caught by the probe).
     They are unresolved.

## What this does and does not imply

These are measurements, not decisions. Routing them into work belongs to Track A (canopy,
building data) and A10 (field truth).

- **Trees are the largest single class of missing shade (38%).**
  - **What the raster recovers, when masked correctly:** +9.5 pp, cutting tree-segment error
    from 41.7 to 33.5 pp.
  - **What is left:** 33.5 pp on tree-shaded segments.
  - **Which factors were tested and ruled out as the cause:** canopy change since 2017, and
    the May-vs-June date.
  - **Which were not tested:** the raster's own height and crown shape, and the fixed leaf-on
    opacity.
  - **First fix:** #220, the shipping masking bug, comes before any fusion work. Until it is
    fixed, NYC routes very likely lose most of this gain. The study can re-measure either
    change by re-running with the new code.
- **Building geometry is not a solved floor.**
  - **The measurements:** 35% of misses are building-attributed, and the trees-removed residual
    is 35.1 pp per segment.
  - **What the staleness test showed:** dropping post-2017 buildings does not reduce the
    residual, so new construction is not where it comes from.
  - **What is still open:** demolitions, and post-2017 buildings that replaced older ones on
    the same lot. A per-building height audit against the LiDAR is the next measurement; a
    newer city surface would settle it, and none is public.
- **"Neither" casters (27%)** include elevated roadway and sheds that no layer models. #218
  tracks them at p3, corrected from the first-pass overcount.

## Data versions and licences

| Dataset | Version | Licence | Role |
|---|---|---|---|
| NYC 2017 topobathymetric LiDAR, classified LAZ | captured May 3–17 2017 (Leica ALS80, ~50% leaf-off); Quantum Spatial for NYC OTI; tiles from `finder.nyc.gov`, indexed by the `NYC_2017_LiDAR_TopoBathymetric_LAS_Tile_Grid_Index` FeatureServer | NYC Open Data Terms of Use (public city dataset) | truth surface and bare earth |
| TNC/UVM NYC land cover, 6 in | 2021, Zenodo record 14053441 (`landcover_nyc_2021_6in.tif`) | **CC BY-NC-SA 4.0** | building/canopy attribution of truth shade |
| TNC/UVM NYC tree-canopy change, 6 in | 2017→2021, same record (`treecanopychange_nyc_2017_2021_6in.tif`; 1 no change, 2 gain, 3 loss) | **CC BY-NC-SA 4.0** | flags sides whose truth rays cross changed canopy |
| NYC Building Footprints, live `BUILDING_view` | `DOITT_ID`, `CONSTRUCTION_YEAR`, fetched 2026-10-02 for each block's ±675 m frame | NYC Open Data Terms of Use | the 2017-era building set (b) |
| CHM v2 imagery metadata | `metadata/0320101101.geojson`, `0320101103.geojson` (dataforgood-fb-data bucket) | CC BY 4.0 | the canopy model's imagery date |
| NYC navigation generation | `nyc-2026-09-18-9f2924750af1`. Buildings: NYC Building Footprints 2026-09-13. Streets: Geofabrik New York 260918. Local copy SHA-verified against the deployed manifest | buildings: NYC Open Data Terms of Use; streets: ODbL 1.0 (OSM) | Umbra's geometry |
| Meta/WRI CHM v2 canopy height | ml3 release, read from source.coop as the app reads it | CC BY 4.0 | Umbra's canopy (A8) |
| suncalc | 1.9.0 (the app's pinned version) | BSD-2-Clause | sun positions, both sides |

The CC BY-NC-SA land-cover and canopy-change windows stay in the study's gitignored cache. This audit is
non-commercial, the windows are used only for the attribution split, and only aggregate
numbers are published.

Attribution: land cover © The Nature Conservancy, New York Cities Program, and the University
of Vermont Spatial Analysis Laboratory, 2021, CC BY-NC-SA 4.0.

## What this note does not say

- **No physical accuracy claim.** Nothing here says a person was or was not in the sun. Both
  sides are geometry; A10's field set is the only path to a physical figure.
- **No claim about the live deployed app.** The audit runs the app's own modules offline
  against the generation the deployment loads, not the deployment itself. S0
  (`competitors.md`) covers the live product.
- **No competitor comparison.** shadewalker models the same city with trees and publishes no
  error figure (S0); nothing here was measured against it.
- **Not a full-city figure.** These are 8 blocks chosen to echo S0's pairs, not a random
  sample. The IoU and error figures describe these blocks and this date × hour grid.

## Corrections

The first version of this note (earlier the same day, PR #219's first commit) was wrong on
canopy.

- **What it reported:** a canopy delta of +3.7 pp, Manhattan-only, and blamed the raster's
  coverage.
- **What actually happened:** the harness masked the raster twice.
  - **First mask:** the study's own, with contained footprints. This one was fine.
  - **Second mask:** the field's own `maskedRaster()`, with all 675 m of caster prisms. The
    second mask hit the #220 bug and zeroed the raster's maximum in Williamsburg, Greenpoint,
    Astoria and Jackson Heights, and cut it to 10 m in Midtown and Concourse.
- **What changed:** every canopy-dependent figure in this note: the full-field error, the
  canopy delta, the share of wholly wrong sides, and the season, elevation, hour and borough
  rows. The building-only error, the mask IoU and the miss shares never read the raster and
  did not change.
- **What was dropped:** the earlier explanations "the raster's coverage is the limit" and "part
  of the residual is the 2017 truth being out of date". The first had no support. The second
  was tested by set (b), which did not bear it out.

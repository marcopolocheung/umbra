# Shade accuracy — Umbra vs NYC LiDAR (S1)

**Measured 2026-10-02.** This is the shade-reality audit. It asks how often Umbra's shade is
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
| Per-segment shade-fraction error, full field with canopy (pp) | **37.3** | 25 | 100 | 100 |
| Per-segment error, buildings-only field vs trees-removed truth (pp) | **35.1** | 25 | 100 | 100 |
| Per-segment error on tree-shaded segments, buildings-only field (pp) | **41.7** | 25 | 100 | 100 |
| Canopy delta: field with the CHMv2 raster minus without (pp) | **+3.7** | 0 | +7.5 | +90 |

Per-segment error is |Umbra − truth| on one sidewalk side of one edge. The distribution is
coarse because short edges carry only 4–5 sample points, so error comes in 20–25 pp steps.
That is why p90 sits at 100: **18% of segment-sides (12,442 of 69,120) are entirely wrong**,
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
- **The CHMv2 canopy raster (A8, read from `main`) recovers +3.7 pp on average and +8.9 pp at
  the June solstice. In these sample blocks that gain is Manhattan-only:** +7.9 pp in
  Manhattan and 0.0 in the Brooklyn, Queens and Bronx blocks, where the LiDAR shows tree shade
  but the raster as wired adds none. The raster's coverage is the limit, not the march over it.
- **With the trees taken out, the buildings-only model is off by 35.1 pp per segment.**
  That residual is the error of the building geometry itself: heights, footprints,
  alignment, and casters no footprint holds. It is smallest at low sun (21.6 pp), where the
  long shadows are robust to a few metres of height error.

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

**Grid:** June 21, March 20 and December 21, 2026, at 08, 10, 12, 14 and 16 local time
(America/New_York), with sun positions from the same suncalc 1.9.0 the app pins.

**Blocks:** 8 blocks of 250 m, centred on street corners and chosen to echo S0's observed pairs:

- **Manhattan:** Midtown, Village, Harlem
- **Brooklyn:** Williamsburg, Greenpoint
- **Queens:** Astoria, Jackson Heights
- **Bronx:** Concourse

**Reproduce.** Every download is cached under the gitignored `studies/shade-audit/cache/`,
about 1.9 GB, so re-runs re-hit no public host:

```sh
node studies/shade-audit/10-download.mjs       # LAZ tiles, land-cover windows, nav shards
node studies/shade-audit/20-lidar-surface.mjs  # truth surfaces
node studies/shade-audit/30-eval.mjs           # the audit, ~30 min
node studies/shade-audit/40-report.mjs         # distributions → cache/results/_summary.json
node --test studies/shade-audit/30-eval.test.mjs  # 7 analytic tests of the truth march
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
| error, full field | 39.4 | 42.7 | 30.0 |
| error, buildings-only vs trees-removed truth | 33.0 | 41.2 | 31.1 |
| error on tree-shaded segments, buildings-only | 56.2 | 46.0 | 27.5 |
| canopy delta from CHMv2 | +8.9 | +2.2 | +1.3 |

**By solar elevation**

| | IoU | full field | buildings-only | tree-shaded segments |
|---|---|---|---|---|
| low (<20°) | 0.838 | 19.3 | 21.6 | 17.2 |
| mid (20–40°) | 0.597 | 42.4 | 43.0 | 45.4 |
| high (≥40°) | 0.346 | 45.1 | 37.5 | 61.4 |

**By hour (local)**

| | 08 | 10 | 12 | 14 | 16 |
|---|---|---|---|---|---|
| IoU | 0.840 | 0.543 | 0.396 | 0.378 | 0.648 |
| error, full field | 18.2 | 43.7 | 45.8 | 47.8 | 31.1 |

**By borough**

| | IoU | full field | canopy delta |
|---|---|---|---|
| Manhattan | 0.616 | 32.6 | +7.9 |
| Queens | 0.584 | 41.9 | 0.0 |
| Brooklyn | 0.513 | 41.9 | 0.0 |
| Bronx | 0.444 | 43.3 | 0.0 |

**By block.** "Miss shares" split the cells the mask missed by caster. "False/miss" is cells
the mask adds that the LiDAR does not see, per missed cell.

| Block | Worst IoU | Mean error (pp) | Miss shares: canopy / building / neither | False/miss |
|---|---|---|---|---|
| Williamsburg | 0.090 | 44.8 | 0.27 / 0.49 / 0.24 | 0.22 |
| Greenpoint | 0.142 | 36.7 | 0.38 / 0.35 / 0.27 | 0.25 |
| Harlem | 0.144 | 38.1 | 0.34 / 0.35 / 0.31 | 0.36 |
| Village | 0.172 | 34.2 | 0.38 / 0.34 / 0.27 | 0.28 |
| Astoria | 0.172 | 44.0 | 0.44 / 0.34 / 0.22 | 0.19 |
| Concourse | 0.188 | 43.3 | 0.43 / 0.15 / 0.42 | 0.47 |
| Jackson Heights | 0.281 | 40.5 | 0.63 / 0.26 / 0.11 | 0.09 |
| Midtown | 0.328 | 22.7 | 0.16 / 0.59 / 0.25 | 0.87 |

## The worst blocks, and why

1. **Williamsburg (IoU 0.090 at June noon), the worst block-hour.**
   - **Scale of the miss:** of the 5,698 cells the LiDAR shades, the mask catches 641 and
     misses 5,057 (89%). It also adds 1,408 cells the LiDAR does not see.
   - **Mostly building shade:** about half the misses are building-attributed (2,356), the
     largest building share of any block outside Midtown. The rest is trees (1,705) and
     casters near neither class (996).
   - **Likely cause, not resolved here:** building heights or footprint parts in the shard
     data that cast less than the LiDAR's roofs do.
2. **Greenpoint, Harlem, Village and Astoria (IoU 0.14–0.17).** Street trees at summer noon,
   roughly a third to two-fifths of the misses each, with building misses of similar size.
   Brooklyn and Queens get none of their tree shade back from CHMv2.
3. **Concourse (IoU 0.188).** The largest "neither" share (0.42) and the highest
   false-to-miss ratio outside Midtown. The cause was not investigated block by block.
4. **Midtown (worst IoU 0.328, the best of the eight).** Tall buildings dominate and trees are
   few. It is also the block where the comparison is least fair to Umbra, and Umbra is ahead
   of the truth there:
   - **Newer towers count as false shade.** Its false-to-miss ratio (0.87) is far the highest,
     and the biggest disagreements are towers built after the 2017 flight. Shard building
     1284912 at (−73.97855, 40.75297) is 427 m tall in Umbra and 1.7 m in the LiDAR: that is
     One Vanderbilt, completed in 2020, which the LiDAR saw as a construction site. Two more
     shard buildings stand 274 m and 154 m taller in Umbra than in the 2017 surface, 157 m
     and 487 m from the block centre.
   - **Some towers run the other way.** A few stand up to 130 m taller in the LiDAR than in
     the shards (footprint parts with partial heights, or a neighbour caught by the probe).
     They are unresolved.

## What this does and does not imply

These are measurements, not decisions. Routing them into work belongs to Track A (canopy,
building data) and A10 (field truth).

- **Trees are the largest single class of missing shade (38%)**, and the canopy raster as
  wired today recovers +3.7 pp on average, and nothing in three of four boroughs' sample
  blocks. A8's remaining fusion work targets exactly this, and the study can re-measure the
  result: re-run with a new provider and compare.
- **Building geometry is not a solved floor.** 35% of misses are building-attributed, and the
  trees-removed residual is 35.1 pp per segment. Part of that is the 2017 truth being
  out of date (One Vanderbilt and others). Part is likely height or footprint-part error in
  the shard data. Separating the two needs a newer surface (a 2021+ city LiDAR or DSM) or a
  per-building height audit, neither of which this checkpoint did.
- **"Neither" casters (27%)** include elevated roadway and sheds that no layer models. #218
  tracks them at p3, corrected from the first-pass overcount.

## Data versions and licences

| Dataset | Version | Licence | Role |
|---|---|---|---|
| NYC 2017 topobathymetric LiDAR, classified LAZ | captured May 3–17 2017 (Leica ALS80, ~50% leaf-off); Quantum Spatial for NYC OTI; tiles from `finder.nyc.gov`, indexed by the `NYC_2017_LiDAR_TopoBathymetric_LAS_Tile_Grid_Index` FeatureServer | NYC Open Data Terms of Use (public city dataset) | truth surface and bare earth |
| TNC/UVM NYC land cover, 6 in | 2021, Zenodo record 14053441 (`landcover_nyc_2021_6in.tif`) | **CC BY-NC-SA 4.0** | building/canopy attribution of truth shade |
| NYC navigation generation | `nyc-2026-09-18-9f2924750af1`. Buildings: NYC Building Footprints 2026-09-13. Streets: Geofabrik New York 260918. Local copy SHA-verified against the deployed manifest | buildings: NYC Open Data Terms of Use; streets: ODbL 1.0 (OSM) | Umbra's geometry |
| Meta/WRI CHM v2 canopy height | ml3 release, read from source.coop as the app reads it | CC BY 4.0 | Umbra's canopy (A8) |
| suncalc | 1.9.0 (the app's pinned version) | BSD-2-Clause | sun positions, both sides |

The CC BY-NC-SA land-cover windows stay in the study's gitignored cache. This audit is
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

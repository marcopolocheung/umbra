# Track A — Shadow Engine

> **Charter:** make shadow a *computed field*, not a screenshot. Given any coordinate or edge
> and any time, return a shadow fraction with a source and a confidence — without moving the
> camera, without re-rendering, and eventually without a main thread.

**Class:** Flagship. **Runs alongside:** B, C freely; coordinate with E (`routing.ts`) and G (fixtures).

---

## Current state

- **Active checkpoint:** A8f (paint the raster canopy, closes #275), then A8e or A5. **A8a–A8d
  are landed** — see the A8 bullet below. **A7c is deprioritised** — the census says painting OSM's
  tree points would misrepresent what Umbra knows, so #275 closes at A8f instead. **A7a+A7b are landed** — canopy is fetched,
  modelled and blended into the field, and the coverage census that decides #275 is in
  `docs/notes/canopy-coverage-2026-09-09.md`. See the A7 note below for what the census found
  and what it changes. **A6 is landed** — see its own note below; it did not meet its
  acceptance criterion and says so with numbers. A4b (the `useNavigation.ts` swap) is landed, but read the A4b
  notes before assuming the canvas is retired: the geometry path is **wired and dormant** in
  practice, because the only source that can cover a route bbox is the tile provider and it is
  not trusted at the zooms where it can. A5's per-cell provider resolution is what turns it on.
- **That prediction is now measured, by Track G's G2 benchmark (#259).** A4's acceptance says
  *"`window.__umbraMetrics` shows `canvasRead` at ~0 on the field path"*. It is
  **1136–2164 ms** — a third to well over half of route latency — on **90 of 90 runs** across
  three sessions, while `shadowFallbackShare` printed **0.0% on all 90**. So the canvas is read
  in full on every calculation and the pixel sampler it feeds then answers no edges at all.
  **A4's acceptance criterion is not met on `main`**, and this is the first time anything
  measured it; A4 closed on test evidence. Numbers and method:
  `docs/notes/performance-baseline.md` § Route Calculation (G2).
- **G contributed a candidate mechanism, not yet proven — see #259 for the arithmetic.**
  `coverage()` is asked about the graph-fetch bbox padded twice (~1897 × 2132 m for a 340 m
  route, because `padding` hits its 0.005° floor), while `sampleEdges` resolves the much
  smaller route-edge bbox; `createTilePrismProvider.prismsFor` declines anything not fully
  inside the ~1160 × 815 m viewport. If that is the cause it is **structural rather than a
  fixture artefact**, and the fix is in how the up-front check is *asked*, not in the fallback.
  **What is not established** is why `shadowFallbackShare` is then 0.0%; two providers are in
  play and they imply different fixes. #259 lists the two cheap steps that settle it — a pure
  Node test and surfacing `EdgeShadow.source` in the metrics. **Do both before writing A5.**
- **Done and on `main`:** A1 (#123 / PR #134), A2 (#125 / PR #135), A3 (#129 / PR #136),
  A4a (#126 / PR #137), A6's index prerequisite (#122 / PR #164), A4b, A6, A7a+A7b (#276, #244),
  A8a (PR #282), A8b (PR #286), A8c (PR #285), A8d (PR #291), and #290's block cache (PR #292).
- **A7's census is the finding, and it is worse than the checkpoint assumed.** OSM holds
  **at most ~23% of Madrid's inventoried street trees and ~1.0% of Singapore's**, and
  `diameter_crown` and `height` are tagged on **under 1% of trees in Madrid and 0% in
  Singapore and Kent** — so the crown model is, in practice, its own defaults applied to a
  bare point. The A3 corpus centre in Singapore has **zero** tagged canopy of any kind in
  2 km². Full table, method and the five things it changes:
  `docs/notes/canopy-coverage-2026-09-09.md`; reproduce with `node scripts/canopy-census.mjs`.
  **#275 has its answer on this data: do not paint canopy yet** — 23% of a street's trees
  rendered reads as a bug, where none rendered reads as "the map does not draw trees", and a
  number can carry a confidence where a paint stroke cannot. **#275 closes at A8f, not A7c.**
- **A8 is promoted out of "stretch" and inverted: the raster is the presence layer, A7's OSM
  trees are enrichment.** Its feasibility is measured, not assumed —
  `docs/notes/canopy-raster-feasibility-2026-09-09.md`: Meta/WRI **CHM v2** is a real COG
  (v1 is not), a 5 km route corridor costs a few hundred KB of byte-range reads, heights are
  **uint8 whole metres**, and `source.coop` republishes the COGs CORS-open, so the browser
  reads them direct with no proxy. See the A8 section for the full slice list.
- **A8a–A8d are landed, and the raster now changes routing answers.** A8a reads the COGs
  browser-direct and indexes `acq_date` offline; A8b's `CanopyTileStore` dedupes, caches and
  cancels; A8c's urban confusion gate **passed** — the model does not read buildings as canopy
  (#279; `docs/notes/canopy-urban-confusion-2026-09-10.md`); A8d marches the building-masked
  raster inside `ShadowField`. #292 gave `geotiff.js` a block cache (#290), so a cold
  route-sized read is 0.9–1.9 s and lands inside `READY_BUDGET_MS`
  (`docs/notes/canopy-raster-shadow-field-2026-09-10.md`). **The cost is #275, now live
  everywhere:** nearly every route through a treed city reports `"mixed"` and quotes canopy
  shade over a map that paints no tree, which is A8f. Still open: **#281**, the Madrid tile's
  imagery is 2020-02, leaf-off in a deciduous city, so the raster under-reports there — no
  vintage correction is applied, deliberately, and it lands on A8e.
- **A6 landed with its acceptance criterion unmet, and the measurement is the deliverable.**
  A 14-hour sweep over a 3 km route was to cost *"< 2× a single-hour sample"*. It costs
  **~21×**, and on `main` it cost ~17× — **the ratio got worse while every absolute number
  improved**, because the denominator sped up more than the numerator. What did happen: the
  sweep went 34.4 ms → 21.9 ms and a single-hour `sampleEdges` went 1.96 ms → 1.04 ms (1.9×,
  which routing gets for free). Everything a sweep can hoist is hoisted; the remainder is the
  point-in-shadow queries, and those are per-instant because the shadow moves — at graph scale
  `sweep` beats N `sampleEdges` calls by only 0–11%, and that margin is the batch plan, which
  does not grow with the number of times. **Beating N× needs a different predicate, not more
  sharing** — filed as **#267**. The design, the three cheaper wins that were measured and
  declined (**#268**, **#269**, and the far-cap reuse), and the per-phase split are in
  `docs/notes/performance-baseline.md` § Time Sweep (A6).
- **The sweep still has no multi-time consumer.** `useHourlyExposure.ts:93` is the only
  `sweep` call site in `app/` and it passes one time. The win the app collects today is the
  ~1.9× on `sampleEdges`; the N-time sharing is built for **H1**, and **#270** tells Track H
  what to budget, because its gate text assumed A6 would make N buckets cheap and it does not.
- **#245 (the one-hour max-shadow window) was decided, not deferred: declined.**
  `docs/notes/one-hour-shadow-window.md` has the reasons — the chief one being that A6's
  measurement destroyed the "nearly free" premise the proposal rested on (a 10-minute-step
  sweep costs 6.8× the hourly one). D6 and H1 can both call `sweep` today — but budget it at
  roughly N× a single sample, not at a discount.
- **How that went wrong, so it does not happen again:** #134→#137 were stacked, each based on
  the previous, and all four merged within 11 seconds — so #135, #136 and #137 landed on their
  *parent branches* and only #134 ever reached `main`. The tree survived at
  `origin/shadow/a3-agreement` (`35f9c6e2`); this PR re-lands those seven files verbatim.
  **Do not stack Track A PRs.** Branch each from `main` and let it merge before the next starts.
- **Both of A4b's blockers cleared.** #122 closed with PR #164, which builds the shadow
  geometry once per sun cell and indexes it (~1,000–2,200× on `sampleEdges`, measured in #166).
  #121 was stale: PR #160 committed a working browser harness, so the swap was confirmed in a
  real browser rather than on test evidence alone — which this track's risk #1 demands, since
  A3 measures agreement between two models, not whether the app still works.
  Still open: #128 (boundary-parallel disagreement), #120 (height reconciliation).
- **The agreement number, as of this re-land** (unchanged from what #136 recorded, despite
  `geometry.ts` gaining 98 lines from #159): `150 cases · mean 2.6pp · p90 0.0pp · worst 62.5pp ·
  severe 3.3% · [madrid 2.2pp, singapore 2.3pp, kent-wa 3.4pp]`. Committed ceilings: mean 0.04,
  p90 0.05, severe share 0.04. **These come down as the field improves; raising one is a product
  decision, not a way to make a failure go away.**

### Decisions made

**A1 — geometry extraction**
- `BuildingPrism` is **one prism per ring**, not per building. Both pre-existing implementations
  already treated inner rings as separate solids, so flattening changes nothing and keeps the type
  flat enough to transfer to a worker later (A5).
- Prisms carry the ring **exactly as the source delivered it** (closed); `openRing` normalizes at
  use. Rewriting coordinates on ingest would have changed the earcut output and therefore the
  rendered roof triangles.
- `PrismSet.maxHeightM` is computed over the *filtered* feature set, before the geometry-type
  check — that is what the renderer's height normalization did before.
- Height derivation is **not** unified across sources (tiles 3.1 m storeys / 3.1 m default,
  Overpass 3 m / 10 m). Filed as #120; it changes numbers, so it belongs to whoever calibrates.
- `vitest.config.ts`'s include glob was widened to `**/__tests__/**` so `app/lib/shadowField/__tests__/`
  runs at all. Track G owns that file — one glob, flagged in the PR.

**A2 — the field**
- **Providers, not a hard-wired source.** `PrismProvider.prismsFor(bbox)` returns `null` when it
  cannot speak for an area, never an empty set — "no buildings here" and "I haven't loaded this"
  give the same shadow number and completely different confidence. Providers are tried in order.
- **`source: "none"`** was added to the published union, distinguished by confidence: `1` for a sun
  below the horizon (astronomically certain, no geometry consulted) and `0` for "nothing covered
  this point", which is a request to fall back rather than a claim of full sun.
- **Confidence is `sourceBase × horizonFactor × dataFactor`**, each documented in `confidenceFor`.
  `dataFactor` keys off *whether the covering source holds any buildings at all*, deliberately
  **not** off whether one is within shadow reach of the sample — the first draft did the latter
  and scored every sunlit point at 0.32, which would have sent almost every open-street edge to
  the canvas fallback at A4. Base values (tiles 0.8, Overpass 0.7) are priors; A3 is what turns
  them into calibrated numbers.
- **`sampleEdges` mirrors `sampleBothSidewalks` exactly** — same ±4 m offset, same `111195` m/deg
  constant, same sign convention, and the same **sample count**: `useNavigation.ts:951` passes
  `max(3, ceil(distanceM / 25))`, *not* the sampler's default of 5, so `edgeSampleCount`
  reproduces that rule. Missing it would have made long edges disagree purely on density.
- **`shadowAt` softens, `sampleEdges` does not.** A point query averages the 5-offset ±4 m probe
  that `queryPointShadow` and `computeBuildingShadowFraction` have always run — right for "is this
  terrace shadowed?", a question about a few square metres. Edge sampling tests the exact sidewalk
  point instead, because it has *already* displaced the sample ±4 m; doing both smears each
  sidewalk across the street it belongs to. **The first draft did both, and A3 caught it as a
  60pp disagreement on a Madrid street.** Pinned by a test.
- An edge's confidence is the **minimum** of its two sidewalks': the whole edge is only as
  trustworthy as its least-covered side.
- `sweep` is correct but naive. A6 replaces the body; a test pins it to be identical to N separate
  `sampleEdges` calls.

**A4a — live providers**
- **`prismsFor` is synchronous and never fetches.** Only `ready()`/`load()` touches the network.
  If the synchronous query could trigger a fetch, sampling one route would fire one Overpass
  request per edge against a shared, rate-limited public service.
- **The tile provider declines anything off-screen.** `querySourceFeatures` sees loaded tiles, not
  the world, so an empty result outside the viewport means "I don't know", and returning an empty
  `PrismSet` would read as open sky at 0.8 confidence. It also declines below zoom 12, where
  MapTiler stops serving building geometry — the same threshold `LocalShadowAdapter` bails at.
- **The Overpass fetch is padded 25% past the requested bbox**, because a shadow is cast by
  buildings *outside* the area it falls on; a fetch stopping at the bbox edge reports a sunlit
  street beside an unseen tower.
- **A too-large area is declined, not attempted.** `fetchBuildingFootprintsAround` gives Overpass
  10 s and aborts at 12 s; a city-scale bbox fails both. Splitting a long route's bbox belongs
  with A5's worker.
- **A failed fetch caches nothing.** Caching it as an empty set would turn a 429 into a confident
  claim of open sky. Concurrent loads of the same area collapse into one request.

**A3 — the harness**
- **The reference is the real pixel sampler**, imported, not reimplemented: `sampleBothSidewalks`
  and `isBlueDominantShadowPixel` run over a synthetic canvas painted in `LocalShadowAdapter`'s
  actual shadow colours and composited the way MapLibre does. That also makes this the only test
  in the suite that exercises **invariant #5** end to end — paint shadow in the renderer's colours,
  read it back through the blue-dominant predicate.
- **The corpus isolates sampling disagreement from geometry disagreement**, and says so. Because
  both paths see the same prisms, the number measures pixel quantization, offset placement,
  sample density and the colour round-trip — *not* MapTiler-vs-Overpass building differences.
  Measuring those needs a browser (#121); the fixture format is already the one that recording
  produces, so the real corpus slots in without touching the metric.
- **Three morphologies, chosen for what breaks an estimate:** Madrid (dense mid-rise grid with
  courtyards — shadow edges land *on* streets), Singapore (towers at 1.3°N — short shadows that
  swing fast), Kent WA (low-rise at 47°N — long shadows, winter sun barely clearing the roofline).
- **A `severeShare` gate, not just p90.** With nine cases in ten agreeing exactly, p90 is 0 and
  blind to the tail. `severeShare` counts readings differing by more than 25pp — enough to change
  which side of a street a route picks.
- **The remaining tail is understood, not hand-waved.** Almost all of it is a shadow boundary
  running *parallel* to a street and landing within a pixel of the sidewalk line, so every sample
  flips together. The field is the more accurate side (it samples the true 4 m offset; the canvas
  rounds to the nearest 1.2 m pixel), but the renderer is what the user believes — filed as #128
  with two candidate fixes for A4.

- **Verification gap, as it stood through A3:** no browser check was thought possible on this
  machine (#121). A1 substituted `tileGeometryParity.test.ts` (pre-refactor implementation held
  as a reference, identical roof triangles, shadow triangles at five sun positions, and
  point-in-shadow answers over a grid). A2 and A3 are pure logic with no UI. **#121 is retired**
  — see `docs/notes/browser-verification.md`.
- **Also filed:** #122 — `pointInPrismShadow` rebuilds every prism's shadow polygon per query
  point. A3's canvas painter had to hoist that out to run at all, which is a preview of the fix
  A6 needs.
**A4b — the swap**
- **The canvas readback is now conditional, not removed.** `ShadowField.coverage(bbox, when)` is
  asked *before* the camera is touched; only when it comes back under `LOW_CONFIDENCE` does the
  pipeline flatten, `fitBounds` and read pixels. So the pre-sampling fit is gone on the covered
  path and unchanged on the fallback path — the cost of the fallback is that its 1.5 s idle wait
  no longer overlaps the graph fetch.
- **Overpass can never answer for `calculateRoute`, by arithmetic.** `calculateRoute`'s bbox
  padding floors at 0.005° (~555 m per side); add the 400 m query pad and the smallest possible
  probe bbox gives `bboxRadiusM × 1.25 = 1575 m`, over `MAX_FETCH_RADIUS_M` (1500). True even
  for a zero-length route. So routing geometry can only ever come from tiles until the bbox is
  split — **A5**.
- **Tiles cover only when the whole padded bbox is on screen**, i.e. at low zoom — which is
  exactly where MapTiler decimates its building layer. Measured in Chromium, same Midtown route
  and time, varying only zoom: shadow came back **83%/85% at z16.3** (canvas) but **53%/66% at
  z14** and **0%/9%/15% at z13** on geometry, because `prismsFor` returned a non-empty but
  half-empty prism set and nothing docked it. That is this track's risk #1 exactly — a field
  that looks right and is quietly wrong.
- **So `PrismProvider.completeness()` was added** (a fourth doubt in `confidenceFor`): the tile
  provider reports 1 at z ≥ 15 and `DECIMATED_COMPLETENESS` (0.5) below, putting a zoomed-out
  tile answer at 0.4 — under `LOW_CONFIDENCE`, so routing consults the pixel sampler instead.
  Re-measured after the fix: z14 and z13 both fall back 100% and report 73–75% / 35–40%, in
  family with the canvas path rather than contradicting it. The net effect on shipped behaviour
  is therefore **no change to any route number**, which is the honest outcome for a checkpoint
  whose data source is not yet good enough where it is available.
- **One `sampleEdges` call for the whole graph.** #164 already partitions internally into 2 km
  sun cells with one region-filtered index each, so slicing the batch outside would rebuild
  those indices and re-triangulate every prism whose shadow straddles a slice edge. Progress and
  `yieldToBrowser` moved to the cheap fill loop that applies the per-edge fallback.
- **Provenance is aggregated over the chosen path, never the graph** (`shadowProvenance.ts`). A
  graph has thousands of edges and a route uses dozens; a route whose own edges are geometric
  says so even when most of the graph fell back. Unsampled virtual/connector edges count their
  distance under `"none"` but are **excluded from the confidence statistics** — every route
  starts and ends on a virtual snap node, so counting them would label every route in the app
  low-confidence.
- `CANVAS_CONFIDENCE = 0.6` is a prior below the tile prior, not a measurement. A3 compares the
  field and the sampler over *identical* prisms, so it cannot speak to the sampler's accuracy.
- **Next action:** A5 — per-cell provider resolution is the unlock, not the worker. Resolving a
  provider per 2 km sun cell (the partition #164 already builds internally) would let tiles
  answer at street zoom for the cells the user is looking at, which is the only configuration in
  which the geometry path both fires and has good data. Until then A4b is mechanism, provenance
  and honesty, not a live change of source. A6 (time sweep) is pure logic and unblocked.
- **Last verified:** 2026-09-04, 330 tests / 32 files green on `shadow/a4b-routing-reads-field`
  (baseline on `main` was 306 / 31). Agreement unchanged from the re-land:
  `150 cases · mean 2.6pp · p90 0.0pp · worst 62.5pp · severe 3.3%`.

---

## Why this track exists

`useNavigation.ts:890-897` does this, every time a route is calculated:

```ts
const canvas = map.getCanvas();
const tmp = document.createElement("canvas");
ctx2d.drawImage(canvas, 0, 0);
const imageData = ctx2d.getImageData(0, 0, tmp.width, tmp.height);
```

…then classifies pixels with `isBlueDominantShadowPixel` (`shadowSampling.ts:10`). Shadow is
whatever the renderer painted, in the viewport, at the current zoom, right now.

Five consequences, all of which are somebody else's blocked checkpoint:

| Consequence | Who it blocks |
|---|---|
| Routing can't leave the main thread (needs the DOM canvas) | #38, A5 |
| A 14-hour time sweep costs 14 re-renders | D1, D6 — the daily-habit product |
| The route must be inside the viewport (`fitBounds` before sampling, `useNavigation.ts:879`) | long routes, B (guidance ahead of the user) |
| Only what the renderer draws counts — no trees, ever | #46, A7 |
| Accuracy is capped by the shadow-color predicate (invariant #5) | D4, D8 |

## What already exists (do not rebuild these)

- **`IShadowLayer.queryPointShadow(lng, lat, {date}) → { shadowFraction, source: "geometry-cache" } | null`**
  (`app/lib/shadow/IShadowLayer.ts`) — the camera-free probe contract, already defined, with a
  documented "return null and let the caller fall back" rule. **`ShadowField` is the
  generalization of this interface, not a replacement for it.**
- **`LocalShadowAdapter.ts:251-282`** — implements it from `buildingCache`, a cache of building
  prisms built from MapTiler vector tiles, invalidated on `sourcedata`/`moveend`/`zoomend`
  (`:122-141`). Viewport-scoped, which is exactly the limitation to remove.
- **`app/lib/shadow/offscreenShadow.ts`** — `queryOffscreenBuildingShadow()`: fetches footprints
  within 180 m via Overpass, `computeBuildingShadowFraction()` ray-tests 5 offsets against sun
  azimuth/altitude from suncalc. Pure, tested, viewport-independent — **this is the seed of the
  geometric field.** It's already the fallback path in the agent's `check_shadow` (`tools.ts:365`).
- **`shadowSampling.ts:sampleBothSidewalks()`** — samples ±4 m perpendicular offsets at 5 points
  per edge, returning `{left, right}` so Dijkstra can pick the shadowed sidewalk. **The
  left/right split is a genuine product asset** (Track B's "cross to the shadowed side" cue
  depends on it). Preserve this semantics in the field API.
- **`app/lib/overpass.ts:382 fetchBuildingFootprintsAround()`**, `:399` the building query.

## Hard invariants that bite this track

- **Invariant #5 — shadow color ↔ shadow predicate coupling.** `isBlueDominantShadowPixel`
  (`r+g+b < 600 && b - (r+g)/2 > 18 && b > (r+g)/2 * 1.15`) must keep working against
  `LocalShadowAdapter`'s colors for as long as the pixel path is the fallback. **Do not tune
  shadow colors to improve the field** — the field must not depend on them at all.
- **Invariant #3 — `preserveDrawingBuffer: true`** stays; GeoTIFF export and the fallback both read back.
- **Invariant #2 — `suncalc` stays on 1.x** and is imported as a default import.
- **Invariant #1 — `maplibre-gl` pinned at 5.9.0.**
- Overpass calls need a `User-Agent` (invariant #6) and polite rate limiting + caching.

## The contract this track publishes

`app/lib/shadowField/ShadowField.ts` — nobody else implements shadow math:

```ts
export interface ShadowSample {
  shadow: number;                                              // 0–1
  source: "tiles" | "overpass" | "canopy" | "mixed" | "canvas";
  confidence: number;                                         // 0–1
}

export interface EdgeShadow { left: number; right: number; confidence: number }

export interface ShadowField {
  shadowAt(lng: number, lat: number, when: Date): ShadowSample;
  sampleEdges(edges: EdgeRef[], when: Date): EdgeShadow[];
  sweep(edges: EdgeRef[], times: Date[]): EdgeShadow[][];       // A6
  ready(bbox: BBox): Promise<void>;                            // geometry preload
}
```

`confidence` is not decoration — it's how callers decide to fall back to the canvas path
(A4) and how the UI stays honest (guardrail: any number shown must be traceable).

---

## What Track A has published (import this, don't re-derive it)

`app/lib/shadowField/geometry.ts` — A1:

```ts
interface BuildingPrism { ring: [number, number][]; heightM: number }  // ring as-delivered, may be closed
interface PrismSet { prisms: BuildingPrism[]; maxHeightM: number }

prismsFromTileFeatures(features)   // MapTiler `building` features -> PrismSet (filtered, shortest first)
prismsFromFootprints(footprints)   // Overpass BuildingFootprint[]  -> PrismSet
buildingHeightM(props)             // render_height -> height -> levels x 3.1 -> 3.1
openRing(ring) / metersPerDegree(lat)
buildShadowTriangles(ring, heightM, azimuth, altitude, mPerLat, mPerLng)
pointInPrismShadow(prisms, lng, lat, azimuth, altitude, mPerLat, mPerLng)
triangulateRing / pointInPolygon / pointInTriangle / pointInTriangles
```

Mercator projection and vertex-buffer packing deliberately stayed in `LocalShadowAdapter` — they
are rendering concerns, and keeping them out is what lets A5 move this module into a worker.

`app/lib/shadowField/ShadowField.ts` — A2:

```ts
type ShadowSource = "tiles" | "overpass" | "canopy" | "mixed" | "canvas" | "none";
interface ShadowSample { shadow: number; source: ShadowSource; confidence: number }
interface EdgeRef    { from: [number, number]; to: [number, number] }   // canonical direction
interface EdgeShadow  { left: number; right: number; source: ShadowSource; confidence: number }
interface BBox       { west: number; south: number; east: number; north: number }

interface PrismProvider {
  source: "tiles" | "overpass";
  prismsFor(bbox: BBox): PrismSet | null;   // null = "I can't speak for this area"
  load?(bbox: BBox): Promise<void>;
}

createGeometryShadowField(providers): ShadowField   // shadowAt / sampleEdges / sweep / ready
staticPrismProvider(set, coverage, source)        // tests, or a caller already holding geometry
confidenceFor(source, sunAltitudeRad, prismsAvailable)
edgeSampleCount(distanceM)                        // max(3, ceil(d/25)) — the pixel path's rule
LOW_CONFIDENCE = 0.5                              // below this, prefer another source
sidewalkOffsets(edge) / bboxAroundPoint / bboxAroundEdges / bboxContains
```

`app/lib/shadowField/providers.ts` — A4a:

```ts
createTilePrismProvider(getMap)        // MapTiler tiles; declines off-screen and below zoom 12
createOverpassPrismProvider(opts?)     // Overpass; fetches only from load(), LRU over 4 areas
bboxRadiusM(bbox)
interface TileMapLike { getZoom, getBounds, querySourceFeatures }   // maplibregl.Map satisfies it
```

Order them tiles-first: `createGeometryShadowField([tiles, overpass])`.

**Other tracks:** import `ShadowField`, not the geometry module, unless you are working on the
field itself. `confidence` is the contract's point — a low-confidence sample must never become a
confident sentence in the UI or in an assistant answer.

---

## Checkpoints

### A1 — Extract geometry assembly
**Goal.** One module owns "footprints + heights → prisms", from both sources.
**Approach.** New `app/lib/shadowField/geometry.ts` with a normalized `BuildingPrism { ring: [number,number][], heightM: number }`. Move the prism-building half of `LocalShadowAdapter.buildBuildingGeometryCache()` into it; make `offscreenShadow.ts` produce the same type from `BuildingFootprint`. Keep the WebGL buffer packing in the adapter — only geometry moves.
**Acceptance.** Adapter consumes the module; zero visual change in `npm run dev` (shadows identical at 3 zooms and 3 times of day); unit tests build prisms from a vector-tile feature fixture and an Overpass fixture; `queryPointShadow` still returns identical values on a fixture.
**Files.** `app/lib/shadowField/geometry.ts` (new), `LocalShadowAdapter.ts`, `offscreenShadow.ts`.
**Size.** Medium. Pure refactor — no behavior change is the whole point.

### A2 — `ShadowField` v1 (the contract)
**Goal.** Publish the interface and a working geometry-backed implementation.
**Approach.** `shadowAt` = `computeBuildingShadowFraction`'s ray test over A1 prisms, generalized to accept a prism provider (tiles or Overpass) and a sun position. `sampleEdges` = `sampleBothSidewalks`'s ±4 m / 5-sample geometry, but testing prisms instead of pixels. Cache prisms by tile key with an LRU (copy the containing-bbox LRU pattern already in `overpass.ts`).
**Acceptance.** Tests over hand-computed cases: one prism, sun due south at 30° altitude → known shadow polygon; a point inside/outside it; an edge half-covered returns ≈0.5; sun below horizon returns 1.0 everywhere; `confidence` drops when no prism source covers the bbox. Published in the brief for other tracks to import.
**Files.** `app/lib/shadowField/ShadowField.ts`, `app/lib/shadowField/__tests__/`.
**Size.** Large — the core of the track. Split into "point query" and "edge query" PRs if it runs long.

### A3 — Agreement harness
**Goal.** Make "is the field as good as the pixels?" a number, not an opinion.
**Approach.** ~200 (edge, time) fixtures across 3 cities with different morphology (Madrid grid + courtyards, Singapore towers, a low-rise suburb). Record the pixel sampler's answer once, offline, as the reference. Report mean absolute disagreement and the 90th percentile.
**Acceptance.** `npm test` prints the disagreement metric; a threshold is committed; CI fails on regression. Coordinate with **G4** — Track G owns the fixture infrastructure, this track owns what's in the fixtures.
**Files.** `app/lib/shadowField/__tests__/agreement/`, coordinated with `e2e/**`.
**Size.** Medium. **Gate: A4 does not start until this is green.**

### A4 — Routing reads the field
**Goal.** Cut the canvas out of the routing path.
**Approach.** In `useNavigation.ts:801 calculateRoute` (and `:495 calculateSketchRoute`), replace the `edgeShadowCache`/`sampleBothSidewalks` block (`:956`) with `field.sampleEdges()`. Keep the pixel path behind a `confidence < threshold` fallback. Remove the pre-sampling `fitBounds` (`:879`) once the field is authoritative.
**Acceptance.** A route calculates correctly with the map panned two cities away; A3 disagreement stays under threshold; `window.__umbraMetrics` shows `canvasRead` at ~0 on the field path; existing routing tests unchanged and passing.
**⚠️ The `canvasRead` criterion is measured and NOT met** — 1136–2164 ms on 90 of 90 runs (G2,
#259). A4 closed on test evidence before anything measured it. The residual is A5a's, not a
reopening of A4, but do not cite A4 as evidence the canvas is off the routing path.
**Files.** `useNavigation.ts` (⚠️ contested — keep the diff surgical), `app/lib/shadowField/**`.
**Size.** Medium. **Coordinate with Track E** if E1 (cost model) is in flight.

### A5 — Wake the geometry path, then offload what is left
**Goal.** Closes **#38** and **#259**. **Re-scoped 2026-09-09 against G2's benchmark — read
this before starting, the original framing aimed at the wrong phase.**

**What changed.** A5 was written as a worker offload: move graph build, shadow sampling and
Dijkstra off the main thread. G2 then measured the phases, and **Dijkstra is 3–18 ms of a ~3 s
2-point calculation** while **the canvas read is 1136–2164 ms**. Offloading a 15 ms search to a
worker buys nothing a user can perceive. The main-thread block is the readback, and the readback
happens because `coverage()` reports the geometry path cannot answer — the dormancy this brief
already predicted.

**So A5 has two parts, in this order, and the first is the one that matters.**

**A5a — per-cell provider resolution, so the geometry path actually runs.** This is the fix the
Current state block always said A5 owned. Land the two diagnostic steps in #259 first (a pure
Node test that reproduces the `coverage()`/`sampleEdges()` mismatch, and `EdgeShadow.source`
surfaced in `metrics.ts`), because they decide whether the fix is in how `coverage()` is asked,
in the padding, or in provider resolution order.
**Acceptance.** `canvasRead` at ~0 on the field path — **A4's original criterion, finally met
and measured**, not asserted. Re-run `npm run bench:route` and commit the before/after into
`docs/notes/performance-baseline.md`. A3 disagreement stays under its committed ceiling. If the
canvas read survives for a real reason, say which and publish the number rather than closing it.

**A5b — worker offload, sized against what is left.** Only after A5a. If A5a removes the
readback, re-measure before assuming a worker is still worth it: the remaining main-thread cost
may be small enough that #38 should be re-scoped or closed on the measurement. The 5-point shape
is the one to check — its dijkstra phase is 320–2690 ms, two orders above the 2-point case,
because it runs a per-leg `dijkstra` rather than `paretoRoutes`.
**Acceptance.** Main-thread long-task time during a 5-point route drops measurably against
**G2's committed benchmark** (no benchmark → no claim); UI stays interactive (timeline draggable
mid-calculation). Note the benchmark's own noise floor: across-session spread is ~2–25% on every
scenario, so a win under ~25% needs higher repeat counts first (**#263**).

**Files.** `app/lib/shadowField/ShadowField.ts`, `app/lib/shadowField/providers.ts`, `useNavigation.ts`
(⚠️ contested — keep the diff surgical), `app/workers/routing.worker.ts` (new, A5b only).
**Size.** A5a Medium, A5b Large. **Depends on G2** — landed.

### A6 — Time sweep ✅ *(landed; one acceptance criterion unmet, in writing)*
**Goal.** `sweep(edges, times[])` — N hours for far less than N× the cost.
**Approach.** Load geometry once; vectorize sun positions across times; reuse the per-edge sample geometry. The shadow polygon for a prism is an affine function of sun azimuth/altitude — precompute per-prism projections per time, not per edge per time.
**Acceptance.** A 14-hour sweep over a 3 km route costs < 2× a single-hour sample; results match 14 individual `sampleEdges` calls exactly.
**Files.** `app/lib/shadowField/ShadowField.ts`, tests.
**Size.** Medium. **This is Track D's dependency — D1 can ship before it, D6 can't.**
**It also gates Track H entirely.** H1 prices every edge at its own traversal time, which
means N time buckets per route; without the sweep that is N× a full sample and will not run
at interactive speed. H is blocked until this lands — see `docs/tracks/TRACK_H.md`.

**What landed.** `prepareShadowCasters` splits the sun-independent half of an index build —
ring bounds, the flat ring, the near cap's triangulation, and a grid over footprints — out of
`buildShadowIndex`, and `ShadowField` memoises it per prism array (both providers already
return a stable array and neither mutates one). The sun-cell partition, each cell's region,
and each edge's sidewalk offsets and sample count are computed once per batch instead of once
per hour. Three trig calls moved out of a per-prism loop. Every float is unchanged: the shift
is spelled exactly as before, `earcut` sees exactly the coordinates `triangulateRing` fed it,
and `shadowTrianglesFlat` is pinned **vertex for vertex** against `buildShadowTriangles` over
ragged concave rings, open and closed — a test added because the frozen reference compares the
two only *through* `isShadowed`, which cannot see a cap cut differently over the same polygon.

**One inexact short-circuit was found in cold review and removed.** A footprint-bounds test in
front of the ray cast is exact for a finite ring and **not** for a ring carrying a NaN vertex,
which the bounds sweep silently excludes while the ray cast still flips parity on its edges —
140 of 160,801 grid points diverged on a constructed case. No ingest path produces one, and it
was worth ~2%. Removed rather than documented as an exception.

**Second criterion met and tested:** results match N individual `sampleEdges` calls exactly,
now over a corpus that actually exercises the sharing — 100 buildings, a 6 km route crossing
several sun cells, 19 hours either side of sunrise and sunset.

**First criterion not met — 20.9×, not < 2×.** The ratio is the wrong instrument (it improves
when a single sample gets slower), the remaining cost is the per-instant point queries, and
the route to beating it is a different predicate rather than more sharing. Numbers, per-phase
split, the alternative design, and the three measured-and-declined wins: `docs/notes/performance-baseline.md`
§ Time Sweep (A6). **Read that before taking H1** — H must budget N time buckets at roughly
N× a sample, not at a discount.

**A7 — canopy v1 (slices a and b landed; c is the UI and is not started)**
- **`shadow` stays physical; the 0.5 preference weight is published and not applied.** #244's
  0.5 is *perceived* intensity, for a route cost model. `ShadowField.shadow` is documented as a
  fraction of the direct beam, and multiplying a preference into it would corrupt the exposure
  series, the heat score and the assistant's spot checks alike. So `canopy.ts` applies
  transmittance (~10% leaf-on / ~70% leaf-off → opacity 0.90 / 0.30) and exports
  `CANOPY_PREFERENCE_WEIGHT` with the citation and its caveat for Track E. Nothing applies it
  yet, and it cannot be applied yet: `EdgeShadow` reports one blended fraction and does not say
  how much of it was canopy, so there is nothing to weight. **Filed as #277 against Track E.**
- **A canopy provider is a separate list, not another `PrismProvider`.** Buildings resolve
  first-one-wins; canopy is *additive* on top of whichever answered. One list would mean either
  a canopy source shadowing a building source or the field guessing which it held.
  `CanopyProvider.prismsFor` also takes the date, because a crown's geometry is fixed and its
  opacity is not — and it must return the **same array** per area and leaf state, since
  `ShadowField` keys its prepared casters on that array's identity.
- **Two indexes per sun cell, not one over the concatenation.** The building path stays provably
  the geometry it always was — same casters, same grid, same order — which is what lets A3's
  agreement numbers and A6's sweep parity keep meaning what they meant; and the prepared-caster
  cache is keyed on array identity, which a per-call concatenation would miss every time. The
  building index is consulted first and wins outright when it answers, so canopy costs nothing
  where there is none.
- **#276: footprint exclusion is a property of the caster.** `BuildingPrism` gained `baseM` and
  `opacity`, both defaulting to what every building has. A caster with `baseM > 0` does not
  occlude its own footprint — under a crown is where its shadow *is* — and its shadow sweeps
  from the base shift to the top shift rather than from the footprint. That second half is not
  optional: a ground-to-crown solid over-reports the whole displacement, ~14 m of it at a 10°
  sun, which is the direction that routes someone into sun while promising shadow.
- **Everything with a direction leans towards less shadow.** Inscribed crown polygons (~90% of
  the circle, not ~110%); untagged leaf cycle read as deciduous; row crowns spaced to touch
  rather than overlap; a height range read at its lower bound. Stated because the census makes
  the defaults the model, not a fallback.
- **Confidence goes *down* when canopy is blended in** (`CANOPY_MIX_FACTOR`, 0.9), and canopy
  alone scores 0.35 — below `LOW_CONFIDENCE`, so it reads as a request to fall back. Adding
  canopy removes a known bias and adds model uncertainty; both are true, and the second is the
  one a route card must not hide. Like the other priors here, A3 cannot calibrate it: the pixel
  sampler it compares against cannot see a tree at all.
- **Woodland relations are skipped**, ways only. A half-assembled multipolygon reports shadow in
  the wrong place with no way for a caller to tell. Tree rows are capped at 300 crowns.
- **Not done in this slice:** the UI (A7c), the renderer (**#275** — declined for now against
  the census, with the numbers recorded on the issue), and a canopy share on `EdgeShadow` for
  Track E to weight (**#277**).

### A7 — Canopy v1 (Overpass trees)
**Status.** Slices (a) fetch + model and (b) field integration are landed, with #276 and #244.
Slice (c), the UI, is not started. #46 is already closed.
**Goal.** Stop under-reporting shadow on the streets shadow-seekers actually use.
**Approach.** Extend the Overpass query with `natural=tree`, `natural=tree_row`, `landuse=forest`, `leaf_type`. Crown model: radius from `diameter_crown` when tagged, else a species/`leaf_type` default (document the defaults); height from `height` else a default. Contribute as `source: "canopy"` with **lower confidence than buildings** — the tagging is sparse and the model is crude.
**Acceptance.** A tree-lined Madrid/Barcelona street reports materially more shadow than before; confidence reflects tag sparsity; the UI can distinguish building shadow from tree shadow; seasonal honesty: deciduous canopy is discounted outside leaf-on months (document the month window per hemisphere).
**Files.** `app/lib/overpass.ts`, `app/lib/shadowField/canopy.ts` (new).
**Size.** Large. Split: (a) fetch + model, (b) integrate into the field, (c) surface in the UI.
**Literature (2026-09-09, ROADMAP §5c).** **#244** — use the published weight, not an invented
one: tree shadow is perceived as **half** as intense as building shadow (Melnikov et al. 2022, via
Wen et al. 2025), which is what the fractional `shadow` field is for. Wen et al. also found tree
shadow *dominates at midday exactly when building shadow collapses* — which is the data behind
sequencing A7/A8 before H3. Keep the two numbers separate: 0.5 is a **route-choice preference
weight**, the ~10%/~70% leaf-on/leaf-off figure is **transmittance**. Also **#245** (a one-hour
max-shadow window, adopt deliberately or decline in writing).

### A8 — Canopy from the raster *(promoted out of "stretch" on 2026-09-09)*

**A7's census inverted this checkpoint's role.** A8 was a stretch goal that would fill in
OSM's gaps. It is now the **presence layer**, and A7's OSM trees are demoted to *enrichment*:
absence of an OSM tree is not absence of a tree, and in Singapore it is not even weak evidence.
Ask the raster whether canopy exists; ask OSM and municipal inventories what is known about a
particular tree. **A8f, not A7c, is what closes #275** — painting A7's sparse points would
imply "these are the trees Umbra believes exist", which the census disproves. A8f can honestly
paint *estimated canopy coverage*, which is what the source is.

**Overture building heights are a separate concern** and stay on this checkpoint only as a
note; they belong with #120 (height reconciliation), not with canopy.

**Feasibility is measured, not assumed** — `docs/notes/canopy-raster-feasibility-2026-09-09.md`.
The four facts that shape everything below:
- **Use v2, not v1.** `forests/v2/global/dinov3_global_chm_v2_ml3` is a real COG (tiled
  512×512, seven overview levels). v1 is striped BigTIFF with no overviews and would need a
  preprocessing pipeline; v2 does not.
- **Route-sized.** 0.91 m/px ground at Madrid, a 1.82 m/px overview, and **41 KB / 260 KB /
  1.4 MB** for a 0.5 / 2 / 5 km box read from the real Madrid tile's byte counts. Whole tiles
  are 85–272 MB, so range reads are mandatory rather than an optimisation.
- **Browser-direct, no proxy.** Meta's own S3 sends no CORS headers, but `source.coop`
  republishes the identical objects (verified byte-for-byte over the Madrid tile) with
  `access-control-allow-origin: *` and range support:
  `https://data.source.coop/tge-labs/meta-chm-v2/chm/<quadkey>.tif`. `geotiff.js` reads them
  straight from the page. A byte-range `api/canopy.js` against Meta's S3 stays on the shelf as
  the fallback if that republication goes away (**#280**) — insurance, not a build item.
- **Height is uint8 — whole metres.** Not sub-metre, whatever v1's `_float` path suggests.

**Slices. A8c is a gate, not a step.**

| | | |
|---|---|---|
| **A8a** | Transport prototype | Browser-direct COG reads from `source.coop` via `geotiff.js` — overview selection, tile-range fetch, decode. One AOI. Plus `acq_date` metadata. Measure requested vs transferred bytes, decode time, peak memory. **No routing effect.** Note the metadata GeoJSONs are 4.7–24.4 MB per tile for a handful of polygons — reading one date costs more than reading the canopy, and A8a owes an answer. |
| **A8b** | `CanopyTileStore` | The viewport and the **route corridor** are independent consumers with independent lifecycles; dedupe, cache decoded tiles, cancel stale reads. This is live debt: `useNavigation` already `fitBounds`es a route into view before sampling, and canopy must not inherit that coupling. |
| **A8c** | **Urban confusion gate** | Does the model read *buildings* as canopy? See below. **Routing gate.** |
| **A8d** | Height field → `ShadowField` | Building-masked raster, ray-march against `rayHeight(d) = d·tan(alt)`, **not** thousands of synthetic prisms. Keep canopy *obstruction* separate from *transmissivity*: the raster says "vegetation this tall", never "this blocks 90% of the beam". |
| **A8e** | Source fusion | Spatial, not whole-dataset: CHM baseline everywhere, municipal inventories *replacing* it where they exist, OSM *refining* individual crowns. This is where A7 earns its keep. |
| **A8f** | Raster canopy rendering | Estimated-canopy fill from a height threshold; optionally distinguish inventoried trees from inferred canopy so the map shows the uncertainty structure. Closes **#275**. |

**A8c — what the gate actually measures.** Not a single correlation coefficient. Rasterize the
existing building geometry onto the CHM grid across all three A3 cities and report: share of
building-footprint pixels classified as canopy at >2/>3/>5 m; share of predicted canopy area
falling inside footprints; CHM height vs building height, **stratified by building height**
(a 3% overall overlap hiding 42% on buildings over 30 m would still wreck downtown routing);
contamination in 0–2 m and 2–5 m rings outside footprints, which separates model error from
registration error; and a **canopy retention ratio** — how much predicted canopy survives an
exact footprint mask, a +1 m dilation and a +2 m dilation. Retention says whether masking
cleans up contamination or deletes the dataset.

Footprint subtraction is a principled mitigation here, not just a hack: the part of a crown
that overhangs a building is not shading walkable ground, because the building already occupies
it. The rings exist because registration error will put false canopy just *outside* a footprint.

**A8c must also check the imagery vintage against the season it is being asked about.** The
Madrid tile's imagery is **all 2020-02** — winter, in a city planted with deciduous planes. A
canopy model reading bare crowns under-detects exactly what A7 exists to find, silently, since
the raster reports a height and not a confidence. Kent's is 2019-07/08 (leaf-on); Singapore's
tile is a mosaic of 30 polygons spanning 2015–2019, so a per-*tile* date is wrong. Multiplying
`canopy.ts`'s leaf-on transmittance onto a winter-derived crown extent would be wrong twice.

**If A8c fails, that is a result, not a failure.** "Free global CHM is not reliable enough in
dense urban morphology" is publishable, and it is a far better position than having bought
LiDAR on the assumption that free data would not work. A8a–A8c commit Umbra to nothing.

### A9 — Beyond binary *(stretch, feeds Track D)*
Export the ingredients of a radiant load, not just a fraction: sky view factor per sample, sun
altitude, surface class. This is what turns Track D's heat score from a heuristic into
something comparable with the SOLWEIG/UTCI literature.

### A10 — Reality Check: observed-shadow ML lifecycle *(agent-capstone prerequisite)*
**Goal.** Learn where the geometry/canopy field is systematically wrong, prove whether a learned
component improves route decisions on unseen places and dates, and operate that component as a
versioned, reversible dependency of the agent. This is the ML-system evidence C12 cannot earn by
calling a hosted vision model.

**Data contract.** Build an owned or explicitly licensed corpus with timestamp, coordinate and
reported accuracy, IANA zone, observation method, local conditions, source/license, geometry and
canopy data versions, and label confidence. Maintain two linked but distinct datasets:

- field observations of sun/shadow for physical calibration;
- geotagged images with reviewed regions/masks when testing a visual segmentation component.

Split by geography and capture date before model development; nearby frames from one walk must
not cross splits. Reserve an untouched final test set. Publish dataset and model cards, consent,
retention/deletion rules, known seasonal/coverage bias, and label-disagreement statistics. A
crowd tap and a model-produced pseudo-label are evidence sources, not unquestioned truth.

**Model ladder.** Start with a constant and the uncorrected `ShadowField`, then logistic
regression and a small gradient-boosted model over geometry confidence, solar altitude, street
orientation, canopy/vintage, morphology, and observation conditions. Add or fine-tune a compact
sky/building/canopy/shadow segmenter only if masks and held-out results justify it. Compare every
rung at equal data and publish ablations; architecture complexity earns no credit without a
decision-level win.

**Evaluation.** Report classification error, calibration/reliability, abstention/coverage,
per-city and per-season slices, worst groups, and route-level consequences: changed route share,
constraint violations, exposure error, and whether the selected plan improved over the untouched
geometry baseline. Fit calibration outside the final test set. Include uncertainty in the
published artifact and preserve `unknown` rather than forcing a label.

**Release lifecycle.** Training is reproducible from a pinned environment and versioned data
manifest. Export a small signed/versioned artifact plus feature schema for deterministic app-side
or build-time inference. Validate training/serving feature parity, run it in shadow mode, promote
behind a version flag only after thresholds, monitor input/coverage/calibration drift, and keep
one-operation rollback to the geometry-only baseline. Never make model availability a prerequisite
for basic routing.

**Agent boundary.** A10 owns acquisition, labels, training, inference, and confidence. Track C
receives only typed observations through a thin tool with model/data version, evidence ids,
validity time, confidence, and explicit unknowns. C5 may cite those observations and C12 may compare
them with Gemini image inspection; neither may rename model output “ground truth.”

**Acceptance.** A clean checkout reproduces the chosen model and final evaluation; geography/date
holdouts and leakage checks pass; the chosen model beats both constant and geometry-only baselines
on at least one predeclared route-decision metric without breaching calibration/worst-slice gates;
otherwise the negative result ships and geometry remains default. A deliberately incompatible
feature schema is rejected, a drift simulation alerts, and a bad candidate artifact is rolled
back. The public report links raw aggregate results, cards, artifact/data versions, and the exact
commit.
**Files.** `server/shadow-ml/**` or `scripts/shadow-ml/**`, versioned permitted data manifests,
exported artifacts, `app/lib/shadowField/` adapter, eval/report notes. **Size.** Very large; split
into (a) data/label contract, (b) baselines and leakage-safe evaluation, (c) optional segmentation,
(d) export/shadow deployment/monitoring/rollback. **Depends on A7/A8 residual measurement.**

---

## Subagent plan

- **Scouts, freely.** "Where does the adapter build prisms and where is that cache invalidated?" / "Does Overpass expose `diameter_crown` often enough to matter in Madrid?" — bounded, read-only, parallel.
- **A3 fixtures are swarm-able**: three cities, three independent fixture sets, disjoint files, worktree isolation.
- **A7 is swarm-able in three slices** (fetch+model / field integration / UI) *only after* the interfaces between them are written down.
- **A1, A2, A4, A5, A6 are solo.** Each is the next one's input, and A4 edits a contested file.
- **A10 is sequential at its boundaries.** Freeze the data contract and splits before parallel
  baseline/segmentation experiments; no experiment may edit the held-out labels or final grader.
- **Verifier on every checkpoint.** This track's failure mode is a field that looks right and is quietly wrong; a cold reviewer with the acceptance criteria catches more than another self-review.

## Risks

1. **The field disagrees with the render and users see both.** The map paints pixels; routing uses geometry. If they diverge visibly, trust dies. Mitigation: A3's threshold is a product gate, not a test detail — and when they diverge, the *renderer* is what the user believes, so fix the field or lower the confidence.
2. **Overpass rate limits** on tree queries in dense cities. Mitigation: reuse the routing-graph bbox and cache; never issue a tree query the graph fetch didn't already cover.
3. **Sparse tagging** makes canopy confidence low in exactly the cities that need it. Mitigation: A8's raster; and say so in the UI rather than overclaiming.
4. **Scope drift into a microclimate simulator.** Out of scope — see AUTONOMOUS_GOAL §7. Approximate honestly, hand the physics to Track D.
5. **A10 leakage masquerading as accuracy.** Adjacent frames and repeated visits are highly
   correlated. Geography/date groups are established before feature or model work and the final
   test set is write-protected by convention and checksums.

## Out of scope / hand-offs

- Heat units, UV, UTCI → **Track D** (consumes A9).
- Cost-model weighting of shadow → **Track E** (A supplies the numbers; E decides what they're worth).
- Agent probes and visual inspection → **Track C** (already calls `queryPointShadow`; will call
  `ShadowField` at C3 and consumes A10's typed observations at C12).
- Benchmarks, fixtures infrastructure, CI budgets → **Track G**.

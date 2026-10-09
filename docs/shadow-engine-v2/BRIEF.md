# Agent Prompt — Umbra Shadow Engine v2

Amendment, 2026-09-12. The "synchronous, main-thread sampleEdges" constraint in the Phase 2 kickoff was wrong. It was derived from Phase 1's observation of the current caller and elevated to a design law, which contradicts this brief's statement that current frameworks and system design are not constraints. Phase 2 and 2a were scoped by it. Compute placement is now an open question, to be decided by evidence in 02b, not assumed.

## Mission

You are doing the research and design work for a ground-up replacement of Umbra's shadow engine
(`github.com/marcopolocheung/umbra`, live at `shademapnav.vercel.app`). Umbra is a shadow-aware
walking-navigation app: Vite + React + TypeScript, MapTiler vector tiles, a WebGL shadow renderer
in `app/lib/shadow/`, and a geometry-backed `ShadowField` sampler that routing reads from.

Today the engine casts shadows from **building footprints only**. Terrain is absent. Canopy is
partially wired (`ShadowSource` reserves a `"canopy"` value; `e2e/canopy.config.ts` exists)
and behaves wrongly — tree shadows render as axis-aligned boxes rather than the amorphous crown
shapes the source canopy raster actually describes, and their **bases translate as time advances**,
which is physically impossible for a static object.

Your job is to produce an implementation plan that takes Umbra to parity with — and then past —
[ShadeMap](https://shademap.app). Not a refactor plan. A replacement plan.

**You are not writing production code in this session.** You are producing a specification that a
subsequent implementation session can execute without re-deriving anything. Small throwaway probes
(decode a tile, time a shader, sample a raster) are encouraged and expected; feature branches are not.

---

## Output contract

Write to `docs/shadow-engine-v2/` in the repo. Required files:

| File | Contents |
|---|---|
| `00-findings.md` | How ShadeMap works. Every claim tagged `[CONFIRMED]`, `[INFERRED]`, or `[UNKNOWN]` with the evidence or the reason it's unresolved. |
| `01-current-engine-audit.md` | What Umbra's engine does today, file by file. What is correct and must survive. What is wrong and why. Root-cause the two known bugs. |
| `02-architecture.md` | The target design. Data flow from tile fetch to rendered pixel to routing query. Include the rejected alternatives and why they lost. |
| `03-data-sources.md` | Every dataset: coverage, resolution, vertical accuracy, licence, attribution obligation, cost, rate limits, failure behaviour. |
| `04-implementation-plan.md` | Ordered, numbered work items. Each with files touched, acceptance test, and rollback condition. |
| `05-validation.md` | How anyone proves the new engine is correct. Test fixtures, oracles, tolerances. |
| `06-open-questions.md` | What you could not resolve, what you'd need to resolve it, and how much it matters. |

Then open one GitHub issue per phase in `04`, each linking the relevant section.

**Ordering rule:** `00` and `01` must be complete before you write a line of `02`. Do not design
against a guess.

---

## Epistemic rules

This repo has a documentation norm — see `docs/notes/evidence.md` — where every number is published
with its method, sample count, hardware, and worst case, and where unmeasured things are named as
unmeasured. **Hold yourself to that standard.** Specifically:

- Never write a performance number you did not measure. Write `[UNMEASURED]` instead.
- Distinguish *"ShadeMap does X"* (you observed it) from *"ShadeMap likely does X"* (you inferred it)
  from *"X is the right approach"* (your engineering judgement). These are three different claims.
- If two sources conflict, say so and say which you trust.
- A plan that admits three unknowns is worth more than one that papers over them. `06-open-questions.md`
  being substantial is a success signal, not a failure.

---

## Phase 0 — Determine how ShadeMap actually works

Do not stop at the marketing page. Concrete methods, roughly in order of yield:

1. **Network inspection.** Load `shademap.app`, exercise it (pan, zoom, scrub time, toggle trees,
   zoom to street level until the "Add Trees" control appears), and record every request. Tile URL
   templates, formats, zoom ranges, tile sizes, response headers, request ordering as the clock moves.
   This is the single highest-value activity — it tells you the data sources directly.
2. **Bundle analysis.** `leaflet-shadow-simulator` and `mapbox-gl-shadow-simulator` are on npm. Pull
   the UMD/ESM builds, un-minify, and read the shader sources — GLSL usually survives minification as
   string literals and is the most legible part of a minified bundle. Look for: the ray-march loop,
   how sun vector is computed, the height texture layout, how tile edges are handled, framebuffer
   sizes and formats.
3. **Its public TypeScript definitions** (`dist/*.d.ts`). The option surface is a map of the
   architecture: what's configurable reveals what's a parameter vs. baked in.
4. **The author's writing.** Ted Piotrowski blogs at `tedpiotrowski.svbtle.com` and posts on Reddit
   as `teddy_pb`. Search for his own descriptions of the algorithm — an author explaining their
   approach beats your reverse-engineering.
5. **`ted-piotrowski/shademap-examples`** and the GitHub issue trackers on both simulator repos.
   Issues are where limitations get admitted.
6. **Prior art in the open.** `Pakillo/CityShadeMapper` (R, LiDAR→shade maps), UMEP/SOLWEIG, `rayshader`,
   GRASS `r.sun` / `r.horizon`. These are published, peer-reviewed approaches to the same problem and
   may be *better* than ShadeMap in places. ShadeMap is the parity target, not the ceiling.

### Licence constraint — read this twice

Both simulator packages are published as **`UNLICENSED`**. You may read them to understand the
technique. You may **not** copy code, shaders, or verbatim structure into Umbra (which is MIT).
Everything in the plan must be a clean reimplementation derived from published technique and your own
derivation. If you find yourself transcribing, stop and re-derive. Note this constraint in `00-findings.md`
so the implementing session inherits it.

### Seed facts

Verify each. Some are confirmed, some are leads. Do not treat any as settled just because it's here.

- **[CONFIRMED]** Terrain DEM: AWS Terrain Tiles, Terrarium-encoded PNG, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, 256px tiles, maxZoom 15. Decode: `elevation = (r * 256 + g + b / 256) - 32768`. This is the documented default in both simulator READMEs.
- **[CONFIRMED]** Solar position: the packages depend on `suncalc` ^1.9.0 and nothing else. Whether that precision is *sufficient* is an open question — see below.
- **[CONFIRMED]** Buildings: Overture Maps (OSM merged with Google/Microsoft/Amazon/TomTom building data), **not** raw OSM. Missing heights default to 3.1 m (one storey).
- **[CONFIRMED]** Free tree data: Meta Data for Good **Canopy Height Maps** (ML-derived, ~1 m), available regionally — hence the conditional "Add Trees" button.
- **[CONFIRMED]** Premium tier: LiDAR/photogrammetry, ~30 cm accuracy, sold per km² (~$3.99/km²). Shows the free/paid accuracy ceiling.
- **[CONFIRMED]** It is GPU-bound by the vendor's own admission, and it aggregates shadow over time to produce sun-hours per day and per year.
- **[LEAD]** Protomaps basemaps are used as a fallback under load — suggests a self-hosted tile story worth understanding.

### The architectural question you must answer first

Everything else follows from it:

> Does ShadeMap project **vector geometry** (extrude footprints, project polygons along the sun
> vector), or does it composite terrain + buildings + canopy into a **single raster height field
> (DSM)** and ray-march each pixel toward the sun?

If it's the raster DSM approach — and the evidence strongly suggests it is — then that single choice
explains both of Umbra's bugs at once. Trees stop being boxes because they're never boxes, they're
pixels of a canopy raster. Shadow bases stop drifting because a DSM pixel's ground position is fixed
in the texture and only the ray direction changes. Confirm or refute this before designing anything.

---

## Phase 1 — Audit the current engine

Clone and read. Start with `.claude/CLAUDE.md` (hard invariants, repo map, task→edit-point table) and
`.claude/rules/`, which contains path-scoped rules for the shadow renderer specifically. Then
`app/lib/shadow/`, `app/lib/shadowField/`, `app/lib/shadowProvenance.ts`, `app/lib/routing.ts`,
`app/components/AccumulationPanel.tsx`, and the agreement harness under
`app/lib/shadowField/__tests__/agreement`.

Answer:

- **Root-cause both bugs.** Why exactly do canopy shadows render as squares? Why exactly do their bases
  move with time? Name the line or the geometric assumption. "Probably because of the representation"
  is not an answer.
- **Where does the time go?** Profile it. Is the bottleneck tile fetch, CPU geometry work, draw calls,
  fill rate, or JS↔GPU transfer? The remedy differs completely by answer, and "it's slow" is currently
  an untested assumption about *which* part is slow.
- **What must survive?** `ShadowField` decoupled routing's shadow measurements from the camera — that
  was correct and the new engine must preserve it. The provenance tracking is correct. The agreement
  harness with committed CI ceilings is correct. Sun-exposure accumulation with GeoTIFF export is a
  real feature. Identify everything in this category explicitly, because a rewrite that silently drops
  it is a regression even if the shadows look better.
- **What is the routing engine's actual query pattern?** The new engine must serve *both* a rendered
  layer and point/segment queries from routing. If routing needs "is this lat/lng in shadow at time T"
  thousands of times per route search, a GPU-only design that can only answer by reading back pixels is
  a bad fit. Specify the query interface before the renderer.
- **What breaks at the seams?** Does the current engine handle a shadow cast by something *outside* the
  viewport? A 400 m tower or a ridge 15 km away casts into view at low sun angles. This is a classic and
  severe failure mode; check for it.

---

## Phase 2 — Design, including the parts ShadeMap doesn't do

Parity is the floor. These are where Umbra can be better, and each belongs in `02-architecture.md`
with a verdict — adopt, defer, or reject with reason:

- **Mercator scale correctness.** Web Mercator metres-per-pixel varies with `cos(latitude)`. A ray-march
  that assumes uniform ground distance per texel is wrong everywhere except the equator, and wrong by
  ~2× at 60° N. Get this right and state the correction explicitly.
- **Precompute the horizon, not the shadow.** For each DSM pixel, precompute the maximum horizon
  elevation angle per azimuth bin (classic horizon mapping, cf. GRASS `r.horizon`). Time scrubbing then
  becomes a texture lookup and a single comparison per pixel instead of a fresh ray-march — O(1) in
  sun position. This is also what makes annual sun-hours cheap rather than a 4000-iteration loop. Assess
  the memory cost against the interactivity win.
- **Penumbra.** The sun is a ~0.53° disk, not a point. Shadow edges are soft, and the softness grows
  with caster distance — a mountain's shadow edge is metres wide, a kerb's is millimetres. Hard-edged
  shadows are a visible tell. Cheap approximation: widen the ray-march acceptance band as a function of
  march distance.
- **Solar position precision.** SunCalc is good to roughly a minute of arc. At sunrise and sunset, when
  shadows are longest and Umbra's routing value is highest, small altitude errors produce large shadow-length
  errors. Evaluate NREL SPA (~0.0003° accuracy) against SunCalc for cost and benefit, and decide.
  Include atmospheric refraction near the horizon — it lifts the apparent sun by ~0.57° at altitude 0,
  which is larger than the entire solar disk.
- **Buffer beyond the viewport.** The height field must extend past the visible area by at least the
  longest plausible shadow at the current sun altitude. Define the rule for computing that buffer.
- **Canopy is not opaque.** Trees transmit light — a deciduous crown passes roughly 10–30% in leaf,
  far more when bare. Binary shade is wrong for exactly the use case Umbra serves (a shaded walking
  route under trees is not the same as under a building). Consider a transmittance channel, and consider
  seasonality: leaf-on vs leaf-off changes tree shade dramatically and is a function of the date the user
  already selected.
- **Terrain/canopy/building fusion.** Meta's CHM gives canopy *height above ground*; the DEM gives ground
  elevation; Overture gives building height above ground. Composing these into one DSM requires deciding
  vertical datum, resolution reconciliation (1 m CHM vs 30 m DEM), and what happens where a building
  footprint and a tree crown overlap. Specify the compositing rule.
- **Where does the compositing run?** The brief permits a backend, a database, and precomputation. Evaluate
  server-side DSM tile generation (GDAL, COGs, a tile service) against fully client-side compositing. Cost,
  latency, coverage, and cold-start all matter. Do not default to client-side because that's what exists now.

---

## Failure modes to avoid

- **Designing before Phase 0 concludes.** If `02` contradicts `00`, the session failed.
- **Confusing a data upgrade with an architecture fix.** Better tree data will not fix drifting shadow
  bases. Fix the representation first.
- **A plan that only a GPU expert can execute.** The implementing session needs file paths, function
  signatures, and acceptance criteria, not "implement a shadow ray-march."
- **Dropping routing.** Rendering is the visible half; routing is the product. An engine that renders
  beautifully and can't answer per-segment shadow queries cheaply is a regression.
- **Untested claims dressed as findings.** Tag them. This repo publishes its worst cases.
- **Scope inflation into implementation.** Probes are fine; branches are not.

---

## Done when

1. `00-findings.md` answers the vector-vs-raster question with evidence, and every remaining unknown
   is in `06` with an estimate of how much it matters.
2. Both canopy bugs are root-caused to a specific mechanism in `01`.
3. `02` specifies the data path end to end, with the rejected alternatives and their reasons.
4. `04` is executable by a fresh session with no access to this conversation — each item names its files,
   its acceptance test, and what would make you roll it back.
5. `05` defines how correctness is proven, including at least one oracle that is **not** another Umbra
   model. The repo already notes that its strongest number is agreement between two of its own models
   rather than physical accuracy; the validation plan must break that circularity. Candidates: published
   LiDAR-derived shade maps, solar geometry computed independently, timestamped georeferenced imagery
   with visible shadows, or direct comparison against ShadeMap at fixed lat/lng/date/time.
6. Every dataset in `03` has its licence and attribution obligation recorded. Umbra is MIT and public;
   an ODbL or CC-BY obligation that shows up after implementation is a problem.

---

## If you get blocked

Do not stall and do not silently substitute a guess. If the network inspection is inconclusive, say so
and proceed with the best-supported hypothesis clearly labelled `[INFERRED]`, plus a note on what
evidence would settle it. If a data source turns out to be unavailable or unaffordable, design against
the next-best and record the degradation. Ask the repo owner only for things only they can decide —
budget ceilings, willingness to run infrastructure, acceptable coverage gaps.
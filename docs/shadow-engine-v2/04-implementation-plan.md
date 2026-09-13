# Shadow engine v2 — implementation plan

Planning date: **2026-09-12**. This is an execution handoff, not an implementation
or a qualification result. The numbered work below is future work. This session
creates this document and one GitHub issue per phase; it creates no branch or code
and changes no application files.

## Authority and execution rules

Read [BRIEF](./BRIEF.md), [00](./00-findings.md),
[01](./01-current-engine-audit.md), **[current 02](./02-architecture.md)**,
[02a](./02a-feasibility.md), [02b](./02b-placement.md),
[02c](./02c-lattice.md), [02d](./02d-delivery.md), and
[03](./03-data-sources.md). Current 02 governs disagreements with historical
wording in the evidence documents. `02-architecture-superseded.md` is history,
not a source of implementation requirements. In particular, FABDEM's admission
for this noncommercial project, ODbL buildings, ordinary worker composition of
source-separated objects, z18, receiver validity, asynchronous queries and bounded
streaming are settled. Do not reopen these choices through an implementation task.

Paths below are relative to the repository root. **New** means a proposed file
that this plan does not create. Brace lists enumerate individual files. Read
`CLAUDE.md` and the relevant `.claude/rules/` before future source edits. Preserve
MapLibre 5.9.0, SunCalc 1.x, direct dependency declarations, lazy MapView loading,
canvas readback invariants, and blue styling while compatibility consumers remain.
Independently derive the engine; the inspected simulator is `UNLICENSED`.

Execute items in number order unless an explicit dependency permits fixture work
to bypass a blocked region. An item's **Depends on** lists work-item numbers;
**02 §12** lists architecture open-item numbers, abbreviated **OI**. “Closes” is
conditional on its acceptance test passing, and is scoped to the tested recipe,
region or device. Documentation alone closes no implementation or measurement
blocker. “Advances” leaves the remaining qualification open.

**Fixture-only** means executable with deterministic local inputs, including
headless software-WebGL correctness tests; it requires neither admitted geographic
assets nor target-device access. **Region-dependent** requires actual admitted
assets, prepared support or the resulting regional measurements. Mixed work is
split at that boundary. Target-phone/hardware performance work starts only after
item 8 passes. If regional work blocks, items 9–16 may proceed on fixtures under
their stated dependencies; that is the fixture exception in [02 §12](./02-architecture.md#12-numbered-open-items-and-blocking-phase),
not permission to proceed to device qualification.

The phase letters here are implementation phases. They do not renumber 02's
“Phase 4” implementation, “Phase 5” validation, or “Phase 6” evidence register.
There is **one production switch, item 20**. Earlier items run through test entry
points or an isolated candidate session in which both consumers select v2. The
shipping pair stays legacy until item 20. On activation failure, restore the whole
legacy renderer/query/canopy/solar/receiver pair, cancel candidate publications and
retain immutable artifacts for diagnosis. Never roll back only one consumer.

| Phase | Items | Exit checkpoint | Issue |
|---|---|---|---|
| [A — Format, composition and early agreement](#phase-a--format-composition-and-early-agreement) | 1–4 | Real v2 output exercises the retained agreement gate | [#314](https://github.com/marcopolocheung/umbrapriv/issues/314) |
| [B — First regional preparation](#phase-b--first-regional-preparation) | 5–8 | Cold, datum-correct, native-canopy region built and sized on the selected host | [#315](https://github.com/marcopolocheung/umbrapriv/issues/315) |
| [C — Worker queries and callers](#phase-c--worker-queries-and-callers) | 9–12 | Bounded async queries, explicit null policy and stale-result control | [#316](https://github.com/marcopolocheung/umbrapriv/issues/316) |
| [D — Renderer and retained features](#phase-d--renderer-and-retained-features) | 13–16 | Candidate renderer, offline package and numeric exposure use the same field | [#317](https://github.com/marcopolocheung/umbrapriv/issues/317) |
| [E — Regional and device qualification](#phase-e--regional-and-device-qualification) | 17–19 | Deployment, physical and device evidence support a declared activation envelope | [#318](https://github.com/marcopolocheung/umbrapriv/issues/318) |
| [F — Joint activation and handoff](#phase-f--joint-activation-and-handoff) | 20–21 | One reversible paired switch and reproducible release record | [#319](https://github.com/marcopolocheung/umbrapriv/issues/319) |

The issues include their phase text as an immediately readable snapshot. Their
repository section links target this path on `main` and become available when the
documentation is published; this planning session does not commit or push it.

## Phase A — Format, composition and early agreement

### 1. Implement the separate-object format and fixture producer

**Fixture-only. Depends on:** none. This is the first implementation task.

**Files touched:** new `app/lib/shadowField/v2/{types,format}.ts`,
`app/lib/shadowField/v2/__tests__/{format.test,formatFixtures}.ts`, and
`docs/shadow-engine-v2/contracts/tile-format-v1.md`.

**Change:** turn [02 §4](./02-architecture.md#4-canonical-field-and-tile-container)
into one byte-addressed contract and its pure encode/decode implementation, usable
in a worker and imported by the later server package. Define separate terrain,
building and canopy schemas, manifest/dependency schema, explicit field widths,
enum/flag assignments, directory offsets, table references and limits in the
contract before writing the codec. Those exact allocations are the remaining OI
11 implementation choice; do not copy D1's probe flags as the production format.
Expose `encodeComponent`, `decodeComponent`, and `validateManifestDependencies`;
the decoder returns a typed component, never an implicitly complete fused tile.
Use an asynchronous decoder with the platform `DecompressionStream` gzip path;
pass a gzip compressor into the encoder so browser code imports no Node module.
The Node fixture producer supplies `node:zlib` gzip at level 6, as will the later
server writer. This needs no new dependency or package-file change. Enforce decoded
length limits while reading the decompressed stream, before allocating band views.

Terrain owns ground vertices and terrain-derived foundations/absolute envelopes.
Buildings retain independent footprints/occupancy, feature IDs, height/base
attributes and foundation references. Canopy retains native AGL/mask/model inputs;
keep raster and OSM fallback evidence/licences distinguishable. Assign absolute
terrain-derived values only to terrain-family delivery artifacts. Specify how
per-source known-empty/nodata/unknown, material and provenance tables survive the
later join. The six-band logical page is a composition result, not a public object.

Use z18, 256 logical/258 stored samples, true one-cell borders, NW–SE terrain
diagonal, little-endian 32-bit planes and 1/64 m heights. Quantize Float64 once,
reject nonfinite/out-of-range values beyond ±100,000 m, and preserve valid zero
and negative values. Record `none` or `horizontal-delta-u32` per band; horizontal
modulo-2³² prediction resets every row and band. Start with horizontal delta and
gzip level 6, one gzip stream per component. Adaptive `none` selection is optional
only when actual encoded size improves; decoding always obeys the directory.
Checksum decoded canonical words including borders and hash the manifest's exact
object, recipe, hierarchy, datum, source and model dependencies. Distinguish
transport identity from decoded physics identity.

**Fresh-session start:** at repository root, record `git status --short` and
`git rev-parse HEAD`; preserve unrelated edits. Check `node --version` against
`package.json`'s Node 24.x requirement and use the lockfile (`npm ci` if dependencies
are absent). Read 02 §§3–5 and 7, this item, `vitest.config.ts`, and
`.claude/rules/{change-discipline,tests}.md`. The current Vitest include already
discovers the proposed nested `__tests__` files. No source credentials, geography,
server, browser or later 05/06 document is needed. Build synthetic independent
components in `formatFixtures.ts`; do not ingest research rasters as production data.

**Acceptance test:** `npx vitest run app/lib/shadowField/v2/__tests__/format.test.ts`
and `npm run typecheck`. Round-trip every declared band/type, signed heights,
unsigned metadata wrap, first/last row words and all borders with both predictors.
Reject unknown format/predictor/codec, overlapping or truncated ranges, invalid
table indices, corrupt checksums, excess decoded length and mixed manifest
dependencies before exposing arrays. A changed terrain fixture leaves independent
building/canopy bytes identical; only their manifest joins change. The contract
contains an annotated golden object/directory and expected decoded words sufficient
for a second implementation to read it. No compression or device-speed claim.

**Rollback condition:** ambiguous framing, silent corruption/unknown-to-empty
conversion, dependence on app/browser state, or terrain-derived data leaking into
independent objects. Revert the codec/schema together and regenerate only these
new fixtures; do not change settled evidence files.

**02 §12:** advances **OI 11** (schemas, framing, checksums); implements the fixture
part of **OI 7** (separation). No dependency on regional OI 1–10 admission or sizing.

### 2. Implement deterministic worker-side composition

**Fixture-only. Depends on:** 1.

**Files touched:** new `app/lib/shadowField/v2/{compose,lattice,treeModel}.ts`,
`app/lib/shadowField/v2/__tests__/{composition.test,lattice.test}.ts`;
extend `types.ts` and `formatFixtures.ts` from item 1.

**Change:** expose `composeTile(components, manifest, reservation)` returning the
six typed canonical planes and explicit support/evidence. Keep it a pure module
for the worker and the server's bounds evaluator to share. Join a whole-feature
foundation to building AGL before clipping, use stable roof/ID precedence, fixed
cell-center ownership and native nearest-neighbor canopy masks. Implement 02 §5.2:
measured underside or 0.35h prior, omitted trunks, roof clipping, positive raster
priority, valid-zero absence, OSM only on unavailable/nodata support, one crown
interval, shared Float32 materials and seasonal priors. Return byte counts and
require an allocation reservation so later callers cannot hide composition scratch.
Never derive foundation separately from each tile's clipped footprint.

**Acceptance test:** focused composition/lattice Vitest suites plus typecheck.
Golden sloped-ground, negative-elevation, courtyard, cross-tile building, roof/crown
overlap and missing-neighbor fixtures produce exact expected integers and matching
neighbor borders. Holey/crescent crowns and 01's two different source-pixel positions
remain distinguishable. Time changes materials/query inputs, never ground occupancy
or footprint position. Missing foundation/ground remains unsupported. Publish no
page when dependencies mismatch or reservation fails.

**Rollback condition:** per-tile foundation seams, invented support, rectangular
block substitution, mutable canonical pages or divergent tree recipes.

**02 §12:** advances **OI 6, 8, 11**; closes only their synthetic composition cases.
Actual extraction/native-data qualification remains in items 5–8.

### 3. Run the agreement gate against the first v2 query output

**Fixture-only. Depends on:** 2. Do this immediately after composition, before
regional adapters, the general acquisition system or renderer work.

**Files touched:** new `app/lib/shadowField/v2/{receivers,march}.ts`,
`app/lib/shadowField/__tests__/agreement/{v2Harness,v2Fixtures}.ts`,
`app/lib/shadowField/__tests__/agreement/v2Agreement.test.ts`,
`app/lib/shadowField/v2/__tests__/receivers.test.ts`;
`.github/workflows/ci.yml` only if explicit reporting/artifact retention is needed.
Existing `agreement/{fixtures,harness,agreement.test}.ts` are read-only inputs.

**Change:** add the smallest actual v2 CPU evaluator needed for the opaque, flat
corpus: canonical receiver validity, biased half-open DDA, ordered sidewalks and
valid-only aggregation. Build corpus component objects with items 1–2, decode and
compose them through the candidate modules, then call the candidate marcher. Do
not return 02c's recorded answers or use its throwaway core as the candidate.
Unimplemented terrain/canopy cases must report unsupported, not silently use the
flat specialization. The ordinary worker facade is intentionally later; this
pure kernel becomes its implementation.

Implement the already-authorized 02c validity adapter in the new harness: mask
identical scheduled locations in candidate and fixed reference sampling, preserve
painted pixels and the existing pixel sampler, count null separately. Mirror the
existing assertions and add the settled validity guard; retain the original legacy
gate as its own run. Frozen fixture sun bypasses the production solar provider so
the reference comparison stays the same experiment. A finite, declared fixture
exterior may be known empty; real regional exteriors may not.

**Acceptance test:** run both `agreement.test.ts` and `v2Agreement.test.ts` with
Vitest. Retain all **150 fixtures**, all three cities and **300 non-null readings**
in this existing corpus; mean ≤0.04, nearest-rank p90 ≤0.05, strict >0.25 share
≤0.04, each city's mean ≤0.08, invalid scheduled share ≤0.25 overall and per city.
Both canopy-fill equality checks pass unchanged. Print every metric, null/count
totals, city exclusions, worst reading and the eight retained witnesses:
**28L, 38L, 45L, 48L, 84R, 135R, 138R, 144R**. Compare their individual outputs with
02d D3 and retain its historical worst **1.0**, even if future justified behavior
changes. Separately test all-invalid/partially valid sidewalks and occupied ground
at night. Deliberately corrupt an output/validity mask and verify the candidate
gate fails. CI must execute the real candidate path from this item onward.

**Rollback condition:** any ceiling failure, missing case, changed reference pixels,
wrong denominator, suppressed tail or candidate path that bypasses the new format
and compositor. Fix the candidate; do not raise ceilings, change z18 or apply D4's
unselected street-width clamp.

**02 §12:** advances **OI 17**; closes implementation of **OI 18**'s retained gate
and reporting contract, subject to continued release regression. Depends on the
fixture parts of **OI 11** delivered by 1–2, not production-region readiness.

### 4. Write the validation protocol and blocker register before new measurements

**Fixture-only. Depends on:** 3.

**Files touched:** new `docs/shadow-engine-v2/{05-validation,06-open-questions}.md`
and `docs/shadow-engine-v2/validation/{cases,thresholds}.json`.

**Change:** define independent analytic ray/plane/interval expectations and a
physical-observation protocol alongside the two distinct agreement gates. Specify
numeric, positional, solar, integration and physical-error metrics/tolerances and
sample selection before measuring the candidate; tolerances must follow a stated
error budget, not its observed errors. Define uncertainty treatment near tangencies,
georeferencing/control points, UTC/time-zone capture, leaf-state/source-date caveats,
device/browser inventory, cold/warm cache states, sample counts, failure reporting,
raw-artifact hashes and reproduction commands. An unresolved observational
tolerance/device availability is an explicit blocker for items 18–20, not a default
pass. Carry all 30 OIs with closure evidence and applicability; preserve lost 02a/02b
raw captures as lost and do not rerun or overwrite 02c/02d/03 in place.

**Acceptance test:** every witness in current 02 §10 maps to an item, executable
test target and independent expected-result method; every numeric threshold has
units, population, derivation/authority and failure consequence. Method agreement,
physical accuracy, allocation caps and performance targets are separately labelled.
05/06 link retained artifacts and identify region/optional blockers without
reopening settled decisions. Review the register against the coverage table below.

**Rollback condition:** post-hoc thresholds, method agreement presented as physical
truth, unsupported device guarantees or lost evidence represented as recovered.

**02 §12:** advances **OI 19, 20, 21, 23, 29**; completes **OI 30**'s deliverable
set when 04/05/06 and the phase issues are all present; records **OI 2, 4, 24–28**
as scoped blockers/deferred work, not prerequisites for fixture implementation.

## Phase B — First regional preparation

Madrid remains a historical fixture/compression and agreement-evidence location in
the documents cited above. It is not the first production activation region. The
first production build and activation target is **New York City (the five boroughs)**;
the exact municipal-boundary source, initial expanded support extent and any later
coverage expansion are pinned in its regional manifest under item 5.

### 5. Pin one region, its sources and executable datum controls

**Region-dependent. Depends on:** 4.

**Files touched:** new `server/shadow-prep/{README.md,package.json,package-lock.json,Containerfile}`,
`server/shadow-prep/regions/new-york-city-v1.json`,
`server/shadow-prep/src/{admission,datum}.ts`,
`server/shadow-prep/test/datum.test.ts`, and
`docs/shadow-engine-v2/evidence/04/preparation/{source-manifest,datum-controls}.json`;
update `06-open-questions.md`.

**Change:** start with New York City, using the five-borough municipal boundary as
the initial activation area and a declared surrounding support extent. Neither is a
completeness boundary: expand the support extent when conservative sunward bounds
require it. Pin FABDEM v1.2 assets and EGM2008→EGM96 grids/operations, Overture building/part
release with explicit OSM recipe selections, and native CHMv2 heights/masks plus
OSM fallback. Pin exact dates, URLs/revisions, hashes, horizontal/vertical frames,
rights and operation areas. Include the retained 908-edge graph and a freshly
pinned production-padding graph; the historical 4,039-edge result is a workload
witness, not a guaranteed replay count. Declare receiver/time domains, including
3°, and an expansion policy driven by unknown surrounding bounds. Retain an
explicitly incomplete boundary test. Record regional LiDAR as an upgrade admission
path; it is not required to make the admitted FABDEM baseline eligible.

Package GDAL/PROJ tooling outside the browser and install/version licensed grids.
Validate transform signs, realization, epochs and residuals using independent
controls under item 4's protocol; disable ballpark operations. Source download
errors/masks and missing grids block the relevant admission. AWS Terrain Tiles and
EU-DEM inversion are not dependencies of this direct-FABDEM first build.

**Acceptance test:** a manifest validator rejects absent fields, invalid rights,
missing grids and out-of-area transforms. Datum controls meet the preregistered
residual limits; an AGL witness receives no geoid shift. Real CHM base/mask blocks
decode with valid-zero/nodata separation. The source manifest enumerates exact
New York City support and baseline/upgrade provenance; all unresolved admissions
block the job. Historical Madrid/Kent source probes and compression fixtures do
not establish New York City source admission or datum controls.

**Rollback condition:** unavailable native support, unvalidated datum/controls or
rights mismatch. Keep New York City blocked; do not substitute the old Madrid AWS compression
capture or coarser canopy. Continue fixture items 9–16 if useful.

**02 §12:** depends on/closes **OI 1, 3, 5, 8** only for selected asset admission;
advances **OI 6, 7**. **OI 2 and 4** remain open for their unselected source paths.

### 6. Normalize complete features and emit separate component objects

**Region-dependent. Depends on:** 2, 5.

**Files touched:** new `server/shadow-prep/src/{sources,terrain,buildings,canopy,normalize}.ts`,
`server/shadow-prep/test/{normalization,sourceSeparation}.test.ts`;
update `server/shadow-prep/regions/new-york-city-v1.json` and source manifest;
new `docs/shadow-engine-v2/evidence/04/preparation/normalization.json`.

**Change:** stream native terrain/CHM blocks and whole Overture/OSM features;
resolve relations, courtyard holes, building parts, IDs, deduplication, height and
min-height/default policy before clipping. Record unsupported raised structures
as conflicts rather than pretending ground-solid v2 models an arcade. Choose a
surveyed base or full-footprint boundary median. Store terrain-derived foundations
in terrain support, independent AGL/geometry in buildings and canopy inputs under
their source licences. Apply transformations before blending; retain masks,
uncertainty and true neighbor support. Use item 1's encoder and item 2's recipe
for comparison. Emit component objects and records, never a distributable fused DSM.

**Acceptance test:** normalized real seam/part/hole/source-boundary samples pass
05's source controls; complete-feature foundations agree across clipped tiles.
Changing FABDEM alters terrain support and in-memory composed heights while
independent building/CHM objects remain unchanged. Native masks/holes survive.
Decode produced objects with the actual candidate codec/compositor and compare
canonical words to normalizer recipe evaluation. Reordering source features gives
identical results. Bound processing allocations rather than creating a regional mosaic.

**Rollback condition:** tile-local roofs, clipped-away relations, datum blending,
mask loss, implicit default heights or fused publication. Invalidate the affected
unpublished generation and fix the producer; preserve source evidence.

**02 §12:** depends on **OI 3, 5, 8, 11** for selected inputs; closes regional
extraction/composition portions of **OI 6 and 8**; advances **OI 7, 10, 11**.

### 7. Build conservative bounds and an atomic regional publication

**Region-dependent. Depends on:** 6.

**Files touched:** new `server/shadow-prep/src/{bounds,terrainPyramid,publish}.ts`,
`server/shadow-prep/test/{bounds,publication}.test.ts`,
`server/shadow-prep/publication/{manifest.schema.json,ATTRIBUTION.md}`;
new `docs/shadow-engine-v2/evidence/04/preparation/{bounds,publication}.json`.

**Change:** reduce the exact normalized z18 terrain into z17/z16/z15/z14 and
coarser min/max support with borders, vertices, provenance and unknown propagation.
Build source-separated component bounds using the same composition recipe;
terrain-dependent absolute envelopes stay terrain-derived. Publish immutable
objects, licence/evidence tables, grids' notices and ODbL derivative database or
qualifying alteration material before atomically exposing their generation
manifest. Support local artifact storage first and the R2 publisher used in item
8. Publication includes a fetchable hierarchy independent of fine-page residency.

**Acceptance test:** exhaustively check every leaf against parents for this first
region; randomized and boundary triangle rays compare hierarchy decisions with
exact leaves. Unknown children/exterior never become a clear certificate; maxima
never become opaque geometry. Interrupt publication between every stage: readers
see either the prior valid manifest or the entire new dependency set. Licence
links and derivative-data access resolve in the published artifacts. Bounds and
objects have consistent decoded/recipe identities.

**Rollback condition:** an underestimated bound, false known-empty child, mixed
manifest or missing notice/derivative access. Withdraw the generation pointer as
a unit; existing immutable valid generations remain usable.

**02 §12:** closes selected-region implementations of **OI 7 and 9**; advances
**OI 1, 11, 14**. No claim of a complete census of real obstacles.

### 8. Measure cold end-to-end preparation before device work

**Region-dependent. Depends on:** 3, 5–7. **Hard predecessor of all target-device
work and of item 19**, even if later fixture implementation has proceeded.

**Files touched:** new `server/shadow-prep/{fly.toml,src/jobs.ts,src/measure.ts}`,
`server/shadow-prep/test/restart.test.ts`,
`docs/shadow-engine-v2/evidence/04/preparation/{cold-build.json,restart.json,costs.json,README.md,SHA256SUMS}`;
update `server/shadow-prep/README.md` and `06-open-questions.md`.

**Change:** make one region reproducibly preparable from pinned raw sources through
validated normalization, separate objects, bounds, notices and R2 manifest, then
consume the published generation with the actual decoder/compositor and CPU
fixture-capable kernel. Run on the selected **Fly performance-1x, 2 GB, one active
preparation process** configuration. Define a cold run's grid/source/cache state
explicitly. Measure input/output and request bytes, CPU and wall time, peak RSS,
scratch, queue delay, restart/retry behavior and billed/configured cost components.
Retain full raw records; repeat completed cold runs under the sample protocol in
05 and include failure attempts. Rerun the unchanged fixture agreement gate after
producer changes. This does not require the full app renderer or a phone.

**Acceptance test:** one complete native-canopy, datum-correct New York City build
finishes end to end within the declared 2 GB host and configured scratch limits;
kill/restart resumes safely without duplicate active jobs or partial publication.
A second build from identical inputs reproduces decoded objects/bounds identities.
Report actual first-region latency and all-in measured/scenario cost components
separately; replace neither with 02b's $35.24/month or 03's 506-tile estimate.
Document preparation throughput and queue sizing supported by those observations,
plus remaining uncertainty. Credentials/host access or missing source controls
leave this item blocked, never “passed locally.”

**Rollback condition:** OOM, excessive scratch, nonrecoverable jobs, missed source
admission or an infeasible measured preparation/cost envelope. Rework bounded
preparation and its sizing before device qualification; if a different host or
scope is necessary, record the explicit revised decision and repeat this checkpoint.
No device optimization can waive this risk or turn a new region into a CDN-only miss.

**02 §12:** closes **OI 10** for the measured host/recipe/region; advances regional
readiness **OI 1** and delivery **OI 11**. Broader-region scaling remains unmeasured.

## Phase C — Worker queries and callers

### 9. Complete shared solar, coordinates and CPU numerical semantics

**Fixture-only. Depends on:** 3–4. May proceed if phase B is region-blocked.

**Files touched:** new `app/lib/shadowField/v2/{solar,coordinates}.ts`,
`app/lib/shadowField/v2/__tests__/{solar,march,coordinates}.test.ts`;
extend `v2/{march,receivers,treeModel,types}.ts`.

**Change:** extend the gate's production kernel to terrain triangles, ground-solid
buildings, elevated transmissive crowns and independent building-only evidence.
Use positive-length intersections, simultaneous corner advances, one-quantum ground/
roof and outward wall bias, vertical-sun handling, integer subtraction before
Float32 conversion, ground-scale latitude updates and geographic/tangent-frame
long-ray transport. No source-building skip or coarse-hit substitute. Keep canopy
transmission as minimum intersected tau, independent of step count; continue for
later opaque/building-only hits when required. Share SunCalc 1.x/2 km cells, exact
UTC keys and the single NOAA correction/night convention from 02 §8.

**Acceptance test:** item 4's independent analytic cases cover negative heights,
seams, grazing/corner intersections, antimeridian, 0°/40°/60° metric-equivalent
scenes, a 15 km ridge in the tangent frame, invalid night and elevated surfaces.
Frozen solar cases verify correction once, cell/time identity and no camera
dependence. Quantization/bias error is reported separately from source error.
The early agreement gate still passes with its fixture sun.

**Rollback condition:** numerical disagreement outside declared tolerances,
step-dependent canopy, silent ray cutoff or renderer-only solar convention.

**02 §12:** advances **OI 17, 20**; observed solar/physical validation remains
item 18, GPU conformance item 13, device work limits item 19.

### 10. Add bounds-driven acquisition, the shared ledger and continuations

**Fixture-only. Depends on:** 2, 9.

**Files touched:** new `app/lib/shadowField/v2/{bounds,acquisition,pageStore,memoryLedger}.ts`,
`app/lib/shadowField/v2/__tests__/{acquisition,streaming,memoryLedger}.test.ts`;
extend `v2/{march,types}.ts`.

**Change:** plan continuous sidewalk strips/endpoints/disconnected components and
visible surface receivers against pinned component bounds. Unknown outer support
cannot be bounded by loaded maxima. Use lower-altitude uncertainty, spatial guard
and conservative terrain refinements; an ambiguous building/crown needs exact
component inputs. Reserve before fetch/decode/composition/upload, page the index
and lease per subscriber. Encode resumable receiver/DDA/triangle/transmission/
independent-hit/completeness state; bounded work exhaustion is incomplete.

Implement the **192 MiB managed target** as explicit 160/16/8/8 MiB categories from
02 §7, counting component inputs, all copies, staging, continuations, targets and
old/new generations. Reserve the additional 64 MiB runtime/driver increment for
later measurement. Remove no caster or route sample to meet a cap. Finite fixture
bounds may be generated analytically; production must consume item 7's hierarchy.

**Acceptance test:** injected missing leaves, unknown exterior, wrong generation,
deadline and reservation failures never produce complete clear results. Forced
one/few-page traversal equals resident exact evaluation, including interruption
inside a crown/terrain triangle and subsequent building-only traversal. Ledger
charges are balanced through cancellation/eviction/errors and never exceed caps.
Synthetic distant tower/canopy/ridge demand survives offscreen movement and lower
sun. `alphaLower<=0` does not acquire a fabricated finite clear proof.

**Rollback condition:** eviction breaks a live lease, a skipped interval changes
results, an allocation is uncharged or memory pressure changes geographic physics.

**02 §12:** advances **OI 9, 11–13, 17**. It enforces allocations on fixtures;
it does not close phone or readiness feasibility.

### 11. Expose cancellable worker jobs and the versioned service facade

**Fixture-only. Depends on:** 10.

**Files touched:** new `app/workers/shadowTiles.worker.ts`,
`app/lib/shadowField/v2/{service,workerProtocol}.ts`,
`app/lib/shadowField/v2/__tests__/{service,workerProtocol}.test.ts`,
`e2e/shadowV2Worker.spec.ts`, `e2e/fixtures/shadowV2Worker.html`;
update `app/lib/shadowField/ShadowField.ts` and `providers.ts`.

**Change:** provide async `shadowAt`, `sampleEdges`, `sweep`, readiness and coverage
facades from 02 §3 while preserving a separately constructible legacy service.
Worker owns authoritative pages; main holds only transient upload buffers/results.
Carry request/subscriber/generation/model/receiver/solar/material identities,
ordered times/edges, one absolute deadline and explicit cancel messages. Use fair,
bounded yielding chunks, latest-only publication, progress for day jobs, shared
leases and immutable exact-result caches. Worker failure rehydrates pinned objects.

**Acceptance test:** deterministic race tests cancel pan while route leases survive,
supersede day/spot/graph requests and reject late/old-generation results. A 15-time
sweep preserves input order and a settled request completes after obsolete jobs
are removed. Worker termination/restart rebuilds identical evidence; queries run
without WebGL and never read canvas. Browser fixture uses the real worker/codec/
compositor; heartbeat/cancel delivery is observed, without a phone-speed claim.

**Rollback condition:** synchronous production batching persists, a stale answer
publishes, worker failure fabricates zero or upload ownership creates a hidden
third persistent field.

**02 §12:** advances **OI 16**, supports **OI 22**, depends on fixture **OI 11–12**
implementations; regional/device recovery remains items 17–19.

### 12. Define null costs and convert every caller behind the candidate pair

**Fixture-only. Depends on:** 11.

**Files touched:** `app/hooks/{useNavigation,useHourlyExposure}.ts`,
`app/lib/{routing,shadowProvenance,shadowSampling,bestTime,savedRoutes}.ts`,
`app/lib/agent/tools.ts`, `app/lib/shadow/offscreenShadow.ts`,
`app/components/{RouteCard,NavigationStatusPanel,HourlyExposureStrip}.tsx`;
new `app/lib/shadowField/v2/routingPolicy.ts`,
`app/lib/shadowField/v2/__tests__/routingPolicy.test.ts`,
`app/hooks/__tests__/shadowV2Callers.test.ts`,
`docs/shadow-engine-v2/contracts/routing-evidence.md`.

**Change:** resolve OI 15 explicitly before wiring costs: specify how invalid,
unsupported and partially valid left/right sides affect admissibility, cost,
fallback and UI; set uncalibrated confidence priors/attenuation in the contract.
Unknown cannot receive a shade reward. Neither 0.8 nor the corpus's ≤25% invalid
ceiling is an automatic production penalty/edge threshold. If product tradeoffs
need owner input, record concrete options and keep dependent integration blocked.

Await one frozen-time graph batch before weights/search in normal, sketch,
recalculation and assistant paths. Keep both sidewalks/canonical direction, chosen-
path distance-weighted provenance and terrain/source exhaustiveness. Preserve the
shared 2500 ms readiness allowance across broad/exact/all-source acquisition.
Day/selection/offset changes request the selected route's 06:00–20:00 series;
same-day clock changes leave calculation-time statistics stored and labelled.
Explicit canvas fallback remains building-only `canvas` evidence, never a complete
terrain/canopy answer. Isolate legacy callers during candidate construction.

**Acceptance test:** policy table tests prove null is never numeric shade, an empty
side cannot hide in its partner's confidence, valid night and evaluated sun stay
distinct, and fallback provenance survives chosen-path aggregation. Controlled
out-of-order promises prove timestamp/cancellation behavior through every caller.
Instrument search to show zero per-relaxation queries; day scrubbing coalesces,
same-day dragging schedules no automatic route resampling. Saved old results retain
their timestamp/version. Typecheck catches remaining numeric-only consumers.

**Rollback condition:** routes favor missing data, sidewalks collapse, stale stats
publish, or compatibility fallback claims combined completeness.

**02 §12:** closes the policy/integration portions of **OI 15–16** after their tests;
advances **OI 13, 21**. **OI 27** remains explicitly deferred.

## Phase D — Renderer and retained features

### 13. Render numeric ground results from the shared pages

**Fixture-only. Depends on:** 9–11. No target-device qualification in this item.

**Files touched:** new `app/lib/shadow/v2/{fieldRenderer,shaders,gpuPages}.ts`,
`e2e/shadowV2Numeric.spec.ts`, `e2e/fixtures/shadowV2Harness.html`;
update `app/lib/shadow/{LocalShadowAdapter,IShadowLayer}.ts` and
`app/workers/sunPosition.worker.ts`.

**Change:** implement WebGL2 integer page mirrors, numeric total shade/transmission,
building-only output and completeness from the candidate kernel semantics. Share
float-rounded solar/material inputs and identities with the worker; remove the
0.15° dirty shortcut from candidate authoritative time. Use budgeted receiver
targets, transient uploads and continuation passes through the shared ledger.
An incomplete new-time frame stays pending or retains a labelled older complete
frame. Context recovery rebuilds the mirror without stopping worker queries.

**Acceptance test:** actual GPU output versus actual worker output at matched
receivers/time/generation meets 05's numeric tolerances, including fractional
canopy, validity, seams, interrupted refinements and independent building-only
termination. Software-WebGL fixtures exercise the real shader rather than 02c's
probe. Corrupt generation/page/cursor inputs fail explicitly. Both agreement suites
still pass; no binary blue-pixel test substitutes for fractional numeric equality.

**Rollback condition:** divergent CPU/GPU physics or identities, a partial frame
looks complete, context recovery changes answers or target/staging bytes escape
the ledger. Keep the candidate renderer inactive in the shipping factory.

**02 §12:** advances **OI 12, 17, 20–21**; device performance remains unqualified.

### 14. Integrate roof/wall receivers, masks and stable canopy display

**Fixture-only. Depends on:** 12–13.

**Files touched:** new `app/lib/shadow/v2/surfaces.ts`,
`e2e/shadowV2Surfaces.spec.ts`;
update `app/lib/shadow/{LocalShadowAdapter,IShadowLayer,heightField}.ts`,
`app/lib/canopyRaster/{canopyLayer,canopyPaint,sharedStore}.ts`,
`app/components/MapView.tsx`, `scripts/verify/{shadow_truth,shadow_readback,wall_shadow_alignment}.py`.

**Change:** generate receiver roof/wall boundaries from canonical occupancy and
actual heights, merge only valid equal-height faces and retain provenance. Apply
surface-normal bias without arbitrary repair of vector walls inside expanded
casters. Support above-roof canopy shadows. Preserve the dedicated building mask's
byte/origin/DPR contract, canopy-fill invariants, layer ordering, GL cleanup and
blue styling. Avoid the old mandatory full-size mask copy. Drive candidate canopy
extent from normalized support with stable coordinates and retire its parallel raw
physics/cache ownership when the pair activates. Candidate old/new-frame state
includes timestamp/completeness; no per-source production toggle.

**Acceptance test:** software-WebGL pitch/roof/wall/courtyard/crown fixtures agree
with numeric worker surface queries. Verify mask isolation and origin/DPR at
multiple viewport sizes, pan/context recovery, canopy holes and 01's two pixel
positions. Sunward and anti-sunward wall rays, seams and actual-height roofs pass.
Canopy extent remains fixed across time while elevated-crown shadows may move.
Agreement/canopy-fill suites pass under all admitted display sampling modes.

**Rollback condition:** floating walls, lost holes/air gaps, mask contamination,
unbudgeted raw caches, layer regressions or independent canopy physics remaining
active in a candidate session.

**02 §12:** advances **OI 11–12, 17–18, 21**; full device validation is item 19.

### 15. Implement the explicit offline package and rehydration

**Fixture-only. Depends on:** 11–14.

**Files touched:** new `app/lib/shadowField/v2/offline.ts`,
`app/lib/shadowField/v2/__tests__/offline.test.ts`, `e2e/shadowV2Offline.spec.ts`;
update `public/sw.js`, `app/lib/savedRoutes.ts`, `app/components/MapView.tsx`.

**Change:** persist graph, app/relevant basemap assets, canonical components,
bounds, manifests, source licences and versioned coverage together. Implement
storage eviction, corruption checks and rehydration; compressed disk storage does
not exempt decoded bytes from the ledger. Saved coverage declares its supported
domain rather than promising every new low-sun time.

**Acceptance test:** disconnect browser fixtures after packaging; worker restart
and context loss recover identical results for covered times. New directions or
missing/evicted corridors report incomplete. Version mismatch, quota failure and
partial saved packages cannot publish ready coverage. Retain graph/time/source
identity in saved routes and notices in downloadable packages.

**Rollback condition:** offline fabricated sun, a stale package silently reused
under new versions or storage eviction breaks active leases.

**02 §12:** closes fixture implementation of **OI 22**; actual regional offline
claims remain gated by items 17 and 19.

### 16. Implement exposure integration and numeric GeoTIFF export

**Fixture-only. Depends on:** 11, 13–15, and item 4's integration tolerances.

**Files touched:** new `app/lib/shadowField/v2/{exposure,numericExport}.ts`,
`app/lib/shadowField/v2/__tests__/{exposure,numericExport}.test.ts`,
`e2e/shadowV2Exposure.spec.ts`;
update `app/components/AccumulationPanel.tsx` and
`app/lib/shadow/{IShadowLayer,LocalShadowAdapter}.ts`.

**Change:** replace the candidate local exposure no-op with a cancellable pinned
grid/time job integrating direct transmission × elapsed hours. Prepare and stream
the union of times/directions within the same budgets. Retain daylight, valid and
complete duration; missing samples are nodata rather than zero sunlight. Export
Float32 numeric GeoTIFF with CRS/geotransform, units, time/integration parameters,
nodata/valid-duration bands and source/model/attribution metadata. Label any retained
RGB export visual. Annual/server execution remains optional, with no invented
throughput claim or hidden remote dependency.

**Acceptance test:** analytic constant-transmission and controlled transitions
meet 05's convergence/error limits. Independent GeoTIFF decoding verifies Float32
values, coordinates, duration/nodata and metadata. Cancellation/supersession never
fires successful completion or overwrites a newer result. Unknown solar domains
reduce complete duration visibly; memory remains bounded.

**Rollback condition:** RGB presented as numeric exposure, null becoming zero sun,
incorrect georeferencing/duration, false completion or uncontrolled grid allocation.

**02 §12:** closes implementation portion of **OI 23**; regional throughput/export
qualification remains item 19. **OI 24–25** are not required accelerators.

## Phase E — Regional and device qualification

### 17. Qualify deployed delivery and regional workload coverage

**Region-dependent. Depends on:** 8, 10–16.

**Files touched:** new `e2e/shadowV2Delivery.spec.ts`,
`server/shadow-prep/test/cdn.test.ts`,
`docs/shadow-engine-v2/evidence/05/delivery/{requests.json,coverage.json,README.md,SHA256SUMS}`;
update `server/shadow-prep/regions/new-york-city-v1.json`, `05-validation.md`, `06-open-questions.md`.

**Change:** exercise real R2 custom-domain objects through the actual acquisition,
codec/compositor, worker and candidate renderer. Verify GET/HEAD, ranges where
used, CORS/exposed metadata, ETags/revisions, partial/corrupt bodies, retries,
throttling and cache recovery. Test whole objects even if canonical transport does
not use ranges. Expand and rebuild surrounding bounds where the requested domain
requires them; every source remains in the proof. Include the retained 908-edge
graph, the newly pinned production-padding graph, broader sparse/dense workloads,
selected-day and session direction unions, concurrent subscriptions and changed
source generations. Record actual separate-object wire/header/metadata bytes and
decode/composition peaks. Exercise regional offline packages and deadline failures.

**Acceptance test:** manifests and notices resolve; faults never become empty
support or mixed versions. Measure cold/warm success, errors and tails under 05,
including the **single 2500 ms shared readiness** allowance without resetting it
per phase/source. Record complete versus incomplete receiver/time domains and all
outside-region requests; extend coverage or explicitly exclude unsupported claims.
Replace 40-read/20 MiB/session and fused D1 projections with measured session
unions and separate-object results. This host/browser run is not phone admission.

**Rollback condition:** false completeness, broken deployed HTTP/version behavior,
unbounded retries or required workload coverage not prepared. Withdraw candidate
regional eligibility; fix/rebuild/retest before device qualification uses it.

**02 §12:** closes **OI 14** and regional delivery portions of **OI 1, 7–9, 11, 13**
within the tested envelope; phone deadlines still depend on item 19.

### 18. Validate physical geometry, optical priors and shared solar

**Region-dependent. Depends on:** 4, 8–9, 13–14, 17.

**Files touched:** new `scripts/verify/shadow_v2_accuracy.py`,
`docs/shadow-engine-v2/evidence/05/accuracy/{observations.json,solar.json,report.md,SHA256SUMS}`;
update `05-validation.md` and `06-open-questions.md`.

**Change:** collect the preregistered georeferenced/timestamped observed shadows
and independent solar/control calculations for the admitted New York City region. Evaluate
ground/roof/crown placement and height errors separately from model discretization,
source date and optical priors. Include dawn/low-sun dates, 2 km solar-cell errors,
NOAA apparent-altitude correction and angular acquisition margins. Compare SPA
only through a documented licensed/independent evaluation; no automatic provider
replacement. Keep canopy underside/transmission/trunk omissions visibly prior-based.

**Acceptance test:** analytic cases and actual CPU/GPU matched outputs pass, then
observations meet 05's predeclared physical/solar tolerances with residuals, sample
counts, worst cases and uncertainty retained. No candidate-produced raster serves
as its own physical oracle. Missing credible observations or unexplained residuals
block validation acceptance; two matching Umbra implementations do not waive it.
Historical Madrid agreement and compression evidence cannot substitute for these
New York City observations.

**Rollback condition:** independent accuracy/solar failures, unsupported acquisition
margins or observations inconsistent with the selected source/model. Restrict
candidate eligibility or repair the shared model/source and rerun both consumers'
gates; never hide the failure with a shader-only correction.

**02 §12:** closes validation portions of **OI 5, 17, 19–20** only for recorded
tests/domains. SPA replacement and calibrated higher-order optics remain deferred.

### 19. Qualify full-app phone memory, streaming and event performance

**Region-dependent. Depends on:** 8, 12–18. This is the first target-device item;
no hardware/phone tuning or performance certification precedes the cold-build pass.

**Files touched:** new `playwright.shadow-v2.config.ts`,
`e2e/bench/shadowV2.bench.spec.ts`,
`docs/shadow-engine-v2/evidence/05/devices/{protocol.md,results.json,admission.json,SHA256SUMS}`;
update `05-validation.md`, `06-open-questions.md` and, only when measurements justify
it, `app/lib/shadowField/v2/{memoryLedger,workerProtocol}.ts` plus their tests.

**Change:** measure named hardware GPUs and target phones with full app/graph/
basemap, actual native-canopy region and production renderer. Include normal,
sketch, assistant/spot, selected-day, same-day drag/play, pan, pitched walls,
shader compile, upload, mask readback, decode/composition, worker fairness,
context loss, generation overlap, offline recovery and daily/annual exposure.
Stress open terrain, distant ridges, dense crowns and long divergent rays as well
as dense opaque streets. Compare exact streamed versus resident reference outputs
and record refinement/page ratios. Set a deterministic work limit per admitted
profile with explicit incomplete behavior.

**Acceptance test:** meet 05's preregistered event/latency protocol and preserve all
correctness gates. Demonstrate allocations ≤192 MiB managed in the 160/16/8/8
categories, measure the runtime/driver increment against its 64 MiB reserve and
whole-app peak, and reduce admission/reject profiles that fail. Complete 3° claims
require actual complete proofs and readiness within the same 2500 ms allowance;
otherwise explicitly retain incomplete low-sun coverage for that profile/domain.
That failure does not authorize a relaxed ceiling or an unconditional 3° release.
Report 30/50 ms event cadence and <500 ms cached-route target separately from
observed results; no earlier SwiftShader/kernel benchmark counts as a pass.
Verify exposure convergence, throughput and regional Float32 round-trip; qualify
only tested offline/exposure modes, leaving annual/server claims unmeasured if so.

**Rollback condition:** OOM/context instability, hidden allocations, missed required
readiness/event targets, stale frames, conformance failures or output density that
breaks compatibility. Reduce concurrency/display density within settled semantics
and requalify, or deny that profile; do not lower caster lattice, remove samples,
clamp sun or claim all 232 tile pairs fit. Preparation changes return to item 8.

**02 §12:** closes tested-profile **OI 12–13, 16–17, 21–23** and the device portion
of **OI 11**. Records residual 3° limitations; remote overflow **OI 24** is not a
silent remedy and does not solve renderer demand.

## Phase F — Joint activation and handoff

### 20. Activate and rehearse rollback of the complete pair

**Region-dependent. Depends on:** 1–19 and a recorded admitted region/device/mode
envelope. Every applicable activation blocker must have linked passing evidence.

**Files touched:** new `app/lib/shadowField/v2/enginePair.ts`,
`app/lib/shadowField/v2/__tests__/enginePair.test.ts`,
`e2e/shadowV2Activation.spec.ts`,
`docs/shadow-engine-v2/evidence/05/activation.md`;
update `app/lib/shadow/createShadowLayer.ts`, `app/lib/shadowField/{ShadowField,providers}.ts`,
`app/components/MapView.tsx`, `app/page.tsx`, `app/lib/canopyRaster/sharedStore.ts`.

**Change:** use one engine-pair selector to construct renderer and worker facade
with matching canopy/model/solar/receiver versions and manifest compatibility.
Retire parallel active legacy tree physics/raw caches only when that pair switches.
Publication requires matching identities, not simultaneous residency of every page.
Keep a rollback-capable legacy pair and invalidate/cancel v2 results when reverting.
Unsupported or unprepared domains within a v2 session report pending/unavailable;
never silently route with legacy while displaying v2. Stage releases only as
complete pairs within the admitted envelope, never renderer-first/query-first.

**Acceptance test:** exercise candidate→legacy→candidate, mid-job rollback,
worker/context failure, missing artifacts and revision changes. Assert every
published frame/query carries its selected pair identity; zero mixed-authority
results and no stale route/assistant/exposure publication. Run both agreement gates,
numeric/analytic suites, browser normal/sketch/assistant/offline/export flows and
repository lint/typecheck/test/build/required smoke checks. Rehearse rollback
without deleting artifacts. Release record cites items 8 and 17–19 and lists any
explicitly incomplete domains/modes instead of broad global/3°/accuracy promises.

**Rollback condition:** any pair/version mismatch, applicable gate failure,
regressed product behavior or unsupported activation claim. Restore the entire
previous pair in one operation and requalify before reactivation.

**02 §12:** verifies closure evidence for applicable **OI 1, 3, 5–23, 29–30**;
conditional/unselected **OI 2, 4** and extension-only **OI 24–28** do not block
the base pair. This item creates no new permission to waive unresolved base gates.

### 21. Seal the release evidence and executable follow-up register

**Region-dependent. Depends on:** 20.

**Files touched:** `docs/shadow-engine-v2/{04-implementation-plan,05-validation,06-open-questions}.md`,
`docs/notes/evidence.md`; new
`docs/shadow-engine-v2/evidence/05/{release.json,README.md,SHA256SUMS}`.

**Change:** record the activated revision, source/format/model hashes, region/device
envelope, raw measurements, failures, rollback exercise and exact reproduction
commands. Link phase issues to evidence before closing them. Retain historical
02c/02d/03 artifacts unchanged, the eight named severe readings and 1.0 worst
reference result. Carry source-quality limits, lost raw captures and every remaining
OI with consequence, next evidence and responsible follow-up; avoid claiming vendor
parity from unverified live ShadeMap details.

**Acceptance test:** a clean checkout can reproduce fixture gates and decode the
release manifest; documented artifact access reconstructs the admitted regional
tests without this conversation or `/tmp`. Hashes verify retained evidence and
05/06 distinguish completed, blocked and deferred work. No claimed metric lacks
method, hardware, sample count and worst case. Close a phase issue only when its
own item acceptance evidence exists, not when this plan is written.

**Rollback condition:** unreproducible/missing evidence or reporting that exceeds
the admitted envelope. Reopen the affected issue/claim; if a release prerequisite
cannot be substantiated, execute item 20's paired rollback.

**02 §12:** closes release retention **OI 29** and handoff **OI 30**; preserves
**OI 2, 4, 24–28** and all region/profile-specific residuals in 06.

## Open-item coverage and stopping boundaries

This index routes every [02 §12](./02-architecture.md#12-numbered-open-items-and-blocking-phase)
open item to its implementation/validation evidence. It does not mark work complete.

| OI | Responsible work items | Remaining scope or condition |
|---|---|---|
| 1 | 5, 7–8, 17, 20 | Initial New York City build; each further region needs its own support/activation record |
| 2 | 4, 21 | AWS delivered datum stays unadmitted; direct FABDEM path bypasses it |
| 3 | 5–6, 18 | Executed transforms/controls per asset and realization |
| 4 | 4, 21 | EU-DEM/EGG08 inversion remains conditional on selecting that source |
| 5 | 5–6, 18 | FABDEM quality/transform and individually admitted LiDAR upgrades |
| 6 | 2, 5–6, 14, 18 | Complete-feature extraction and physical/surface validation |
| 7 | 1, 5–7, 15–17 | Separate publication, independent notices and derivative-data access |
| 8 | 2, 5–6, 17–18 | Native CHM/masks/overlap and real source quality |
| 9 | 7, 10, 17 | Conservative normalized hierarchy; exterior unknown retained |
| 10 | **8** | Must pass before target-device work; no local-only substitute |
| 11 | **1–2**, 6–8, 10, 17, 19 | Format/compositor first; separate-object costs qualified later |
| 12 | 10, 13–14, **19** | Budget enforcement is distinct from phone feasibility |
| 13 | 10, 12, 17, 19 | Production graphs, unions, deadlines and incomplete domains |
| 14 | 7–8, **17** | Actual R2/custom-domain behavior and source reliability |
| 15 | **12**, 20 | Concrete null/confidence policy before caller activation |
| 16 | 11–12, 19–20 | Async jobs and end-to-end cancellation/publication |
| 17 | 3, 9–10, 13–14, 18–20 | Full numerical/surface conformance across both consumers |
| 18 | **3**, 14, 21 | Retain original gate/tail; no width clamp or graph repair |
| 19 | 4, **18** | Independent physical observations; priors stay labelled |
| 20 | 9, 13, **18** | Shared solar qualified; SPA replacement is separate future work |
| 21 | 4, 12–14, **19** | Real hardware/full-app event qualification |
| 22 | **15**, 17, 19 | Regional offline claims need actual persisted support |
| 23 | **16**, 19 | Numeric export/integration and measured throughput |
| 24 | 4, 21 | Remote overflow deferred; no deployment in base plan |
| 25 | 4, 21 | Horizon acceleration deferred; no required atlas/precompute |
| 26 | 4, 21 | Penumbra, stems, calibrated optics and higher-order geometry deferred |
| 27 | 4, 12, 21 | Automatic current-time route-card refresh deferred |
| 28 | 4, 21 | Vendor deployment unknowns retained; no base implementation dependency |
| 29 | 4, 8, 17–19, 21 | Durable scoped evidence, including failures and known losses |
| 30 | This 04 and its phase issues; 4, 21 | 05/06 are future work in item 4; this session stops at the plan/issues |

**Handoff boundary:** item 1 has concrete paths, inputs, entry points, test commands,
failure behavior and no regional or conversational prerequisite. No implementation,
new source probe or device experiment is required to finish this planning session.

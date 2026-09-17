# Handoff — NYC remote field delivery, rendering, and routing

**Verified 2026-09-15.** Checked-out head: `3f41e9c` (`feat/e5-trip-model`). Relevant
unmerged local head: `394830b` (`feat/nyc-browser-pack-smoke`). Common ancestor:
`5d48825`. The working tree was clean when this handoff was written.

This is a multi-PR implementation thread. Take **one PR at a time**, starting from the latest
accepted base after rechecking the state below. Do not treat a later PR as permission to skip
an earlier gate. Do not merge PRs; that remains the owner's action.

## Goal

Make the existing NYC field generation usable by the application without redoing the source
acquisition:

```text
normalized NYC terrain/building/canopy candidates
                  ↓
immutable z18 .smb bundles in R2
                  ↓
Cloudflare delivery Worker / CDN
                  ↓
browser worker: fetch, verify, decode, compose, cache, query
                  ├── WebGL2 field renderer
                  └── batched route-edge shade values
```

Cloudflare owns immutable storage and delivery. The browser owns interactive computation:
decompression/composition in a Web Worker, frame rendering on the local GPU, and batched route
sampling/search on the client. Do not add a request-per-edge Cloudflare query path.

## State to recheck before starting

Run:

```bash
git fetch --all --prune
git status --short
git show -s --format='%h %D %s' origin/main feat/nyc-browser-pack-smoke feat/e5-trip-model
git merge-base feat/nyc-browser-pack-smoke feat/e5-trip-model
curl -fsS https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev/_shadow/current.json
```

As verified on the date above:

- The shipping factory still always constructs `LocalShadowAdapter`.
- `LocalShadowAdapter` still reads `maptiler_planet/building` and never reads `.smb` data.
- `feat/nyc-browser-pack-smoke` contains the SMB1 bundle, full packer, Cloudflare allow-list
  Worker, R2 generation, and `current.json` catalog client.
- The active pointer names generation
  `nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v1` with 61,442 tiles.
- The immutable manifest is about 46.9 MB. It is not an acceptable viewport membership index.
- The bundles total about 2.466 GB; mean bundle size is about 40 KB, p95 about 59 KB, maximum
  about 76 KB.
- A composed 258×258 six-plane tile is 1,597,536 bytes. The 17 decoded input planes add
  4,526,352 bytes before temporary decoder, main-thread staging, and GPU copies. Budget bytes,
  not merely tile count.
- A z18 tile is about 116 m wide in NYC and occupies 256 CSS pixels at map zoom 18. A centered
  3×3 diagnostic set therefore begins around **map zoom 20**, not map zoom 18.

## Existing defect that must not be normalized away

The active bundles contain building masks and heights, but sampled building components declare
`support: "known-empty"`. Times Square's sampled bundle has 30,558 nonzero building-mask cells.
The producer allocates `buildingSupport` as zero and never fills it, while `supportCounts`
counts zero as empty. `compose.ts` also carries a contradictory support-value comment.

This is a support/evidence defect, not missing building geometry. Fix and repack from the
existing immutable normalized candidates. Do not redownload the raw sources or rerun GDAL
terrain/canopy normalization unless a new finding proves the physical planes themselves wrong.

## Invariants for every PR

- Keep MapLibre pinned at exactly 5.9.0 and preserve `preserveDrawingBuffer: true`.
- `LocalShadowAdapter` remains the shipping fallback until PR 8 activates a qualified pair.
- No partial or missing remote coverage may be presented as clear/unshadowed.
- Pin generation, recipe, datum, hierarchy, solar, tree-model, and receiver identities through
  worker results and rendered frames. Never mix generations inside a query or frame.
- Renderer and routing must eventually consume the same composed pages and solar semantics.
- No network request per road edge or per animation frame.
- Abort/supersession must prevent stale publication even if the underlying fetch finishes.
- Preserve the blue-dominant visible-shadow contract and the building-only mask contract.
- Keep data attribution and component licences accessible with the promoted generation.
- Feature flags default off until PR 8.

---

## PR 1 — Land and harden the browser-pack transport foundation

**Purpose:** bring the already-built bundle/catalog/Cloudflare work onto the current accepted
base without changing the selected renderer or routing behavior.

### Start state

Start from the latest `origin/main` after checking whether E5 and the browser-pack work have
merged. The two verified local branches diverge from `5d48825`; do not assume either contains
the other. Prefer replaying the browser-pack commits in order or a reviewed merge over copying
individual files without history. Resolve `app/page.tsx` against the latest application state.

### Scope

- Bring in and review:
  - `app/lib/shadowField/v2/bundle.ts`
  - `app/lib/shadowField/remoteCatalog.ts`
  - `server/shadow-prep/src/{pack,pack-cli,pack-full-cli}.ts`
  - pack tests and storage additions
  - `cloudflare/shadow-data-worker/**`
  - AWS batch submission/configuration changes used by the completed pack
  - `.env.example` and `app/vite-env.d.ts`
- Keep the current pointer fetch out of ordinary user-facing readiness UI. A successful
  `current.json` request proves catalog reachability, not loaded or renderable tiles.
- Keep the R2 bucket private and the Worker path allow-list narrow: `current.json`, immutable
  generation manifest/index/notices, and immutable `.smb` tiles only. No list, raw candidate,
  normalized-plane, write, or arbitrary-key access.
- Add focused tests for malformed pointer paths, generation traversal attempts, bundle framing,
  overlapping/out-of-range entries, wrong kind/tile, truncation, and component corruption.
- Document local-development access. The verified staging Worker allows the production origin,
  not `localhost`; either add a Vite same-origin development proxy or an explicit nonproduction
  Worker environment. Do not weaken production CORS to `*` merely to make local testing work.

### Explicitly out of scope

- Fetching viewport tiles.
- New map layers.
- Changing `createShadowLayer`.
- Correcting or promoting the active generation.
- Routing changes.

### Acceptance

- Existing app behavior and network behavior are unchanged when `VITE_SHADOW_API_BASE` is unset.
- Catalog and bundle tests are hermetic and do not require Cloudflare credentials.
- A manual/staging smoke can load and parse `current.json` through the intended dev path.
- The public Worker still rejects unlisted keys and methods.
- No UI says “NYC shade data ready” based only on the pointer.

### Verify

```bash
npm test -- app/lib/shadowField/v2
npm --prefix server/shadow-prep test
npm run typecheck
npm run lint
npm run build
```

### Stop/rollback

Stop if integration changes current MapTiler shadows, routing, app startup without configuration,
or exposes any raw/candidate storage prefix.

---

## PR 2 — Publish a corrected, browser-consumable generation contract

**Purpose:** correct support semantics and add small coverage/bounds/notices artifacts so the
client does not need the 46.9 MB manifest merely to decide which tiles exist.

### Contract decisions to settle in code and tests

- Define named cell-support constants in one shared module. Occupancy belongs in
  `buildingMask`/`canopyMask`; source support must not be inferred from occupancy.
- For the admitted NYC building extract, cells covered by the source are known even where
  `buildingMask` is zero. Unknown remains distinct from observed absence.
- A component cannot declare `known-empty` when its occupancy mask contains a present cell.
- All three embedded components must agree on generation, tile, recipe, datum, hierarchy, and
  applicable model identities before composition.
- Verify the outer bundle's transport/physics records instead of treating unused directory
  fields as documentation.

### Scope

- Fix `buildingSupport` production and the contradictory support comment/interpretation.
- Add producer and decoder invariants for component support versus masks.
- Add a deterministic repair/repack path from the existing immutable candidate planes. Record
  the repair as a versioned pack recipe; do not mutate the old generation or old candidate
  objects in place.
- Produce compact immutable artifacts, each hash-pinned by the new pointer:
  - tile membership/coverage index suitable for startup use;
  - conservative per-component leaf bounds and reduced hierarchy needed by PR 4;
  - attribution/licence notices;
  - immutable detailed manifest retained for audit, not normal viewport startup.
- Extend `ShadowCurrent` with exact artifact paths and SHA-256 hashes. Bump its version if the
  existing strict parser cannot remain unambiguous.
- Build the hierarchy from normalized selected fields. At minimum retain coverage state,
  `minG/maxG`, maximum absolute building top, maximum crown top, and child identity with outward
  conservative reduction. Outside the index is unknown.
- Upload under a new immutable generation, verify every object, then promote `current.json`
  last. Preserve the old generation for rollback.

### Tests

- Nonempty building mask + `known-empty` component must fail.
- Known source coverage + zero occupancy remains valid known absence.
- Unknown cells survive composition as unknown.
- Every leaf is represented once in coverage and enclosed by every hierarchy ancestor.
- Corrupt/mismatched coverage, bounds, notices, manifest, bundle, or hash fails closed.
- Interrupted upload cannot change `current.json`.
- Re-running identical repair/pack inputs produces identical generation objects.

### Acceptance

- Times Square and named samples in all five boroughs report building support consistently with
  their nonzero masks.
- The browser can determine membership and acquire bounds without downloading the full manifest.
- Pointer, indexes, notices, manifest, and bundles all share one verified generation identity.
- Promotion evidence records object counts, byte totals, hashes, and sampled decode/composition.
- No source redownload or full physical normalization rerun occurred unless separately justified.

### Verify

```bash
npm test -- app/lib/shadowField/v2
npm --prefix server/shadow-prep test
npm run typecheck
npm run build
```

Also run the packer's full reconciliation and retained staging smoke defined by
`server/shadow-prep/README.md`; save its report and promoted pointer.

### Stop/rollback

Do not promote if any component is internally inconsistent, a hierarchy parent fails enclosure,
notices are missing, or a bundle cannot be independently decoded and composed. Rollback is the
old `current.json` value; immutable objects are not overwritten.

---

## PR 3 — Remote tile service and unmistakable debug visualization

**Purpose:** prove actual R2 field bytes reach the map while leaving real shadows and routing on
the legacy engine.

### New boundaries

Suggested modules:

- `app/workers/shadowTiles.worker.ts`
- `app/lib/shadowField/v2/{workerProtocol,remoteTileService,memoryLedger,coverage}.ts`
- `app/lib/shadow/v2/DebugFieldLayer.ts`
- focused unit tests plus `e2e/shadowV2Debug.spec.ts`

### Worker protocol

Commands must carry `requestId` and pinned generation:

- `configureGeneration`
- `setInterests` with viewport/user/route priorities
- `releaseInterest`
- `setBudget`
- `shutdown`

Events must carry the same identity:

- `generationReady`
- `tileLoading`
- `tileReady`
- `tileIncomplete`
- `tileError`
- `tileEvicted`
- `accounting`

Late events from an obsolete request/generation are ignored by the caller. Aborting a subscriber
must not abort a shared fetch still leased by another interest.

### Acquisition and cache behavior

- Do no `.smb` work outside the compact NYC coverage index.
- Initial viewport policy: map zoom at least 20, centered 3×3 z18 neighborhood, maximum nine
  requested tiles. Separate tile zoom from map zoom in names and telemetry.
- Coalesce settled camera changes; never fetch on every `move` event.
- Fetch, decode, verify, and compose off the UI thread.
- Keep compressed Cache Storage and decoded/composed memory accounting separate.
- Cache names include generation. Preserve active shadow caches when `public/sw.js` activates;
  do not let the shell service worker delete every non-shell cache.
- Charge embedded components, decompression scratch, composed arrays, transferable/upload copies,
  and retained worker pages to a strict byte ledger.
- After composition, release decoded component planes unless another operation explicitly leases
  them.
- Do not transfer the worker's only authoritative buffers and then continue counting them as
  resident. Transfer a charged staging copy or deliberately relinquish worker ownership.
- Use bounded fetch concurrency and negative membership from the coverage index, not cached 404s.

### Debug layer

- Paint building mask, canopy mask, unknown/incomplete support, and tile edges with distinct,
  high-contrast colors.
- Use nearest sampling and exact z18 Mercator bounds; exclude the one-cell gutter from the
  logical display extent.
- Developer panel shows generation, requested/in-flight/ready/error/evicted tile counts, cache
  source, compressed bytes, worker resident bytes, staging bytes, GPU bytes, and completeness.
- Hide behind a development/feature flag. Existing blue MapTiler shadows remain authoritative.

### Acceptance scenarios

- Outside NYC: no `.smb` requests. Pointer/index behavior matches the documented lazy policy.
- Manhattan at map zoom 19.9: no tile request.
- Manhattan at map zoom 20: at most nine centered tiles requested.
- Debug building/canopy masks visibly align with basemap features at named Manhattan/Brooklyn
  samples.
- Fast pan: obsolete results never publish; shared interests survive; memory remains bounded.
- Corrupt/truncated/mixed-generation bundle: visible error/incomplete state, never empty support.
- Worker restart and warm Cache Storage read reproduce the same tile identity.
- Borough/water edge: membership is exact and missing exterior remains visibly unknown.

### Verify

```bash
npm test -- app/lib/shadowField/v2
npm run typecheck
npm run lint
npm run build
npx playwright test e2e/shadowV2Debug.spec.ts
```

Run the real browser manually against staging and retain screenshots plus network/memory counts.

### Stop/rollback

Stop if a 3×3 diagnostic exceeds its declared budget, masks drift from the map, panning can show
stale tiles, or an error is painted as known-empty. Rollback is disabling the debug flag; legacy
rendering remains untouched.

---

## PR 4 — Shared numeric worker, solar semantics, and offscreen acquisition

**Purpose:** turn composed pages into authoritative, cancellable numeric shade answers before
either routing or the new renderer depends on them.

### Scope

- Implement/finalize shared solar and coordinate conventions with explicit version identity.
- Build the worker page table and conservative acquisition planner from PR 2's hierarchy.
- Receiver domains include viewport ground and route sidewalk strips; acquisition sweeps them
  sunward using conservative component bounds and lower solar altitude.
- Gutters provide seam-safe interpolation only. They do not terminate rays or replace adjacent
  caster pages.
- Add resumable CPU marching over terrain, opaque buildings, and canopy intervals.
- Canopy returns fractional direct transmission using the selected tree model; do not turn it
  into a binary building mask or multiply opacity once per step.
- Expose batched APIs, not per-point messages:
  - `queryPoints`
  - `queryEdges` for both sidewalk sides
  - optional `queryTimes` for one receiver set
- Every result includes value or null, complete/incomplete state, building-only evidence,
  generation/model identities, and accounting.
- Missing page, unknown exterior, deadline, cancellation, night, and unsupported receiver are
  distinct outcomes. Null never becomes shade or sun.
- Keep one shared readiness deadline across index, broad acquisition, exact refinement, and all
  components; do not reset the clock per stage.

### Tests

- Analytic flat ground, wall/tower, terrain ridge, courtyard, canopy air gap, roof overlap,
  negative elevation, seam, vertical sun, grazing ray, and night cases.
- Offscreen tower/canopy and a long ridge require pages outside the receiver tile.
- Lowering the sun or changing azimuth expands/replaces interest correctly.
- Streamed/evicted execution equals fully resident execution exactly.
- Cancellation, worker restart, stale generation, corrupt hierarchy, and exhausted budget fail
  incomplete rather than clear.
- Preserve the existing legacy/v2 agreement corpus and report invalids separately.

### Acceptance

- The worker can answer a named NYC point batch and route-like edge batch without WebGL.
- Answers are stable across tile load order and cache state.
- No query causes one network request per point/edge.
- Memory ledger remains exact across fetch, decode, composition, query continuation, and eviction.
- This PR still does not change shipping route weights or visible shadows.

### Verify

```bash
npx vitest run app/lib/shadowField/v2/__tests__/solar.test.ts \
  app/lib/shadowField/v2/__tests__/coordinates.test.ts \
  app/lib/shadowField/v2/__tests__/acquisition.test.ts \
  app/lib/shadowField/v2/__tests__/streaming.test.ts \
  app/lib/shadowField/v2/__tests__/memoryLedger.test.ts \
  app/lib/shadowField/v2/__tests__/service.test.ts \
  app/lib/shadowField/v2/__tests__/workerProtocol.test.ts
npx vitest run app/lib/shadowField/__tests__/agreement/
npm run typecheck
```

### Stop/rollback

Stop on false completeness, CPU/GPU-independent semantics not yet defined, or unbounded low-sun
acquisition. The service remains separately constructible and inactive.

---

## PR 5 — GPU field-shadow renderer, still feature-flagged

**Purpose:** render numeric shadow/transmission from the exact pages and identities used by PR 4.

### Suggested modules

- `app/lib/shadow/v2/{FieldShadowLayer,gpuPages,shaders,pageTable}.ts`
- fixture harness and `e2e/shadowV2Numeric.spec.ts`
- narrow extensions to `IShadowLayer` for readiness/evidence without breaking legacy callers

### Scope

- Implement a MapLibre WebGL2 custom layer using integer field textures. Upload height bands to
  integer textures and material/provenance data to appropriate integer/palette textures.
- Share solar coordinate conventions, rounded inputs, tree-material semantics, generation, and
  receiver identity with the CPU worker. Do not create a second “close enough” sun model.
- Render numeric total shade/transmission and an independent building-only result.
- A clock change updates uniforms and reuses resident pages when coverage remains sufficient.
  If the new sun requires more caster coverage, retain the last labelled complete frame or show
  pending; never display a partial new-time frame as complete.
- Handle context loss by reuploading from worker-owned pages.
- Preserve blue-dominant visible styling and the top-left building-mask readback contract.
- First integration may be pitch-0/ground-receiver only, but it must say so visibly and remain
  feature-flagged. Do not silently claim the current pitched roof/wall behavior until PR 7.
- Wire real NYC tiles only behind `VITE_NYC_FIELD_RENDERER` (or equivalent) with default off.

### Tests and acceptance

- Actual GPU output agrees with actual worker numeric output at matched receiver/time/generation
  within predeclared tolerances, including fractional canopy and invalid/incomplete pixels.
- Exercise seams, missing pages, time changes, pan, resize, DPR, context loss, corrupt identity,
  and building-only isolation in software WebGL.
- In a staging Manhattan scene, the time slider moves field shadows without downloading a new
  tile set when the existing conservative coverage remains valid.
- Legacy mode remains byte-for-byte/selectively behaviorally unchanged with the flag off.
- No CPU readback is used as the normal render path.

### Verify

```bash
npx playwright test e2e/shadowV2Numeric.spec.ts
npx vitest run app/lib/shadowField/__tests__/agreement/
npm run typecheck
npm run lint
npm run build
```

Perform a real-browser visual check at pitch 0 with the debug masks toggleable over the rendered
result.

### Stop/rollback

Stop if CPU/GPU results diverge, an incomplete frame looks ready, GPU allocation escapes the
ledger, or context recovery changes the answer. Keep the factory on legacy by default.

---

## PR 6 — Route scoring from the shared remote field

**Purpose:** make NYC route choice use the same generation and physics as the field renderer,
without changing outside-NYC routing.

### Scope

- Add a route-corridor interest separate from viewport interest. Camera movement must not cancel
  tiles still leased by an in-flight route calculation.
- Freeze the route calculation timestamp and field identities at calculation start.
- Before constructing weights/searching, batch all candidate edge samples for both sidewalk
  directions through `queryEdges`. Do not query during each Dijkstra/Pareto relaxation.
- Map numeric shade, validity, completeness, and confidence into the routing evidence contract.
  Resolve the product policy explicitly:
  - unknown receives no shade reward;
  - invalid left and right sides do not hide inside an average;
  - deadline/incomplete may use an explicitly labelled legacy building-only fallback or fail the
    shade route, but may not claim combined NYC completeness.
- Preserve normal, sketch, recalculation, assistant-triggered planning, generation cancellation,
  chosen-path provenance, distance-weighted statistics, and the shared readiness allowance.
- Route search remains local browser CPU. Cloudflare supplies tiles, not per-edge answers.
- Keep outside-NYC routes on the legacy field. A route crossing the eligibility boundary must
  use one explicit policy; it cannot silently combine incompatible evidence into one percentage.

### Tests

- Zero per-relaxation worker/network queries.
- Both sidewalks retained and canonical direction preserved.
- Out-of-order worker results cannot overwrite a newer route calculation.
- Missing/unknown tiles cannot make a route look shadier.
- Same-time renderer/route spot checks name identical generation/model identities.
- Route crossing NYC boundary returns the declared mixed/unavailable policy.
- Legacy routes and route modes remain unchanged outside eligibility.

### Acceptance

- A Manhattan route downloads a bounded corridor/caster working set, computes one batched field
  result, and produces routes with remote-field provenance.
- Changing only the selected route card does not redownload the field.
- Same-day clock dragging does not silently rewrite stored calculation-time route statistics.
- Feature remains off by default and cannot select v2 routing without the matching renderer.

### Verify

```bash
npx vitest run app/lib/shadowField/v2/__tests__/routingPolicy.test.ts
npx vitest run app/hooks/__tests__/shadowV2Callers.test.ts
npm test
npm run typecheck
npm run build
npm run e2e
```

### Stop/rollback

Stop if route weights can consume null as numeric shade, routing and rendering use different
identities, or route acquisition becomes camera-dependent. Rollback is the paired feature flag,
not renderer-only or routing-only selection.

---

## PR 7 — Pitched surfaces and remaining field consumers

**Purpose:** preserve the application's non-route shadow features before production activation.

### Scope

- Generate valid ground/roof/wall receiver surfaces from canonical occupancy and heights for
  pitched rendering. Preserve courtyards, equal-height merge rules, actual foundations, and
  above-roof canopy.
- Integrate point queries used by assistant spot checks without camera movement.
- Convert hourly exposure reads to the worker field with frozen times and explicit nulls.
- Implement or explicitly disable candidate accumulation/export until numeric exposure is ready;
  never present the legacy local adapter's current no-op/visual export as v2 numeric exposure.
- Preserve canopy display extent while retiring independent canopy physics/cache ownership in a
  v2 session.
- Preserve building-only mask origin/DPR, visible layer order, navigation overlays, labels over
  pitched buildings, resize, context recovery, and blue-shadow detection.
- Add old/new frame timestamp and completeness to developer evidence.

### Tests and acceptance

- Roof, wall, courtyard, canopy-above-roof, and sunward/anti-sunward wall fixtures agree with
  worker receiver queries.
- Assistant point checks and hourly values share the rendered generation and time.
- Multi-DPR, pitch transitions, pan, resize, and context recovery retain alignment.
- Unsupported accumulation/export is clearly unavailable rather than silently legacy/mixed.
- No independent active canopy shadow model remains in a v2 session.

### Verify

```bash
npx playwright test e2e/shadowV2Surfaces.spec.ts
npx vitest run app/lib/shadowField/__tests__/agreement/
npm test
npm run typecheck
npm run build
```

Run the existing readback, truth, and wall-alignment verification scripts where their harnesses
apply, plus a real pitched-map visual check.

### Stop/rollback

Stop on floating walls, filled canopy air gaps, lost holes, mask contamination, mismatched
assistant/hourly evidence, or an unlabelled legacy fallback.

---

## PR 8 — Paired NYC activation, performance qualification, and rollback

**Purpose:** make the remote field normal behavior only inside the measured eligibility envelope.

### Eligibility and precedence

- Outside NYC or below the supported zoom/mode/device envelope: legacy renderer and legacy query
  engine remain paired.
- Inside NYC: select v2 only after the complete receiver/caster domain required for the current
  viewport/route/time is ready.
- While first loading: show “Loading NYC shade data” and do not present legacy results as verified
  NYC field results.
- On later time changes: retain a labelled prior complete v2 frame/result until the new domain is
  ready, or show pending.
- At borough boundaries, outside built support is unknown. Use a tested exclusion/guard envelope
  or explicit incomplete state; one-cell gutters do not justify seamless eligibility.
- `LocalShadowAdapter` cannot simply remain visible underneath loaded remote tiles. Select one
  complete renderer/query pair for the eligible domain or implement a proven spatial mask.

### Scope

- Add the single paired release flag and kill switch. No separate production tree/building,
  renderer/routing, or per-source toggles.
- Add loading, incomplete, stale-frame, unavailable, and fallback provenance UI states.
- Exercise candidate → legacy → candidate, pointer promotion, cached old generation, worker
  restart, WebGL context loss, network interruption, corrupt tile, quota failure, and rollback.
- Measure named phones/browsers and full application workloads:
  - cold/warm pointer/index/tile latency;
  - route readiness under the one shared allowance;
  - time-slider frame intervals;
  - decoded, worker, staging, GPU, and Cache Storage memory;
  - dense Manhattan, open, canopy-heavy, waterfront/boundary, and low-sun scenes;
  - viewport-only, route-only, and concurrent interests.
- Replace projected limits with measured budgets and set the admitted zoom/device/mode envelope.
- Record outside-region requests, completeness, failures, worst cases, generation hashes, and
  attribution access. Update shadow-v2 execution status and validation records to match reality.

### Acceptance

- No frame, route, assistant answer, or hourly result mixes legacy and v2 authority without an
  explicit documented fallback identity.
- Renderer and routing agree at matched generation/time samples.
- Fast pan and slider use remain responsive on every admitted device profile.
- Memory never exceeds the declared ledger cap; eviction preserves leased route/viewport pages.
- Production custom-domain delivery, cache behavior, CORS, ETag/revision handling, and immutable
  generation rollback are tested.
- Physical accuracy is described honestly. Method agreement and visual alignment are not called
  real-world accuracy without independent observations.
- Feature flag defaults on only for the qualified envelope and can be remotely/build-time
  disabled as one pair.

### Verify

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
npx playwright test e2e/shadowV2Activation.spec.ts
```

Also run the retained deployed-delivery, target-device, and physical-validation procedures. A
green unit/browser suite alone does not authorize activation.

### Rollback

Restore the entire legacy renderer/query pair and the previous pointer. Do not roll back only the
renderer or only routing. Immutable v2 generation objects may remain for forensic comparison;
the mutable pointer/feature flag controls selection.

---

## Recommended session boundary

PRs 1–3 produce the first visible proof without changing product behavior. PRs 4–7 construct
the shared engine and consumers behind flags. PR 8 is the only activation PR.

If a new session has only enough time for one outcome, take **PR 1** if its work is still
unmerged; otherwise take the earliest incomplete PR. Do not jump directly to the GPU renderer:
without the corrected generation, compact index/bounds, worker ownership, and numeric oracle,
it would create a second unverified shadow implementation rather than connect the data safely.

## Copy-paste prompt for the next session

> Read `CLAUDE.md` and `docs/handoffs/NYC_REMOTE_FIELD.md` completely. Recheck the handoff's
> branch heads, deployed `current.json`, and working tree. Identify the earliest incomplete PR
> in the handoff and implement **only that PR** from the latest accepted base. Preserve all
> listed invariants and explicit out-of-scope boundaries. Run its focused verification plus the
> repository gates, update the handoff's verified state if reality changed, and report any
> manual/deployed checks that remain outstanding. Do not merge or activate a later-stage
> renderer/routing pair.


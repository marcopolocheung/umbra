# Shadow engine v2 — execution handoff

This is the current-state companion to [the implementation plan](./04-implementation-plan.md), not a second architecture document. The plan and [current architecture](./02-architecture.md) remain authoritative for behavior; this file says what exists, what may run next, and how to prove it.

## Current state

- Branch: `phase-b-item-5-nyc-admission`, started from updated `origin/main` with the prerequisite Phase-A commits replayed. It is local preparation work only; no PR, deployment, or activation result is asserted here.
- Active next work: implement **item 9** in fixture mode while NYC remains blocked. Item 4's documentation protocol is complete; do not interpret the NYC block as permission to begin item 17+.
- Machine-readable counterpart: [execution-status.json](./execution-status.json). Update Markdown and JSON in the same change.
- Preservation-check limitation: `python3 docs/shadow-engine-v2/evidence/02c/verify.py` currently stops at its recorded `02-architecture.md` SHA-256 (`fd874070…860f3`) versus this checkout's unchanged current file (`ce5d7f47…27f97`). This item did not alter either file or historical evidence. Do not regenerate, overwrite, or relax that historical record; a separately authorized evidence/architecture reconciliation is required before that verifier can pass.

| Item | Status | Exact current state |
|---:|---|---|
| 1 | completed | Source-separated codec, synthetic reusable fixture producer, portable v1 contract/golden directory, and acceptance/rejection coverage are present. |
| 2 | completed | Deterministic source-separated composition, lattice and tree model, fail-closed support/dependency/reservation behavior, and synthetic seam/ownership/crown coverage are present. |
| 3 | completed | The candidate fixture path and retained 150-case agreement gate exist and run under normal Vitest discovery. |
| 4 | completed | `05-validation.md`, `06-open-questions.md`, `validation/cases.json`, and `validation/thresholds.json` preregister every §10 witness and all 30 OIs. They record no new measurement or physical-accuracy result. |
| 5 | partial | The Containerfile dependency-copy correction, receipt/control fail-closed checks, external-mount policy, and Docker smoke script exist. The DCP boundary was copied externally and both hash-pinned NGA grids were installed externally. The twelve source receipts/raw inputs, independent controls/output, executed NYC PROJ evidence, Docker validation, and a numerical control residual threshold remain missing. This is not regional admission and does not permit item 6. |
| 6 | blocked | Skeleton normalizers/tests exist; it requires item-5-admitted NYC inputs. |
| 7 | blocked | Basic bounds/publication tests exist; regional hierarchy/publication evidence requires item 6. |
| 8 | blocked | No cold-build/Fly/R2 qualification; requires items 5–7, valid Docker run, and credentials. |
| 9 | unstarted | Fixture numerical semantics; it is next after item 4. |
| 10 | unstarted | Fixture acquisition, ledger, and continuation implementation. |
| 11 | unstarted | Fixture worker/service implementation. |
| 12 | unstarted | Fixture caller conversion after explicit null-cost policy. |
| 13 | unstarted | Fixture numeric renderer implementation. |
| 14 | unstarted | Fixture surfaces/masks/canopy-display implementation. |
| 15 | unstarted | Fixture offline package implementation. |
| 16 | unstarted | Fixture exposure/GeoTIFF implementation. |
| 17 | blocked | Requires admitted regional generation, deployment, and items 10–16. |
| 18 | blocked | Requires item 17 plus NYC observations and controls. |
| 19 | blocked | Requires regional qualification plus target phones. |
| 20 | blocked | Requires completed items 1–19 and admitted activation evidence. |
| 21 | blocked | Requires item-20 activation and release artifacts. |

Do not do the following unless the named work item explicitly authorizes it:

- Do not download or probe sources.
- Do not use R2, Fly, app switching, renderer work, or production data work.
- Do not upload, deploy, activate, or create a regional generation.

## Clean-checkout verification matrix

Raw assets, generated regional objects, credentials, and device captures are external to Git. Never put them in this checkout.

| Mode | Covers | Required environment | Bootstrap and expected result |
|---|---|---|---|
| Fixture | 1–4, 9–16 | Node/npm; Node 24 is supported application runtime. Node 20+ is accepted only for deterministic fixture checks and is recorded. | `npm ci` → `npm run preflight:shadow-v2:fixtures` → `npx vitest run app/lib/shadowField/v2/__tests__/` → `npx vitest run app/lib/shadowField/__tests__/agreement/` → `npm run typecheck` → `npm run build`. Preflight emits JSON with actual Node version; tests/typecheck/build pass. |
| NYC local-prep | 5–8 | Docker, Node 24, GDAL/PROJ with NGA grids, and an external data mount. | `npm --prefix server/shadow-prep ci` → `npm --prefix server/shadow-prep test` → `docker build -f server/shadow-prep/Containerfile -t umbra-shadow-prep .` → `docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj umbra-shadow-prep admit`. The external grid mount is read-only. `admit` is **expected to reject** until every named raw asset/receipt/control and the unadmitted residual-threshold blocker are resolved; that is fail-closed, not a broken implementation. |
| Deployment/device | 17–21 | Credentials, admitted regional generation, real deployment endpoints, and named target phones. | First rerun fixture mode and a successful NYC prep admission/build/verify. Then run each item’s delivery/device command below. Expected result is a retained, scoped evidence record; without these inputs the commands must not be treated as a pass. |

The prep preflight is intentionally strict: `npm --prefix server/shadow-prep test` runs a `pretest` check and rejects any Node major other than 24. Fixture preflight prints the actual version instead of pretending that a Node-20 fixture pass is app/prep runtime support.

## Executable work cards

Each **read first** list is mandatory. “Future” means the path is intentionally not present yet; create it only in that item. Save command output, `git rev-parse HEAD`, input hashes, and any stated evidence artifact outside the repository where appropriate.

### 1. Separate-object format and fixture producer — completed

- Preconditions / environment: fixture mode; no geography, credentials, or browser needed.
- Read first: plan item 1; 02 §§3–5, 7; `app/lib/shadowField/v2/{types,format}.ts`; `format.test.ts`; `.claude/README.md` and `.claude/rules/{change-discipline,tests}.md`.
- Preserve: existing codec API, `DecompressionStream` decoding, z18/258 dimensions, and current format tests.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/format.test.ts && npm run typecheck`.
- Completed evidence: `formatFixtures.ts` supplies deterministic independent terrain/building/canopy objects with injected node:zlib level-6 gzip; `contracts/tile-format-v1.md` specifies framing, tables, identity, limits and an annotated golden directory. The format suite covers predictors, corruption/truncation/ranges, format/codec/predictor/table failures, checksums, length cap, dependencies and independent-object bytes.
- External inputs: none; synthetic inputs only.
- Done / evidence: full round-trip/rejection matrix, independent-byte fixture proof, contract golden object, command log and fixture hashes.
- Next: item 2 is complete; fixture-mode item 9 remains the directed next item because item 5 is blocked.

### 2. Deterministic worker composition — completed

- Preconditions / environment: fixture mode and item-1 codec behavior.
- Read first: plan item 2; `types.ts`, `compose.ts`, `composition.test.ts`, and 02 §5.2.
- Preserve: source separation, allocation reservation, and no fused distributable object.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/composition.test.ts app/lib/shadowField/v2/__tests__/lattice.test.ts && npm run typecheck`.
- Completed evidence: `compose.ts`, `lattice.ts`, and `treeModel.ts` keep source objects separate, require manifest identity and reservation before a page, return support/evidence/accounting, use NW–SE terrain and fixed ownership, and apply native-mask/fallback/roof rules.
- External inputs: none; synthetic cases only.
- Done / evidence: exact seam/courtyard/cross-tile/zero-mask fixtures, reservation failures, and preserved independent object bytes.
- Next: items 3–4 remain complete; fixture-mode item 9 is the next permitted item while item 5 remains blocked.

### 3. First v2 agreement output — completed

- Preconditions / environment: fixture mode.
- Read first: plan item 3; existing `agreement/{fixtures,harness,agreement.test,v2Fixtures,v2Harness,v2Agreement.test}.ts`; `v2/{receivers,march}.ts`.
- Preserve: original agreement suite, all 150 fixtures/300 readings, validity denominator, reference pixels, and named witnesses.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/__tests__/agreement/`.
- Expected result: normal Vitest discovery runs legacy and v2 agreement suites and both pass; deliberate corruption tests fail the gate internally.
- External inputs: none.
- Done / evidence: printed metric report, witness outputs, and CI log for this exact command.
- Next: item 4, then item 9; rerun after all candidate-kernel changes.

### 4. Validation protocol and blocker register — completed

- Preconditions / environment: fixture mode; do not measure, download, or alter historical evidence.
- Read first: plan item 4; 02 §10 and §12; existing `05-validation.md`, `06-open-questions.md`, and evidence directories `02c`, `02d`, `03`.
- Preserve: existing thresholds/blockers, historical artifacts, and the distinction between agreement, analytic, physical, and device evidence.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/__tests__/agreement/ && npm run typecheck`; run the documented immutable-fixture checks and review every 02 §10 witness and all 30 OIs against both JSON registers.
- Expected result: preservation commands pass; `validation/cases.json` and `validation/thresholds.json` exist; no new physical measurement is claimed.
- External inputs: none for protocol completion; device inventory and observations remain recorded blockers, not defaults.
- Done / evidence: case/threshold JSON with units, population, authority, failure effect, test target, independent oracle, OI closure/applicability, and a review log.
- Next: item 9 in fixture mode; item 5 stays blocked.

### 5. NYC source/datum admission — partial

- Preconditions / environment: NYC local-prep mode; Node 24, Docker, GDAL/PROJ and named grids.
- Read first: plan item 5; `server/shadow-prep/README.md`, `regions/new-york-city-v1.json`, `src/admission.ts`, `test/{admission,datum}.test.ts`, and `06-open-questions.md`.
- Preserve: fail-closed receipt/hash/grid controls, external-data-only policy, and existing admission tests.
- Setup: `npm --prefix server/shadow-prep ci && npm --prefix server/shadow-prep test`; only after external prerequisites, run the Docker sequence in the matrix.
- Verify: `npm --prefix server/shadow-prep test`; `npm --prefix server/shadow-prep run test:container-smoke`; then `docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj umbra-shadow-prep admit`.
- Expected result: Node-24 unit tests pass. The smoke script reaches admission logic rather than module resolution. `admit` rejects until named raw assets, receipts/hashes/rights/support extents, NGA operation evidence, controls, and the deliberately unadmitted numerical residual threshold are resolved; save the rejection, do not weaken it.
- External inputs: pinned raw source bytes/rights/receipts, DCP boundary, NGA grids, independent controls, Docker.
- Current evidence: [source manifest](./evidence/04/preparation/source-manifest.json), [datum controls](./evidence/04/preparation/datum-controls.json), [Docker smoke record](./evidence/04/preparation/docker-smoke.json), and [verification record](./evidence/04/preparation/verification.json) record only external-input/Docker progress and blockers. They are not an admitted external manifest, control residual result, or valid-zero/nodata data proof.
- Next: 6 after successful admission; otherwise 9 only.

### 6. Normalize complete features — blocked

- Preconditions / environment: item 5 admitted NYC data; NYC local-prep mode.
- Read first: plan item 6; `src/{sources,terrain,buildings,canopy,normalize}.ts`, `test/normalization.test.ts`, and item-2 composition contract.
- Preserve: whole-feature normalization, separate objects, no regional mosaic, masks and provenance.
- Setup: `npm --prefix server/shadow-prep ci && npm --prefix server/shadow-prep test`.
- Verify: `npm --prefix server/shadow-prep test` and Docker `build`/`verify` after admission.
- Expected result: unit tests pass; no real normalization runs before admission.
- External inputs: admitted raw data and item-5 controls.
- Done / evidence: seam/part/hole samples, deterministic normalization record, decoded candidate objects, allocation measurements.
- Next: 7.

### 7. Bounds and atomic publication — blocked

- Preconditions / environment: item 6 generation; NYC local-prep mode.
- Read first: plan item 7; `src/bounds.ts`, `test/{bounds,publication}.test.ts`, publication schemas, and 02 hierarchy rules.
- Preserve: unknown exterior, immutable object identities, atomic generation visibility, licences/notices.
- Setup: `npm --prefix server/shadow-prep ci && npm --prefix server/shadow-prep test`.
- Verify: `npm --prefix server/shadow-prep test && docker run --rm -v "$PWD/../shade-prep-data:/data" umbra-shadow-prep verify`.
- Expected result: unit tests pass; regional verify cannot pass without a built admitted generation.
- External inputs: item-6 objects, external artifact mount; R2 is not authorized here.
- Done / evidence: exhaustive enclosure and interrupt/publication logs, manifest/object identities, attribution access record.
- Next: 8.

### 8. Cold end-to-end prep — blocked

- Preconditions / environment: items 3 and 5–7, Docker, admitted data; Fly/R2 only when this item authorizes it.
- Read first: plan item 8; prep README, `src/{cli,build}.ts`, `test/*.test.ts`, and item-4 protocol.
- Preserve: external raw/generation storage, fail-closed admission, fixture agreement gate.
- Setup: `npm --prefix server/shadow-prep ci && npm --prefix server/shadow-prep test && docker build -f server/shadow-prep/Containerfile -t umbra-shadow-prep .`.
- Verify: `docker run --rm -v "$PWD/../shade-prep-data:/data" umbra-shadow-prep admit && docker run --rm -v "$PWD/../shade-prep-data:/data" umbra-shadow-prep build && docker run --rm -v "$PWD/../shade-prep-data:/data" umbra-shadow-prep verify`.
- Expected result: before inputs, admission fails closed; after inputs, a 2-GB cold/restart measurement is retained. No local test is a host/deployment pass.
- External inputs: admitted data/grids, Fly performance-1x and R2 credentials/configuration.
- Done / evidence: cold/restart/cost JSON, hashes, RSS/scratch/queue records, repeated identities, fixture-gate rerun.
- Next: 17 only after 10–16 and this pass; 9 may proceed while blocked.

### 9. Solar, coordinates, CPU numerical semantics — unstarted

- Preconditions / environment: item 4 complete; fixture mode.
- Read first: plan item 9; 02 §8; `v2/{march,receivers,types}.ts`; item-4 cases/thresholds.
- Preserve: item-3 opaque-flat gate and frozen fixture sun.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/solar.test.ts app/lib/shadowField/v2/__tests__/march.test.ts app/lib/shadowField/v2/__tests__/coordinates.test.ts && npx vitest run app/lib/shadowField/__tests__/agreement/ && npm run typecheck`.
- Expected result: new suites and agreement pass; until created, missing focused test paths mean item 9 is unstarted, not a passing no-op.
- External inputs: none.
- Done / evidence: analytic oracle results, frozen solar identity/correction cases, numerical error report.
- Next: 10.

### 10. Bounds acquisition, ledger, continuations — unstarted

- Preconditions / environment: items 2 and 9; fixture mode.
- Read first: plan item 10; 02 §7; `v2/{compose,march,types}.ts`.
- Preserve: unknown is not clear, reservations charge all copies, and exact physics under memory pressure.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/acquisition.test.ts app/lib/shadowField/v2/__tests__/streaming.test.ts app/lib/shadowField/v2/__tests__/memoryLedger.test.ts && npm run typecheck`.
- Expected result: all incomplete/error paths fail closed and ledger caps hold.
- External inputs: none; analytic fixture bounds only.
- Done / evidence: cancellation/eviction accounting report and exact resident-versus-streamed comparisons.
- Next: 11.

### 11. Cancellable worker/service facade — unstarted

- Preconditions / environment: item 10; fixture mode plus Playwright/Chromium for browser fixture.
- Read first: plan item 11; `ShadowField.ts`, `providers.ts`, and v2 codec/compositor APIs.
- Preserve: separately constructible legacy service and worker-only authoritative pages.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npx playwright install chromium`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/service.test.ts app/lib/shadowField/v2/__tests__/workerProtocol.test.ts && npx playwright test e2e/shadowV2Worker.spec.ts`.
- Expected result: deterministic races/restarts pass without WebGL or phone-performance claim.
- External inputs: none.
- Done / evidence: race/heartbeat/cancel logs and browser-fixture report.
- Next: 12 and 13.

### 12. Null costs and caller conversion — unstarted

- Preconditions / environment: item 11 and an explicit product decision where policy requires one; fixture mode.
- Read first: plan item 12; all listed hooks/callers; legacy fallback provenance; 02 OI 15.
- Preserve: both sidewalks, selected-route provenance, 2500-ms shared allowance, and legacy isolation.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/routingPolicy.test.ts app/hooks/__tests__/shadowV2Callers.test.ts && npm run typecheck`.
- Expected result: null never becomes shade; no per-relaxation query; unresolved policy blocks integration.
- External inputs: product-owner null/confidence decision if plan options remain open.
- Done / evidence: routing-evidence contract, policy table, caller race instrumentation.
- Next: 14.

### 13. Numeric renderer — unstarted

- Preconditions / environment: items 9–11; fixture mode with software WebGL.
- Read first: plan item 13; current shadow adapters, sun worker, v2 service/march identities.
- Preserve: shared identities/ledger, numeric fractional output, inactive shipping factory.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npx playwright install chromium`.
- Verify: `npx playwright test e2e/shadowV2Numeric.spec.ts && npx vitest run app/lib/shadowField/__tests__/agreement/`.
- Expected result: GPU/worker numeric comparisons meet item-4 tolerances; no binary-pixel substitute.
- External inputs: none.
- Done / evidence: matched receiver output, generation-corruption failures, allocation report.
- Next: 14 and 16.

### 14. Surfaces, masks, canopy display — unstarted

- Preconditions / environment: items 12–13; fixture mode with software WebGL.
- Read first: plan item 14; existing adapters/canopy modules/MapView and verification scripts.
- Preserve: mask origin/DPR, blue styling, layer ordering, canopy-fill invariants, stable coordinates.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npx playwright install chromium`.
- Verify: `npx playwright test e2e/shadowV2Surfaces.spec.ts && npx vitest run app/lib/shadowField/__tests__/agreement/`.
- Expected result: roof/wall/crown numeric equality and mask isolation pass; no renderer activation.
- External inputs: none.
- Done / evidence: multi-DPR/pan/recovery reports and exact surface cases.
- Next: 15.

### 15. Offline package and rehydration — unstarted

- Preconditions / environment: items 11–14; fixture mode with browser storage.
- Read first: plan item 15; service worker, saved routes, MapView, component/manifest contracts.
- Preserve: versioned notices/coverage and decoded-byte ledger charging.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npx playwright install chromium`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/offline.test.ts && npx playwright test e2e/shadowV2Offline.spec.ts`.
- Expected result: disconnected covered fixture recovers; corrupt/partial/quota cases remain incomplete.
- External inputs: none.
- Done / evidence: offline package hashes, rehydration and eviction/corruption logs.
- Next: 16.

### 16. Exposure and numeric GeoTIFF — unstarted

- Preconditions / environment: items 11, 13–15 and item-4 integration tolerances; fixture mode.
- Read first: plan item 16; accumulation panel, adapters, existing export conventions, item-4 integration cases.
- Preserve: nodata is not zero sunlight, pinned/cancellable jobs, Float32 numeric export.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npx playwright install chromium`.
- Verify: `npx vitest run app/lib/shadowField/v2/__tests__/exposure.test.ts app/lib/shadowField/v2/__tests__/numericExport.test.ts && npx playwright test e2e/shadowV2Exposure.spec.ts`.
- Expected result: analytic convergence and independent GeoTIFF decoding pass; no annual/server claim.
- External inputs: none.
- Done / evidence: decoded GeoTIFF report, cancellation trace, memory/convergence record.
- Next: 17 after item 8 passes.

### 17. Deployed delivery coverage — blocked

- Preconditions / environment: item 8, items 10–16, deployment/device mode.
- Read first: plan item 17; item-7 manifests/notices; acquisition/renderer contracts; item-4 protocol.
- Preserve: fault-to-incomplete behavior, one shared 2500-ms allowance, separate-object identities.
- Setup: successful fixture and NYC local-prep modes, then configure actual R2/custom domain credentials.
- Verify: `npx playwright test e2e/shadowV2Delivery.spec.ts && npm --prefix server/shadow-prep test`.
- Expected result: external faults cannot become empty; without deployment inputs this remains blocked.
- External inputs: admitted generation, R2/custom domain credentials, workload graphs/captures.
- Done / evidence: cold/warm/fault/session evidence and scoped coverage record.
- Next: 18.

### 18. Physical geometry/solar validation — blocked

- Preconditions / environment: items 4, 8–9, 13–14, 17; deployment/device mode.
- Read first: plan item 18; validation protocol, accuracy evidence layout, source/date caveats.
- Preserve: independent physical oracle and prior-based canopy limits; no self-validation.
- Setup: successful item 17 plus preregistered field protocol.
- Verify: `python3 scripts/verify/shadow_v2_accuracy.py` after that future script and observations exist.
- Expected result: absent credible observations blocks acceptance; agreement does not substitute.
- External inputs: georeferenced NYC observations, control survey, UTC/leaf-state/weather records, independent solar calculation.
- Done / evidence: raw observations/solar/report hashes, residuals, uncertainty and worst cases.
- Next: 19.

### 19. Phone memory/event qualification — blocked

- Preconditions / environment: items 8, 12–18; target phones and admitted NYC generation.
- Read first: plan item 19; device protocol, ledger/worker contracts, validation thresholds.
- Preserve: fixed semantic lattice, one readiness allowance, full-app measurement scope.
- Setup: successful items 8 and 17–18; configure named phones/browsers and production candidate.
- Verify: `npx playwright test --config=playwright.shadow-v2.config.ts e2e/bench/shadowV2.bench.spec.ts`.
- Expected result: untested profiles are rejected/incomplete, never inferred from SwiftShader or host results.
- External inputs: target phones, GPU/browser inventory, admitted deployment and measurements.
- Done / evidence: device results/admission JSON, traces, memory categories, event/readiness/exposure records.
- Next: 20.

### 20. Pair activation and rollback — blocked

- Preconditions / environment: items 1–19 with recorded admitted region/device/mode envelope.
- Read first: plan item 20; engine identities, legacy factory, MapView/canopy stores, all qualification evidence.
- Preserve: all-or-nothing legacy/v2 pair, immutable artifacts, explicit unavailable domains.
- Setup: clean fixture mode, deployed qualified environment, and rollback-capable release configuration.
- Verify: `npx playwright test e2e/shadowV2Activation.spec.ts && npm run typecheck && npm run build` plus both normal agreement commands.
- Expected result: candidate→legacy→candidate and mid-job rollback pass without mixed authority; no activation until all blockers close.
- External inputs: release authority, admitted deployment, qualified device evidence.
- Done / evidence: activation/rollback rehearsal, selected-pair identities, release envelope and command logs.
- Next: 21.

### 21. Release evidence and follow-up register — blocked

- Preconditions / environment: item 20 completed; clean checkout plus access to retained release artifacts.
- Read first: plan item 21; 04/05/06, `docs/notes/evidence.md`, activation record, status JSON.
- Preserve: historical 02c/02d/03 evidence, named severe readings, incomplete/deferred OIs.
- Setup: `npm ci && npm run preflight:shadow-v2:fixtures && npm --prefix server/shadow-prep ci`.
- Verify: `npm run typecheck && npx vitest run app/lib/shadowField/v2/__tests__/ && npx vitest run app/lib/shadowField/__tests__/agreement/ && npm --prefix server/shadow-prep test && npm run build`.
- Expected result: fixture gates/build pass and release manifest/evidence hashes reproduce; no claim exceeds the envelope.
- External inputs: release manifest/object access and all retained regional/device evidence.
- Done / evidence: `evidence/05/release.json`, hashes, reproduction record, updated 05/06 and execution status.
- Next: none; separately scoped follow-up only.

## CI agreement

The normal CI `verify` job now runs the clean-PR gate below (in addition to lint, full test, and coverage):

```sh
npm run typecheck
npx vitest run app/lib/shadowField/v2/__tests__/
npx vitest run app/lib/shadowField/__tests__/agreement/
npm --prefix server/shadow-prep test
npm run build
```

`npm test` remains in the job, so the v2 agreement suite stays covered by normal Vitest invocation as well as its explicit gate.

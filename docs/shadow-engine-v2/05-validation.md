# Shadow engine v2 validation protocol

This is a preregistered protocol, not a measurement result. It separates retained
method agreement, analytic conformance, regional integrity, physical observation,
and device performance. Passing one category does not establish another, and no
entry below makes a physical-accuracy claim.

The machine-readable protocol is [cases.json](./validation/cases.json) and
[thresholds.json](./validation/thresholds.json). The case register maps every
[02 §10 witness](./02-architecture.md#10-implementation-boundaries-and-activation)
and all 30 [02 §12 open items](./02-architecture.md#12-numbered-open-items-and-blocking-phase)
to a work item, target, independent expectation, threshold, failure consequence,
and retained evidence. A target marked `future` is a required later test, not a
passing no-op.

## Categories and boundaries

| Category | Protocol | What a failure means |
|---|---|---|
| Retained agreement | Run the legacy and v2 fixture paths over all 150 fixtures, three cities, 300 non-null readings, shared validity masks, canopy-fill checks, the eight named readings, and historical worst 1.0. | Candidate agreement fails. Do not alter the corpus, pixels, denominator, or thresholds. This remains method agreement only. |
| Analytic conformance | Use an independently implemented ray/plane/interval oracle on declared quantized synthetic inputs. Exact discrete classifications are required outside the preregistered tangent band; height residual is at most one 1/64 m quantum. | The affected CPU/geometry case fails. Tangencies stay labelled indeterminate inside their recorded band. |
| CPU/GPU conformance | Compare actual worker and renderer outputs at matched receiver/time/generation, including fractional canopy, discrete evidence and interruptions. | Renderer remains inactive; matching implementations still do not establish physical truth. |
| Regional integrity | Validate source admission, transformations, complete features, masks, conservative bounds, object identities/notices, and deployed fault behavior with pinned inputs. | Reject the source/generation or return incomplete; a region is not eligible. |
| Physical observation | Before candidate evaluation, retain at least 36 independent NYC observation events across the listed strata, independent controls, UTC/time-zone, weather/leaf state, source dates, and independent solar calculation. | Physical acceptance and any physical-accuracy claim remain blocked until a signed residual error budget and the observations exist. |
| Device performance | Inventory named phone/browser/GPU profiles and record repeated cold/warm full-app traces, memory categories, context recovery, workload, and failures. | Deny the profile or return incomplete. Host/SwiftShader evidence is not phone evidence. |

## Numeric rules

Every numeric rule, population, units, derivation, failure action, and required
artifact is in [thresholds.json](./validation/thresholds.json). Its categories are
deliberately distinct:

- Retained agreement: mean ≤0.04, p90 ≤0.05, strict >0.25 share ≤0.04, city mean
  ≤0.08, and invalid scheduled-share ≤0.25. The last is a corpus guard, never a
  routing penalty.
- Analytic/implementation conformance: one 1/64 m canonical-height quantum,
  zero discrete mismatches, ≤1e-6 transmission difference for matched Float32
  inputs, and exact streamed-versus-resident fixture outputs.
- Allocation/performance: 192 MiB managed (160/16/8/8 categories), a separately
  measured 64 MiB runtime/driver increment reserve, one shared 2500 ms readiness
  allowance, and separately reported 30/50 ms event and <500 ms cached-route
  targets. These are not demonstrated device results.
- Integration/export: zero constant-fixture direct-sun-hour error, ≤0.125
  direct-sun-hour error for a single transition at the preregistered 0.25-hour
  maximum step, and zero independent-decoder Float32/georeferencing/metadata
  mismatches.

There is intentionally no numerical physical residual tolerance yet. The known
source, registration, temporal, and optical uncertainty budget has not been
admitted; inventing one here would be postulated rather than derived. That
unresolved tolerance is a blocker for items 18–20, not a default pass.

## Observation and device records

Each later observation record must save raw observation bytes/photos, a
preregistered selection manifest, independent control survey, UTC and local
time-zone, coordinate/georeferencing uncertainty, weather, leaf state, source
dates, independent solar output, candidate identities, residuals, uncertainty
handling for near tangencies, worst cases, and SHA-256 hashes. Strata are opaque
ground, roof/wall, crown, open control, low sun, and building-part/courtyard;
strata can overlap, but every event remains individually retained.

Each later device record must name phone model, OS, browser/build, GPU, app commit,
network/cache state, workload/graph/generation, cold/warm repetition, managed
ledger categories, whole-app peak, event/readiness trace, context/worker recovery,
complete/incomplete outcome, and raw trace hashes. Device availability is currently
unresolved and blocks device qualification.

Every record also saves reproduction command, input/output SHA-256, source/model
versions, raw and output byte counts, CPU/wall time, peak RSS, scratch, failures,
and restart state. Historical 02c/02d/03 evidence is immutable: do not overwrite,
rerun in place, or treat lost 02a/02b captures as recovered.

# Shadow engine v2 validation protocol

This protocol is written before NYC measurements. It separates method agreement,
analytic conformance, regional preparation integrity, physical observation and
device performance; a pass in one category is not evidence of another.

| Category | Population / threshold | Derivation and failure consequence |
|---|---|---|
| Retained agreement | 150 fixtures, 300 non-null sidewalk readings; mean ≤0.04, p90 ≤0.05, >0.25 share ≤0.04, city mean ≤0.08, invalid share ≤0.25 | Existing frozen corpus and 02c contract. Failure blocks candidate query changes. |
| Datum controls | Predeclared independent 3DEP controls; residual threshold recorded with each control set before result interpretation | Absolute EGM08 terrain is transformed to EGM96 using named installed grids; AGL values shift exactly 0. Ballpark/out-of-operation result blocks admission. |
| Component integrity | Every object hash, decoded checksum, mask and manifest dependency validates | This is a transport/model-integrity condition, not physical accuracy. Failure rejects generation. |
| Bounds | Every z18 terrain leaf enclosed by all parents | Exact model enclosure. Any under-bound or unknown-clear proof rejects generation. |
| Physical observations | Pending preregistered sample locations, control survey, UTC, georeferencing and leaf-state capture | No NYC physical-error threshold is currently declared. This blocks physical-accuracy claims and activation. |
| Device performance | Pending target device/browser inventory, cold/warm state and allocation cap | Host measurements do not imply a phone envelope. This blocks activation. |

Analytic cases cover horizontal/sloped planes, NW–SE terrain diagonal, tangency,
roof/crown interval overlap, seam/border values, zero/negative height, invalid
receivers and unknown exterior. Each needs an independent ray/plane/interval
oracle, expected value and executable test before it can close conformance.

Every measurement record includes command, input and output SHA-256, source dates,
versions, UTC timestamps, raw bytes, output bytes, CPU/wall time, peak RSS,
scratch, cold/warm cache state and failures/restarts. Observation records additionally
include device/browser, location uncertainty, local timezone, weather/leaf state,
source age and the rule used for near-tangent uncertainty. Measurements never
overwrite the historical Madrid/Kent/Singapore evidence.

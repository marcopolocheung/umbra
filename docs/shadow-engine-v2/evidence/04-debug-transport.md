# V2 debug transport merge evidence

This diagnostic is deliberately opt-in (`VITE_SHADOW_V2_DEBUG=true`) and has no
connection to `LocalShadowAdapter` or route scoring. The committed hermetic
evidence is the v2 fixture/controller suite and `e2e:shadow-v2-debug`, which
uses a mocked Worker origin.

## Live run record (required before merge)

No live Worker origin is configured in this checkout, so this record must be
completed from a local same-origin Vite proxy before merging. Do not substitute
fixture values for these observations.

| Location | Generation | requested / in-flight / ready / incomplete / error / evicted | cache storage / active compressed / worker / staging / GPU bytes | SMB requests | z18 alignment / screenshot |
| --- | --- | --- | --- | --- | --- |
| Times Square | pending | pending | pending | pending | pending |
| Brooklyn Borough Hall | pending | pending | pending | pending | pending |

Acceptance is exact z18-to-basemap alignment at both locations, no requests
outside `coverage.available`, and worker resident bytes no greater than 96 MiB.

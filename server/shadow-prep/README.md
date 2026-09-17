# Local NYC shadow preparation

This package creates **local-only**, immutable, source-separated preparation
generations. It does not deploy, upload, activate the app, or make a physical
accuracy claim. Node 24, GDAL and PROJ are intentionally container-only.

Create an external data directory (never a directory inside this repository). The
only supported way to populate it is the reproducible local acquisition command:

```sh
docker run --rm -v "$HOME/shade-prep-data:/data" umbra-shadow-prep acquire --plan
docker run --rm -v "$HOME/shade-prep-data:/data" -e PROJ_DATA=/data/proj:/usr/share/proj umbra-shadow-prep acquire --execute
```

`acquire --plan` reports the pinned URLs, external output paths, and required free
space without making a network request or writing a file. `--execute` streams each
response to a temporary file, records response metadata plus SHA-256, and publishes
it without replacing a hash-valid object. It fetches only DCP 26b, the FABDEM v1.2
archive, the two pinned NGA grids, CHMv2's index and its 14 frozen selected COGs,
the two 2026-08-19.0 Overture extracts, five USGS controls, and bounded OSM fallback
and workload snapshots. It then freezes the five-borough union plus a 20 km EPSG:32618
buffer, runs admission/controls/approved 1e-9 m decision/receipts/normalization plan,
and writes `evidence/nyc-acquisition-handoff.json`. It never uploads, deploys,
publishes an image, creates CloudFormation resources, or submits Batch work.

Preparation is personal, non-commercial only. FABDEM-derived output must retain
its CC BY-NC-SA 4.0 attribution and may not be public, paid, ad-supported, or
distributed to customers. The command supplies the pinned NGA files in
`~/shade-prep-data/proj`; this directory is read-only in the container.
`raw/source-receipts.json` has exactly twelve logical receipt IDs, and each receipt
lists one or more assets with its publisher URL, release, SHA-256, concrete format,
acquisition time, CRS/datum and exact polygonal coverage. Every file in `raw/`,
apart from the receipt itself and the pinned borough boundary, must be listed by an
asset; mosaics and normalized intermediates are rejected.

Receipts carry required source-specific policy: terrain carries the exact recorded
NYC EGM2008→EGM96 PROJ result and its hash; buildings and parts carry deterministic
selection, `overture-then-osm` priority, `missingHeight: reject`, and
`raisedStructure: retain-conflict`; CHMv2 height/mask records format, valid-zero,
nodata, mask-hole and OSM-fallback semantics. The 3DEP receipt retains transformed
controls and a residual report in `evidence/`. It begins with
`thresholdStatus: "unadmitted"`, which always blocks admission. Only the authority's
signed decision ID plus an approved numerical maximum can change it to `approved`.

On a Docker-capable host:

```sh
mkdir -p ~/shade-prep-data/{raw,proj}
docker build -f server/shadow-prep/Containerfile -t umbra-shadow-prep .
docker run --rm --entrypoint sh umbra-shadow-prep -lc 'node --version; gdalinfo --version; proj; projinfo --searchpaths'
docker run --rm --entrypoint sh -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep -lc 'sha256sum /opt/proj/us_nga_egm08_25.tif /opt/proj/us_nga_egm96_15.tif; cd /workspace/server/shadow-prep && npm test'
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep admit
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep controls
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep approve-controls NYC-DATUM-ROUNDTRIP-2026-09-13-R1 0.000000001
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep receipts
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep normalize --plan
```

`normalize` now materializes Item-6 candidates only. It streams each terrain and
canopy tile through temporary GDAL scratch, preserves the 258×258 one-cell
gutter, performs the admitted EGM2008→EGM96 conversion, joins complete Overture
parents and parts before clipping, and writes source-separated terrain,
buildings, and canopy planes. It writes each plane and validates its SHA-256
readback before writing `descriptor.json` as the final completion marker. It
still never invokes `build`, `verify`, a manifest, or a current pointer.

For deterministic Batch-style work splitting, use `normalize --shard 0/32`;
shards are sorted z18 keys assigned by index modulo shard count. A retry verifies
the existing descriptor and every plane hash, then skips only valid completed
tiles. `normalize --smoke` processes the first four sorted support tiles under
`normalized/validation/<normalization-id>/`, separate from production
candidates. It is a cloud-I/O/native-tool validation, not a support-completion
claim.

Set `SHADE_PREP_STORAGE=filesystem` (the default) to keep candidates beneath the
external `SHADE_PREP_ROOT`. Set `SHADE_PREP_STORAGE=s3`,
`SHADE_PREP_S3_BUCKET=<normalized-bucket>`, and optionally
`SHADE_PREP_S3_PREFIX=<prefix>` for object publication. S3 uses the same
`normalized/<normalization-id>/...` layout and descriptor-last protocol.

When `SHADE_PREP_RAW_BUCKET` is set, `admit`, `normalize`, and other
admission-backed commands first run the same bounded staging protocol used by
Batch. The private raw bucket must preserve this object layout exactly:

```
raw/source-receipts.json
raw/<every receipt asset filename>
raw/nyc-borough-boundaries-26b.geojson
acquisition/nyc-five-borough-20km-support.geojson
acquisition/nyc-acquisition-manifest.json
proj/us_nga_egm08_25.tif
proj/us_nga_egm96_15.tif
evidence/<each datum-control output/report named by source-receipts.json>
```

Every receipt asset and both grid objects must carry their recorded SHA-256;
staging streams objects to a temporary scratch file, verifies that hash, then
renames it into the local admission layout. `SHADE_PREP_SCRATCH_MAX_BYTES`
defaults to 180 GiB; Batch sets it to 180 GiB on the encrypted 200 GB disk.
Use `shadow-prep stage` to test this transfer alone. Staging never uploads,
alters, or approves raw data.

## AWS preparation (not a deployment instruction)

`aws/cloudformation.yml` defines private S3 raw/normalized/evidence buckets,
ECR, OIDC-only GitHub image publishing, and a zero-minimum EC2 On-Demand Batch
environment. The initial job definition is limited to 4 vCPUs, one attempt and
one hour, with a 200 GB encrypted scratch disk. It creates no access keys and it
does not submit any work. The surrounding VPC is intentionally supplied as
private-subnet and no-ingress-security-group parameters rather than being
silently created.

For a new account with only public default subnets, deploy the separate,
reviewed `aws/private-network.yml` prerequisite first. It creates a dedicated
one-AZ private Batch subnet, no-ingress security group, free S3 gateway endpoint
and a NAT gateway for outbound-only AWS access. Its NAT gateway is intentionally
separate from the preparation stack because it is a billable temporary network
resource; remove it after the isolated smoke run if no further work is approved.
Pass its `PrivateSubnetId` and `BatchSecurityGroupId` outputs to
`cloudformation.yml`. It is a smoke-run convenience, not a multi-AZ production
network design.

Before any deployment, review the CloudFormation change set and a validation-job
estimate against the separately approved $25-after-credits ceiling. Budget
alerts are not a hard cap; the vCPU, timeout, and retry settings are the actual
technical limits. Deployment, paid-account upgrade, workflow dispatch, and a
full NYC run require explicit operator approval. After a reviewed stack exists,
set the GitHub environment secret `AWS_SHADOW_PREP_PUBLISH_ROLE_ARN` to the stack
output and manually run `Publish shadow-prep image`; it exchanges GitHub OIDC for
the narrowly scoped role and pushes an immutable commit-SHA image tag. If GitHub
has immutable OIDC subjects enabled, set `GitHubImmutableSubjectPrefix` to the
exact `sub_claim_prefix` reported by `gh api repos/OWNER/REPO/actions/oidc/customization/sub`;
the role then recognizes that precise immutable identity as well. No raw or
candidate object is public, and candidates have no expiry rule until a future
verified Item-7 handoff explicitly adds one. Before submitting even the smoke
job, update the reviewed stack’s `PrepImageTag` parameter from `bootstrap` to
that published commit SHA; this makes the Batch definition point at a pinned
image rather than an implicitly moving tag.

`admit` never downloads. It verifies the boundary acquired by `acquire --execute`
against its pinned SHA-256 on every run, and rejects the region until every required source,
licence/rights, exact receipt, hash, mask, retained datum-control output/report and grid is locally present. It saves the exact `projinfo --bbox -74.26,40.49,-73.70,40.92 --grid-check known_available` result in external evidence and checks that terrain and control evidence use that result. Receipts live at
`raw/source-receipts.json` and conform to
`publication/source-receipts.schema.json`; an unrecorded extra file or an
unrecorded source is not admissible. `build` reads only admitted raw assets through
the GDAL/PROJ normalizer. It never accepts `normalized/*.json` as a production
input. Synthetic normalization is an exported test-fixture helper only. `verify`
rechecks the manifest, component hashes, decoded words and parent enclosure.

Raw source bytes, normalized inputs, build scratch and published generations are
all deliberately external to Git. Each command writes `evidence/` with command,
tool versions, hashes, byte counts, wall/CPU time, peak RSS, scratch and result.
`normalize --plan` re-runs admission, checks every admitted source against the
frozen `acquisition/nyc-five-borough-20km-support.geojson` hash, enumerates the
globally anchored, support-intersecting z18 tiles, and reports the maximum
candidate footprint plus its required 25% free-space margin. `normalize` is an
external candidate operation only: it has no manifest, hierarchy, current pointer,
publication, deployment, or build/verify side effect. Candidate plane bytes use
canonical little-endian words and their descriptor is renamed atomically only after
all planes exist. Do not run `build` or `verify` as part of Item 6.

## Private NYC browser-pack handoff

The prepared five-borough candidate set can be converted into browser bundles
without making it public. The full handoff has three deliberately separate
Batch definitions: `BrowserPackIndexJobDefinition` scans only descriptor keys
once and freezes the expected 61,442 z18 tiles in the private evidence bucket;
`BrowserPackArrayJobDefinition` is submitted as a 128-child array, whose
children each own one deterministic contiguous slice and write an immutable R2
receipt after decoding every object they uploaded; and
`BrowserPackAggregateJobDefinition` accepts only all 128 valid receipts, heads
every packed R2 object, and then writes the sole complete manifest.

The city run uses the distinct immutable generation
`nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v1`, so it cannot collide
with the earlier 36-tile smoke generation. It never writes `current.json`;
that remains a separate, explicit promotion decision. The R2 credential is
injected into Batch only from the scoped Secrets Manager secret and is named
`SHADE_PACK_R2_*` so it cannot replace the task-role credentials used to read
candidate S3.

`scripts/aws/submit-nyc-browser-pack.sh` (from the repository root) is intentionally a dry run unless
called with `--execute`. It refuses to submit only when the EC2 standard On-Demand
vCPU quota is below 1; with fewer than 128 vCPUs the 128-child array runs in
waves until the pending quota increase arrives. It waits for index → array →
aggregate in that order, and leaves the current pointer unchanged. Review and
explicitly run it only after the capacity request is approved and the reviewed
image/stack update is live.

## PR2 corrected generation (recipe v2)

The v1 generation's bundles carry building masks but declare `known-empty`
support: the v1 producer allocated `buildingSupport` as zeros and never filled
it. PR2 repacks from the existing immutable candidate planes — no source
redownload, no GDAL rerun — under the new immutable generation
`nyc-70e3507f16d472adf5475b614a60cb16-five-borough-v2`
(recipe `nyc-candidate-browser-pack-v2`):

- Per-cell building support derives from the hash-pinned frozen-support
  geometry (1 covered, 2 outside admitted coverage, 0 forbidden); an occupied
  cell outside coverage fails the tile instead of publishing.
- Component states gain `partial`; composition accepts it and keeps building
  and canopy evaluation independent.
- Bundle decoding verifies outer physics hashes and shared
  generation/tile/recipe/datum/hierarchy identity universally; v1 zero planes
  are grandfathered for support semantics only.
- The v2 `sourceHash` binds the original candidate identity plus the repair
  receipt (policy, geometry, original/corrected plane hashes).
- New immutable artifacts, all hash-pinned by `generation.json` (the only
  document `current.json` v2 names): `coverage.json` (availability vs
  borough-clipped activation), `bounds.json` (composed leaf bounds plus the
  z17..z10 reduction pyramid plus any `roof-below-terrain` tiles that PR3 must
  not compose), `notices.json` (receipt-level rights URLs, FABDEM modification
  disclosure, Overture building/building-part, CHMv2 height/mask and Vantor,
  OSM fallback, and installed NGA-grid notices). The detailed manifest is
  retained for audit.
- `current.json` moves last with an expected-previous-sha256
  compare-and-swap (hash the live `current.json` bytes before promoting);
  rollback is restoring the v1 pointer value, with the old generation retained
  in R2 for forensic comparison.

Runbook (operator, after the reviewed image/stack update is live):

```sh
# 0. Stage the two pinned geometry inputs where Batch can read them.
#    Support geometry hash must match the acquisition manifest pin;
#    borough hash must match regions/new-york-city-v1.json boundary.sha256.
# 1. Dry smoke of the repair on representative tiles:
docker run --rm -v "$HOME/shade-prep-data:/data" umbra-shadow-prep \
  server/shadow-prep/src/pack-cli.ts --normalization-id 70e3507f16d472adf5475b614a60cb16 \
  --tiles 18/77196/98516,18/77336/98545 --recipe 2 \
  --support-geometry /data/acquisition/nyc-five-borough-20km-support.geojson \
  --support-sha256 <support-pin> \
  --admission-manifest /data/admission/new-york-city-v1.json \
  --write-dir /tmp/repair-smoke
# 2. Full run (index is reused, not rebuilt):
scripts/aws/submit-nyc-browser-pack.sh --execute --v2 \
  --image-sha <full-reviewed-merge-sha> \
  --support-geometry s3:<raw-bucket>:acquisition/nyc-five-borough-20km-support.geojson --support-sha256 <support-pin> \
  --candidate-tile-geometry s3:<raw-bucket>:acquisition/nyc-five-borough-output-target.geojson \
  --candidate-tile-sha256 <output-target-pin> \
  --borough-boundary s3:<raw-bucket>:raw/nyc-borough-boundaries-26b.geojson \
  --admission-manifest s3:<evidence-bucket>:evidence/admission/new-york-city-v1.json
# 3. Verify without writing, then promote explicitly:
#    pack-full-cli --promote --verify-only [--report promote-verify.json]
#    pack-full-cli --promote --expected-previous-sha256 03343254... [--report promote.json]
```

The support geometry is the admitted 20 km source-acquisition coverage used to
derive known/unknown cells. The separate candidate-tile geometry is the
unbuffered output target and must reproduce the frozen 61,442-tile index
exactly; substituting either one for the other fails closed.

Before the 128-child array starts, the launcher verifies that the index,
array, and aggregate job definitions all resolve to the exact full merge-SHA
image, then runs `--validate-v2-inputs` against the live S3 evidence. That
read-only gate hash-checks and parses every input, reconciles all 61,442
candidate tiles, and exercises borough activation without accessing R2. If an
array child fails, the launcher waits for all children to become terminal and
retries only each failed index once as an ordinary job; any repeated failure
prevents aggregation.

Batch jobs have no host `/workspace/admission` mount. The AWS launcher supplies
the retained admission object automatically when `--admission-manifest` is
omitted; an explicit value must be an S3 object spec. Both the canonical
`s3:<bucket>:<key>` form and the older `s3:<bucket>/<key>` spelling are accepted.

Budgets enforced by producers and browser parsers: coverage 2 MiB, bounds
6 MiB, notices 256 KiB, generation root 256 KiB. The aggregate step fails if
any artifact exceeds its budget; the size-gate projection test lives in
`app/lib/shadowField/v2/__tests__/artifacts.test.ts`.

Known live-data condition: whole-feature foundations on steep real terrain
can store a roof below the local ground cell (observed in staged v1 tiles
18/77196/98516 and 18/77196/98517, up to ~1 m buried). The shared composer
rejects those cells, so pack-time bounds fall back to the conservative plane
reduction (`reduceConservativeBounds`, parity-tested against composition) and
each affected tile is recorded as a `roof-below-terrain` anomaly in shard
receipts, the aggregation report, and the promotion sample report. The
anomaly list is PR4's input for a buried-roof marching/rendering policy; it
never blocks packing or promotion once recorded.

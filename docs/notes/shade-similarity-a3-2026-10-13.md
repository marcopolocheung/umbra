# A3: verified local shade-pattern matches

A3 adds `likeCandidateId` to the existing assistant tool. A reference must be a verified
sidewalk from an earlier shade-window result. Searches stay within 200/400/800 m of its
centreline midpoint, inherit the reference's date/window/display mode unless overridden,
and default to 400 m. Ordinary shade/sun searches keep their existing validation and behavior.

The client filters by geometry, length and requested-window daylight before searching the
existing frozen signatures. It excludes the reference block face, shortlists at most 500
sides, reranks by exact integer-byte squared distance over the model's 581 annual daylight-union
slots, then returns up to four distinct block faces. Opposite sidewalk sides remain distinct.
A small pool is searched in full. Retrieval remains approximate for larger pools; no
per-query guarantee is claimed beyond the measured cases. Annual similarity and the displayed
window's shade percentages are separate observations.

## Retrieval evidence

The [aggregate measurements](shade-similarity-a3-2026-10-13.json) extend the merged offline
benchmark with production geometry, reference-face exclusion and block-face output. Truth
reads the original slot-major table directly; shortlist reranking reads packed profiles.
Both use the same deterministic distance/spatial-distance/identity tie rule.

The same 1,414 spatially spread references were attempted at each radius. **25 reference
midpoints are outside published support**, so each radius has 1,389 evaluated queries.
Skips are excluded from scores, not counted as perfect matches. The comparison window is
2026-06-15, 14:00–16:00 New York time. This does not evaluate cross-area or citywide search.

| Radius | Queries with ≥10 alternatives | Mean side recall@10 | Mean block-face recall@4 | Profile bytes median / p95 | Range requests median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 m | 1,373 | 1.0000 | 1.0000 | 0.52 / 0.93 MB | 16 / 29 |
| 400 m | 1,384 | 1.0000 | 1.0000 | 1.51 / 2.27 MB | 35 / 61 |
| 800 m | 1,387 | 1.0000 | 1.0000 | 2.84 / 4.14 MB | 68 / 117 |

Every measured query recovered its exact top sides and faces, including the three known M100
failure examples. For pools smaller than ten, side recall uses the available top-k.
Reported bytes are uncompressed binary page sizes. Indexes, geometry, signatures, window
samples, HTTP overhead and compression are separate; these are not measured production wire
traffic or latency. Maximum binary profile reads were 1.60/3.44/5.24 MB at 200/400/800 m.

## Exact profiles through existing delivery

`navigation-prep profiles` copies the already-built shade bytes into side-major profiles,
in shade-index segment order, left then right. It does not run shadows, refit PCA or train a
new model. `profiles/index.json` binds the generation, frozen model, slot order and per-cell
indexes. Cell indexes bind canonical segment order, source payload digest, complete payload
digest and hashes for pages of 32 sides; they omit generation labels to avoid a digest cycle.

Selective reads verify metadata digests, row identity, response boundaries, lengths and each
page hash. Adjacent pages share ranges of at most 256 KiB, with six concurrent requests.
A comparison requests at most 501 profiles and retains at most 16 MiB of verified cached pages.
Whole-object responses, oversized bodies, bad ranges/hashes, missing data and cancellation
fail the comparison rather than substituting signature-only results. Only the reference and
returned matches need ordinary time-window shade reads.

The new artifact is optional. Old generations continue to support A1/A2 and return
`no_similarity_data` for likeness queries. References from another generation must be searched
again. Receipts derive reference details, distances and both timelines from validated tool
evidence; unsupported numeric or reference proposals are rejected.

Local generation **`nyc-2026-09-18-ab747d9b8627`** has 386 profile cells, 1,868,694,702 binary
profile bytes and 1,875,649,968 total profile bytes. The complete generation is
**5,295,945,242 bytes**, below the existing 6 GB limit. The independent verifier compared every
profile byte with the original table. Its publication dry-run reconciles 2,624 objects and
places `current.json` strictly last. No dataset was published and no Worker was deployed.

## Validation and activation

Hermetic checks cover inherited defaults, reference authority, cross-generation rejection,
small filtered pools, integer distances, corrupt pages, bad/oversized/whole-object responses,
cancellation, optional artifacts, deterministic generation rebuilding, stray-file rejection,
receipt tampering and comparison UI. App and prep suites, type/lint/build checks and the
existing Worker type-generation/typecheck/deployment dry-run passed. The full app run passed
2,825 tests; the final targeted run also passed the additional legacy-generation case and all
comparison checks. Navigation-prep passed 29 node tests plus five parity tests.

A browser fixture ran the real A2→A3 loaders, verified receipts and comparison component with
actual local generation bytes served by an intercepted HTTPS origin. Desktop and 390 px mobile
both returned four matches from a 500-side shortlist of 569 eligible sides, read 2.10 MB of
annual binary pages, and showed no page errors or horizontal overflow. This is an isolated
component/data integration check, not a live assistant evaluation or real HTTP latency test.
A4's live-model evaluations remain pending.

Deploy the updated browser consumer and delivery Worker **before** promoting the new dataset:
older manifest parsers reject the new optional field. Publication is an owner decision; merging
this code alone leaves likeness unavailable on the current published generation. Before owner
publication, rerun verification and publication dry-run against the exact candidate, then use
the existing pointer-last uploader. Rollback retains the prior generation and disables A3
while preserving ordinary window searches.

## Reproduction

From `server/navigation-prep`, use Node 24 and the existing dependencies:

```bash
npm run profiles
npm run build -- --grid z14
npm run verify -- nyc-2026-09-18-ab747d9b8627
npm run publish -- nyc-2026-09-18-ab747d9b8627
```

These commands require `NAVIGATION_PREP_ROOT` pointing to the existing local producer data.
`publish` without `--execute` is a local dry-run. Generated data and evidence remain outside git.

The extended benchmark accepts the generation directory, the prior benchmark cache, an output
JSON path, an optional query limit and an optional radius. Run each radius independently:

```bash
node_modules/.bin/tsx tools/benchmark_shade_similarity.ts \
  <generation-directory> <prior-benchmark-cache> <output.json> 1414 400
```

It saves `.checkpoint.json` alongside output every 25 attempted references and resumes a matching
configuration. Remove that checkpoint before rerunning after code/data changes. The local
validation directory is `~/umbra-a3-validation/`; the previous cache is
`~/umbra-signature-benchmark/nyc-2026-09-18-e6718823bbb3/`.

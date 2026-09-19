# NYC navigation data — citywide preparation (in progress)

Checkpoint 5 preparation session of `docs/handoffs/NYC_NAVIGATION_DATA.md`.
Producer code, fixture, and evidence live in this PR; raw downloads and the
citywide generation live under `NAVIGATION_PREP_ROOT` outside git.

## Source pins (acquire receipts)

- Streets: `https://download.geofabrik.de/north-america/us/new-york-260918.osm.pbf`
  (pinned via `-latest` resolution), last-modified
  `Fri, 18 Sep 2026 23:08:34 GMT`, 496,469,143 bytes. Upstream Geofabrik MD5
  `24d1705c4c8f...` verified locally; the producer receipt records the SHA-256
  of those exact bytes together with the PBF header replication timestamp.
- Buildings: `BUILDING_view/FeatureServer/0/query` ordered pages
  (`orderByFields=OBJECTID ASC`, 2,000/page, `outSR=4326`), pinned as one
  acquired release of 1,083,030 features against the catalog
  `data_updated_at`; the receipt records page-total bytes and the SHA-256
  over the ordered raw page bodies.

Receipts as written and verified in this session (see the measured outcome
table below; `validate` re-checks every byte against them, and the verifier
rebuilds the generation id from these receipts plus the final shard bytes).

## Decisions (measurements, not taste)

1. **Grid**: build both z13 and z14 candidates and record selected bytes,
   shard count, and per-request totals over the retained borough samples;
   adopt the winner, document per above.
2. **Wire format**: location stays strict JSON with HTTP transfer
   compression; no binary format considered.
3. **Building source**: NYC Building Footprints only, per the handoff.
4. **Missing heights**: vertices converted feet → metres
   (to 2 dp) inside `server/navigation-prep` only; `0`/`null`/implausible
   (\> 3000 ft) takes the per-feature-code median; when the class has no
   known height, the citywide median is used. Only when neither exists is
   `heightSource = "unknown"` published; each shard ref counts those
   (`missingHeights`). Under construction never stays `unknown`.
5. **Feature/status policy**: placeholder triangles (`1003`) and the
   `Demolition`/`Marked For Demolition` last-status records are rejected;
   other non-building casters ship with `status: "other"`; 5100 (under
   construction) → `under-construction`, so `active` means a ground truth
   building that is currently a valid caster.
6. **Caster reach**: `QUERY_PAD_M` = 400 m remains the cap (same cut-off as
   `USE-to-QUERY_PAD` shadow march). `maxCasterReachM` in the verify evidence
   is computed with the existing `LOW_SUN_ALTITUDE_RAD`=10°.
7. **Budgets**: per-shard `MAX_STREET_SHARD_BYTES`/`MAX_BUILDING_SHARD_BYTES`,
   total `MAX_TOTAL_BYTES`, and a per-request budget on the documented sample
   routes (enforced in `src/verify.ts`). Update `shardContract` when the
   citywide-sized envelope is measured against the retained evidence, and
   record prior→new values here.
8. **Ring repair**: closed/open rings are repaired (duplicate points dropped,
   unclosed rings are closed) and counted; rings that stay degenerate, lose
   their area, or self-intersect are rejected and counted.
9. **Attribute car-over**: retention keeps `DOITT_ID`, `LAST_STATUS_TYPE`, raw
   feet, feature code, and `LAST_EDITED_DATE` in the normalized intermediates;
   the published shard carries only what the client parser allows.

## Evidence checklist (retained under NAVIGATION_PREP_ROOT/evidence)

- borough/support coverage; source receipts and recipe version;
- node, edge, and connected-component counts;
- seam and ghost-node reconciliation; tag histograms;
- building feature/status counts; known/missing/fallback height rates;
- rejected/repaired geometry; maximum height and caster reach;
- shard count and size percentiles; total bytes; notices/licensing;
- sample verification in every borough.

## Pipeline outcome

Session command sequence: `acquire` → `validate` → `normalize` (twice, the
second after the ring-area floor fix) → `build --dry-run --report-only` at
z14 and z13 for the grid decision → `build` (z14) → `verify` (final bytes
only): all green. The z14 dry-run rebuild reproduces the generation id
`nyc-2026-09-18-9f2924750af1` and every recorded budget from unchanged
inputs, matching the offline builder's determinism guarantee. Raw downloads
and the 818 MB generation live under `$NAVIGATION_PREP_ROOT` outside git;
each mutating command's evidence is retained under `<root>/evidence/`.

## Measured outcome (first full build, 2026-09-19 session)

### Source receipts

| source | bytes | SHA-256 |
|---|---|---|
| `new-york-260918.osm.pbf` (Last-Modified 2026-09-18T23:08:34Z; upstream MD5 24d1705c) | 496,469,143 | 4a6d88bb78080820d4526351354c8643025c86d4ae4f82b05bd5b6d106d041e6 |
| Building Footprints ordered pages (catalog `data_updated_at` 2026-09-13T15:49:22Z, 1,083,030 features, 542 pages) | 557,939,065 | 5d350430d6804d6db10378152e9784e361d9447f24166caa67eeae8cc1100a8a |

Recipe identity: `nyc-navigation-producer/recipe-v1`.

### Finalized decisions

1. **Grid z14 wins.** z13 measured 39% fewer shards but every Manhattan cell
   exceeded the 5 MB envelope (largest street shard 12.06 MB, largest
   building shard 10.81 MB, all against 4.75/3.54 MB for z14), so z14 is the
   only candidate that respects the shard budget, at negligible extra total
   bytes (+0.11%). Row of the record:
2. **Wire format:** strict JSON, unchanged. Citywide bytes ≈ 855 MB
   (streets 529.7 MB, buildings 325.7 MB, notices 1.8 KB). This re-settles
   the budget decision, not the representation.
3. **Building source and missing heights:** unchanged from the plan above;
   measured known 1,069,355 / fallback 699 / unknown 0 over 1,070,054
   accepted features, so the typed fallback is nearly always a height.
4. **Caster reach:** nominal max 2,679 m at the top height of 472.44 m and
   10° altitude, but the shipped selection keeps the 400 m
   `QUERY_PAD_M` cut-off.
5. **Budgets:**
   - per-shard `MAX_STREET_SHARD_BYTES`/`MAX_BUILDING_SHARD_BYTES` = 5 MB each
     (meas. 4.75 / 3.54 MB) — unchanged;
   - total `MAX_TOTAL_BYTES`: bumped 100 MB → 2 GB because the measured
     envelope is 855.4 MB (enforced and re-verified after the bump);
   - per-request `MAX_REQUEST_BYTES` = 100 MB, measured borough samples
     4.3–7.1 MB, cross-borough sample 86.8 MB, all passing.
6. **Feature/status:** accepted 1,070,054 of 1,083,030; rejected 12,934
   invalid rings, 29 placeholders, 13 demolition/marked-for-demolition.
   Repaired rings 0 (source rings were already closed).
7. **Ring repair:** fixed the citywide detour: with a 1 m² floor only
   12,934 features are geometry-rejected (1.2%) vs 597,647 first pass that
   used an accidental ~95 m² floor.

### Verified counts

- streets: 1,312,772 nodes, 3,216,560 directed published edges
  (3,217,174 normalized − 614 segments beyond the buffered support);
- graph components: 2,190 (largest 1,048,550 nodes); seam edges 54,596;
  ghost-node records 25,545 (4,341 seam-tip ghosts exist only in one shard —
  the recorded count);
- tag histograms: `footway` 1.85 M directed edges, `residential` 0.52 M,
  `service` 0.48 M, plus `secondary/tertiary/path/steps/cycleway/...` surface
  histogram retained;
- buildings: 1,070,054 features / 1,072,181 rings, status `active`
  1,069,106 / `other` 618 / `under-construction` 330; max height 472.44 m;
- shard sizes by served bytes: streets p50 1.35 MB / p90 2.62 MB / max
  4.75 MB; buildings p50 0.93 MB / p90 2.38 MB / max 3.54 MB;
- sample verification in all five boroughs passes (above).

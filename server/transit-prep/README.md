# NYC transit preparation

Downloads MTA GTFS Static feeds (subway + 6 bus), validates, normalizes, and
publishes versioned client shards to R2. Steps 1–5 of the transit pipeline;
Step 6 (client swap in `app/lib/trainGraph.ts`) is separate future work.

## Data

Seven feeds, ~68 MB zipped, all keyless:

- Subway: `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip`
- Bus (one per borough + BusCo): `gtfs_{bx,b,m,q,si,busco}.zip`
- Out of scope: LIRR / Metro-North (commuter rail, not pedestrian routing)

Upstream facts the code pins (validate fails on drift):

- Bus feeds move on quarterly picks; subway baseline a few times a year.
  Every feed declares its window in `feed_info.txt`.
- Several Mon–Fri services run at once — a base pick, the next pick, school
  variants — and `calendar_dates.txt` removals, not the day columns, decide
  which one runs on a date (Brooklyn: 728 rows, 700 of them type 2). Headways
  therefore describe **one representative date** per day type, not the union of
  everything Mon–Fri. See "Headways" below.
- BusCo ships different tables (minimal 5-column stops, `route_url` in
  routes) with disjoint route_ids; shared stop_ids may disagree by metres
  (worst observed 147.7 m) — borough coords win, past 150 m is fatal.
- `stop_times` past midnight use `25:xx:xx` times; shapes carry no distance
  column (edge lengths come from stop coords).

## Layout (under TRANSIT_PREP_ROOT, outside git)

```
raw/<feed>.zip + raw/source-receipts.json
<work dirs: gtfs_subway, gtfs_bx, gtfs_b, gtfs_m, gtfs_q, gtfs_si, gtfs_busco>
normalized/<generation>/{subway.json,bus-*.json,manifest.json}
evidence/<command>-<ts>.json
```

## Commands

```sh
export TRANSIT_PREP_ROOT=$HOME/shade-prep-data-nyc-transit   # absolute, outside git
npm run acquire:plan   # HEAD-check sizes/dates, no writes
npm run acquire        # download (skip-if-SHA-matches) + refresh work dirs
npm run receipts       # (re)assemble raw/source-receipts.json
npm run validate       # schemas, bbox, integrity, cross-feed pins
npm run normalize      # stats only (also: -- --only subway|bus)
npm run build          # 8 objects + manifest under normalized/<gen>/
npm run verify         # re-hash + structural checks (also: verify <gen>)
npm run publish        # dry-run R2 key list; publish -- --execute to upload
npm test               # tsx --test, hermetic fixtures (no network, no env)
```

Budgets (build fails past them): 3 MB/shard, 15 MB total. Current
generation: ~13 MB. Heap: validate needs 4 GB, normalize/build 6 GB
(Brooklyn `stop_times` is 155 MB / ~2.4 M rows; loaders stream + intern ids).

## Publish env

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_TRANSIT_BUCKET`, optional `R2_TRANSIT_PREFIX` (default `transit/nyc`),
`R2_PUBLIC_BASE` (report only). Keys: `<prefix>/<gen>/{shards,manifest.json}`
plus the stable `<prefix>/current.json` pointer
(`{version, dataset: "nyc-transit", generation, manifestPath, manifestSha256}` —
bucket-relative paths; serving routes are Step 6's job). Previous generations
stay put for rollback; the client reads the pointer, never a hardcoded
generation. A generation id is `nyc-<date>-<hash12>`, where the hash covers
every feed's identity *and* every shard's bytes — so identical inputs rebuild
to the same id, and any change to either the upstream picks or this pipeline
earns a new one. That is what makes the shards safe to serve `immutable`.

## Freshness

Weekly: `acquire:plan` (bytes-free HEAD) → `acquire` on change → `receipts`
→ `validate` → `build` → `verify` → `publish -- --execute`. Guardrails:
fail when any feed's `feed_end_date` is <14 days out; alert when a bus feed
goes >90 days without an upstream change (picks are quarterly). Weekend
construction reroutes never appear in GTFS Static — that needs GTFS-RT,
explicitly out of scope. `manifest.json` carries `schedulesAsOf` and
`headwayDates` plus the honesty notes the transit card must surface
(scheduled-not-traffic bus times, which date each headway table describes,
post-midnight hours 24–27, unsheltered-stop wait assumption).

## Headways

Each day type's table is the schedule of a single date, chosen as the **modal
active-service pattern** among candidate dates on or after a reference date
(the build date by default; `manifest.headwayDates.referenceDate` records it,
so a generation rebuilds exactly). Anchoring on the reference date matters: the
subway feed spans two Saturday picks and the *expired* one covers more dates,
so scanning the whole window would publish a timetable that has already ended.

Unioning every Mon–Fri service instead — which is what day columns alone give
you — roughly halves the headway. Measured over 1,651 Brooklyn weekday buckets
before this changed: a median 0.57x the true single-day figure, 85% understating
the wait, 42% at or below half. B1 direction 0 at 13:00 read 180 s where every
real weekday is 360 or 480.

`manifest.headwayDates` reports, per dataset and day type, the chosen date and
how many candidate dates share its pattern — 48 of 78 remaining weekdays for
the bus graph, 33 of 33 for the subway. Dates outside that pattern (holidays,
school-holiday variants, pick boundaries) genuinely run a different timetable.
Each shard's `stats.unrepresentedServices` lists services with trips that no
representative date includes.

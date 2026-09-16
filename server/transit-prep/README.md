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
- Every id `normalizeBus` pools on is pinned, because pooling six feeds by a
  bare id corrupts silently rather than failing: `trip_id` must be unique
  across the bus feeds (measured 230,532, zero collisions) and a shared
  `service_id` must carry identical calendar *and* calendar_dates rows
  (measured 136, none shared). `shape_id` needs no pin — it is namespaced per
  feed. A `trip_id` collision would interleave two boroughs' stop_times into
  one trip.
- Subway `transfers.txt` is `transfer_type` 2 throughout (613 rows, histogram
  recorded in the validate evidence). Type 3 means "transfer not possible" and
  is fatal, rather than quietly becoming a walkable edge.

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
generation: ~10.8 MB. Each bus shard carries only the routes its own edges
use, plus those routes' shapes and headways — see "Shard scope" below. Heap: validate needs 4 GB, normalize/build 6 GB
(Brooklyn `stop_times` is 155 MB / ~2.4 M rows; loaders stream + intern ids).

## In-station line changes

Subway nodes are parent stations, so a change from the 1 to the 3 at Times Sq is
one node and costs nothing unless something prices it. The only thing that does
is `transfers.txt`'s self-transfer rows (`from_stop_id == to_stop_id`), 463 of
its 613 rows — and because both ends resolve to the same node they used to be
dropped as degenerate. They now land on `StopNode.changeSec`, verbatim:

```
   0 s  x 57    cross-platform: 72 St / Times Sq / 14 St [1,2,3],
                Grand Central and Union Sq [4,5,6], Nevins St [2,3,4,5]
 180 s  x 400   a typical in-station change
 300 s  x 6     Penn Station, Atlantic Av-Barclays, Rockefeller Ctr
 unset  x 33    the feed prices no change; 11 of them serve >1 route
```

0 is data, not a missing value, so the `> 0 ? x : 180` fallback used for
station-to-station transfers is deliberately **not** applied here — it would
turn every free cross-platform change into a three-minute penalty. Where the
feed says nothing the field is omitted rather than defaulted, so no number
appears that the agency did not give; those 11 stations are same-platform pairs
(135 St [2,3], 72 St [N,Q], 34 St-Hudson Yards [7,7X]) where the real cost is
near zero anyway. `stats.multiRouteStationsWithoutChangeCost` reports the gap.

How to spend `changeSec` is Step 6's call — cost, penalty, or both.

## Shard scope

A bus edge belongs to a borough shard when either endpoint stop was listed by
that borough's feed, and the shard's `routes`, `shapes` and `headways` are
scoped to the routes those edges use. `verify` enforces that: a bus shard
carrying a route with no edge, or a shape for such a route, fails.

Overlap between shards is real and irreducible under per-borough sharding —
boundary stops put a route in every shard that lists one of its stops, and
BusCo's express routes (BxM/QM/BM) span the city, so `bus-busco.json` keeps 493
of the 683 shapes. The six shards hold 1,665 shape entries for 683 distinct
shapes. What *was* removable was shipping all 683 in all six regardless of use:
that cost 1.99 MB of the 12.76 MB total.

Routes with no surviving edge anywhere (54 of 399 display routes — every edge
dropped as sparse or implausibly fast) now appear in no shard. Nothing can
route over them, and no headway row survives for them either.

`bus-busco.json` is still 86% of its 3 MB ceiling, so a pick that adds BusCo
routes can fail the build. Raising the per-shard budget or splitting that feed
is an open decision, not something this scoping fixed.

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

### Hours are service-day hours, 0-27

`HeadwayRow.hour` is the hour of the *service day*, not a wall-clock hour of
`dayType`. GTFS puts a departure after midnight on the previous service day at
`24:xx`-`27:xx`, so hours 24+ are the early morning of the *following* date —
which `headwayDates[dataset][dayType].nextDate` and `.nextDayType` name
outright, because the following day is often a different day type:

```
saturday  20260919 -> hours 24+ land on 20260920 (sunday)
sunday    20260927 -> hours 24+ land on 20260928 (weekday)
```

So Saturday's hour 24 is *Sunday* service. A client reaching for `hour === 0`
on a Saturday to find the 00:30 bus will find nothing useful: Brooklyn's bus
tables have no hour 0 or 1 at all, only hours 2-25.

Hours 0-3 and 24-27 both sit around midnight and **must not be merged** — they
are different calendar days carrying different service. They genuinely coexist:
9 of the subway's 26 late-night groups also have an early-morning bucket, and
the 7 train weekday direction 0 ships hour 1 at 1200 s against hour 24 at 570 s.
Collapsing them would blend a 20-minute headway with a 9.5-minute one and double
the trip count. `verify` rejects any hour outside 0-27.

`manifest.headwayDates` reports, per dataset and day type, the chosen date and
how many candidate dates share its pattern — 48 of 78 remaining weekdays for
the bus graph, 33 of 33 for the subway. Dates outside that pattern (holidays,
school-holiday variants, pick boundaries) genuinely run a different timetable.
Each shard's `stats.unrepresentedServices` lists services with trips that no
representative date includes.

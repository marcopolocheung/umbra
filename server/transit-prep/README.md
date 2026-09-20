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
  (measured 136, none shared). `shape_id` is not pooled at all any more — no
  geometry ships — though `validate` still checks every trip references a real
  one. A `trip_id` collision would interleave two boroughs' stop_times into one
  trip.
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
npm run osm            # fetch + cache the OSM subway geometry, stop areas and station-area footways the structure, entrance and walkability steps need
npm run receipts       # (re)assemble raw/source-receipts.json
npm run validate       # schemas, bbox, integrity, cross-feed pins
npm run normalize      # stats only (also: -- --only subway|bus)
npm run build          # 8 objects + manifest under normalized/<gen>/
npm run verify         # re-hash + structural checks (also: verify <gen>)
npm run publish        # dry-run R2 key list; publish -- --execute to upload
npm test               # tsx --test, hermetic fixtures (no network, no env)
```

Budgets (build fails past them): 3 MB/shard, 15 MB total. Current
generation: ~10.2 MB. Each bus shard carries only the routes its own edges
use, plus those routes' headways — see "Shard scope" below. Heap: validate
needs 2 GB, normalize/build 6 GB
(Brooklyn `stop_times` is 155 MB / ~2.4 M rows; loaders stream + intern ids).

## Station entrances

GTFS publishes no NYC entrances. Each subway stop ships `entrances: [{lat, lon, exitOnly?}]`,
the doors listed in the OSM `public_transport=stop_area` that holds a platform of a line
stopping there (`src/entrances.ts`). A door belongs to the station OSM groups it with, not to
whichever station is nearest: at Grand Central the 7, the 4/5/6, the S and the Metro-North
terminal are separate stop areas, and only the 7's doors reach the 7. One platform picks the
stop area: its own `gtfs:stop_id` where tagged (138 stations), else the nearest serving
platform within 250 m.

476 of 496 stations resolve. An empty list means OSM maps no door there (the 18 Staten Island
Railway stations, Newkirk Plaza, Canarsie–Rockaway Pkwy), and the client uses the station
point; no field at all means a cache from before stop areas, which is unknown. `access=no|private`
and `entrance=emergency` are dropped and `entrance=exit` is marked `exitOnly`. `open=no` is
**not** a closure here: all 31 NYC entrances with it are `door=hinged|swinging`, a door kept
shut, and at four stations it is the only door.

## Subway↔bus transfers

Bus feeds publish no transfers, so `transfers.ts` pairs every bus stop within 200 m of a
station (uncapped) as a straight-line `spatial` stub, which the client refuses (#419).
`walkability.ts` promotes a stub to `walked` when OSM's pedestrian ways connect one of the
station's own doors (exit-only doors only when leaving) to the stop within 1.5 × the
door-to-stop straight line + 50 m, each point joining the network within 20 m. It publishes
`walkM` (station point → door straight, then the routed street path) and `minSec` = `walkM`
at 1.4 m/s. A station with no door walks nothing. The parameters and the SHA-256 of
`raw/osm/footways.json` go in the manifest (`constants.walked*`, `walkedTransfers`), and
`verify` re-routes every stub on those bytes and fails on any difference, so it needs the
same OSM cache the build used.

## Segment structure (tunnel / viaduct / at grade)

GTFS says nothing about whether a ride is underground, and for a shade app that is the
question. `npm run osm` fetches the NYC subway route relations and their member ways from
Overpass (two queries, ~5 MB) into `raw/osm/` with a receipt, plus the stop areas the entrance
join below reads (a third, ~2.7 MB); `build` reads **only** that
cache, so a build never depends on Overpass being reachable. Refreshing is deliberate.

`src/structure.ts` samples along the straight line between each edge's two stops and takes the
nearest way *of that same service*, which is what stops the 7 — elevated over Queens Boulevard
— inheriting the E and F's tunnel underneath it. Route-relation membership also excludes yards,
sidings and crossovers, which are 43% of `railway=subway` ways and carry no riders.

Edges ship shares, not a label, because the F and G share the Culver Viaduct for part of a run:

```jsonc
"structure": {"underground": 0.86, "elevated": 0.14}
```

They sum to at most 1; the shortfall is the part no way matched. An edge with no `structure`
is **unknown**, which is not `at_grade` — that means a matched way tagged neither tunnel nor
bridge nor cutting nor embankment. Current generation: 1,816 of 1,949 edges determined (93.2%),
with a measured 1.2% error rate against lines documented as fully underground.

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
that borough's feed, and the shard's `routes` and `headways` are scoped to the
routes those edges use. `verify` enforces it: a bus shard carrying a route with
no edge fails.

Overlap between shards is real and irreducible — a boundary stop puts a route in
every shard listing one of its stops, and BusCo's express routes span the city.
Shards stay self-contained: every stop a shard's edges reference ships with it,
including the far endpoint of a cross-borough hop such as the S53 over the
Verrazzano.

Routes with no surviving edge anywhere (54 of 399 display routes — every edge
dropped as sparse or implausibly fast) appear in no shard. Nothing can route
over them and no headway row survives for them.

## Geometry

**Route geometry ships per edge**, as a Google encoded polyline in `RouteEdge.geom`.

`shapes.txt` gives one polyline per *pattern* — a distinct stop sequence — and a
route has many. The A train has 12 in direction 0 alone (Far Rockaway, Lefferts,
Rockaway Park, short-turns). Shipping one representative polyline per
`route:direction` meant picking the busiest pattern (166 of ~460 A trips, 36%)
and discarding the rest, so the line traced a different part of the city for
every other trip. Measured on the last generation that shipped them: **54 of 56
subway `route:direction` pairs had more than 10% of their served stations over
400 m off the line** — the M train 27 of 36, the 5 train 28 of 46 — and 208 of
289 Brooklyn bus pairs, median 27%.

Per-*pattern* shapes would not fix it either, because an edge is aggregated
across patterns: `medianSec` is the median over every trip using that stop pair,
whatever branch it ran. Geometry that matches the graph has to be per-*edge*.

So each edge is sliced out of the shape its own trips run on: both stops are
projected onto the shape, and the shape points strictly between the two feet are
published. The endpoints are the stops, which the shard already carries. Most
edges are served by several shapes (74.9% subway, 38.9-59.0% bus) — the same
fact that sank per-route geometry — but between two *adjacent* stops every
pattern runs the same track: over 250 multi-shape edges per feed the sliced
length was identical for every shape serving the edge, median spread 0.0 m in
all seven, worst 0.3 m. The lowest `shape_id` is taken, so the build reproduces.

`shape_dist_traveled` is absent from all seven feeds, so the slice is by
projection rather than by published distance. That costs nothing: the snap is
0.0 m at the median on subway and ~8 m on bus, where the stop is at the kerb and
the shape is the street centreline.

**Absence is a stated fallback, not a fix.** 32 of 24,354 edges (0.13%) run on a
shape that doubles back between the two stops, so no sub-path between them
exists; an edge whose stops land on one segment has nothing between them at all.
Neither ships a `geom` and a client draws the straight chord. `distM` is the
along-track length of the slice where there is one, and the straight-line
haversine between the two stops where there is not.

The wire format was decided on size. As JSON coordinate arrays at 5 dp the seven
shards' geometry adds 6.58 MB (+71%) to a first load that already fetches
9.21 MB; encoded it adds 1.14 MB (+12.4%), and `subway.json` grows 1.16 MB to
1.28 MB. The 1.1 cm the quantisation costs is far finer than the ~8 m a bus stop
already sits off its own centreline.

The straight chord this replaces was justified on *length*, and on length it
held up — straight over track is 0.996-1.000 at the median in all seven feeds.
Length was the wrong statistic. One subway edge in five was drawn more than
100 m off the track it claimed to be (worst 1,862 m), because express and
river-crossing hops skip stops and the chord cuts across everything between;
Staten Island, Bus Company and Queens buses are as bad. The measurement is
`docs/notes/transit-edge-geometry.md`.

Subway geometry affects only drawing, since `TRAIN_SUN_EXPOSURE.subway` is 0. A
bus shape is the street centreline, about half a carriageway off the pavement a
rider walks, so slicing it fixes the *drawing* and does not by itself earn a
shade claim sampled along the ride.

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

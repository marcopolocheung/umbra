# Pricing the wait and the change (Phase 2, #391)

Why the train search stopped being keyed on the station alone, what the two new
terms are worth against the real feed, and the one place the published data
turned out not to support the inference it invites.

Sequel to `docs/notes/transit-cost-seconds.md`, which put the graph in seconds
and named these two terms as the things it deliberately did not price.

## The state was the bug

`trainDijkstra` keyed its search on the station. Both remaining terms depend on
**which route you board**, and a station-keyed search cannot see a boarding at
all:

- **Changing lines inside one station.** No transfer *edge* is traversed going
  from the N to the Q at Union Sq — it is one node, and both routes' edges leave
  it. The feed publishes `changeSec` for exactly this, and nothing charged it.
- **Waiting to board.** Half a headway is the expected wait for an
  unsynchronised arrival at an unsynchronised service, and the headway is a
  property of the route, not of the platform.

So the state is now `(station, what the rider arrived on)`, where the arrival is
one of: on foot, over a transfer edge, or on a named route. That is one state
per route serving a station plus two, and in the published NYC graph the route
half of it is 956 (station, route) pairs against 496 stations — low thousands,
and the array-scan PQ still holds. Measured, the full 5 × 5 candidate sweep in
`findBestTrainRoute` costs 3–102 ms on the real graph, the longest being
Times Sq → 231 St at 23 stops, against an Overpass round trip measured in
seconds.

The arrival is what makes the two charges separable:

| arrived | boarding a different route costs |
|---|---|
| on foot, at the origin | the wait only — walking in off the street is not a change |
| over a transfer edge | the wait only — the edge's `minSec` already bought the walk between platforms |
| on another route, at this node | `changeSec` at this station **plus** the wait |
| on the same route | nothing; you are already on the train |

## Where each number comes from

| Term | Source |
|---|---|
| `changeSec` | the feed's own cost of changing lines inside that station, carried through `TransitStop` → `TrainStation` |
| Headway | `medianSec` for the `(route, direction, dayType, hour)` being boarded, halved |
| Transfer | unchanged — the agency's `min_transfer_time`, already the edge weight |
| Overpass | nothing, for either. It ships no timetable and no change cost, and behaves exactly as it did |

**Directional, because a platform is.** The tables are published per direction
and 144 of their 1,313 route-hours publish only one of the two — the peak-only
`6X` and `7X`, the `Z`, the Rockaway `H`. Borrowing the other direction's number
would be inventing a frequency nobody scheduled, so a wait is priced only where
the feed published one for the exact key.

**Absent is not zero.** `changeSec: 0` is a real value at the 57 cross-platform
interchanges; 33 stations publish nothing at all and the field stays absent
through both hops (#384). An absent change charges nothing because it is
*unpriced*, not because it is free, and the distinction is what stops a number
being made up for it.

## Which clock

`dateRef.current` is a browser-local `Date`, and the tables are a New York
timetable however far away they are read. The boarding zone is resolved with
`zoneAt(origin)` after `ensureZoneLookup()` — the route pipeline is already
async, so the boundary set can simply be waited for rather than raced — and
turned into an offset with `utcOffsetMinAt(zone, at)`. An unresolved lookup
leaves the wait unpriced rather than reading hour 0 in UTC, which is the same
choice E5 made for the trip's departure zone.

Every boarding on a path is priced at the departure instant rather than at the
time the rider would really reach that platform. The tables are hourly and a
subway journey rarely outlives the hour it started in; a time-dependent search
is a different thing and is not this.

## Service-day hours, and the one the feed does not reach

`hour` is a service-day hour, 0–27 (#383). Hours 24+ are the early morning of
the *next* date, whose day type the manifest gives as `nextDayType`. So:

- **04:00–23:59** reads that day's table at that hour. Unambiguous.
- **00:00–03:59** reads the *previous* service day at hour + 24, which is the
  encoding the manifest documents and the one NYC's overnight service uses. It
  refuses outright when `nextDayType` says that table describes a different
  morning — the weekday table's hour 24 is a Thursday morning and cannot price a
  Saturday one.

The tables' own hours 0–3 are therefore never read. Both buckets describe the
same calendar morning from different service days, and they may not be merged;
reading one and not the other is what "not merged" costs. It is 34 rows of 2,482.

## The inference the data does not support

Charging nothing where nothing is published looked like the honest default until
it was run against the feed. It is not: a zero wait makes an unscheduled route
the cheapest edge in the graph, and the router boards it by preference.
Measured, a 10 a.m. Times Sq → Grand Central trip took the **`7X`**, the peak-only
Flushing express, which publishes no trips at that hour. The `FX` publishes none
on a weekday at all and would have won every Queens Boulevard trip for nothing.

So a missing row is read as what it is — the schedule listing no trips — and
that boarding is refused, but **only in an hour the tables describe**:

| reading | when | effect |
|---|---|---|
| `published` | a row exists | charge half of it |
| `no-service` | no row, in an hour the table covers | the edge cannot be boarded |
| `unreadable` | no table, no departure time, or an hour nothing covers | charge nothing, refuse nothing |

The third row is load-bearing, and the limit on the second is too. The published
feed reaches hour 24 and stops: the weekday table lists nine route-directions
there and nothing at all at 25–27, on a system that runs all night. Read
positively an hour-24 headway is still the agency's own number and is charged;
read negatively it stranded **36 of 65 sampled trips with no transit option at
all** at half past midnight. So the negative inference stops at hour 23, and the
small hours price what they publish and refuse nothing.

## What it is worth, against the published feed

Sampled over 65 station pairs spread across the system. The baseline is the graph
the old adapter built — `changeSec` stripped from every station and no headway
table — so the two terms can be read apart:

| when | mean line changes: before → + `changeSec` → + wait | mean wait | trips left with no option |
|---|---|---|---|
| weekday 10:00 | 2.42 → 1.80 → **1.06** | 7.0 min | 0 |
| saturday 14:00 | 2.42 → 1.80 → **1.00** | 8.5 min | 0 |
| weekday 23:30 | 2.42 → 1.80 → **0.87** | 11.3 min | 2 |
| weekday 00:30 | 2.42 → 1.80 → 1.85 | 0.1 min | 0 |
| weekday 02:00 | 2.42 → 1.80 → 1.80 | 0.0 min | 0 |

The change of shape is the headline, and both terms do some of it. A free
interchange was worth taking for any saving at all, so the router took nearly
two and a half of them per trip; `changeSec` alone removes a quarter of those,
and pricing the wait takes it down to one. The two trips that lose their option
at 23:30 lose it to the timetable — their only path ran on a line that has
stopped for the night. The last two rows are the overnight window, where nothing
is priced and nothing is refused: `changeSec` is all that applies, which is why
they sit at 1.80.

Door to door on four named routes, at 10 a.m. on a weekday:

| O–D | before | after |
|---|---|---|
| Times Sq → Grand Central | `GS`, 4.5 min | `GS`, 6.5 min (2.0 waiting) |
| Union Sq → Atlantic Av-Barclays Ctr | `N`/`Q`/`B`, 14.0 min | `Q`, 18.0 min (4.0 waiting) |
| Columbus Circle → Wall St | `1`/`2`, 15.5 min | `2`, 19.5 min (4.0 waiting) |
| Times Sq → 231 St (Bronx) | `2`/`1`, 31.0 min | `1`, 38.0 min (2.5 waiting), 23 stops |

The first row is the one this was built for. `N`/`Q`/`B` reading as a single
uninterrupted ride is the exact symptom `transit-cost-seconds.md` recorded, and
it was two free changes of line at Union Sq and Atlantic Av. It is now the `Q`,
which is what a rider takes.

## What reaches the user

A transit leg's `travelTimeSec` now includes the wait, so the quoted time moved.
`RouteLeg.waitSec` carries how much of it is platform, and the leg line says so
— `11 min · incl. ~2 min wait · 2 stops · assumed underground`. The `~` is not
decoration: half a published median headway is an expectation for an
unsynchronised arrival, not a prediction of the next train, and the table itself
is one representative date's schedule.

## What this still does not price

- **Where the rider is standing while they wait.** The wait is a number of
  seconds, not an exposure — which is the whole product argument for the
  dataset, and which needs the per-segment exposure model (#393, Phase 3B)
  before it can be answered.
- **Waiting at the time you actually arrive.** See the departure instant above.
- **Anything overnight.** 01:00–03:59 maps to hours 25–27, which the feed does
  not publish, so it is priced exactly as it was before: not at all.

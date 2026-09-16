# Transit cost in seconds (step 6, S3a derivation)

Why the train graph's edge weight moved from metres to seconds, what that
changes about which route wins, and the two terms it deliberately still does
not price.

## The unit was the bug

Before this slice, `TrainGraphEdge.weight` was metres and `trainDijkstra`
minimised distance. `findBestTrainRoute` then chose between candidate stations
with:

```
totalCost = walkInM + pathDistM + walkOutM
```

Every term is a metre, so a metre walked and a metre ridden cost the same. That
is not a rounding error, it is a claim — and the claim is false by a factor of
about six: NYC's subway covers `subway:101 → subway:103` in 90 s over 544 m
(6.0 m/s) against a walk at 1.4 m/s.

Two consequences followed, and the second is the one that matters:

1. **Riding could never beat walking the same ground.** `distM` is
   straight-line haversine, and a walk leg was priced in the same straight-line
   metres. Riding a stop therefore cost *at least* what walking it cost.
2. **So a transfer could never pay.** On top of (1), `TRANSFER_PENALTY_M = 300`
   was pure surcharge. The router's dominant strategy was to alight at the
   first station near the destination and walk — which it did, on a toy graph
   and on the real one.

The fix is not a better constant. Distance and time are only interchangeable at
a fixed speed, and a journey that mixes a 1.4 m/s mode with a 6 m/s one has no
fixed speed. So the graph is priced in seconds and the walks are converted
through `travelTimeSeconds`.

## Where each number comes from

| Edge | Before | Now | Source |
|---|---|---|---|
| Rail hop, shards | `distM` | `medianSec` | the feed's own scheduled median run time |
| Rail hop, Overpass | `haversineMeters` | `distance / TRAIN_SPEED_MPS` | 30 km/h, the figure `useRouting` already used to turn a transit leg into a duration |
| Transfer, shards | `TRANSFER_PENALTY_M` (300) | `minSec` | the agency's published `min_transfer_time` |
| Transfer, Overpass | `TRANSFER_PENALTY_M` (300) | `TRANSFER_PENALTY_SEC` (180) | modal `min_transfer_time` in the NYC subway feed |
| Walk to/from station | metres, added raw | `travelTimeSeconds(m, "walk")` | 1.4 m/s, the walking policy the rest of routing uses |

The Overpass producer only ever had geometry, so its seconds are derived, not
measured — a 30 km/h average that includes dwell. The shard producer's are
measured. Both are seconds, which is what makes them addable to a walk; only one
of them is a timetable, which is why the shards are preferred wherever they
reach.

`TRANSFER_PENALTY_SEC = 180` is a real change of behaviour for the Overpass
path, not a unit conversion. The old 300 m was worth ~36 s at train speed;
180 s prices an interchange as the feed actually measures one. Overpass routes
will now avoid transfers they used to take.

## Checked against the real feed

Built from the published `subway.json` (496 stations, 1,949 rail edges, 150 GTFS
transfers), door-to-door including the straight-line walks:

| O–D | Route found | Ride |
|---|---|---|
| Times Sq → Grand Central | `GS`, the 42nd St Shuttle | 4.5 min |
| Union Sq → Atlantic Av-Barclays Ctr | `N`/`Q`/`B` | 14.0 min |
| Columbus Circle → Wall St | `1`/`2` | 15.5 min |
| Times Sq → 231 St (Bronx) | `2`/`1`, 18 stops | 31.0 min |

These are close to the times the agency advertises, which the metres model could
not have produced at any constant.

## What this still does not price

Both of the remaining terms depend on **which route you are boarding**, and a
shortest path keyed on station alone cannot see that. Splitting them out is
deliberate, not an oversight:

- **Waiting to board.** The headway table is the reason this dataset exists — it
  is what makes "how long am I standing in the sun at this stop?" answerable.
  Half a headway is the expected wait for an unsynchronised arrival, and it is
  charged once per boarding.
- **Changing lines inside one station.** `changeSec` is the feed's own cost for
  exactly this, and **0 is a real value** at the 57 cross-platform interchanges.
  No transfer *edge* is traversed when you change from the N to the Q at one
  station node, so nothing today charges anything: the routes above switch lines
  mid-path for free, which is why `N/Q/B` reads as one ride.

Pricing either one requires the search state to be `(station, route boarded)`
rather than `station`. That is the next slice.

## Consequence for the acceptance bar

A transit leg's duration is now read straight off `path.totalSec` instead of
being re-derived in `useRouting` by dividing distance by an assumed 30 km/h. Any
future change that reintroduces a distance-denominated transit term has to
explain what fixed speed makes it valid.

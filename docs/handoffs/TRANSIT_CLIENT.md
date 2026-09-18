# Transit client — Step 6

> **You are here because the NYC transit data is published, verified and reachable, and
> nothing in the app reads it.** `server/transit-prep` is steps 1–5 of a six-step pipeline.
> This document is step 6: make the browser route on that data instead of Overpass.

> **Superseded for planning by [`TRANSIT_NEXT.md`](TRANSIT_NEXT.md).** S1–S3a and the S5
> decision are merged; this document is now the *record* of how the client came to route on the
> published data, and the settled decisions behind it. What is left — S3b, bus, and the two
> defects the browser found — is planned there.

**Status, 2026-09-16.** S1, S2 and S3a are implemented: the app fetches the published shards,
routes the NYC subway on them, and prices the graph in seconds. S3b (#391), S4 (blocked on
#388) and the S5 decision are covered below. Overpass is **not** retired and will not be —
see S5.

**Verified in a browser** (`npm run dev`, real published data, Bryant Park → Madison Sq Park).
The three r2.dev hops return 200 from `localhost:5173` — which is in the bucket's CORS
allowlist; `127.0.0.1:4173`, where `npm run e2e` runs, is **not**, so the e2e suite cannot
exercise this path. The app logs
`[transit] using published shards: generation nyc-2026-09-16-…, 496 stations`, matches 431
Overpass entrances, and boards Times Sq-42 St for 23 St. The card renders
`Via Transit · 27% shadow · 566 m` with `Leg 2: Broadway Local · 4 min · 3 stops`.

Two things the browser found that no test could:

- **The map draws the wrong route in transit mode** — `selectedRouteIndex` indexes
  `filteredRoutes` in the panel and `navRoutes` in `useRouting`, which differ as soon as the
  mode filter bites. Measured: the drawn line is pixel-identical in walk and transit mode, and
  the subway polyline never reaches the canvas at all. **Pre-existing** (G6a, `90b2e48`), filed
  as **#395**. It means `buildTrainDrawData` has never actually rendered.
- **The transit card asserts "Underground — no sun"** for every subway leg, which is
  `TRAIN_SUN_EXPOSURE.subway = 0.0` reaching the user as a claim. #393 is therefore a
  user-facing honesty bug, not just an internal constant.

**Verified 2026-09-16**, `main` at `55f9c71`. Every claim below has a command next to it.
If this document disagrees with the code, the code wins — fix the document in the same PR
as the work, as `docs/tracks/README.md` requires of the briefs.

---

## What is live

```
https://pub-c960c9abbd204246901a291a24850f55.r2.dev/transit/nyc/current.json
  → nyc-2026-09-16-f8c5f275d305    7 shards + manifest, 9.14 MB
```

Bucket `umbra-transit-public` (public, CORS allows `shademapnav.vercel.app` and
`localhost:5173`). Shards are served `immutable`; the pointer and manifest are `max-age=300`.

Re-check it:

```sh
curl -s -A "Mozilla/5.0 Chrome/140" \
  https://pub-c960c9abbd204246901a291a24850f55.r2.dev/transit/nyc/current.json
```

Two traps. `r2.dev` **filters on User-Agent** — Python's `urllib` gets a 403 where curl with a
browser UA gets 200, so any server-side check needs a real UA. And `r2.dev` is rate-limited;
production wants a custom domain (`docs/shadow-engine-v2/02b-placement.md`).

Rebuilding and republishing is `server/transit-prep`'s job, not yours; credentials live in
`~/.config/umbra/r2-transit.env`.

---

## The contract you consume

Three hops: pointer → manifest → shards. Paths in the pointer are **bucket-relative**, so the
client supplies the base URL itself (see *Open decisions*).

```jsonc
// current.json
{ "version": 1, "dataset": "nyc-transit",
  "generation": "nyc-2026-09-16-f8c5f275d305",
  "manifestPath": "transit/nyc/<gen>/manifest.json",
  "manifestSha256": "a5de6d…" }
```

`manifest.json` lists the 7 shards with `bytes`/`sha256` (verify if you like — every hash held
when checked from the public URL), plus `schedulesAsOf`, `headwayDates`, `constants` and
`notes`. **Read `notes`.** They are the honesty statements the transit card has to surface.
A shard ref carries `key`/`bytes`/`sha256`/`stops`/`edges`/`routes` and **no bounding box** —
see S1's correction below.

The two shard kinds differ more than the sketch above suggests: `subway.json` is
`kind: "subway"` with an object `feed` and a `transfers` array; `bus-*.json` is
`kind: "bus-shard"` with a *string* `feed`, an array `feeds`, a `variants` field on each route,
and **no `transfers` key at all**.

```jsonc
// subway.json — keys: kind, feed, stops, edges, routes, headways, transfers, stats
{"id":"subway:127","name":"Times Sq-42 St","lat":40.75529,"lon":-73.987495,"changeSec":0}
{"from":"subway:101","to":"subway:103","route":"1","direction":1,
 "medianSec":90,"trips":550,"distM":544}
{"from":"subway:112","to":"subway:A09","minSec":180,"kind":"gtfs"}
{"from":"subway:101","to":"bus:100587","minSec":57,"kind":"spatial"}

// bus-<borough>.json — keys: kind, feed, feeds, stops, edges, routes, headways, stats
{"id":"bus:200132","name":"LILY POND AV/McCLEAN AV","lat":…,"lon":…,"feeds":["bus-si"]}
{"route":"B1","direction":0,"dayType":"weekday","hour":13,
 "medianSec":360,"trips":9,"services":1}
```

Sizes: subway 1.09 MB (2,737 stops / 1,949 edges / 5,322 transfers); bus shards 0.94–2.16 MB.
A shard is **self-contained** — every stop its edges reference ships with it, including the far
end of a cross-borough hop (the S53 over the Verrazzano puts Staten Island stops in `bus-b`).

**Route geometry ships per edge**, as an encoded polyline in `edge.geom`; an edge without one
is drawn stop-to-stop. Sampling along a bus line is a separate question the geometry does not
settle — see *Settled decisions*.

---

## The five mismatches — this is the actual work

`app/lib/trainGraph.ts` (679 lines) was written against Overpass. The shards do not fit it.

**1. Identity is the wrong type.** ~~`TrainStation.id` and `TrainGraphEdge.to` are `number`~~
**Done in S2.** Both are now namespaced strings. The Overpass producer emits `osm:<node id>`,
so the only place OSM numbers survive is inside `buildGraph`.

On *"anything that persisted a station id"*: nothing needed migrating. A saved route stores a
whole `RouteOption`, which carries `trainDrawData`, whose stop ids were numbers — but those ids
are only ever compared against other ids from the **same** `trainDrawData` object
(`transferIds.has(s.id)` in `MapView.tsx`). An old record stays self-consistent and still
draws; no id is ever compared across records.

**2. The cost model is in metres.** `TrainGraphEdge.weight` is metres and `trainDijkstra`
minimises distance, with a flat `TRANSFER_PENALTY_M = 300` standing in for a change of line.
Shards give **seconds**. That is strictly better data, but once you are in seconds the flat
penalty has to become time, and two real terms appear that the app has never had:

- `StopNode.changeSec` — the feed's own cost for changing lines inside a station
- **headway wait** — from the `headways` table, the thing that makes "how long am I standing
  in the sun at this stop?" answerable at all. It is why this data exists.

**3. `TrainStation.lines` has no shard equivalent.** ~~Derive it by grouping `edges` by
`route`.~~ **Done in S2** — exactly that. Times Sq-42 St derives `["1","2","3"]` from the real
shard.

**4. Bus is new surface, not a swap.** `TrainMode` is `subway | light_rail | monorail` and
`TRAIN_SUN_EXPOSURE` has no bus figure. A bus runs at grade in the sun and a bus stop wait is
fully exposed — that is new modelling, and it is the half that matters most for Umbra. Note
`TRAIN_SUN_EXPOSURE.subway = 0.0` is already a simplification: NYC's elevated lines (7 in
Queens, J/M/Z, much of the outer boroughs) are not underground. Out of scope here; worth filing.

**5. Station entrances still come from Overpass.** **Decided: they stay there.**
`fetchStationEntrances` (`app/lib/overpass.ts:657`) runs alongside the graph fetch in
`useRouting.ts`, and shards carry station **centroids**, not entrances. Entrances are not in
GTFS, so the pipeline cannot supply them today — and Overpass is needed anyway for every city
the NYC dataset does not cover. See S5 below.

*S2 had to fix the matcher to do this safely.* `matchEntranceToTrainStation`'s name arm is a
**substring** test and was unbounded by distance, which was survivable against a bbox-limited
Overpass station set and is not against all 496 GTFS-named stations: `Wall St` is a substring of
`Christopher Street-Stonewall Station` 3 km away, and a station named `Broadway` matched an
entrance 9.4 km up the same street. Because `useRouting` only supplies a centroid for stations
with *no* matched entrance, one false positive **replaces** a station's position with a door in
another neighbourhood. Measured over 822 real OSM entrance nodes in Manhattan against the real
shard: **12 matches landed beyond 400 m before the fix, 0 after, with the same 816 matched** —
so bounding the name arm and taking the nearest match costs no true matches.

---

## Where it plugs in

`app/hooks/useRouting.ts:854`:

```ts
const [trainGraph, entrances] = await Promise.all([
  fetchTrainGraph(trainSouth, trainWest, trainNorth, trainEast, calcSignal),
  fetchStationEntrances(trainSouth, trainWest, trainNorth, trainEast, calcSignal),
]);
```

Everything downstream — `findBestTrainRoute`, `matchEntranceToTrainStation`, the
`TRAIN_SUN_EXPOSURE[lineMode]` lookup at `:979`, `buildTrainDrawData` at `:1031` — consumes
`TrainGraph`. Keeping that interface and replacing only its **producer** is the cheapest
first slice, even though the type has to change (mismatch 1).

`RouteLeg.sunExposure` (`routing.ts:100`) already carries per-leg exposure. Transit legs
already exist. You are changing where the graph comes from, not inventing legs.

---

## Suggested slicing

Each is one PR. Stop after any of them and the app still works.

**S1 — transport. Landed.** `app/lib/transit/` — `shardContract.ts` (types + strict parsers)
and `remoteTransit.ts` (pointer → manifest → shards, each verified against the previous hop's
digest, cached by generation). `VITE_TRANSIT_BASE`, absent = feature off. No `trainGraph`
change. 19 hermetic tests, no network in CI.

*Correction:* shards are chosen **by kind, not by bbox** — the manifest gives each shard byte
and record counts but **no extent**, so a client cannot tell whether `bus-q.json` covers a
bbox without downloading it. Subway is one city-wide shard, so kind selection is exact for
everything S2/S3 route. Per-shard bounds in the manifest are the fix, and they are a pipeline
change — filed as **#388**, needed before S4 can pick bus shards geographically.

**S2 — adapter, subway only, behind the flag. Landed.** `trainGraphAdapter.ts` builds a
`TrainGraph` from the shards; `trainGraphSource.ts` picks the producer and `useRouting.ts`
calls that instead of `fetchTrainGraph` directly. Station ids are namespaced strings —
`osm:123456` from Overpass, `subway:127` from the shards — so the two producers cannot
collide (mismatch 1), and `lines` is derived by grouping edges by `route` (mismatch 3).

*The dataset is NYC-only and the manifest has no extent*, so the shard graph is accepted only
once it holds **two or more stations inside the requested bbox**; everywhere else, and on any
failure, Overpass still answers. Without that check a Tokyo route gets Manhattan stations and
no transit option at all.

*Finding, and the case for S3:* under the metres model **a transfer can never pay**. `distM` is
straight-line and the walk legs are priced in the same metres, so riding one more stop can
never beat walking it, and `TRANSFER_PENALTY_M` is pure surcharge on top. On the toy graph the
router alights one stop early and walks rather than cross a transfer. That is the cost model,
not the adapter — and it is why S3 is not optional polish.

**S3 — time-based cost.** *Split in two, because `changeSec` and the headway wait turned out
to need a different search, not just a different number.*

**S3a — seconds. Landed.** `weightSec` replaces `weight` on every edge and both producers emit
it: `medianSec` from the shards, `distance / TRAIN_SPEED_MPS` from Overpass. A transfer costs
the agency's published `minSec` (Overpass: `TRANSFER_PENALTY_SEC = 180`, the feed's modal
`min_transfer_time`). `findBestTrainRoute` converts its walk legs through `travelTimeSeconds`,
and `useRouting` reads `path.totalSec` instead of re-deriving a duration from distance.
Derivation note: `docs/notes/transit-cost-seconds.md`. Real feed, door-to-door: Union Sq →
Barclays Ctr 14.0 min on `N/Q/B`, Columbus Circle → Wall St 15.5 min on `1/2`.

**S3b — the two route-dependent terms. Not started.** `changeSec` and the headway wait both
depend on *which route you are boarding*, which a path keyed on station alone cannot see. No
transfer edge is traversed when you change from the N to the Q inside one station, so that
change currently costs nothing — which is why the routes above read as a single ride. Both
need the search state to be `(station, route boarded)`. Filed as **#391**.

**S4 — bus. Blocked on #388, and correctly so.** New `TrainMode` member, a sun-exposure figure
for at-grade transit, stop-wait exposure.

Selecting bus shards needs the per-shard bounds the manifest does not publish. Without them the
only correct choice is *all six*, which is ~8 MB on a free-tier browser app — and borough names
cannot stand in, because a shard is self-contained by design (the S53 over the Verrazzano puts
Staten Island stops in `bus-b`). `selectShardRefs()` already takes `{ bus: true }`; it needs the
data, not the code. The pipeline change is #388, and republishing is `server/transit-prep`'s
job, not the client's.

The sun-exposure figure is the other half and is product work, not plumbing:
`TRAIN_SUN_EXPOSURE` prices a *mode*, and a bus is at grade in full sun while a bus stop wait is
fully exposed and unsheltered (GTFS carries no shelter geometry). Note the same table already
calls every NYC subway line underground at 0.0, which the elevated 7 and J/M/Z are not —
filed separately as **#393**.

**S5 — decided: Overpass stays, and is not going anywhere.** Two independent reasons, either
one sufficient:

1. **Entrances.** `fetchStationEntrances` is the only source of them. Shards carry station
   *centroids*, and `useRouting` walks to a door, not a centroid — it falls back to the centroid
   only when no entrance matches. Retiring Overpass would silently make every NYC transit route
   board at the middle of the station footprint. Entrances would have to be added to the
   pipeline first, and they are not in GTFS.

   *Measured, not assumed:* `matchEntranceToTrainStation` tries a **name** match first and only
   then nearest-centroid within 300 m, and its names now come from GTFS (`Times Sq-42 St`)
   rather than OSM (`Times Square–42nd Street`). Over 822 real OSM entrance nodes in Manhattan
   against the real shard, **816 match and none lands beyond 400 m** once the name arm is
   bounded (see mismatch 5). What is still unverified is what any of this looks like on the map,
   which needs a browser.
2. **Everywhere that is not New York.** The published dataset is NYC-only. `trainGraphSource.ts`
   accepts the shard graph only where it holds two or more stations inside the requested bbox,
   and Overpass answers everywhere else. Umbra routes transit in any city with OSM route
   relations; that is not a capability to trade away for one city's timetable.

So the two producers coexist by design. The shards are preferred where they reach because they
are a timetable rather than geometry; Overpass remains the floor. Nothing in S1-S3a removed an
Overpass call, and mismatch 5 is resolved as "the dependency stays".

---

## Settled decisions — do not re-litigate

Each was measured; the measurement is in the PR.

- **Headways describe one representative date per day type**, chosen as the modal
  active-service pattern on or after a reference date — not the union of every Mon–Fri
  service. Unioning them halved the headway (median 0.57× true, 42% of Brooklyn buckets at or
  below half). `manifest.headwayDates` names the date and how typical it is. (#376)
- **`hour` is a service-day hour, 0–27, not a wall-clock hour.** Hours 24+ are the early
  morning of `headwayDates[dataset][dayType].nextDate`, whose type is given as `nextDayType` —
  **Saturday's hour 24 is Sunday service.** Hours 0–3 and 24–27 are different calendar days
  and must not be merged: the 7 train ships hour 1 at 1200 s and hour 24 at 570 s. (#383)
- **`changeSec` is verbatim, including 0.** The 57 zeros are cross-platform interchanges
  (Times Sq, Grand Central, Union Sq) where you step across one platform. Do not treat 0 as
  missing. 33 stations have no value — 11 of them multi-route, all same-platform pairs; the
  field is absent rather than defaulted, so no number appears the agency did not give. (#384)
- **Route geometry ships per edge**, as a Google encoded polyline (precision 5) in
  `edge.geom`: the shape points strictly *between* the two stops, endpoints excluded because
  the shard already carries the stops. One polyline per `route:direction` could not describe a
  branched route — 54 of 56 subway pairs had >10% of their stations >400 m off the line — but
  an edge slice can, because between two adjacent stops every pattern runs the same track.
  (#385, item F)
- **An edge with no `geom` is drawn as the straight chord.** Either its shape doubles back
  between the two stops (32 of 24,354, 0.13%) or both stops land on one shape segment.
  Absence is not a licence to guess, the same precedent as `changeSec` and `structure`.
- **`distM` is along-track** where the edge carries geometry, and straight-line haversine
  (~5–7% under true path length) where it does not.
- **Generation ids are content-addressed** — identical inputs and code rebuild to the same id.

---

## Known gaps — none blocking, all real

- **54 of 399 display routes ship nowhere** (every edge dropped as sparse or implausibly
  fast). Nothing can route over them; no headway row survives for them.
- **Subway↔bus transfers are spatial stubs** — every bus stop within 200 m of a station,
  capped at 10, at 1.4 m/s. Never validated against reality. 5,172 of them. The subway-only
  graph drops all of them, because no loaded edge serves their far end.
- **The shard graph has no synthesised interchanges, and is right not to.** The Overpass
  producer invents a transfer between any two same-named stations within 150 m
  (`INTERCHANGE_DIST_M`); the shard graph uses only the 150 the agency publishes. Measured on
  the real shard, the heuristic would have added exactly **one** interchange GTFS omits —
  `Rector St` (1) ↔ `Rector St` (R/W), 49 m apart — and that is *not* a free transfer in
  reality: you exit and pay again. So this is strictly a correctness gain, not a lost route.
  (Five further sub-150 m pairs differ in name, so the heuristic never had them either.)
- **No GTFS-RT.** Weekend construction reroutes are invisible. Scheduled, not traffic-aware.
- **Bus stop wait assumes an unsheltered stop** (GTFS carries no shelter geometry).
- **`bus-busco.json` is 72% of its 3 MB shard budget**; the count baselines (496 subway
  parents / 13,461 bus stops) hard-fail the build on the next pick by design.
- **The subway feed expires 2026-10-31.** Around mid-October the pipeline needs a fresh feed;
  the freshness guardrail fails at <14 days out.
- **#10 from the review is open**: the shadow pointer uses serving routes (`/_shadow/…`) and
  the transit pointer uses bucket keys. Belongs with the Cloudflare move (#358/#360).

---

## What is NOT verified

**No client code has ever consumed this data.** The only thing that has is a throwaway
Playwright probe. It is the honest starting point for S1, and it worked:

```js
const pointer  = await (await fetch(`${base}/transit/nyc/current.json`)).json();
const manifest = await (await fetch(`${base}/${pointer.manifestPath}`)).json();
const dir      = pointer.manifestPath.split("/").slice(0, -1).join("/");
const subway   = await (await fetch(`${base}/${dir}/subway.json`)).json();
const busB     = await (await fetch(`${base}/${dir}/bus-b.json`)).json();

const adj = new Map();
for (const e of [...subway.edges, ...busB.edges]) {
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e);
}
```

From Chromium at `localhost:5173`: **3.0 MB in ~1,048 ms, 5,117 adjacency nodes, no console
errors.** `subway:127` reads `changeSec: 0`; B1 weekday 13:00 reads `360s from 9 trips,
1 service`. Nothing beyond that has been exercised — no routing, no rendering, no shade
sampling on a transit leg.

---

## Relationship to Track E

This is **not** E6. E6 is *mixed-mode journeys* — walk + transit + bike legs in one `Trip`,
with per-leg modes and totals that sum across them. Step 6 is a **data-source swap** that E6
then builds on. E5's decision that "transit access legs stay pedestrian (mixed-mode is E6)"
still holds.

Do it before E6. E6 generalising `trainGraph.ts` over the Overpass graph, and then having the
data source change underneath it, is the expensive ordering.

---

## Commands

```sh
npm run dev            # localhost:5173 is in the CORS allowlist
/gates                 # all four, before any PR
npm run e2e            # the only automated browser check

# the pipeline that produced the data (not your job, but this is how to look)
cd server/transit-prep
TRANSIT_PREP_ROOT=$HOME/shade-prep-data-nyc-transit npm run verify
```

`npm test` never opens a browser. If you change what the map draws, say the browser check is
outstanding rather than letting four green gates imply it.

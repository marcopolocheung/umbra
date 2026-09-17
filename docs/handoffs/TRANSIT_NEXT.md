# Transit — what is left after step 6

> **You are here because the app now routes the NYC subway on the published GTFS data, and
> almost none of that reaches the user.** `docs/handoffs/TRANSIT_CLIENT.md` was step 6: S1, S2
> and S3a are merged. This document is everything after it, in the order the dependencies
> actually allow.

**Verified 2026-09-17**, `main` at `7a00d71`. Green: lint 0 errors (56 warnings / 8 infos, the
known backlog — re-run at `--max-diagnostics=500`, the default cap truncates and can hide a real
error), typecheck 0, **1288 tests / 97 files**, build clean. One caveat on that green:
`RemoteTileController.test.ts` is timing-flaky under full-suite load and fails on `main` itself
(#421), so a red third gate is worth reproducing in isolation before believing it.

**Subway from R2 is complete.** Phase 1 (#397, #398, #399) made it visible and honest and
`VITE_TRANSIT_BASE` is set in Vercel, so production has routed on the published data since 1D.
Phase 1.5 (#401, #400, #407) fixed two robustness defects production surfaced in the *Overpass*
half. Phase 2 (#408) priced the wait to board and the change of line. Phase 3A (#409) added
per-shard bounds; 3B-1 (#411) joined OSM structure onto every subway edge and 3B-2 (#414) spent
it; #415 surfaced the timetable's own caveats on the card. #418 gave the router a heap and #419
refused the unvalidated transfer stubs.

**Bus is the open edge.** #420 routes on it and is in review. Read
"[After 3C — what is actually left](#after-3c--what-is-actually-left)" before picking anything
up: the thing that motivated bus at all, the sun you take standing at the stop, is **not built
yet**.
If this document disagrees with the code, the code wins — fix the document in the same PR as the
work, as `docs/tracks/README.md` requires of the briefs' state blocks.

---

## What landed

| PR | | |
|---|---|---|
| #389 | S1 | `app/lib/transit/` — pointer → manifest → shards, each hop verified against the previous one's SHA-256, cached by generation. `VITE_TRANSIT_BASE`, absent = off. |
| #390 | S2 | `trainGraphAdapter.ts` builds a `TrainGraph` from shards; `trainGraphSource.ts` picks the producer. Station ids are namespaced strings (`osm:…`, `subway:…`). |
| #392 | S3a | Edge weight metres → `weightSec`. Both producers emit seconds. `docs/notes/transit-cost-seconds.md`. |
| #394 | S5 | Decision: Overpass **stays**. Entrances are not in GTFS, and the dataset is NYC-only. |

Verified in a browser on a real NYC route: the three r2.dev hops return 200 from
`localhost:5173`, and the card renders `Via Transit · 27% shadow · 566 m` with
`Leg 2: Broadway Local · 4 min · 3 stops`. **The map drew the wrong route anyway** — see 1A.

---

## Why this order

Four constraints, and they fully determine the sequence:

0. **Phase 1.5 before Phase 2.** Phase 2 makes transit routes *better*; Phase 1.5 is why a third
   of them do not appear at all. Improving the timetable maths while the option silently
   vanishes spends effort where nobody can see it. *(Done — #401, #400, #407.)*
1. **Nothing transit-shaped is observable until #395 is fixed.** `buildTrainDrawData` had never
   rendered. Any change in Phase 2 or 3 would have to be verified blind. *(Done — #397.)*
2. **Bus stop-wait exposure *is* headway wait.** Building S4 on a search that cannot price
   waiting means rewriting S4. Phase 2 before Phase 3, for the same reason
   `TRANSIT_CLIENT.md` put step 6 before E6.
3. **#388 is server-side**, so it is the one item that parallelises — start it whenever, it only
   has to be done before S4. *(Done — 3A.)*

---

## Phase 1 — make it visible and honest

**Done and merged: #397 (1A), #398 (1B), #399 (1C), plus 1D.** Kept below as the record of what
was wrong and why the order was what it was — the whole phase is complete.

*One correction to the plan below:* 1A turned out to be **two** independent bugs, not one. The
index mismatch was only half — the train-layer effect also fell back to `map.once("load")`, an
event that fires when the map first comes up and never again, so the layers were never added at
all. Fixing either alone leaves the map blank. The Phase 1 ordering held: nothing else was
diagnosable until the map drew something.

It was three small PRs. None depended on another, except that **1A had to come first** — it is
what made the other two observable.

### 1A — #395: the map draws the walk route in transit mode

**The defect.** `app/hooks/useRouting.ts:1253` resolves the selection against `navRoutes`:

```ts
const selectedRoute     = navRoutes[selectedRouteIndex];   // :1253
const navTrainDrawData  = selectedRoute?.trainDrawData ?? null;  // :1264
const navMrtEntrances   = selectedRoute?.mrtEntrances  ?? null;  // :1265
```

but the panel renders `filteredRoutes` (`:1267`), which partitions by `routeMode`, and
`page.tsx` wires `onSelectRoute={setSelectedRouteIndex}` straight through — so the index is into
`filteredRoutes`. In walk mode the arrays share a prefix and the indices coincide. In transit
mode `filteredRoutes` is `[Via Transit]` while `navRoutes` is
`[Shortest, Balanced, Most shadowed, Via Transit]`, so index 0 resolves to **Shortest**.

**Measured** (dev server, real data, Bryant Park → Madison Sq Park), hashing route-line pixel
positions off the canvas:

```
walk     cards=[Shortest, Balanced, Most shadowed]  orangePx=3172  redPx=0  lineHash=958968040
transit  cards=[Via Transit]                        orangePx=3172  redPx=0  lineHash=958968040
```

Identical geometry in both modes. `redPx=0` is the other half: the subway line colour never
reaches the canvas, so `buildTrainDrawData`'s polylines, stop dots and transfer rings — and the
`mrtEntrances` markers — have never rendered. `MapView.tsx:1265` gets `null` every time.

**Fix.** Resolve the selection against the array the panel renders. Prefer deriving
`selectedRoute` from `filteredRoutes` inside `useRouting` over remapping at the call sites —
`onSelectRoute={setSelectedRouteIndex}` appears at **three** places in `page.tsx` (`:908`,
`:1027`, `:1096`), and fixing one surface and not the others is the same bug again. Check
`fitMapToRoute(options[0])` at the end of the calculation while you are there: same assumption.

**Test it.** A transit route in `navRoutes` at an index other than `selectedRouteIndex`,
asserting `navTrainDrawData` is the transit route's. Watch it fail first — this bug is invisible
to every existing test.

Pre-existing, from G6a (`90b2e48`); the step-6 PRs touch neither line.

### 1B — #393(a): stop asserting "Underground — no sun"

`TRAIN_SUN_EXPOSURE.subway = 0.0` reaches the user as a claim. The 7 through Queens, the J/M/Z
and much of the outer boroughs are elevated, and their riders are in full sun.

The label is **duplicated**, with identical thresholds, in two places:

- `app/components/RouteCard.tsx:189`
- `app/components/NavigationPanel.tsx:749`

```ts
const sunLabel = sunExposure < 0.05 ? "Underground — no sun" : …
```

This item is only the **honesty half**: stop stating as fact something the data cannot support.
The real per-segment model is 3B. Fix both sites (or extract the one helper — but see
`.claude/rules/change-discipline.md` before widening the diff). Worth a grounding pass: the
router *also* treats an elevated ride as free shade, which is the deeper half and belongs to 3B.

### 1C — let CI cover the transit path at all

Today it cannot. `npm run e2e` serves on `127.0.0.1:4173`, and the bucket's CORS allowlist has
only `shademapnav.vercel.app` and `localhost:5173` — so the browser check is manual, and
everything in Phases 2 and 3 would regress silently.

**Do it hermetically**, the way Overpass already is (`e2e/helpers/scenario.ts:62`). Two parts,
both needed:

1. The `smoke` build must set `VITE_TRANSIT_BASE`, or the transit code never fires — the
   webServer command is `npm run build && npm run start` in `playwright.config.ts:79`, so the
   var has to be inlined there.
2. Add a fixture shard next to `e2e/fixtures/overpassGrid.ts` and route the transit origin in
   `stubNetwork`. The fixture needs stations near the existing midtown waypoints; note
   `WAYPOINT_A`/`B` are deliberately ~340 m apart, **under** the 500 m transit threshold, so the
   transit assertion needs its own pair.

Adding the e2e origin to the bucket's CORS instead would test the network rather than the
client; if the real fetch is worth covering, that belongs in a `smoke-live`-shaped project.

### 1D — enable it in production *(ops, not a PR)* — **done**

Set `VITE_TRANSIT_BASE` in Vercel. Until then all of the above is inert in production —
`configuredBase()` returns `undefined` and no request is made.

**Trap:** Vercel **preview deployments get unique origins**, which are not in the CORS
allowlist, so previews silently fall back to Overpass and will not show you this feature. Either
add them or know that only production exercises it.

Do this after 1A, so production does not ship a card that disagrees with the map.

---

## Phase 1.5 — make transit survive Overpass

**Two PRs. Do this before Phase 2.** Reported from production once Phase 1 went live: transit
routes often failed with *"The map server is busy — try a smaller area and retry"*, and when they
did succeed the option sometimes simply was not there. Both trace to the **Overpass** half, not
the published data.

### Settle these first — they are already measured, do not re-investigate

- **The R2 data is fine.** The deployed site fetches `current.json`, `manifest.json` and
  `subway.json` (all 200) and routes the R from Times Sq-42 St to 23 St. The published half works.
- **It is not client caching.** `graphCache` and `stationEntranceCache` (`app/lib/overpass.ts:46`,
  `:290`) and `cached` (`remoteTransit.ts:152`) are plain module-level variables that die on every
  reload; there is no `localStorage`/IndexedDB caching of API results; and `public/sw.js`'s
  `shouldHandle()` excludes non-GET, cross-origin, and `/api/`. Incognito reproduces the *working*
  state. So "it started working after five reloads" was **upstream recovery**, not a warm cache —
  which means the fragility is entirely intact.
- **The geometry is fine when entrances resolve.** Across three NYC O-D pairs: subway polylines
  chain head-to-tail, and the gap between the end of a walk leg and the first subway stop is
  **28–55 m**. Nothing is misplaced.

### 1.5A — shrink the entrance query (#401) — **landed**

Entrances are now fetched *after* `findBestTrainRoute`, as two boxes of
`ENTRANCE_MATCH_MAX_M` (400 m) around the chosen entry and exit, in one Overpass request
(`fetchStationEntranceBoxes`). Measured, rather than the "one to two orders of magnitude" this
document originally guessed:

| route | old area | new area | |
|---|---|---|---|
| 1.3 km | 0.001434 deg² | 0.000136 deg² | **10.5×** |
| 7 km | 0.005170 deg² | 0.000136 deg² | **37.9×** |

The new box is a fixed size, so the saving grows with the trip. In the browser the same route
went from **431 entrance nodes to 77**, and produced the identical board node and walk leg
(`4770624015`, 411 m) — smaller query, same route.

*One trap, worth knowing before touching this again:* entrances must still be matched against
**every** station, not just the two endpoints, even though only their boxes are fetched.
Narrowing the station set makes the matcher *more* permissive per station — the 300 m distance
fallback attributes a neighbour's door to an endpoint, and the walk leg then snaps somewhere
unroutable, dropping the transit option. Every unit test passed while that was broken; only the
browser caught it.

#### The original analysis

A transit calculation issues **two** Overpass queries. The second is the problem:

```ts
const trainPadding = Math.max(padding, 0.015);          // useRouting.ts:866
…
fetchStationEntrances(trainSouth, trainWest, trainNorth, trainEast, calcSignal),  // :881
…
const bestTrain = findBestTrainRoute(a, b, trainGraph); // :914
```

`trainPadding` is effectively always `0.015°`, so the box is the route extent plus **~3.3 km in
each dimension** — a 2 km trip queries roughly 5 km × 5 km of Manhattan. And it runs at `:881`,
*before* `findBestTrainRoute` at `:914`, so it is fetched before anything knows which two
stations matter.

**Fix:** move the fetch after `findBestTrainRoute` and ask for two small boxes around the chosen
entry and exit — Overpass takes both in one query:

```
(node["railway"="subway_entrance"](bbox1); node["railway"="subway_entrance"](bbox2););
```

That is one to two orders of magnitude less area, and it helps whichever failure mechanism is
actually biting.

**Three things not to re-propose** — I suggested all three in #401 before reading the code, and
two were wrong:

| Idea | Reality |
|---|---|
| Cache entrances | **Already exists** — `stationEntranceCache`, 8 entries, bbox-containment. It is the *first* call in an area that pays. |
| Cache at the proxy (`s-maxage`) | **Impossible** — `server/overpassProxy.js` rejects non-POST, and POST is not CDN-cacheable. |
| Add retry/failover | **Already exists** — a three-endpoint pool (`overpass-api.de`, `overpass.private.coffee`, `maps.mail.ru`) with failover on 429/5xx. |

That last one changes what the error *means*: "map server is busy" implies **all three mirrors
failed**, not one.

### 1.5B — measure before tuning any budget — **the signal now reaches the browser**

The 503 body used to be a fixed string, so the `failureClass` split existed only in the proxy's
own logs — which expire, for a failure that is transient and hard to reproduce on purpose. The
503 now carries one entry per attempt, and the client prints it:

```
[overpass] upstream unavailable (503): overpass-api.de attempt_timeout 8001ms | … 429 120ms
```

So the measurement no longer needs server logs: reproduce it once and read the browser console.
Same fields as the log line, and the same rule — never the query, never a coordinate, with a
test pinning that for the response as well as the log.

**Read it like this**, then act:

| what you see | means | what to do |
|---|---|---|
| `retryable_http`, `429` on every mirror | genuine rate limiting | ask less often; more mirrors |
| `attempt_timeout`, `durationMs` ≈ 8000 | too slow for the budget | shrink the **walk** query, or raise the budget |
| `total_timeout` | the 26 s pool budget ran out | usually downstream of the above |
| `network` | the endpoint was unreachable | check the endpoint list |

If it is `attempt_timeout`, aim at `fetchRoutingGraph`, not entrances: 1.5A shrank the entrance
query by 10–38×, so the walk network is now the dominant Overpass cost. Raising
`DEFAULT_ATTEMPT_TIMEOUT_MS` means raising `DEFAULT_TOTAL_TIMEOUT_MS` with it — three attempts
must still fit — and it trades directly against how long a spinner sits there.

#### The original analysis

There are two candidate mechanisms and they need different fixes: genuine rate limiting, or a
query merely too slow for `DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000` (three attempts ≈ 24 s against
`DEFAULT_TOTAL_TIMEOUT_MS = 26_000`, so a slow query can exhaust the pool without any mirror
refusing it). A 2.4 km × 1.25 km walk-network capture was already **1.78 MB / 3,044 ways**.

**The answer is probably already in the Vercel logs.** `logAttempt` emits
`"Overpass upstream attempt"` through `options.logger ?? console`, with a `failureClass`:

| value | means |
|---|---|
| `retryable_http` (status 429) | genuine rate limiting — shrinking and spacing queries is the fix |
| `attempt_timeout` | the query is too slow for the 8 s budget — 1.5A helps directly |
| `total_timeout` | the 26 s pool budget ran out |
| `network` / `forwarded_http` | neither; look again |

Do not touch the timeouts until that split is known. Raising them trades directly against how
long a user stares at a spinner.

### 1.5C — stop losing the transit option silently (#400) — **landed**

All three pieces shipped. The one that mattered is the second: `snapToReachable` +
`reachableFrom` in `routing.ts` snap to the nearest node the walker **can actually get to**,
rather than the nearest node outright. An OSM pedestrian graph is not one connected piece —
station interiors and service stubs are their own islands — and the station centroid lands on one
often enough to have cost two of three routes their transit option.

Re-measured against the original table, with the entrance query returning **503** (harder than
the empty response first tested):

| O-D | before | after |
|---|---|---|
| Bryant Pk → Madison Sq | no transit option | **Via Transit, 634 m** |
| 40.756,-73.990 → 40.740,-73.985 | no transit option | **Via Transit, 727 m** |
| 40.757,-73.986 → 40.742,-73.984 | works | works |

`fetchStationEntranceBoxes` now returns `{ entrances, failed }`, so a rate-limited Overpass is
distinguishable from a door-less area, and a dropped option sets a `navWarning` naming the
station instead of vanishing.

*Worth knowing:* the notice is now hard to trigger. `walkOpts` pins travel mode to walk, walk
prohibits no edge, so `reachableFrom` is exactly what `dijkstra` can traverse — a snapped node is
reachable by construction. It is kept so that an unforeseen failure is legible rather than
silent, and there is a test that it does **not** fire merely because the entrance fetch failed.

#### The original analysis

Reproduced by stubbing the entrance response to `[]` and varying nothing else:

| O-D | entrances present | entrances `[]` |
|---|---|---|
| Bryant Pk → Madison Sq | works | **no transit option** |
| 40.756,-73.990 → 40.740,-73.985 | works | **no transit option** |
| 40.757,-73.986 → 40.742,-73.984 | works | works |

Two of three lose it entirely — no card, no layers, no message. Three separable pieces:

1. **`fetchStationEntrances` must distinguish failure from empty.** It returns `[]` for a non-OK
   status, an HTML body and a thrown error alike (`app/lib/overpass.ts:657`), so a rate-limited
   Overpass is indistinguishable from "this area has no entrances". One caller
   (`useRouting.ts:881`), so the signature is cheap to change.
2. **The centroid fallback has to route.** When no entrance matches, `useRouting` falls back to
   the station centroid (`:926`/`:931`); `snapToGraph` then lands somewhere `dijkstra` cannot
   reach from the origin, `walkA` comes back null, and the option is dropped at `:979`. Snap to
   the nearest node **reachable from the origin**, or keep trying candidates until one routes.
   This is the actual defect — (1) only makes it legible.
3. **Say something when a found option is dropped.** `bestTrain` exists and both walks failed;
   the user sees walking routes with no hint transit was considered.

*I did not pin down the exact snapping failure.* An offline reconstruction of the walk graph
disagreed with the app's own `snapToGraph` — the centroid looked reachable there and is not in
the app — so whoever takes this should instrument from inside rather than trust that model.

**Order: 1.5A before 1.5C.** Both land in the same block of `useRouting.ts`, and 1.5A
restructures the code 1.5C's fallback lives in. Doing 1.5C first means writing it twice.

**Test it where the bug lives.** (2) needs a graph whose nearest node to the centroid sits in a
component the origin cannot reach — watch it fail first. The e2e fixture from #399 is the natural
place for an entrances-unavailable variant, since this is a browser-level failure that the unit
suite could not see.

---

## Phase 2 — #391: spend the data — **merged (#408)**

**Done, one PR, not merged.** Derivation note:
`docs/notes/transit-wait-and-change-seconds.md`, which carries the measurements. What follows
is the brief as it was written, then what actually had to change.

This is the reason the dataset exists. Two terms were unpriced, and both depend on **which
route you are boarding**, which a search keyed on station alone cannot see:

- **`changeSec`** — the feed's own cost for changing lines inside one station. No transfer
  *edge* is traversed when you change from the N to the Q at one node, so it cost nothing.
- **Headway wait** — half a headway is the expected wait for an unsynchronised arrival, charged
  once per boarding. It is what makes *"how long am I standing in the sun at this stop?"*
  answerable, which is the whole product argument for this data.

**The change.** Search state is `(station, what the rider arrived on)` — on foot, over a
transfer edge, or on a named route — rather than the station alone. On each rail edge it charges
nothing if the incoming edge carried the same route; otherwise half the boarded route's headway,
plus `changeSec` when the change happens inside one station node. A change made *over* a
transfer edge has already paid the agency's `min_transfer_time` in the edge weight, and boarding
at the origin is not a change at all. 956 (station, route) pairs against 496 stations, and the
array-scan PQ held: the full candidate sweep is 6–102 ms on the real graph.

### The plumbing this document did not mention

`buildTrainGraphFromShards` dropped **both** inputs before any of the above could run, and
nothing downstream could reach them:

- `TransitStop.changeSec` was not copied onto `TrainStation`.
- The shard's `headways` array was not carried into `TrainGraph` at all.
- `TransitEdge.direction` was not carried either — and the headway tables are keyed by it.
- `headwayDates` lives in the **manifest**, not the shard, so `trainGraphSource` had to pass it
  down: it is what says which calendar morning each table's hours 24+ describe.

So `TrainStation`, `TrainGraphEdge` and `TrainGraph` all grew fields, and
`buildTrainGraphFromShards` grew a second parameter. The Overpass producer sets none of them
and behaves exactly as before.

### The trap that was not in the brief

**Charging nothing where nothing is published is not the safe default.** A zero wait makes an
unscheduled route the cheapest edge in the graph. Measured on the real feed, a 10 a.m.
Times Sq → Grand Central trip took the **`7X`** — the peak-only Flushing express, which
publishes no trips at that hour — over the shuttle, *because* its wait was unpriced. The `FX`
publishes nothing on a weekday at all and would have won every Queens Boulevard trip for free.

So a missing row is read as the schedule listing no trips and the boarding is refused — but only
in an hour the tables describe. The distinction between *"the table covers this hour and is
silent about you"* and *"nothing here reaches this hour"* is load-bearing, and so is where it
stops: inferring "no service" from the overnight tail stranded **36 of 65 sampled trips with no
transit option at all** at half past midnight, because the feed lists nine route-directions at
hour 24 and nothing at 25–27 on a system that runs all night. The negative inference therefore
stops at hour 23; the small hours price what they publish and refuse nothing.

### The three traps that were

- **`changeSec: 0` is a real value**, not a missing one — 57 cross-platform interchanges. 33
  stations have no value at all and the field stays *absent* through both hops (#384). An absent
  change charges nothing because it is unpriced, not because it is free.
- **`hour` is a service-day hour, 0–27** (#383). 04:00–23:59 reads that day's table at that
  hour; 00:00–03:59 reads the *previous* service day at hour + 24, and refuses when
  `nextDayType` says that table describes a different morning — the weekday table's hour 24 is a
  Thursday morning and cannot price a Saturday one. The tables' own hours 0–3 are never read:
  both buckets describe the same calendar morning from different service days, and not merging
  them means reading one.
- **Which clock.** `zoneAt(origin)` after `ensureZoneLookup()` — the pipeline is already async,
  so the boundary set is waited for rather than raced — then `utcOffsetMinAt(zone, at)`. An
  unresolved lookup leaves the wait unpriced rather than reading hour 0 in UTC.

### What it was worth

Sampled over 65 station pairs, weekday 10:00, against the graph the old adapter built: mean line
changes per trip **2.42 → 1.80 (`changeSec`) → 1.06 (+ wait)**, mean wait 7.0 min, no trip left
without an option. Union Sq → Atlantic Av-Barclays went from `N`/`Q`/`B` in 14 min — the exact
symptom `transit-cost-seconds.md` recorded, which was two free changes of line — to the `Q` in
18 min, 4 of them waiting. Times Sq → 231 St went from `2`/`1` to the `1` alone, 23 stops: a
change traded for a longer ride on one train, which is the trade a rider actually makes.

### What is still open after it

- The wait is a number of seconds, not an exposure. *Where* the rider stands while they wait is
  3B, and it is the half that the shade argument needs.
- 01:00–03:59 maps to hours 25–27, which the feed does not publish. Unpriced, as before.
- A trip whose only path runs on a line that has stopped for the night now finds no transit
  option, and says nothing about why. Two of 65 sampled pairs at 23:30. The 1.5C notice fires
  when a *found* option is dropped, not when none is found.

---

## Phase 3 — bus

The half that matters most for shade: a bus runs at grade in full sun, and a stop wait is total
exposure. Three items, in this order.

### 3A — #388: per-shard `bounds` in the manifest *(merged, #409)*

`TransitShardRef` now carries the computed min/max lat/lon over the stops each shard ships, and
`selectShardRefs()` drops a shard whose extent cannot reach the requested bbox before it is
fetched. `bounds` is **optional forever** — a manifest without it selects by kind exactly as
before, which is what let the client half ship independently of the pipeline half.

Published and live: generation `nyc-2026-09-17-43b41d7d333d`. The field cost **963 bytes** in a
7,647-byte `max-age=300` document — stripping `bounds` back out reproduces the previous
generation's 6,684 bytes exactly.

The extent is computed, never the borough name, and the data says why that mattered: `bus-si`
reaches `north 40.766314, east -73.96678` — Manhattan — because the Staten Island express routes
carry their Manhattan stops into their own shard.

| shard | south | west | north | east |
|---|---|---|---|---|
| `subway.json` | 40.512443 | -74.251961 | 40.903339 | -73.753476 |
| `bus-bx.json` | 40.76246 | -73.974456 | 40.917649 | -73.783366 |
| `bus-b.json` | 40.572635 | -74.069364 | 40.77535 | -73.789588 |
| `bus-m.json` | 40.603427 | -74.210476 | 40.892236 | -73.781349 |
| `bus-q.json` | 40.603427 | -74.068996 | 40.844403 | -73.701373 |
| `bus-si.json` | 40.502981 | -74.252016 | 40.766314 | -73.96678 |
| `bus-busco.json` | 40.566123 | -74.068996 | 40.933637 | -73.702517 |

**Measured in a browser** against the live bucket, counting requests:

```
manhattan  (Bryant Park → Union Sq)      pointer 1  manifest 1  subway.json 1   Via Transit ✓
outside    (Golden Gate Park → Alamo Sq) pointer 1  manifest 1  subway.json 0   Via Transit ✓
```

The second line is the whole point: 1.09 MB that used to be downloaded and discarded is now not
requested at all. The pointer and manifest are still fetched — they are where `bounds` lives, so
that hop cannot be skipped, and both are small and `max-age=300`. Outside New York the app falls
through to Overpass as it always did.

`verify` re-derives each extent from the shard's own stops and fails on a mismatch. That guard is
load-bearing rather than decorative: the client *skips a download* on the strength of `bounds`, so
a merely plausible extent would silently drop transit for real New York routes and look like the
feature being switched off. **Consequence for ops:** `verify` now treats a missing `bounds` as a
failure, so re-running it against a generation directory built *before* 3A fails by design. Verify
the current generation, not a retained older one.

The client is deliberately laxer than `verify` in exactly one place: it treats `"bounds": null` as
absent rather than malformed, because that is what a serializer emits for an optional it has no
value for, and it parses today by being ignored.

### 3B — #393(b): exposure is a property of a segment, not a mode

Settle this before S4, because bus asks the identical question and answering it twice
differently would be worse than answering it once. The G is underground; the 7 is both.

The shards carry no structure and no route geometry (#385). Candidate sources: OSM
`tunnel=yes`/`bridge=yes` on the rail ways; a per-edge structure flag added to
`server/transit-prep` (NYC's GTFS has none, so the pipeline would join against OSM itself); or
sampling the shadow canvas along the drawn stop-to-stop line, which samples *building* shadow
and not the structure shading its own riders.

#### The data question is answered: OSM is good enough *(measured 2026-09-17)*

The open question was whether NYC's subway ways are tagged completely enough to use. **They
are.** Measured over every `railway=subway` way in the NYC bbox, via Overpass:

| | ways | |
|---|---|---|
| tunnel | 1,433 | 48.7% |
| bridge | 866 | 29.4% |
| embankment | 195 | 6.6% |
| cutting (open cut) | 145 | 4.9% |
| explicit at-grade | 8 | 0.3% |
| **no structure tag** | **295** | **10.0%** |

**90.0% of revenue track carries an explicit structure determination.** A first pass said 18.7%
was untagged, which read as "OSM is too patchy". That number was wrong three times over, and
every error was ours:

1. **43% of `railway=subway` ways are not revenue track** — 2,229 of 5,210 carry
   `service=yard|crossover|spur|siding`. Yards and crossovers have no riders.
2. **PATH is tagged `railway=subway`.** The `Newark - World Trade Center` ways are not in our
   feed. Staten Island Railway *is* (route `SI` is in `subway.json`), so it stays in.
3. **Absent `tunnel` means "not a tunnel", not "unknown."** Unlike `changeSec` (#384) this is a
   closed-world tag, and NYC has real at-grade and open-cut subway that OSM tags *specifically*
   as `cutting` and `embankment`.

**Coverage alone would not have settled it, so it was checked against lines whose structure is
documented and unambiguous:**

| line | tunnel | bridge | none | known structure |
|---|---|---|---|---|
| IND Crosstown (G) | **100%** | 0% | 0% | underground, entirely |
| IRT Lexington Av (4/5/6) | **100%** | 0% | 0% | underground in Manhattan |
| IND Eighth Av (A/C/E) | **100%** | 0% | 0% | underground in Manhattan |
| IND Sixth Av (B/D/F/M) | **100%** | 0% | 0% | underground in Manhattan |
| BMT Jamaica (J/M/Z) | 17% | **83%** | 0% | elevated |
| IRT Jerome Av (4) | 31% | **65%** | 0% | elevated in the Bronx |
| IRT Flushing (7) | 28% | **67%** | 5% | underground in Manhattan, elevated in Queens |
| BMT Astoria (N/W) | 32% | **62%** | 0% | elevated |

Every fully-underground line is 100% tunnel-tagged with zero untagged ways, and the elevated
lines' tunnel fractions are not noise — they match the portion that genuinely runs underground
before surfacing. OSM answers correctly wherever the answer is independently checkable.

The residual 295 undetermined ways sit where "no tag" is the right answer for at-grade running:
Staten Island Railway (98), IND Rockaway (42), BMT West End (29), IRT White Plains Road (21).
**SIR is the one genuinely thin spot** — 98 of its 176 ways carry nothing — and it is in our
feed, so it needs its own decision rather than being averaged away.

Caveat: this is way-count weighting, not length weighting. No geometry was pulled, so a long
untagged way counts the same as a short one. The ground-truth table is robust to that; the 90%
is not, and would move under length weighting.

#### 3B-1 — the join, in the pipeline *(merged, #411)*

`server/transit-prep/src/structure.ts` joins OSM structure onto every subway edge at build time,
and the shard ships it as `TransitEdge.structure`. Live as generation
`nyc-2026-09-17-af01f9ffbdc5`.

```jsonc
{"from": "subway:101", "to": "subway:103", "route": "1", …, "structure": {"elevated": 1}}
{"from": "…", "to": "…", "route": "G", …, "structure": {"underground": 0.86, "elevated": 0.14}}
```

**Shares, not a label.** The F and G share the Culver Viaduct for part of a run and a single
label cannot say so. Shares sum to **at most 1**; the shortfall is the part no OSM way matched,
so the field carries its own uncertainty and needs no confidence number beside it.

**Result: 1,816 of 1,949 edges determined (93.2%)** — 1,228 underground, 457 elevated, 78 at
grade, 34 open cut, 19 embankment; 690 edges are mixed. `subway.json` grew 1,093,087 → 1,161,442
bytes (+6.3%).

**Measured error rate: 1.2%.** On the lines documented as underground along their whole revenue
route (E, C, G, with the Culver Viaduct excluded), 2 of 172 edges get a non-underground dominant
reading — both directions of the same E segment, 50 St ↔ 7 Av, from one untagged OSM way. The
error leans towards claiming **sun where there is shade**, which is the conservative direction
for this app: it under-rates a shaded option rather than promising shade that is not there.

Three decisions worth not re-litigating:

- **Overpass, cached — not a Geofabrik extract.** The earlier note here said Geofabrik; that was
  wrong on the specifics. The join needs ~3,700 ways, and Overpass answers exactly that question
  natively in two queries totalling ~5 MB, where a Geofabrik extract means a 400 MB state-wide
  download plus a `.osm.pbf` parser dependency. The real requirement was *never depending on
  Overpass during a build*, and **caching** is what satisfies it: `npm run osm` writes
  `raw/osm/` with a receipt, and `build` reads only that. The mirrors being down does not break a
  build, it just means you cannot refresh.
- **Route-relation membership does two jobs.** It attributes a way to a service, which is what
  stops the 7 (elevated over Queens Boulevard) inheriting the E and F's tunnel underneath it —
  and it excludes yards, sidings and crossovers for free, since none of them is in a route
  relation.
- **An undetermined segment stays undetermined.** Same precedent as `changeSec` (#384): absent is
  not zero. An edge with no `structure` is unknown and must not inherit "underground, free
  shade" — that is precisely the bug 1B was opened for. Note `at_grade` is *not* absence: it
  means a matched OSM way tagged neither tunnel nor bridge nor cutting nor embankment.
- **A floor of 50% coverage.** Without one, a single matching sample out of nine yields
  `{"underground": 0.11}`, which reads as a measurement of a segment that was 89% unseen.

#### 3B-2 — spend it *(merged, #414)*

Closes #393. Replace `TRAIN_SUN_EXPOSURE[mode]` with a per-segment figure derived from
`structure`, and fix the two duplicated label sites (`RouteCard.tsx:189`,
`NavigationPanel.tsx:749`). This is the half 1B deliberately left: the router still treats an
elevated ride as free shade, which is the deeper defect behind "Underground — no sun".

Decide there, not here: what an **unknown** segment costs, and how much sun an **open cut** or an
**embankment** gets. Both are real categories in the published data, and neither is 0 or 1.

### 3C — S4: bus *(#420, in review)*

**What it does.** `TrainMode` gains `bus` at `TRAIN_SUN_EXPOSURE.bus = 0.25` — the same
windowed-vehicle figure as `light_rail`, which is physically what a bus is. The shard filter
accepts `bus-shard`, `route_type` 3 maps to `bus`, and `trainGraphSource` asks for
`{ subway: true, bus: true }`. Manhattan loads 13,909 stations and 374 lines against 496 and 29.

**Subway and bus are searched separately, and that is correctness rather than presentation.** A
bus stop stands every ~200 m, so the five nearest "stations" to any midtown point are all bus
stops within a block. One unfiltered search takes bus candidates at one end and subway at the
other, and since #419 refuses the spatial stubs those are *disconnected components* — so it
returns **no transit route at all**, not merely a worse one. `findBestTrainRoute` therefore takes
a mode and filters candidates by the modes each station's own lines serve.

Two silent defaults that would have claimed shade that is not there are now guarded:

- `routeTagToMode` (the Overpass producer) returns `"subway"` for anything it does not recognise.
  Safe only because its query asks for rail modes and nothing else — **do not add bus to that
  regex** without changing the function first.
- `coveredHours` was one global set, so the subway feed covering weekday hour 10 made a bus
  route's silence at hour 10 read as *"no bus is scheduled"* rather than *"this table does not
  reach here"*, and `boardingCost` refuses a `no-service` edge outright. It is keyed per dataset
  now, through a shared `coveredHourKey` — the hand-built test table had already drifted from the
  adapter's, which is how the bug surfaced.

Entrances are fetched for subway only: a bus stop is its own boarding point and has no OSM
entrance geometry, so the fetch and its O(entrances × stations) match were pure waste.

**What the browser check found, and no test could.** Bus shards ship **no transfers at all** —
measured, 0 across all six — and the spatial stubs are refused, so **every bus route is an
isolated corridor with no change possible anywhere in the network**. A bus answer exists only
where a single route runs from near the origin to near the destination. Bryant Park → Union
Square therefore offered the *Pt. Richmond – Manhattan Express*: 29 stops, 75 minutes, an
18-minute wait, against the subway's 14. Correct, honestly labelled, and a poor thing to offer.

---

## After 3C — what is actually left

Written 2026-09-17, after #418/#419 merged and with #420 in review. Ordered by what a rider
would notice, not by what is easiest.

### A. The bus stop wait is not modelled — this is 3B-2's unfinished twin *(the big one)*

**Bus was worth doing because of the wait, and the wait is the part that is missing.** Manhattan
weekday median headway is 10 minutes, so the expected wait is **5 minutes standing at an
unsheltered stop**, against 4 on a subway platform that is usually underground. At a bus's
~9.7 km/h that is a quarter to a third of the journey, entirely unattenuated. Today the bus card
says *"assumed some sun"* from the per-mode constant — exactly the kind of claim 3B replaced for
subway.

**Decided, not yet built:** sample the real shadow at the boarding stop rather than assuming full
sun. A stop in a building's shadow genuinely is shaded; the no-shelter assumption is about
shelter structures, not buildings, and still has to be stated.

`ShadowField.shadowAt(lng, lat, when)` (`app/lib/shadowField/ShadowField.ts:113`) returns
`{ shadow, source, confidence }` synchronously and takes an explicit time, so a boarding's own
clock is expressible. Treat it as an **untried seam — it has no production caller today**:

- it needs geometry preloaded (`ready(bbox)` / `bboxAroundPoint(lng, lat, padM)`). The pipeline
  already awaits `readyEdges` for the walk graph, so a stop on the walked path is likely covered;
  **a boarding stop off that path may not be.**
- gate on `confidence` (`LOW_CONFIDENCE = 0.5`) and fall back to *saying it is unknown*, never to
  assuming shade.

Plumbing: `trainDijkstra` accumulates only a scalar into `waitTo`, so it must accumulate
`{ stationId, sec }` pairs for the boarding stop to be knowable at all. `useRouting` around the
leg assembly is the only place with map context, a resolved `Date` and the stop coordinates.
Surface it beside `waitSec`, and put the assumption in the `transitSunCaveat` family rather than
folding it into a percentage — `riderFacingNotes` already passes the manifest's own
unsheltered-stop note through to the card.

### B. Bus cannot change buses, so its answers are thin and sometimes absurd

Zero transfers published across all six bus shards, and the subway↔bus stubs are refused, so the
bus network is a set of isolated single-route corridors. That is what produced a 75-minute Staten
Island express for a 1.9 km midtown trip.

Two separate questions, and they want answering in this order:

1. **Bus-to-bus.** GTFS publishes none, so any would have to be synthesised — the same
   unvalidated-straight-line problem as the subway↔bus stubs, at far greater volume. Do not
   synthesise before deciding how to validate.
2. **Subway↔bus**, which is the 5,172 stubs #419 refused. `server/transit-prep` now downloads OSM
   for the structure join (#411), so a build-time walkability check has a natural home. Note
   **271 of 454 stations (60%) sit at the cap of 10**, so *which* stops connect stays arbitrary
   even after validation — fix the cap or accept it explicitly.

Until one of these lands, a dominated bus option is visible to users. Suppressing an option on a
time ratio is a product judgement; it was deliberately **not** taken in #420.

### C. A transit card's "% shadow" describes the walk, and nothing else

`shadowCoverage` on a transit `RouteOption` is the distance-weighted mean of the two walking
legs. The ride and the wait contribute nothing. Worse, `routeExposureMinutes`
(`app/lib/routeTradeoff.ts`) — the only thing feeding `dose()` — is distance ÷ speed, so it
reports **zero** sun for the entire ride and wait of every transit route.

So the headline number on a transit card is not wrong so much as about something else. Fixing it
means deciding whether stationary minutes belong in a dose model built from distance, which is a
real modelling change and should be its own decision rather than a side effect.

### D. Measure the 9.21 MB first load before optimising it

A Manhattan route now fetches **all seven shards, 9.21 MB**, because every borough's buses
converge downtown and all seven bounding rectangles overlap there. Parsing and verifying that is
**87 ms** — 17 ms of SHA-256 and 70 ms of `JSON.parse` — so it is a bandwidth problem, not a CPU
one, and it is paid once per generation because shards are immutable and cached.

**Measure a real first load on a throttled connection before doing anything about it.** Two fixes
were considered and deliberately deferred for want of that evidence:

- **A Cloudflare Worker serving a bbox-filtered shard** (#358/#360). Cuts Manhattan to a few
  hundred KB, and breaks both the integrity chain — every hop is verified against the previous
  hop's SHA-256, and a per-request response has no pre-publishable digest — and
  `immutable, max-age=31536000` caching, trading one 9 MB download for a request per calculation.
- **Resharding by ~5 km grid instead of by borough**, which needs no compute and keeps both. The
  catch is real: shards are **self-contained by design**, each carrying the far end of every edge
  it holds, which is why the S53 puts Staten Island stops in `bus-b`. Grid tiles either break that
  or duplicate boundary stops and inflate.

### E. Small, real, and each one a trap for someone

- **The 500 m transit threshold is three unshared literals** — `useNavigation.ts:390`,
  `useRouting.ts:865`, `:876` — that must stay in sync, and **nothing tests that transit is
  withheld below it**. 3C's plan called for extracting a named constant and it was not done.
- **`at_grade` slivers put a number on a ride that is wholly underground.** Times Sq → Union Sq
  reads "6% above ground" because a stray untagged OSM way near a station is read as at grade
  under the closed-world convention. The label threshold is `< 5% above ground → "underground"`,
  which is a shade too tight against the measured 1.2% error floor. Either raise it to ~10%, or
  stop reading an untagged match as `at_grade` when the rest of the segment is tunnel — the
  second attacks the cause and is inference on inference, so measure first.
- **#421 — `RemoteTileController.test.ts` is timing-flaky** under full-suite load and fails on
  `main`. It makes the third gate non-deterministic, which trains people to re-run until green.
- **`buildTrainDrawData` draws stop-to-stop straight chords**, because the shards ship no route
  geometry by design (#385). Acceptable for an invisible subway, visibly wrong for a bus on a
  street. The browser check showed no stop-dot caterpillar, so `MapView.tsx` was left alone;
  anything better needs geometry the shards do not carry.

### What is genuinely done

Subway from R2 is complete and honest: real GTFS graph, scheduled run times, headway wait priced
per boarding, in-station changes priced from the feed's own `changeSec`, per-segment sun exposure
measured from OSM at a 1.2% error rate, geographic shard selection, and the timetable's own
caveats on the card. Nothing in the list above is a defect in that.

## Running alongside — calendar, not dependency

- **The subway feed expires 2026-10-31, and rebuilding does not move it.** The full pipeline was
  re-run on 2026-09-17 for 3A and again for 3B-1; the live generation is
  **`nyc-2026-09-17-af01f9ffbdc5`**, the one carrying per-shard `bounds` and per-edge
  `structure`. The subway window came back **unchanged at 20260526 → 20261031**: the upstream
  `gtfs_subway.zip` is still the 27 August baseline, so MTA has not posted a newer one. The
  freshness guardrail therefore still starts failing around **17 October**, and the fix is not a
  re-run but *MTA publishing*. Re-check `npm run acquire:plan` — if `lastModified` on
  `gtfs_subway.zip` has moved past 27 August, a rebuild will clear it; if it has not, nothing in
  this repo can. Credentials are in `~/.config/umbra/r2-transit.env`.
  The bus feeds are good to 20270102.
- **`r2.dev` is rate-limited and wants a custom domain**, with the Cloudflare move (#358/#360).
  Not a correctness blocker; it is a production one. Related: #10 from the review, that the
  shadow pointer uses serving routes and the transit pointer uses bucket keys.

---

## Settled — do not re-litigate

Each was measured; the measurement is in the PR or the issue.

- **Overpass stays.** Entrances are not in GTFS and the dataset is NYC-only (#394). The two
  producers coexist by design; shards are preferred only where they hold ≥2 stations inside the
  requested bbox.
- **The entrance name match is bounded to 400 m and takes the nearest match.** It is a substring
  test: unbounded, `Wall St` matched `Christopher Street-Stonewall Station` 3 km away and
  `Broadway` matched an entrance 9.4 km up the street. Measured over 822 real OSM entrance nodes:
  12 matches beyond 400 m before, 0 after, same 816 matched.
- **No synthesised interchanges in the shard graph.** The Overpass heuristic (same name, <150 m)
  would have added exactly one GTFS omits — `Rector St` (1) ↔ `Rector St` (R/W) — and that is
  *not* a free transfer in reality.
- **Edges are published directed** and both ways wherever service runs both ways. Synthesising
  the reverse would invent service on the 14 stop pairs that genuinely run one way.
- **`TRANSFER_PENALTY_SEC = 180`** is the feed's modal `min_transfer_time`, not a conversion of
  the old 300 m — which was worth ~36 s at train speed and was never a distance anyone walked.
- **OSM is good enough for track structure.** 90.0% of revenue track carries an explicit
  determination and every line documented as fully underground is 100% `tunnel`-tagged with zero
  untagged ways. The three ways a naive count gets this wrong are written up under 3B; do not
  redo the measurement without reading them.
- **Only `underground` is enclosed.** An open cut and an embankment are open to the sky, and no
  constant is invented for them — the shade a retaining wall casts is no more modelled than the
  buildings beside an elevated line. It overstates sun in a cut, which under-rates a shaded option
  rather than promising shade that is not there.
- **A seat is not a pavement.** Above-ground rail exposure is the measured track share times
  `RAIL_VEHICLE_EXPOSURE = 0.25` — this codebase's own long-standing "windowed surface vehicle"
  figure, not a new number. The first cut of 3B-2 collapsed the measured fact and the model
  constant into one number and reported an elevated ride as 1.0; the card states the **track
  fact** ("75% above ground") precisely so the two stay apart.
- **Exposure is measured over the determined part, with coverage carried beside it.** Below 60%
  coverage the card reports how much of the ride is known rather than a percentage derived from
  the sliver that is.
- **Spatial transfer stubs are refused in the client, not unpublished.** They stay in the shard;
  this is only which of them the client will route on, so re-enabling needs no republish.
- **Subway and bus are searched per mode.** Not a presentation choice — see 3C.
- **Manifest `notes` are shown verbatim and chosen by subject, not by array index**, and an
  unrecognised note is *shown*, because a new note is far likelier to be a new caveat than a new
  contract detail.
- **A missing headway row is "no trips scheduled", not "unknown"** — but only in an hour the
  tables describe, and never past hour 23. Both halves were measured: unpriced-means-free sent a
  10 a.m. trip on the peak-only `7X`, and refusing on the overnight tail stranded 36 of 65
  sampled trips at 00:30. See `docs/notes/transit-wait-and-change-seconds.md`.
- **Headways are read per direction.** 144 of the 1,313 published route-hours carry only one
  direction — the peak-only `6X`/`7X`, the `Z`, the Rockaway `H` — and those are real
  one-directional services, not gaps to fill from the other platform.
- **Every boarding on a path is priced at the departure instant**, not at the time the rider
  would reach that platform. The tables are hourly; a time-dependent search is a different thing.

---

## Commands

```sh
npm run dev            # localhost:5173 is in the CORS allowlist; 127.0.0.1 is NOT
/gates                 # all four, before any PR
npm run e2e            # the only automated browser check; 1C gave it a hermetic transit fixture

# what the app fetches, by hand
curl -s -A "Mozilla/5.0 Chrome/140" \
  https://pub-c960c9abbd204246901a291a24850f55.r2.dev/transit/nyc/current.json
```

`npm test` never opens a browser, and `r2.dev` filters on User-Agent — a server-side check needs
a real one. Tests run as `npx -y node@24 node_modules/vitest/vitest.mjs run` if the local Node is
20. If you change what the map draws, say the browser check is outstanding rather than letting
four green gates imply it.

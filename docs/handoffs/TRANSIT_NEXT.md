# Transit — what is left after step 6

> **You are here because the app now routes the NYC subway on the published GTFS data, and
> almost none of that reaches the user.** `docs/handoffs/TRANSIT_CLIENT.md` was step 6: S1, S2
> and S3a are merged. This document is everything after it, in the order the dependencies
> actually allow.

**Verified 2026-09-16**, `main` at `c50eb79`. Green: lint 0 errors (55 warnings / 8 infos, the
known backlog — re-run at `--max-diagnostics=500`, the default cap truncates and can hide a real
error), typecheck 0, **1173 tests / 86 files**, build clean.
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

Three constraints, and they fully determine the sequence:

1. **Nothing transit-shaped is observable until #395 is fixed.** `buildTrainDrawData` has never
   rendered. Any change in Phase 2 or 3 would have to be verified blind.
2. **Bus stop-wait exposure *is* headway wait.** Building S4 on a search that cannot price
   waiting means rewriting S4. Phase 2 before Phase 3, for the same reason
   `TRANSIT_CLIENT.md` put step 6 before E6.
3. **#388 is server-side**, so it is the one item that parallelises — start it whenever, it only
   has to be done before S4.

---

## Phase 1 — make it visible and honest

**Done, in review: #397 (1A), #398 (1B), #399 (1C).** #399 is stacked on #397 because it
asserts behaviour #397 creates; #398 is independent. 1D remains, and is an ops step.

*One correction to the plan below:* 1A turned out to be **two** independent bugs, not one. The
index mismatch was only half — the train-layer effect also fell back to `map.once("load")`, an
event that fires when the map first comes up and never again, so the layers were never added at
all. Fixing either alone leaves the map blank. The Phase 1 ordering held: nothing else was
diagnosable until the map drew something.

Three small PRs. One session can carry all three; none depends on another, so they can also be
split. Do **1A first regardless** — it is what lets you see the other two.

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

### 1D — enable it in production *(ops, not a PR; the only Phase 1 item left)*

Set `VITE_TRANSIT_BASE` in Vercel. Until then all of the above is inert in production —
`configuredBase()` returns `undefined` and no request is made.

**Trap:** Vercel **preview deployments get unique origins**, which are not in the CORS
allowlist, so previews silently fall back to Overpass and will not show you this feature. Either
add them or know that only production exercises it.

Do this after 1A, so production does not ship a card that disagrees with the map.

---

## Phase 2 — #391: spend the data

This is the reason the dataset exists. Two terms are still unpriced, and both depend on **which
route you are boarding**, which a search keyed on station alone cannot see:

- **`changeSec`** — the feed's own cost for changing lines inside one station. No transfer
  *edge* is traversed when you change from the N to the Q at one node, so it currently costs
  nothing. It shows: Union Sq → Atlantic Av-Barclays Ctr prices as one uninterrupted `N/Q/B`
  ride.
- **Headway wait** — half a headway is the expected wait for an unsynchronised arrival, charged
  once per boarding. It is what makes *"how long am I standing in the sun at this stop?"*
  answerable, which is the whole product argument for this data.

**The change.** Search state becomes `(station, route boarded)` rather than `station`. The graph
is small — 496 stations, ~29 routes, 2,099 adjacency edges — so the state space stays in the low
thousands and the existing array-scan PQ is still fine. On each rail edge charge nothing if the
incoming edge carried the same `route`; otherwise `changeSec` at that station plus half the
boarded route's headway. `prevLine` already tracks the incoming route for segment
reconstruction — it just is not part of the key.

**Three traps, all with issues behind them:**

- **`changeSec: 0` is a real value**, not a missing one — 57 cross-platform interchanges at Times
  Sq, Grand Central and Union Sq. 33 stations have no value at all, and the field is *absent*
  rather than defaulted, so nothing may substitute a number the agency did not publish (#384).
  `parseTransitShard` already preserves this distinction; do not undo it.
- **`hour` is a service-day hour, 0–27, not wall-clock** (#383). Hours 24+ are the early morning
  of `headwayDates[dataset][dayType].nextDate`, whose type is `nextDayType` — **Saturday's hour
  24 is Sunday service.** Hours 0–3 and 24–27 are different calendar days and must not be
  merged: the 7 ships hour 1 at 1200 s and hour 24 at 570 s.
- **Which clock.** `dateRef.current` in `useRouting` is a browser-local `Date`. Someone planning
  an NYC trip from another timezone must not read the wrong hour's headway. The existing honest
  way to resolve it is `zoneAt(lat, lng)` in `app/lib/tzLookup.ts` — note it needs
  `ensureZoneLookup()` to have resolved first, and returns `null` until it has — with
  `utcOffsetMinAt(zone, at)` in `app/lib/timezone.ts`. E5 hit the same trap and chose to leave
  the existing zone standing rather than flap to UTC on an unresolved lookup; do the same rather
  than silently reading hour 0.

The Overpass producer has no headways and no `changeSec`, so it charges zero for both and keeps
behaving as it does today.

This one warrants a derivation note in the form of `docs/notes/transit-cost-seconds.md`.

---

## Phase 3 — bus

The half that matters most for shade: a bus runs at grade in full sun, and a stop wait is total
exposure. Three items, in this order.

### 3A — #388: per-shard `bounds` in the manifest *(server-side; start any time)*

A shard ref carries `key`/`bytes`/`sha256`/`stops`/`edges`/`routes` and **no extent**, so a
client cannot tell whether `bus-q.json` covers a bbox without downloading it. Add the computed
min/max lat/lon over the stops each shard ships:

```jsonc
{"key": "bus-b.json", …, "bounds": {"south": 40.5, "west": -74.06, "north": 40.74, "east": -73.83}}
```

Additive, a few hundred bytes in a `max-age=300` document, and the pipeline already walks every
stop to produce the counts beside it. It must be the **computed** extent, not the borough name:
a shard is self-contained by design, so the S53 over the Verrazzano puts Staten Island stops in
`bus-b`.

Client side, `selectShardRefs()` grows a bbox-intersection filter and keeps the kind filter as
the fallback for a manifest that predates the field.

It fixes a second thing: today a user **outside** New York pays the full pointer → manifest →
shard round trip (~1 s, 1.09 MB) on their first route calculation, serially, ahead of the
Overpass call that answers them — because coverage can only be checked after the download. No
client-side cache can avoid that first hit; only this can.

### 3B — #393(b): exposure is a property of a segment, not a mode

Settle this before S4, because bus asks the identical question and answering it twice
differently would be worse than answering it once. The G is underground; the 7 is both.

The shards carry no structure and no route geometry (#385). Candidate sources, none free:
OSM `tunnel=yes`/`bridge=yes` on the rail ways via Overpass; a per-edge structure flag added to
`server/transit-prep` (NYC's GTFS has none, so the pipeline would join against OSM itself); or
sampling the shadow canvas along the drawn stop-to-stop line, which samples *building* shadow
and not the structure shading its own riders.

### 3C — S4: bus

Needs 3A for shard selection and Phase 2 for the stop wait; lands on 3B's model.
`selectShardRefs()` already takes `{ bus: true }` — it needs the data, not the code. New
`TrainMode` member, a sun-exposure figure for at-grade transit, and stop-wait exposure.

`buildTrainGraphFromShards` currently **refuses** a bus shard outright rather than defaulting it
to `subway` (which would claim a bus ride is fully shaded). That guard is deliberate; removing it
is part of this item, not a workaround for it.

Two things that only become real here: the **5,172 spatial subway↔bus transfer stubs** (every bus
stop within 200 m of a station, capped at 10, at 1.4 m/s, never validated against reality) drop
out today because no loaded edge serves their far end — they will surface the moment bus shards
load. And bus stop wait **assumes an unsheltered stop**, because GTFS carries no shelter
geometry; that is a stated assumption the card has to carry, not a number to quietly use.

---

## Running alongside — calendar, not dependency

- **The subway feed expires 2026-10-31.** The freshness guardrail fails at under 14 days out, so
  the pipeline starts failing around **17 October** regardless of which phase you are in.
  Rebuilding and republishing is `server/transit-prep`'s job; credentials are in
  `~/.config/umbra/r2-transit.env`.
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

---

## Commands

```sh
npm run dev            # localhost:5173 is in the CORS allowlist; 127.0.0.1 is NOT
/gates                 # all four, before any PR
npm run e2e            # the only automated browser check — and it cannot see transit yet (1C)

# what the app fetches, by hand
curl -s -A "Mozilla/5.0 Chrome/140" \
  https://pub-c960c9abbd204246901a291a24850f55.r2.dev/transit/nyc/current.json
```

`npm test` never opens a browser, and `r2.dev` filters on User-Agent — a server-side check needs
a real one. Tests run as `npx -y node@24 node_modules/vitest/vitest.mjs run` if the local Node is
20. If you change what the map draws, say the browser check is outstanding rather than letting
four green gates imply it.

# Handoff — NYC static streets and building shadows

> Build an NYC-specific, CDN-served walking graph and building-prism dataset for route
> calculation. Streets replace the normal NYC Overpass graph request; buildings replace the
> normal NYC building-geometry request for shadow sampling. The existing canopy providers stay
> additive, and the existing transit graph continues to provide the ride while this graph
> provides every access and egress walk.

**Verified 2026-09-18**, `main` at `34e27c8`. The only unrelated working-tree item when this
handoff was written was untracked `docs/research/transit.md`; do not absorb it into this work.
If this handoff disagrees with the code, the code wins. Update the handoff in the same PR that
changes a stated contract.

This is a multi-PR implementation plan. Take one checkpoint per PR. The first implementation
session should complete **Checkpoint 1** and stop; later checkpoints are included so its wire
contract does not paint the rest of the work into a corner.

## Decision in one paragraph

Yes, this is possible and is a good fit for NYC. Build both datasets offline, publish small
versioned spatial shards to the same kind of Cloudflare/R2 delivery surface already used by
transit, and load only the shards needed for a route. This should make NYC route startup more
predictable and remove public Overpass availability from the ordinary route path. It can also
make building-shadow coverage independent of the current map viewport. It does **not** make
MapLibre render faster: map style, street drawing, visible 3-D buildings, and shadow painting
remain unchanged. The performance win is a hypothesis until the cold/warm browser benchmarks
in Checkpoint 6 pass; static data can still lose if shards are too large or expensive to parse.

## Scope, stated narrowly

In scope:

- NYC pedestrian street topology used to construct the existing `RoutingGraph`.
- NYC building footprints and heights used to construct the existing building prisms.
- Composition of those building shadows with the canopy providers already passed to
  `createGeometryShadowField`.
- Pure-walking routes and the walking access/egress legs around subway and bus rides.
- An offline producer, immutable publication contract, browser loader, caches, fallback,
  observability, tests, and measured rollout.

Not in scope:

- The `_shadow` pointer, `.smb` bundles, `shadowField/v2`, terrain, or the NYC remote-field/R2
  implementation documented in `NYC_REMOTE_FIELD.md`.
- Moving, repacking, or changing the Meta/WRI canopy COG path; changing the Overpass canopy
  provider is also unnecessary for this project.
- Replacing the MapTiler style, vector sources, street rendering, visible buildings, or the
  `LocalShadowAdapter` renderer. A route may therefore be calculated from newer NYC building
  footprints than the visible MapTiler building layer. That difference must be observable, not
  hidden.
- PMTiles as the routing graph format. Vector-tile geometry is normally clipped and simplified
  for drawing; routing needs stable node identity and exact cross-shard connectivity.
- Running Valhalla, OSRM, GraphHopper, or another routing service. They solve server-side route
  search; this app already performs client-side Pareto search and needs its per-edge shadow
  cost.
- Changing `dijkstra`, `paretoRoutes`, the shade cost model, travel-mode policy, sidewalk
  construction, transit wait cost, guidance, or global routing coverage.
- Removing Overpass fallback on the first release.

## Current state to re-check

Run these before starting any checkpoint:

```bash
git fetch --all --prune
git status --short
git show -s --format='%h %D %s' origin/main
rg -n "fetchRoutingGraph|createGeometryShadowField|fetchBestTrainGraph" app/hooks/useRouting.ts
rg -n "createTilePrismProvider|createOverpassPrismProvider" app/lib/shadowField/providers.ts
rg -n "VITE_TRANSIT_BASE|loadTransitDataset" app/lib/transit
```

As verified on the date above:

- `app/lib/overpass.ts:109` sends one Overpass request for a route-sized street bbox. Its filter
  admits `footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps|track|bridleway`, rejects `area=yes`, and asks for `out body geom`.
- `buildRoutingGraphFromElements` creates numeric OSM nodes and bidirectional edges carrying
  `highway`, `surface`, `smoothness`, `cycleway`, `bicycle`, `foot`, and `access`. Preserve this
  behavior before attempting to improve OSM semantics.
- `app/hooks/useRouting.ts:405-450` starts street fetch and shadow readiness together, then
  samples every graph edge before search. `graphFetchMs` currently includes both graph fetch and
  field readiness.
- `app/hooks/useRouting.ts:238-242` constructs the building provider chain as MapTiler tiles,
  then Overpass; OSM canopy and raster canopy are separate additive provider lists.
- `PrismProvider["source"]` is currently only `"tiles" | "overpass"`, and
  `SOURCE_BASE_CONFIDENCE`, `EdgeShadow.buildingSource`, `shadowProvenance.ts`, and the routing
  diagnostics all assume that closed union. A static provider is a contract change, not merely
  another factory call.
- The MapTiler provider can only speak for loaded viewport tiles. Overpass is the offscreen
  building fallback. A static NYC provider belongs **ahead of both** inside verified coverage;
  outside it, the current order remains useful.
- Transit is already independently published as pointer → manifest → immutable shards in
  `app/lib/transit/remoteTransit.ts`. `fetchBestTrainGraph` selects published NYC transit and
  falls back elsewhere.
- Transit access and egress already route over the same shadow-enriched `routingGraph` as a
  walking-only trip. Once that graph and its building shadows are static-backed, subway and bus
  walking legs benefit without a second routing implementation.
- Current transit shards publish station entrances when known. The client calls
  `fetchStationEntranceBoxes` only for old/unknown station records. Do not merge entrance data
  into the street dataset merely to claim there are no API calls.

## Source choices

### Streets: OSM PBF, processed offline

Use a dated New York State `.osm.pbf` snapshot, clipped to a buffered NYC publication boundary
during preparation. A current extract is available from
[Geofabrik](https://download.geofabrik.de/north-america/us/new-york.html). Record the exact
download URL, upstream timestamp, byte count, and SHA-256 receipt; never make a browser parse a
PBF.

OSM is the first source because it matches the current graph's node ids, highway filter, and
pedestrian tags. NYC CSCL may be an authoritative centerline, but switching to it here would
also be a routing-semantics migration: park paths, pedestrian passages, steps, and current OSM
tag behavior would need a new join and parity study. Evaluate CSCL later only as a quality
supplement, not in the first static replacement.

The published graph remains an OSM-derived database. Ship `© OpenStreetMap contributors`, an
ODbL link, snapshot identity, and the required derived-database offer/process with the
generation. Confirm the exact distribution obligations before production promotion; the
[OSM legal FAQ](https://wiki.openstreetmap.org/wiki/Legal_FAQ) gives the requested attribution
and licence link but is not a substitute for project legal review.

### Buildings: NYC Building Footprints, not the 2014 3-D model

Use the maintained NYC Building Footprints dataset for the MVP. The City's
[official metadata](https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md)
says it is released weekly, gives `DOITT_ID` as the consistent building key, and defines
`HEIGHT_ROOF` as roof height above ground; zero or null means unavailable. It also identifies
placeholder, ordinary-building, under-construction, and other feature codes. Pin a release and
source receipt rather than querying the feature service at runtime.

Do not lead with the NYC 3-D model: it describes the city captured by the 2014 aerial survey,
is split across community-district products, and contains roof/facade detail that the current
flat-prism shadow model cannot use without a separate geometry project. Do not mix Overture
buildings into v1 either; deduplicating two building databases and reconciling their height
semantics is its own measured change.

Checkpoint 1 must settle and test these building policies before a full build:

- include normal buildings; decide explicitly how parking structures, tanks, garages,
  skybridges, cantilevers, and buildings under construction map to a ground-shadow caster;
- reject placeholder triangles and records marked demolished; document treatment of “marked
  for demolition” rather than guessing;
- convert source feet to metres once in the producer;
- treat zero/null height as unknown, not zero-height and not observed empty;
- choose a versioned missing-height rule only after reporting its prevalence and height
  distribution. Prefer a conservative typed fallback by feature class over silently inheriting
  the current generic OSM default;
- repair/reject invalid rings deterministically and report every count;
- retain `DOITT_ID`, feature code, height provenance, and last-edit timestamp in preparation
  evidence, while publishing only fields the browser needs.

## Architecture

Keep this publication separate from both transit and `_shadow`, even if one Worker/origin serves
all three prefixes:

```text
dated OSM PBF                    pinned NYC building-footprint release
      │                                      │
      ├─ filter using current highway rules  ├─ validate/status/height policy
      ├─ preserve OSM node ids + tags        ├─ convert feet → metres
      └─ build seam-safe graph shards        └─ build whole-footprint prism shards
                         │                  │
                         └──── one atomic NYC navigation generation ────┐
                                                                         │
  /navigation/nyc/current.json                                           │
  /navigation/nyc/generations/<generation>/manifest.json                 │
  /navigation/nyc/generations/<generation>/streets/<cell>.json           │
  /navigation/nyc/generations/<generation>/buildings/<cell>.json         │
  /navigation/nyc/generations/<generation>/notices.json                  │
                                                                         ▼
  browser: pointer → manifest → bbox-selected verified shards → generation cache
                    ├─ merged RoutingGraph → shadow sampling → walk/Pareto search
                    └─ NYC PrismProvider ─┐
  existing OSM/raster canopy providers ──┴─ existing ShadowField blend
  existing published transit graph ───────── ride + same graph for access/egress
```

Use one navigation generation for streets and buildings so a route receipt can name one
coherent snapshot and a pointer promotion is atomic. That does not mean the two shard formats or
runtime caches should be coupled. Acquire one route-scoped `NavigationSnapshot` (pointer plus
verified manifest) before graph fetch and field readiness start in parallel, and make both paths
consume that immutable snapshot. Do not let the graph and prism provider independently re-read
`current.json` during one calculation. The provider/store API will need an explicit pin/lease or
equivalent calculation-scoped input; a shared module cache alone does not prove this invariant
when a pointer is promoted mid-flight.

### Publication contract

Model the integrity chain on transit, not on the much larger SMB manifest:

1. `current.json` is tiny and mutable with a short cache lifetime. It contains version,
   `dataset: "nyc-navigation"`, generation, manifest path, and manifest SHA-256.
2. `manifest.json` is immutable. It contains schema versions, generation, created time,
   publication/support bounds, source receipts, preparation recipe identity, budgets, notices
   ref, and street/building shard refs.
3. Every shard ref has kind, key, exact byte count, SHA-256, bounds, support bounds, and useful
   counts. Street refs report nodes and directed/undirected edges; building refs report features,
   rings, missing/fallback-height counts, and maximum height.
4. A client verifies generation, schema, key safety, byte count, digest, bounds, and counts before
   adapting bytes into runtime objects. A missing or corrupt member invalidates the whole request;
   never route over a half-static/half-fallback graph or mix generations.
5. Promote `current.json` last. Immutable objects are cache-forever and old generations remain
   available for rollback.

Start with strict JSON and HTTP transfer compression because it is inspectable and mirrors the
proven transit client. Set hard per-shard and per-request byte budgets from the Midtown fixture.
Only switch to a compact binary representation if Checkpoint 6 attributes unacceptable time or
memory to transfer/JSON parse. Do not choose `.pbf`, PMTiles, or a binary schema merely because
the source arrived in PBF.

### Street sharding and graph merge

Benchmark a fixed grid around z13 and z14 with a one-ring halo; do not hardcode the winner before
measuring request count, payload size, parse time, and typical route spill. The contract must
make seams exact regardless of grid size:

- keep original numeric OSM node ids;
- assign every edge to one owner cell, and include any referenced endpoint as a ghost node;
- select owner cells intersecting the requested route bbox plus a declared halo;
  (As built in Checkpoint 2: no halo — streets select by geometry intersecting the
  bbox exactly, and seam connectivity is the producer's ghost-node job. See
  `selectNavigationShards` in `app/lib/navigationData/remoteNavigation.ts`.)
- merge by stable node id and stable edge identity, deduplicating exact duplicates;
- reject conflicting coordinates or edge tags for the same identity;
- preserve cross-boundary edges and intersection flags;
- publish support bounds separately from geometry bounds, so “outside coverage” differs from
  “covered and no routable ways”; and
- verify a route that crosses every kind of seam against the unsharded graph.

The first producer must reproduce `buildRoutingGraphFromElements`, including its current closed
pedestrian-plaza handling and bidirectional edges. Improvements for `oneway`, conditional access,
pedestrian areas, turn restrictions, private paths, or topology repair need separate behavior
PRs with route fixtures. A data migration must not quietly change routing policy.

The initial client request should cover the route stops using the same bbox semantics as today,
plus the chosen shard halo. (As built in Checkpoint 2: streets carry no halo; ghost nodes
cover the seams. Adaptive expansion stays future work.) If missing edges near bbox limits
remain material, measure adaptive expansion rather than downloading all NYC. Abort and
supersession must stop stale graphs from being published to the active calculation.

### Building sharding and shadow reach

Publish whole footprints, not clipped vector-tile fragments. Assign a building to one owner cell
and select it through an index/ref whose geometry bounds can overlap neighbouring queries. At
minimum each browser record needs a stable id, outer ring(s), height metres, optional minimum
height if the current prism model is extended to use it, and a compact height/provenance code.

A building outside the route bbox can cast onto it. `ShadowField` currently pads sampling by
`QUERY_PAD_M = 400`, and low-sun confidence deliberately falls toward the horizon. The static
provider must load every owner shard whose **caster reach bounds** overlap the requested padded
bbox, not just buildings whose centroid lies inside it. The producer can conservatively expand
each shard by its maximum building height and the lowest supported solar altitude, or publish a
spatial membership index. Cap the policy consistently with the existing shadow march and record
the cutoff in the manifest. Test a tall building just outside the query and a caster crossing a
shard seam.

The provider contract remains synchronous-at-query-time:

- `load(bbox, signal)` selects, fetches, verifies, decodes, converts through
  `prismsFromFootprints`, and atomically publishes a cached `PrismSet`;
- `prismsFor(bbox)` performs no network request and returns the same prism-array identity until
  its generation/coverage changes, preserving the prepared-caster `WeakMap` optimization;
- `prismsFor` returns `null` for unloaded, failed, out-of-coverage, or incomplete areas;
- a verified covered area with zero buildings returns an empty `PrismSet`; and
- generation change drops decoded street and building caches atomically.

Add an explicit provider source such as `"nyc-static"`. Update `PrismProvider`,
`SOURCE_BASE_CONFIDENCE`, `EdgeShadow.buildingSource`, diagnostics, and provenance tests. Do not
assign confidence by intuition alone: begin with a documented conservative prior, then compare
against retained NYC samples and record height completeness. The user-facing label may remain
“from building geometry,” while diagnostics and route receipts must name the generation/source.

Provider order in NYC becomes:

```ts
[
  createNycStaticPrismProvider(...),
  createTilePrismProvider(() => mapRef.current),
  createOverpassPrismProvider(),
]
```

Outside verified NYC support, or when the static load fails, the first provider returns `null`
and current behavior continues. The two canopy lists passed to `createGeometryShadowField`
remain unchanged. That is the entire building+canopy integration: the field already masks raster
canopy against resolved buildings and blends canopy additively.

### Transit integration

Create `fetchBestRoutingGraph`, parallel to `fetchBestTrainGraph`, and replace the direct
`fetchRoutingGraph` call in `useRouting`. It should:

1. attempt the static NYC dataset only when manifest support fully covers the requested bbox and
   required halo (as built: the bbox exactly — Checkpoint 2 ships no street halo);
2. return one merged static `RoutingGraph` only after every selected shard verifies;
3. fall back to the current `fetchRoutingGraph` outside NYC, when unconfigured, or on a
   non-abort static failure; and
4. preserve caller aborts rather than turning cancellation into an Overpass request.

Do not combine the walking and transit graphs. `fetchBestTrainGraph` continues to select subway
and bus ride data. The already-shadow-enriched walking graph continues to compute `walkA` and
`walkB` to the selected station/stop.

There is one coverage trap: the initial walking bbox is based on route stops, while transit may
select a station outside it. Today the large graph often happens to contain the snapped station
entrance. Add an explicit contract. Preferred first approach: include bounded origin and
destination access zones large enough for the transit station search, then load/merge any missing
street shards after entry/alight selection if the selected entrance falls outside them. Do not
download the rectangle spanning every candidate station. Test subway and bus routes whose chosen
board/alight point lies across a street-shard seam. If the second-load path is chosen, it must run
the added edges through the same shadow sampling, sidewalk expansion, access filtering, spatial
indexing, and reachability preparation as the initial graph before either transit walk is searched.
If that makes the hook state unsafe or duplicative, load the bounded access zones before the first
enrichment pass instead; do not splice raw, unshadowed edges into `routingGraph`.

Published transit entrances remain authoritative. The old-generation entrance Overpass fallback
stays for compatibility and is not evidence that street loading failed. A later transit
generation can eliminate normal NYC entrance requests independently.

## Checkpoint plan

### Checkpoint 1 — contract, source policy, and one hermetic fixture

This is the next session. It should not change production routing.

Add:

- `server/navigation-prep/` with its own package/scripts, modeled on `server/transit-prep` but
  without copying transit concepts;
- acquisition receipt types and `--plan`/fixture-only seams for the PBF and building release;
- pure normalization for a small committed Midtown fixture;
- strict pointer, manifest, street-shard, building-shard, and notices schemas on producer and
  client sides; and
- `app/lib/navigationData/shardContract.ts` with strict parsers and size/count/bounds budgets.

The fixture must include an intersection, a path, steps, a tagged access/surface case, a graph
edge crossing a shard seam, an ordinary known-height building, an unknown-height building, a
rejected placeholder, and a building whose shadow reaches across a shard seam. Hand-author the
small source fixture or retain a legally distributable clipped extract with its receipt; tests
must never reach the network.

Write a short decision record under `docs/notes/` containing source versions, field mapping,
height fallback analysis, candidate grid measurements, licensing/attribution handling, and
expected full-build budgets. Stop if the fixture cannot round-trip deterministically.

Acceptance:

- identical inputs produce byte-identical shards and generation identity;
- parsers reject traversal paths, malformed/overlapping bounds, non-finite coordinates,
  duplicate ids, dangling edges, conflicting nodes, invalid rings, impossible heights, count
  mismatches, oversize documents, generation mismatch, and bad digests;
- the fixture reconstructs the same `RoutingGraph` behavior as its unsharded source;
- no app code fetches or uses the new data; and
- source policy and unresolved choices are evidence, not TODOs hidden in producer code.

### Checkpoint 2 — remote loader and cache, still dark

Add `app/lib/navigationData/remoteNavigation.ts` with pointer → manifest → selected shard fetch,
verification, generation-scoped deduplication, and test seams. Add
`VITE_NAVIGATION_BASE` to `.env.example` and `app/vite-env.d.ts`; absent means off and performs no
request. An HTTPS origin without a path is the simplest contract and can share the transit
origin.

Cache the pointer according to its response policy and immutable shards with `force-cache`.
Begin with a module/session decoded cache. Add Cache Storage or IndexedDB only if the cold/warm
measurements show it is worth the invalidation and quota complexity. Concurrent identical shard
requests must coalesce. Abort by one waiter must not corrupt a shared completed result or publish
stale data. Expose a route-scoped snapshot/lease so street and building loads are pinned to the
same verified generation even if `current.json` changes while the calculation is running.

Acceptance: hermetic tests cover cache reuse, bbox selection, coverage rejection, abort,
generation rollover, partial failure, corrupt bytes, and the rule that generations never mix.

### Checkpoint 3 — static streets, static-first source selection

Add `routingGraphAdapter.ts` and `routingGraphSource.ts`; make `fetchBestRoutingGraph` return the
existing `RoutingGraph` shape. Integrate it at the one `fetchRoutingGraph` call in `useRouting`.
Keep the feature configuration-off by default and keep Overpass fallback.

Acceptance:

- configured NYC fixture routes with Overpass deliberately failing;
- unconfigured and outside-support routes take the current Overpass path;
- one missing/corrupt required shard falls back for the **whole graph request**;
- seam-crossing and captured-Overpass parity fixtures agree on reachable components, tags,
  route distance, and selected path within documented tolerance; and
- pure walk plus subway/bus access and egress all receive the same static-backed walking graph.

### Checkpoint 4 — static buildings composed with existing canopy

Add `createNycStaticPrismProvider`, extend source/provenance types, and put it first in the
building provider list. Do not touch canopy source acquisition or renderer code.

Acceptance:

- `ready`, `readyEdges`, `coverage`, and synchronous `prismsFor` obey their current contracts;
- whole rings, multiparts, missing-height policy, empty-covered cells, seam ownership, outside
  casters, cancellation, and corrupt shards are tested;
- static buildings plus OSM canopy and static buildings plus raster canopy produce the existing
  `mixed` semantics and correct footprint masking;
- failure returns unknown/fallback, never a confident empty city; and
- diagnostics name `nyc-static` and the generation while user-facing provenance remains honest.

### Checkpoint 5 — full NYC build, verify, and publish

Acquire pinned inputs outside git, normalize, build, and run a separate verifier that re-reads
published-form bytes rather than trusting builder memory. Produce evidence for borough coverage,
connected components, seam counts, tag histograms, building status/height coverage, rejected and
repaired geometry, max caster reach, object counts, total bytes, and source hashes.

Publish immutable generation objects first, smoke-fetch and verify samples from every borough,
then publish the pointer last. Retain the previous generation. The serving Worker must allow only
the navigation pointer and immutable navigation objects, support CORS for intended origins, set
correct JSON/cache headers, and expose no raw acquisition directory or write/list operation.

### Checkpoint 6 — benchmark, browser smoke, and guarded rollout

Use the existing performance instrumentation but split its combined phase so reports distinguish:

- pointer/manifest time, shard transfer, verification, decode/parse, graph merge;
- building-shard transfer, verification, prism conversion, and shadow-index preparation;
- shadow sampling and Dijkstra/Pareto time already measured;
- transferred bytes, request count, selected shard count, nodes/edges/buildings, peak retained
  decoded bytes, cache hit/miss, source/generation, and fallback reason.

Record cold-cache and warm-cache p50/p95 on the same browser/hardware for short Manhattan,
cross-borough, subway, and bus cases. Compare against the current Overpass path and the existing
baseline in `docs/notes/performance-baseline.md`. The likely win is lower variance and fewer
upstream failures; do not claim a percentage until measured. Search itself may be unchanged, and
visible map rendering is expected to be unchanged.

Add a hermetic Playwright scenario with `VITE_NAVIGATION_BASE` and stubbed pointer/manifest/shards.
Assert a configured NYC walking and transit route succeeds while all Overpass graph/building
requests fail. Also assert outside-coverage fallback and no `_shadow` request. Manually inspect
one real route because unit tests do not run MapLibre.

Enable only after payload, memory, correctness, and latency budgets pass. Log/measure fallback
share before considering removal of routine NYC street/building Overpass requests. Roll back by
unsetting `VITE_NAVIGATION_BASE` or repointing `current.json`; neither requires deleting a
generation.

## Failure semantics

| Situation | Required result |
|---|---|
| `VITE_NAVIGATION_BASE` absent | No navigation-data request; current behavior. |
| Request outside verified support | Use existing Overpass streets and building providers. |
| Pointer/manifest unavailable or invalid | Fall back; report a reason in development/telemetry. |
| Any required street shard missing/corrupt | Discard the static graph request and fetch one complete Overpass graph. |
| Any required building shard missing/corrupt | Static provider returns unknown; tile/Overpass building fallback may answer. |
| Verified covered building selection has zero buildings | Valid empty prism set, with the lower no-geometry confidence policy still applied. |
| Generation changes mid-calculation | Finish on the pinned old generation or abort/retry; never mix. |
| Caller aborts | Stop publication and do not launch fallback network work. |
| Canopy source fails | Existing canopy behavior; do not reinterpret it as a building failure. |
| Transit shards fail | Existing `fetchBestTrainGraph` behavior, independent of walking data. |

## Test matrix

All automated tests remain hermetic: committed fixtures, fake fetch, fake hashes where the test
seam already permits them, no R2 and no Overpass.

- **Contract:** strict versions, finite coordinates, monotonic bounds, safe relative keys,
  digests, byte/count budgets, source receipts, and generation pinning.
- **Graph:** node/edge round trip, preserved tags, intersection flags, ghost nodes, dedupe,
  conflicting duplicates, seam crossing, disconnected components, empty-covered cells, and
  parity with the existing pure builder.
- **Buildings:** units, status/feature policy, known and fallback heights, invalid rings,
  multipart/holes according to current prism capability, whole-feature ownership, empty coverage,
  seam crossing, and caster reach beyond query bounds.
- **Shadow field:** static-only building answer, static+OSM canopy, static+raster canopy, raster
  building-mask subtraction, source confidence/provenance, low sun, missing shard, and unchanged
  fallbacks.
- **Routing:** walk modes, access/surface tags, shade-selected alternative, cancellation,
  generation rollover, and full-request fallback.
- **Transit:** subway and bus access/egress, published entrance, legacy entrance fallback,
  entrance across a graph seam, and station outside the first endpoint cell.
- **E2E:** configured NYC succeeds with graph/building Overpass blocked; outside NYC falls back;
  UI and map still render through their existing paths.
- **Performance:** cold/warm p50/p95, bytes, requests, parse/merge/preparation, memory, cache hits,
  and fallback share using fixed route fixtures.

Run focused tests first, then the repository gates required by the touched checkpoint:

```bash
npm --prefix server/navigation-prep test
npm test -- app/lib/navigationData app/lib/shadowField app/hooks
npm run lint
npm run typecheck
npm test
npm run build
```

Run the browser smoke/manual map check for Checkpoints 3, 4, and 6. A green Node suite does not
prove MapLibre behavior.

## Decisions that require measurements, not taste

Checkpoint 1 must measure and record these; the recommended default is first:

| Decision | Default | Evidence that may change it |
|---|---|---|
| Street/building grid | Benchmark z13 vs z14 | Typical selected bytes/requests, seam overhead, route spill. |
| Wire format | Strict JSON + HTTP compression | Parse/heap dominates budget after sharding. |
| Building source | NYC Building Footprints | Measured height/geometry gaps justify a separately designed supplement. |
| Missing heights | Versioned typed fallback | Prevalence/distribution supports a better documented rule. |
| Caster reach | Current 400 m/query and low-sun policy, made explicit | Edge cases or retained samples show missed relevant casters. |
| Persistent browser cache | Module cache only | Warm reload cost is material and storage complexity has a measured payoff. |
| Publication generation | Streets + buildings atomic | Independent refresh cadence proves atomic promotion too costly. |

## Definition of done

This track is done only when all of the following are true:

- With navigation data configured and Overpass graph/building calls blocked, a cold NYC walking
  route succeeds from verified static street shards and samples static building shadows.
- The same graph computes subway and bus access/egress walks; transit rides still come from the
  existing transit implementation.
- Existing canopy is blended with static buildings without moving or rewriting canopy data.
- A route crossing street and building shard seams matches its unsharded fixture.
- Outside NYC, unconfigured builds, and failed/corrupt generations preserve current fallbacks.
- No unknown or partial coverage is represented as no street, no building, or full sun.
- Pointer, manifest, and shard integrity is verified; one calculation never mixes generations.
- NYC building source policy, missing-height rate, licensing/notices, and OSM attribution are
  published with the generation.
- Cold/warm browser results and payload/memory budgets are recorded; any speed claim names the
  tested route and phase.
- Map rendering, `_shadow`, terrain, canopy acquisition, and routing algorithms are unchanged.

## Files likely to be touched

New:

- `server/navigation-prep/**`
- `app/lib/navigationData/{shardContract,remoteNavigation,routingGraphAdapter,routingGraphSource,buildingProvider}.ts`
- `app/lib/navigationData/__tests__/**`
- `docs/notes/nyc-navigation-data-*.md`

Existing, only when their checkpoint reaches them:

- `app/hooks/useRouting.ts`
- `app/lib/shadowField/ShadowField.ts`
- `app/lib/shadowField/providers.ts`
- `app/lib/shadowProvenance.ts`
- `.env.example`
- `app/vite-env.d.ts`
- `playwright.config.ts` and `e2e/**`

Avoid touching `MapView.tsx`, the MapLibre style/source configuration, `shadowField/v2/**`,
`cloudflare/shadow-data-worker/**`, or the canopy COG implementation for this track.

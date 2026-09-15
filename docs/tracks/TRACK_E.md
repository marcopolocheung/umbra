# Track E — Journeys & Modes

> **Charter:** make the app the one the mission describes — "walking, biking, scootering,
> skateboarding, running, wheeling" — and give a multi-stop journey a first-class object
> instead of three parallel arrays.

**Class:** Adjacent. **Runs alongside:** C, D freely; coordinate with A (`routing.ts`), B (`Trip`,
`useNavigation`), G (G6 splits this track's biggest file).

---

## Current state

- **Active checkpoint:** none in flight. Next is E7, slices (a)–(c), which can build on a stub; E5 waits for G6
- **Done:** E1 (merged #346: bike cost model, selector, share-URL mode), E2 (merged #350: mode-aware output), E4 (merged #355: scoot/skate profile)
- **Open PRs:** none
- **Decisions made:** cycleway preference is a capped discount (min(40 m, 50% of edge)) so Pareto pruning stays admissible; reported `distanceM` stays physical, labels/budget live in mode-cost space; Pareto budget excludes crossing penalties so walk matches main exactly; transit access legs stay pedestrian (mixed-mode is E6); `RouteOption.travelMode` drives displayed durations. E2: `shadowStrength` does NOT scale with speed — the 1/v time normalization cancels (derived in `docs/notes/mode-shadow-weight.md`); the 250 m Pareto flat and 15 m crossing penalty are walk-metres time-normalized by `v_mode/v_walk` (walk ratio exactly 1, walk byte-identical); heat/dose definitions untouched — Track D owns them, convective cooling filed as #349; acceptance deviation: no weighting added to force route divergence beyond what the derivation supports. E4: one mode, id `scoot` (kick scooters + skateboards; e-scooters excluded — legally bike-like, use bike mode); speed 3.0 m/s stated as assumption (drives ETA + E2 normalization); steps *excluded* by prohibition (`highway=steps`, `foot=no` except on dedicated `highway=cycleway` — segregated cycleways are the smooth network scooters legally ride, banning them would strand scoot where it should shine; `access=no` with a foot yes/designated/permissive override — no scooter/skateboard access tag invented, `bicycle=*` ignored); bad surfaces *penalized* near-disqualifying (+1000 m, still routes when no smooth option) over `cobblestone|sett|gravel|sand|unpaved|dirt|ground` (`sett` included: Madrid tags stone setts as `sett`); `smoothness` overrides surface where tagged (excellent/good free, intermediate +50 m, bad-or-worse +1000 m), absent falls back to surface; no cycleway discount for scoot so `minCostRatio` derives from policy (1 for walk/scoot, 0.5 for bike); E4 review fix: the Pareto detour allowance prices the baseline's physical length (`shortestCost + shortestPhys×(factor−1) + flat`) instead of doubling penalties — doubling a +1000 m sett penalty admitted ~4× detours; walk is bit-identical, bike shifts by (physical−cost) on the baseline path, pinned by a sett-corridor regression test; `RouteResult/RouteOption.surfaceMetresM` carries physical metres per surface and the card confesses ("includes N m of …") instead of implying smooth; Madrid-centre coverage measured 2026-09-15 (bbox 40.4118,-3.7088,40.4218,-3.6988 around Puerta del Sol, n=681 ways, one Overpass query): 91.8% `surface`, 30.8% `smoothness` — no sparse-data note needed for surface, smoothness fallback documented; acceptance metric is raw-surface share (walk >90% → scoot <10% on fixture O-D 21734300→351959168, detour <2×), smoothness-blind by construction. 2026-09-15 rescope: E7 reads the shadow engine v2's prepared terrain (NYC first) behind an `ElevationSource` interface, not MapTiler terrain. Unknown elevation stays null, never flat. The site is moving from Vercel to Cloudflare (#360); that move strands `localStorage` saved routes unless a handoff ships first (#357)
- **Blocked on:** E7 slice (d) only, on #356 (NYC terrain is FABDEM, which can't be published) and the first published v2 NYC generation. E7 slices (a)–(c) are unblocked
- **Next action:** E7 slices (a)–(c) against a fixture stub; or wait for G6 (E5)
- **Last verified:** 2026-09-15, 917 tests green on the branch (60 files; jsdom-component suites can't start workers on this machine — pre-existing, identical on clean main), e2e smoke green incl. the new Scoot round-trip step, lint/typecheck/build clean; review round 2 (budget inflation + Scoot accessible name) fixed with a sensitivity-checked regression test

---

## Why this track exists

The mission names six ways of moving. The product supports one.

- `app/lib/travelMode.ts` defines `TRAVEL_MODE_POLICIES` with `speedMps`, `stepsPenaltyM`,
  `roughSurfacePenaltyM`, `cyclewayPreferenceM` for `walk` and `bike`. **`useNavigation.ts:22`
  imports exactly one thing from it: `travelTimeSeconds`.** The three penalties are dead code.
- **There is no mode selector anywhere in the UI.** Grep confirms zero references to
  `travelMode` in `app/components/**` or `app/page.tsx`.
- The data is ready and unused: `GraphEdge` carries `highway`, `surface`, `cycleway`,
  `bicycle`, `foot` (`routing.ts:12-21`, PR #106), and the Overpass query already ingests
  `cycleway`, `steps`, `track`, `bridleway` (`overpass.ts:100`).

So E1 is not new capability — it's connecting three things that already exist. That's the
cheapest large win on the board.

The second half of the track is structural: waypoints live as `waypointA`, `waypointB`, and
`additionalWaypoints[]` threaded through a 1445-line hook. Track B needs to browse legs, Track
C needs to plan multi-stop journeys, and Track D needs to attach a saved commute. All three
want the same missing object: a `Trip`.

## What already exists

- `routing.ts:333 dijkstra()` — cost is `distanceM * (1 - shadowStrength * shadowFactor *
  MAX_SHADOW_SAVING * solarIntensity) + crossingPenaltyM` (`:329-330`, `MAX_SHADOW_SAVING = 0.7`
  at `:325`). **This one line is where every mode policy lands.**
- `routing.ts:472 paretoRoutes()` — the detour-budget Pareto search producing shortest /
  balanced / most-shadowed. Mode changes must not break its optimistic-bound pruning.
- `RouteLeg` / `RouteOption` (`routing.ts:48-76`) — legs, transit legs, `totalTimeSec`,
  `partial`. Multi-stop already produces real leg data.
- `trainGraph.ts` (679 lines) — transit routing with `sunExposure` per leg (0 underground,
  0.25 surface), station entrances, transfers.
- `savedRoutes.ts` + `SavedRoutesSection.tsx` — saving exists; it just doesn't save *journeys*.
- `dijkstraMultiLeg()` (`routing.ts:1129`) and `snapRouteStopsToReachableEdges()` (`:928`).

## Hard invariants that bite this track

- **Don't break the Pareto pruning.** `paretoRoutes` prunes with an optimistic bound; a cost
  model that can *decrease* with distance (a negative preference like `cyclewayPreferenceM`)
  can make that bound unsound. Model preferences as *reduced* positive cost, never negative cost.
- `routing.ts` is the most heavily tested file in the repo (63 tests). Behavior changes there
  require tests, not just a green suite.
- Overpass needs `User-Agent` (invariant #6) and caching — mode changes that widen the query
  (e.g. adding `highway=cycleway` variants) increase graph size in dense cities; measure it.

## The contract this track publishes

`app/lib/trip/types.ts`:

```ts
export interface Stop {
  coord: [number, number];
  label: string | null;
  dwellMinutes?: number;          // "30 min for coffee"
  placeId?: string;               // Foursquare, when it came from a place
}

export interface TripLeg {
  from: number; to: number;       // indices into stops
  mode: TravelModeId;
  route?: RouteOption;
  partial?: PartialRouteInfo;
}

export interface Trip {
  stops: Stop[];
  legs: TripLeg[];
  defaultMode: TravelModeId;
  totals: { distanceM: number; timeSec: number; shadowCoverage: number };
}
```

`TravelModeId` grows from `"walk" | "bike"` to include `"wheel"`, `"scoot"`, `"run"`.

---

## Checkpoints

### E1 — Mode selector + real cost model
**Goal.** Ship one mode beyond walking, end to end. Closes **#45**.
**Approach.** Apply the policy in `dijkstra`'s edge cost: `stepsPenaltyM` when
`highway === "steps"`, `roughSurfacePenaltyM` for `surface` in
`cobblestone|gravel|sand|dirt|ground`, and `cyclewayPreferenceM` as a *discount* on the
positive cost (see the pruning invariant). Segmented control in `DirectionsPanel`; mode
persisted in the share URL (`shareState.ts`). **Bike first** — best-tagged mode in OSM.
**Acceptance.** Routing tests for each penalty on a synthetic graph (a stairs shortcut is
avoided in bike mode and taken in walk mode); ETA reflects `speedMps`; Pareto options still
return three distinct routes; mode survives a share-link round trip.
**Files.** `routing.ts`, `travelMode.ts`, `DirectionsPanel.tsx`, `shareState.ts`, `useNavigation.ts` (⚠️).
**Size.** Large. Split: (a) cost model + tests, (b) UI + URL.

### E2 — Mode-aware output
**Goal.** Everything downstream speaks the selected mode.
**Approach.** ETA, the tradeoff sentence, and the shadow weighting adapt: a cyclist at 4.5 m/s
accumulates roughly a third of the dose per metre, so `shadowStrength` should scale with
exposure *time*, not distance. Coordinate the exposure half with **Track D** (D4's score
consumes the same reasoning).
**Acceptance.** Documented relationship between mode speed and shadow weight; the same origin/
destination in walk vs bike produces sensibly different route choices, not just a different ETA.
**Files.** `routing.ts`, `routeTradeoff.ts`, `useNavigation.ts` (⚠️). **Size.** Medium.

### E3 — Wheeling profile
**Goal.** The mission's word "wheeling", taken seriously.
**Approach.** Borrow the OpenSidewalks/AccessMap schema: exclude `highway=steps`, cap incline
(needs E7's elevation), prefer `kerb=lowered` / `crossing:kerb=lowered`, penalize bad surfaces,
require `sidewalk`/`footway` where tagged. **Surface *why*** a route was chosen — for this user
an unexplained detour is indistinguishable from a wrong one.
**Acceptance.** A route with a stepped shortcut avoids it entirely (penalty, not preference); a
route that can't be made accessible says so plainly rather than returning a route the user
can't use; the "why" is visible in the route card.
**Files.** `travelMode.ts`, `routing.ts`, `overpass.ts` (kerb/incline tags), route card.
**Size.** Large. **Depends on E7 for incline.**

### E4 — Scoot / skate profile
**Goal.** Surface-dominant costing.
**Approach.** `cobblestone`, `gravel`, `sand`, `unpaved` become near-disqualifying;
steps excluded; smoothness (`smoothness=*`) consulted where tagged.
**Acceptance.** On a cobblestone-heavy fixture (Madrid centre), scoot mode routes materially
differently from walk mode. **Size.** Small–medium once E1's machinery exists.

### E5 — The `Trip` model ← **the structural payoff**
**Goal.** One object for a journey; three tracks stop improvising.
**Approach.** Introduce `app/lib/trip/**` and migrate `useNavigation`'s waypoint arrays behind
it, keeping the current public hook API until consumers move. Add per-stop dwell time (needed
for "coffee then dinner" — a 30-minute stop changes which hour the next leg is routed for,
which is the whole point of a shadow app).
**Acceptance.** `Trip` is the argument type for save, share, export, and the agent's planning
tool; existing route tests unchanged; the share URL round-trips a 4-stop trip with dwell times.
**Files.** `app/lib/trip/**` (new), `useNavigation.ts` (⚠️), `savedRoutes.ts`, `shareState.ts`.
**Size.** Large. **Best done immediately after G6 splits `useNavigation`.**
**Per-stop dwell is a hard dependency for Track H.** H5 prices waiting and dwell as exposure
in their own right — sun you accumulate standing still — and consumes `Trip` rather than
reinventing a stop model. Track C's C4 also wants `Trip` as its planning-tool argument shape.

### E6 — Mixed-mode journeys
**Goal.** Walk + transit + bike legs in one `Trip`.
**Approach.** `trainGraph.ts` already produces transit legs with `sunExposure`; generalize so
each `TripLeg` carries its own mode and the totals sum across modes.
**Acceptance.** A walk→transit→walk journey reports honest per-leg shadow (underground legs are
100% shadowed and should say why); a bike leg that can't continue underground is handled explicitly.
**Files.** `app/lib/trip/**`, `trainGraph.ts`, `useNavigation.ts` (⚠️). **Size.** Large.

### E7 — Elevation *(unblocks E3; rescoped 2026-09-15)*
**Goal.** Per-edge grade from **the same terrain the shadow engine uses**, so the hill that
casts a shadow and the hill that slows you down are the same hill.
**Why rescoped.** The original plan read MapTiler terrain tiles (`MapView.tsx`,
`TERRAIN_SOURCE_SPEC`). Shadow engine v2 (`docs/shadow-engine-v2/`, `server/shadow-prep/`)
now prepares terrain regionally, starting with New York City, and publishes it as immutable
objects served from R2 (#360). A second elevation source would disagree with the shadows and
bring its own terms (03-data-sources §T1). The NYC source isn't settled either:
`regions/new-york-city-v1.json` requires FABDEM (CC BY-NC-SA), which `publication/ATTRIBUTION.md`
says must not be made public. **#356 has to resolve before any public grade ships.** 3DEP is
the recommended source.
**Approach, stub first.**
(a) `app/lib/elevation/`: an `ElevationSource` interface that batches `[lng, lat][] →
Promise<(number | null)[]>` and carries provenance (source, generation, vertical datum).
`null` means unknown and never becomes 0, the same rule v2 applies to shadow. Tests use a fixture stub.
(b) Per-edge elevation profile: sample the endpoints plus interior points at a stated
spacing, and compute directed grade (edges are directed). State the resolution limit: a
~30 m DEM can't see a 20 m ramp. The sidewalk split copies tags with a spread, so check new
edge fields survive it, with a test.
(c) Slope-speed model for ETA: a cited function per mode (e.g. Tobler's hiking function for
walk; bike needs its own source). Changing route **cost** needs an E2-style derivation note.
Where elevation is null, ETA and routing stay byte-identical for walk, bike and scoot.
(d) Swap the stub for v2's published terrain reader, reusing v2's decoder rather than a
parallel tile reader. This needs #356 and a published NYC generation (v2 items 7 and 17, #315/#318).
**Outside prepared regions:** elevation is `null` and the card says so. A worldwide fallback
source is a separate later decision that needs its own licence review, not a silent
MapTiler default.
**Acceptance.** Interface and stub tests; null propagates end to end (unknown elevation
never reads as flat); no routing change where elevation is null. With admitted NYC terrain,
ETA on a named NYC hill route (e.g. Washington Heights, or Staten Island's Grymes Hill) gets
closer to a timed reference walk, with the method and sample count recorded.
**Files.** `app/lib/elevation/**` (new), `routing.ts` (edge fields), `travelMode.ts`
(slope speed), `useNavigation.ts` (⚠️ attach elevation after the graph fetch, minimal).
**Size.** Medium for (a)–(c), small for (d).

### E8 — Saved journeys
Home/Work + a commute `Trip` that reopens with today's shadow. Part of **#64**; pairs with
Track D's D6/D7 to close the habit loop. Extends `savedRoutes.ts` from routes to trips
(with a migration for existing saved data — don't strand it). Saved routes live in
origin-scoped `localStorage`, so the Vercel → Cloudflare move strands them too. The handoff
in #357 has to land before cutover, whether or not E8 has started.

---

## Subagent plan

- **E1 splits cleanly into two builders** (cost model + tests / UI + URL) once the policy shape
  is fixed — disjoint files, worktree isolation.
- **E4 is a good solo warm-up** for a session picking up this track cold: small, self-contained,
  and it exercises the E1 machinery.
- **E5 and E6 are solo and sequential.** They touch the contested hook by definition.
- **Scout** for OSM tagging reality checks ("how often is `kerb=lowered` tagged in Madrid vs
  Seattle?") — this determines whether E3 is credible in a given city, and it's exactly the
  bounded question a scout answers well.
- **Verifier on E1 and E5.** `routing.ts` is the most-tested file in the repo and the easiest
  place to break something subtle (the Pareto bound).

## Risks

1. **Unsound pruning from negative costs.** The single most likely way to silently break
   routing. Preferences reduce positive cost; they never go below zero.
2. **Graph size in dense cities** if mode support widens the Overpass query. Measure against
   Track G's benchmark before and after.
3. **Accessibility theater.** A wheeling profile built on tags that aren't mapped in the user's
   city is worse than none — it promises and fails. Mitigation: report data coverage honestly
   in the route card ("kerb data sparse here").
4. **`Trip` migration stranding saved data.** Write the migration in the same PR as the model.
5. **The hosting move stranding saved data and share links.** `localStorage` belongs to one
   origin, and share URLs are absolute. See #357: the handoff must ship before cutover, and the
   old domain must 308-redirect preserving the query.
6. **Grade from a source we can't publish.** NYC terrain is currently FABDEM (non-public).
   E7 slice (d) waits on #356; never fall back to an unreviewed source to unblock it.

## Out of scope / hand-offs

- Shadow math → **Track A**. Heat weighting → **Track D** (E applies, D defines).
- Terrain preparation and publication → **shadow engine v2** (`docs/shadow-engine-v2/`); E7
  consumes it. Hosting, R2 and the proxy port → the Cloudflare migration (#360), which the
  repo owner owns.
- Live guidance and leg *browsing UI* → **Track B** (B8 consumes `Trip`).
- Splitting `useNavigation.ts` → **Track G** (G6). Don't do it opportunistically mid-checkpoint.

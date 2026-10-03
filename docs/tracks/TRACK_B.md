# Track B — Live Navigation

> **Charter:** make the app navigate. Turn a calculated route into guidance a person can
> follow while walking — with the one instruction no competitor can give:
> *"cross to the shadowed side."*

**Class:** Flagship. **Runs alongside:** A, C, D, G freely; coordinate with E (`Trip`, `useNavigation`).

---

## Current state

- **Active checkpoint:** B2 — implemented on `feat/b2-street-names` (this branch). B1 is merged
  (`app/lib/guidance/maneuvers.ts` is on `main`). B2 keeps OSM `name` on every routing edge and
  threads it into `Maneuver.streetName` (via `streetNamesAlong`); the memory cost is measured
  (one reference slot per edge, single-digit to low-tens of bytes) in
  `docs/notes/guidance-street-names.md`. Live position tracking and UI follow in B3/B4.
- **Done:** B1 implementation and its captured-route tests; prerequisite camera work #148
  (the PR for #145) and #159 merged, as did #150 (chosen sidewalk plumbing), #171
  (roof depth precision) and #178 (wall/ground shadow alignment). No numbered checkpoint
  before B1.
- **Open PRs:** B2 (this branch) — street names in the graph.
- **Decisions made:**
  - **B1 consumes ordered walking nodes** via `generateManeuvers(nodes, legIndex = 0)` in
    `app/lib/guidance/maneuvers.ts`; distances are cumulative haversine meters along the
    supplied path, local to that leg. Use each walking leg separately: transit options'
    top-level GeoJSON joins disconnected walking legs. Do not derive walk guidance from it.
  - **The supposed bearing helper did not exist.** B1 extracts `bearingDegrees` in
    `routing.ts` for both turn counters and guidance, correcting raw longitude/latitude
    degree differences to geographic bearings. Routing still counts turns at >30°;
    guidance uses <20° continue, [20°,50°) slight, [50°,120°] turn, >120° sharp.
    Positive deltas mean right; an exact 180° reversal deterministically means sharp-left.
    Geographic angles can change the displayed turn count, but do not change route costs.
  - **Continue instructions are omitted**, including small successive bends; real adjacent
    turns are retained even when close together. Consecutive duplicate positions are skipped.
    Empty paths yield no maneuvers; stationary paths yield only arrival at 0 m.
    `guidance/types.ts` publishes the full contract; street names are filled from the graph by B2
    (`streetNamesAlong`), and shadow hints remain unset until B6. The Madrid fixture records actual OSM nodes, source timestamps,
    way IDs and capture inputs; its 281 m path yields five turns plus depart/arrive.
  - **No terrain, ever.** It displaces the ground while the shadow layer's triangles stay at
    `z = 0`. Draping them means sampling the DEM in the shadow vertex shader, and elevation
    adds nothing to urban pedestrian shadow. Deleted rather than fixed.
  - **`buildings-3d` is gone; `LocalShadowAdapter` draws the extrusions.** A
    `fill-extrusion` cannot be shadowed, so painting shadows onto the buildings meant owning
    the geometry. Pass E extrudes the very prisms that cast the shadows and shadows each
    fragment against the height FBO, so a building and its shadow can no longer disagree —
    which also retires the `BUILDING_HEIGHT_EXPR` that had to mirror `buildingHeightM()`.
    The layer is topmost and `renderingMode: '3d'`, so MapLibre puts its opaque-pass cutoff
    there and the nav overlays above it keep testing no depth.
    `bringNavOverlaysToFront` deliberately does not list `local-shadow-layer`. Do not "fix"
    this with `moveLayer`.
  - **Shadowed building surfaces are lighter than the ground shadow, never equal to it.**
    A shadowed wall first came out at `#405880` against a `#516990` street — same hue, more
    contrast the wrong way — so a tilted view looking away from the sun showed rooftops
    floating on blue with no walls under them, which reads as "transparent buildings".
    The ladder is now ground `#516990` < wall `#6f7f99` < roof `#8797b2` < lit wall `#c0c0c0`
    < lit roof `#ceced0`, all still blue-dominant. Keep it monotone if you retune it.
  - **Roof exclusion (Pass C) is now exact, and that changes the flat view.** Feeding
    Pass B the ceiling ramp rather than the caster's constant height means a roof is
    erased when the shadow reaching *that height* clears it, not when any taller
    building's ground polygon merely overlaps it. Measured against `main` at pitch 0,
    z16.3, 1 pm Midtown: **12.2% of the map area changes**, essentially all of it
    rooftops going `#516990` → `#c0c0c0` (shadow-over-building-fill → bare fill). The
    street network is untouched, so the sidewalk samples the shadow routing reads are
    unaffected — but do not repeat the earlier claim that pitch 0 is pixel-identical.
    It is not, it is *more correct*, and any future pixel comparison has to be against
    `main` rather than against another build of the same branch.
  - **Pass E leaves the depth *range* alone.** MapLibre sets `depthRangeFor3D` before
    calling a `'3d'` custom layer, reserving the top slice so no 3D fragment can lose
    LEQUAL to the near-1 depths the opaque-pass basemap fills wrote. Taking the full
    `[0,1]` re-opens that and lets the ground reject a distant building.
  - **Place labels ride above the buildings only while tilted.** Lifting them at pitch 0
    would put untinted label pixels over shadowed sidewalks in the canvas the shadow sampler
    reads back (invariant #5). The lift is captured as slots at the very top of the `load`
    handler, before any of our own layers exist — anchoring a slot to one of ours strands
    the style's whole trailing run of place labels above the buildings.
  - **Camera pitch lives in `useShadowTime`**, not in a component: the map arrives via a ref,
    so a component subscribing on mount finds `null` and never re-renders to retry.
  - 3D tilt is **55°**, and the toggle honours `prefers-reduced-motion` with `jumpTo`.
  - **Wall sample nudges are ceiling-neutral away from the near cap.** Pass E still samples
    1.5 m toward the sun and 1.5 m along the wall normal to escape its own footprint, but its
    wall-only threshold rises by each offset's sunward component times `tan(alt)`. Roofs take
    exactly zero lift. Near-cap residuals and purely transverse normal offsets remain explicit
    limitations; #176 owns making the nudge texel-adaptive.
- **Blocked on:** nothing for B1. For B6, `ShadowField.sampleEdges` already returns per-side
  shadow and confidence (`app/lib/shadowField/ShadowField.ts`), and #168 uses it in navigation;
  no A2 stub is needed. `GraphEdge.side` and `RouteResult`/`RouteOption.sides` also exist
  after #150. Remaining integration work: switching sides costs nothing (#151), and
  endpoint connectors currently shift sidewalk labels against final GeoJSON (#180).
- **Next action:** B3 — position tracking and map matching. B2 is implemented (this branch).
- **Last verified:** 2026-10-03 — B2 on `feat/b2-street-names`: lint (0 errors), typecheck,
  tests (1945 passing), build all green. 2026-09-05, main `fb47c18` baseline: 342 tests / 33 files green.
  B1 branch: all four gates green, 376 tests / 34 files (34 new guidance tests), build
  5.57 s; lint has 52 existing warnings and 8 infos (capped output), with no errors in
  the changed files. Cold verifier: no findings, independently reran all four gates.
  CI's coverage command also passed; `maneuvers.ts` has 100% statement/branch/function/line
  coverage. B1 has no UI/map change, so no browser check applies. The branch has since
  merged main (`9ccde54`, picking up #177 and #178) to clear a docs-only conflict in this
  file; the gates have not been rerun on the merge commit.
  Prior shadow verification (2026-09-05, #178): three identical Tribeca z17 / pitch-55
  browser pairs each compared 4,060,451 stable Pass E pixels — 22,169 shadowed→lit (0.546%),
  zero lit→shadowed, zero roof differences, 1,166 strict wall-base paths, and wall-base
  disagreement improved 15.015% → 14.524% across 11,009 whole wall/ground samples; ordinary
  z17–18 renders kept walls variably lit and the PR #171 rooftop case unchanged.
  Prior camera verification (2026-09-03): screenshots of Midtown Manhattan at pitch
  0/60/65/70 across the day, a pitch round-trip asserting exact label order restoration,
  and a `main`-vs-branch pixel diff of the flat view.
  #121 is workable: Playwright's Chromium runs headless in WSL once
  `libnss3`/`libnspr4`/`libasound2` are `apt-get download`ed and extracted to a
  `LD_LIBRARY_PATH` dir (no sudo), with `--use-angle=swiftshader` for WebGL. Take the
  screenshots — do not record a visual check as outstanding.

---

## Why this track exists

The app is named for navigation and does not navigate. Verified 2026-08-24:

- `watchPosition` appears **nowhere** in `app/`. The only geolocation calls are one-shot
  `getCurrentPosition` (`useNavigation.ts:292`, `agent/tools.ts:90`).
- The `NAVIGATING` phase (`useAppState.ts`) renders `NavigationStatusPanel.tsx` — 161 lines
  showing destination, distance, ETA, shadow %, and a turn *count*. No maneuvers, no street
  names, no progress, no off-route detection, no reroute, no arrival detection, no voice.
- `ARRIVAL` is reached by the user tapping a button.

Meanwhile Google is shipping shadow *inside* real turn-by-turn with landmark-based voice cues.
A route you have to hold in your head is a planning tool.

## The asset nobody else has

`shadowSampling.ts:sampleBothSidewalks()` samples **±4 m perpendicular offsets** and returns
`{left, right}` shadow independently; `useNavigation.ts:984-991` assigns them to separate parallel
edges so Dijkstra picks a *side of the street*. That means the app already knows which
sidewalk is shadowed — it just never tells anyone. Every shadow-routing competitor routes on
street centrelines.

**B6 is the point of this track.** B1–B5 are the machinery that makes B6 sayable.

## What already exists

- `RouteOption.geojson` + `legs: RouteLeg[]` (`routing.ts:48-76`) — geometry and per-leg data.
- `RouteResult.turnCount` — turns are already counted, so the bearing math exists in spirit.
- `routeProgress.ts` + `routeBounds.ts` — route-calculation progress and bounds helpers,
  used by `DirectionsPanel`; neither tracks a walker's progress (that is B3).
- `guidance/maneuvers.ts` + `guidance/types.ts` — B1's pure walking-node maneuver generator
  and published contract; the captured Madrid fixture is in `guidance/__tests__/fixtures/`.
- `useAppState.ts` — the `IDLE → PLACE_DETAIL → DIRECTIONS → NAVIGATING → ARRIVAL` FSM, with `START_NAVIGATION`/`ARRIVE` actions already wired.
- `MapView.tsx` layer conventions: `nav-route` source/layer (`:660-664`), train layers (`:1214+`), sketch layers (`:624-646`). Add guidance layers the same way.
- `partialRoute.ts` — the "this leg couldn't be routed" state B8 must render.

## Hard invariants that bite this track

- **`MapView` only via `React.lazy`** (invariant #4) — guidance layers go *inside* MapView or a lazily-loaded module, never a static import from app code.
- **`preserveDrawingBuffer`** stays true.
- Reduced-motion: guidance re-centering must respect `prefers-reduced-motion` (a11y is a mission word, and `jumpTo` vs `easeTo` is the difference).
- Nominatim/Overpass need a `User-Agent` (invariant #6) — B2's street names come from the graph, not a geocoder, so don't add lookups here.

## The contract this track publishes

`app/lib/guidance/types.ts`:

```ts
export type ManeuverType =
  | "depart" | "continue" | "turn-left" | "turn-right"
  | "slight-left" | "slight-right" | "sharp-left" | "sharp-right"
  | "cross" | "board" | "alight" | "arrive";

export interface Maneuver {
  type: ManeuverType;
  bearingDelta: number;          // degrees, signed
  distanceFromStartM: number;
  streetName?: string;
  shadowSideHint?: "left" | "right" | null;   // B6
  legIndex: number;
}

export interface GuidanceState {
  maneuvers: Maneuver[];
  activeIndex: number;
  progressM: number;
  distanceToNextM: number;
  etaSec: number;
  offRoute: boolean;
  snapped: [number, number] | null;   // map-matched position
}
```

---

## Checkpoints

### B1 — Maneuver generation (pure)
**Goal.** Route node list → `Maneuver[]`.
**Approach.** `app/lib/guidance/maneuvers.ts`. Bearing per segment; classify the delta at each node (thresholds: <20° continue, 20–50° slight, 50–120° turn, >120° sharp); omit redundant `continue`s; emit `depart`/`arrive`. Share `bearingDegrees` with both `turnCount` paths in `routing.ts` (B1 extracted their duplicated inline formula).
**Acceptance.** Unit tests: a straight line yields depart+arrive only; an L yields one turn with the correct sign; a staircase of small deltas doesn't emit a maneuver per node; a real captured route fixture produces a human-plausible list.
**Files.** `app/lib/guidance/**` (new); minimal shared-bearing extraction in `app/lib/routing.ts`. **Size.** Medium. **No UI.**

### B2 — Street names in the graph
**Goal.** Instructions that name a street.
**Approach.** Keep `name` on edges in `overpass.ts` (the pattern exists — PR #106 already preserves `surface`/`cycleway`/`bicycle`/`foot` on `GraphEdge`, `routing.ts:12-21`). Thread it into `Maneuver.streetName`.
**Acceptance.** Graph tests assert `name` survives; maneuvers on a named-street fixture carry it; memory impact of the extra string is measured, not guessed (dense-city graphs are big).
**Files.** `app/lib/overpass.ts`, `app/lib/routing.ts` (type only), `app/lib/guidance/**`. **Size.** Small. ⚠️ Coordinate with **Track E** — E1 also edits edge tags.

### B3 — Position tracking + map matching
**Goal.** Know where the user is, on the route.
**Approach.** `app/hooks/useGuidance.ts`: `watchPosition` with `enableHighAccuracy`, drop samples with `accuracy > 30 m`, project onto the nearest route segment within tolerance (start at 25 m), monotonic progress (don't let noise walk you backwards), heading from `coords.heading` with a bearing-of-travel fallback.
**Acceptance.** A **playback harness** — a GPX fixture replayed at 1.4 m/s — drives `progressM`, `activeIndex`, and `distanceToNextM` correctly in tests, including a noisy-sample case and a tunnel/dropout case. No browser needed for the test; that's the point of the harness.
**Files.** `app/hooks/useGuidance.ts` (new), `app/lib/guidance/matcher.ts` (new). **Size.** Large.

### B4 — Guidance UI
**Goal.** Replace the static card with something usable one-handed, outdoors, in sun.
**Approach.** Next maneuver (large), distance to it, remaining distance/ETA, a shadow strip for the next ~500 m, a recenter control, screen wake lock (`navigator.wakeLock`, with graceful absence). High contrast — the persona is in direct sunlight.
**Acceptance.** Touch targets meet the audit in `docs/notes/touch-target-audit.md`; keyboard and screen-reader clean (`aria-live="polite"` on the maneuver, not assertive); respects `prefers-reduced-motion`; verified in `npm run dev` at a phone viewport.
**Files.** replacement for `NavigationStatusPanel.tsx`, a guidance layer module in `MapView.tsx` (⚠️ contested), ~15 lines in `page.tsx` (⚠️ contested). **Size.** Large.

### B5 — Off-route + reroute
**Goal.** Recover when the user leaves the line.
**Approach.** Off-route after N consecutive samples beyond tolerance (start N=3) — never on one sample. Recompute from the snapped position to the remaining destination, **preserving the shadow preference and the selected Pareto option**. Rate-limit reroutes (Overpass is a shared free resource).
**Acceptance.** The B3 playback harness, with a deviation injected, flags off-route and recovers; no reroute storm when GPS is noisy; a reroute that fails degrades to "follow the map" rather than a dead end.
**Files.** `app/hooks/useGuidance.ts`, `useNavigation.ts` (⚠️ contested — reuse `calculateRoute`, don't fork it). **Size.** Medium.

### B6 — Shadow-aware cues ← **the reason for this track**
**Goal.** "Cross now — the north side is shadowed for the next 300 m."
**Approach.** Track A's `ShadowField.sampleEdges` gives `{left, right}` for edges ahead. Emit a `cross` maneuver only when: the side delta exceeds a threshold (start 0.25), the shadowed run ahead exceeds a minimum length (start 150 m), a legal crossing exists nearby (`highway=crossing` in the graph), and solar intensity × (1 − cloud cover) is high enough to matter (`computeSolarIntensity` + `weather.ts`).
**Acceptance.** No cue chatter on a fixture route (≤1 cue per 400 m); zero cues at night or under heavy cloud; every cue traceable to the field sample that triggered it. **Never suggest crossing where no crossing is mapped** — this is a safety-shaped feature, and the honest failure is to stay quiet.
**Files.** `app/lib/guidance/cues.ts` (new). **Size.** Medium. **A2 is available on main; use `ShadowField.sampleEdges`.**

### B7 — Voice + arrival summary
**Goal.** Eyes-up guidance, and the sentence Track F will share.
**Approach.** Web Speech API (`speechSynthesis`) — announce at distance thresholds, never repeat, always have a mute. Arrival: "You walked 78% in shadow — about 4 minutes of direct sun." Fires `ARRIVE` automatically within a geofence of the destination.
**Acceptance.** Speech degrades silently where unsupported; announcements don't fire twice; the summary's numbers come from the actual tracked path, not the planned route (if the user detoured, say what they actually did).
**Files.** `app/lib/guidance/voice.ts` (new), arrival component. **Size.** Medium.
**Two tracks are waiting on B7's arrival sentence:** it is Track F's documented unpark
condition (with D1, which has landed), and Track P's P3 demo recording ends on it. Neither
should be started with a mocked summary.

### B8 — Leg and stop browsing
**Goal.** Step through a multi-stop journey. Closes **#66**.
**Approach.** `RouteLeg[]` already exists and `RouteCard` renders per-leg detail. Add prev/next leg navigation that flies the map to each leg and scopes the maneuver list. This is also where `partialRoute.ts`'s "this leg couldn't be routed" belongs.
**Acceptance.** Works for walk-only and walk+transit journeys; keyboard navigable; a partial route shows which leg failed and why.
**Files.** leg-browser component, `DirectionsPanel.tsx` (⚠️ Track E owns — coordinate). **Size.** Medium. **Wants Track E's `Trip` (E5).**

### B9 — Battery and background *(stretch)*
GPS + WebGL while navigating is the real-world cost. Throttle the shadow layer's refresh while
moving, drop the sun-position worker cadence, measure with the Track G benchmark before claiming a win.

---

## Subagent plan

- **Scout** for prior art questions ("how does `turnCount` compute bearings today?", "what does MapLibre give us in `coords.heading` across browsers?").
- **B1 + B3's playback harness are swarm-able** (disjoint files, both pure) once the `Maneuver` type is committed.
- **B4, B5, B8 are solo** — contested files.
- **Verifier mandatory on B5 and B6.** Off-route logic and crossing cues are where a plausible-looking change is dangerous rather than merely wrong.

## Risks

1. **Testing without a browser.** Everything here is position-driven, and the repo has no browser coverage (#35). Mitigation: the B3 playback harness makes B3/B5/B6 testable in `vitest` with zero browser — build it before the features, not after. Track **G1** covers the rest.
2. **Cue safety.** A "cross here" where no crossing exists is the worst thing this app could say. Mitigation: require a mapped crossing; prefer silence.
3. **GPS in urban canyons** — the exact cities this app targets are the worst for multipath. Mitigation: accuracy filtering, monotonic progress, generous off-route thresholds.
4. **Contested-file collisions with Track E.** Mitigation: the compatibility matrix in `docs/tracks/README.md`; wait for **G6** if both tracks are hot.

## Out of scope / hand-offs

- Route *calculation* → reuse `useNavigation`'s pipeline; never fork it.
- Shadow math → **Track A** (`ShadowField`).
- What a "trip" is (stops, modes, dwell) → **Track E** (`Trip`).
- Turning the arrival summary into a shareable image → **Track F** (F1).

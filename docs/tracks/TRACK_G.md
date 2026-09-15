# Track G — Proving Ground

> **Charter:** make every other track's "done" verifiable, and remove the file collisions that
> stop them running at once. This is not overhead — it is the precondition for parallel work.

**Class:** Enabling. **Staff first, alongside A.** **Runs alongside:** B, C, D freely; ⚠️ A (owns
A's fixtures), ⚠️ E (G6 rewrites E's biggest file). **G6 runs alone.**

---

## Current state

- **Active checkpoint:** **G6(a)** — `useNavigation.ts` split PR open (fixes #362, the
  in-flight freeze notice). `useNavigation` is a thin facade over `useTrip` /
  `useSketch` / `useRouting` (`app/hooks/`, pure helpers in
  `app/lib/navigationHelpers.ts`); page.tsx, useAgent and all tests compile
  untouched against the pinned return key set (`useNavigationKeys.test.ts`).
  `MapView.tsx` (#313) and `page.tsx` (#343) splits are separate PRs and out of
  scope here — G6(b/c) take those files next.
- **Done — G2.** `npm run bench:route` landed with the committed baseline in
  `docs/notes/performance-baseline.md` (see the G2 section below for the split,
  the warm-slower-than-cold finding and issues #259, #261–#266).
- **Open PRs:** **#258** (`fix/g2-metrics-instrument`, #182 + #183) and **#260**
  (`feat/g2-route-benchmark`, G2 + the #243 sweep). **Merge #258 first** — #260's warm scenarios
  call `clearMetrics()` and its cross-check reads `summary.p50TotalMs`, so it does not build
  without it. GitHub retargets #260 to `main` when #258 merges.
- **G2 is the highest-leverage item on the board.** A5's acceptance criterion is literally
  *"no benchmark → no claim"*, Track H cannot state its central comparison without a committed
  baseline, and Track P cannot publish a performance number that does not exist.
- **Take G7 before G3.** It is `docs/ROADMAP.md` Wave 0 — it blocks claims rather than
  features. The public-mirror work moved to **Track P (P1)**, which owns the public surface.
- **Done in G7:** **#52** — the repo has a LICENSE. Two files called it open-source while
  `license: NONE` made it all-rights-reserved; it is MIT now, declared in `package.json` and
  linked from the README, so the mirror shows a licence a reader can act on.
- **Done in G7:** **#53 and the last live bullet of #50** — `.env.example` is committed (the
  `.gitignore` needed a `!.env.example` negation, and `mirror-guard.sh` an exception, or the
  template would have been ignored and then blocked from publication). It separates the two
  `VITE_`-prefixed dev-only client keys from the server-only ones and says why the prefix is
  the whole difference. `CLAUDE.md` and the README no longer say `.env.local`, and the README
  no longer promises per-directory `CLAUDE.md` files. **P2 owns the same README lines** — it
  inherits them fixed.
- **Done:** **#205** — the two provider-policy defects in the search path. Nominatim is now
  reached only through a same-origin proxy (`api/nominatim.js` in production, the Vite
  `/__nominatim` proxy in dev), which is the only place a `User-Agent` can actually be set:
  the header is forbidden to `fetch`, so the one three client files had been sending never
  once reached Nominatim. Search now runs on an explicit submit — Enter or the magnifier —
  because the OSMF policy lists autocomplete under unacceptable use; `SearchBar`,
  `WaypointInput` and `NavigationPanel` no longer fire a geocode from a keystroke.
  `LocationSearch.tsx` was deleted (unreferenced, and its whole body was the direct fetch).
  Invariant #6 in root `CLAUDE.md` now says where the header can and cannot be set, and the
  `PreToolUse` hook enforces that version — it denies stripping the header from a proxy and
  denies adding it back to client code.
- **Done — G8 is closed out.** The **dependency-bump policy** is written into G8 below: the two
  invariant pins and why they are `ignore`d, `npm audit fix --force` banned, majors with no
  security driver declined by default, and the three Node-20-blocked majors deferred to #215.
  #32 and #33 are closed.
- **Done:** **#215** — CI and the repo now run **Node 24.21.0 LTS**, not 20. The bump
  target changed from the 22 the issue proposed: Vercel has been building and running
  `api/*.js` on **24.x** all along, so 22 would have narrowed a CI/production runtime gap
  that 24 closes — and 24 is Active LTS while 22 is in maintenance. `engines.node` is
  `24.x` in `package.json`, which Vercel reads, so the deployed runtime is now declared in
  version control instead of only in a dashboard.
- **Done — two of the three deps #215 unblocked.** `jsdom` **30.0.1** (#141) and `@types/node`
  **24.13.3** (#142, taken at 24 not the 26 offered — G8's rule is that types track the runtime,
  and nothing runs 26). **`vitest` 5 was declined and filed as #254:** it removes the `bench`
  export outright, so `shadowField.bench.ts` fails `tsc` and `npm run bench` dies with
  `TypeError: bench is not a function`. All 550 tests pass on vitest 5 — the benchmark file is
  outside the test glob by design, which is exactly why nothing in CI would have caught it.
  Porting the benchmark is a change to how this repo measures things, not a dependency bump,
  and it should not land immediately before **G2**, which is entirely about benchmarking.
  **#254 also owns a naming collision G2 will hit:** `npm run bench` is already taken.
- **Filed, not fixed:** **#229** — `api/overpass.js` and `api/nominatim.js` take requests from
  any origin with no rate limit, unlike `api/fsq.js` and `api/agent.js`. Pre-existing in the
  Overpass proxy; the Nominatim one followed its idiom rather than inventing a one-off, so the
  mitigation should be chosen once for both.
- **Done:** **#212** — the place popup's `href`/`src` accept an `http(s)` URL only. `escapeHtml`
  is no defence in URL position, so the scheme is now checked before interpolation: `javascript:`,
  `data:` and protocol-relative values drop their row, `tel:` is built from dialable characters
  only, and `escapeHtml` also escapes quotes so a value cannot end the attribute it sits in. The
  popup body moved to `app/components/placePopup.ts`, which is what makes the emitted HTML
  testable.
- **Done:** **G4, delivered by Track A** — `app/lib/shadowField/__tests__/agreement/` meets G4's
  acceptance in full (prints the metric every run, enforces committed ceilings, adding a city is
  a data change). G owns how it runs; A owns what is in it.
- **Done:** G1 — `npm run e2e`, one Playwright smoke test over the built app, running in CI on
  every PR: shadows paint (imported `isBlueDominantShadowPixel`, 27.8% of sampled pixels at 09:00
  against 0.000% on the first readable frame), the timeline drag retimes them (mask diff 0.307
  after the drag against a 0.000 noise floor over 4 s without one, landing on 12:00 in the URL),
  and a stubbed-Overpass two-point route puts route-line pixels on the canvas against 0 before
  the click. ~17 s locally, one retry then fail.
- **Open PRs:** none in this track — #165 merged this refresh, bringing **G0** (routing-quality
  eval) and the G4-delivered finding. The Dependabot backlog is tracked in `docs/ROADMAP.md`
  Wave 0, not here.
- **Decisions made:** the smoke test seeds state through the existing share-link params
  (`?lat/lng/z/date/time/a/b`) rather than driving the geocoder, and stubs `/api/overpass` with a
  synthetic street grid. It runs as two projects. `smoke` intercepts the MapTiler style request
  and serves a synthetic style whose `maptiler_planet` **geojson** source carries the building
  footprints — maplibre 5.9.0 resolves a tile's layers as `_geojsonTileLayer || [sourceLayer]`,
  so every `querySourceFeatures("maptiler_planet", { sourceLayer: "building" })` caller works
  unchanged and no production code moved. That project needs no key, so it runs on forks. Its
  fixture palette is pure greys, because a blue-dominant basemap would make the unshadowed baseline
  score as shadow and the whole assertion vacuous. `smoke-live` repeats the same assertions
  against real tiles wherever the secret exists — the only check on MapTiler's real `building`
  schema. CI uploads no Playwright artifacts (`smoke-live` traces record tile URLs, which carry
  the key).
- **Blocked on:** nothing. `VITE_MAPTILER_API_KEY` as a repo secret (#173) now only adds the
  `smoke-live` project; it is no longer the difference between a real run and a green skip.
- **Decisions made in G2, so a future session does not re-derive them:** the benchmark is
  keyless (real tiles put network variance inside a baseline); the canonical environment is a
  named developer machine, not a GitHub runner (~3x slower there, so before/after must happen on
  one machine); it **gates nothing** and lives in its own Playwright config so `npm run e2e` —
  and therefore CI — cannot pick it up; `npm run bench` stays the vitest shadow benchmark and the
  route one is **`npm run bench:route`**; and the detour sweep runs in Node against
  `paretoRoutes` rather than the browser, because `maxDetourFactor` is a `DijkstraOptions` field
  `useNavigation` never passes and exposing it would have been a production change.
- **Done — the G2 instrument, ahead of the benchmark itself (#182, #183).** G2 reads
  `window.__umbraMetrics.summary`, and that object could not state variance: `p95TotalMs` was
  an unconditionally mislabeled **maximum** — `MAX_HISTORY = 20` is the buffer's ceiling and
  `Math.min(Math.floor(N * 0.95), N - 1)` lands on the last element for every N from 1 to 20, so
  there was no reachable sample count at which it was a 95th percentile. It is now an
  interpolated percentile (R-7), there is a `p50TotalMs` beside it, and `clearMetrics` is on the
  window object so a multi-scenario bench can reset without reloading the page. The three reads
  are getters rather than snapshots, or a `summary` captured at record time would survive the
  reset and open scenario 2 on scenario 1's numbers. `metrics.ts` has its first tests — 14, pure
  Node, and the old percentile index fails one of them. Filed and deliberately not fixed here:
  **#256** (a dev-only block in the same file), which is stale as filed — the fields it says are
  unused are read by the `console.groupCollapsed`/`console.table` immediately below.
- **Done — G2.** `npm run bench:route` (`e2e/bench/**`, its own Playwright config) drives the
  G1 browser through 2-point and 5-point calculations, cache-cold and cache-warm, and reads the
  app's own `window.__umbraMetrics`. The baseline is committed in
  `docs/notes/performance-baseline.md` with the machine named, the variance stated and a zero
  retry budget. It is **on demand, never in CI** — `npm run e2e` ignores `e2e/bench/**`, so the
  separation from G3's gate is mechanical rather than a convention. Keyless only: real tiles
  would put network variance inside a baseline.
  - **The headline is not the total, it is the split.** Dijkstra is 3–18 ms of a ~3 s 2-point
    calculation; the canvas read is 1.1–2.2 s, a third to well over half of the whole thing.
    **A5's worker offload should be read against that** — the main-thread block is the
    readback, not the search.
  - **Warm is slower than cold**, in all six cold/warm comparisons (2-point 1.3–1.5x, 5-point
    1.8–2.0x). The graph cache works and saves ~15 ms against a several-hundred-ms rise in the
    canvas read. The per-run series is published so the level shift is visibly not a climb;
    *why* it shifts is an untested hypothesis and the note says so.
  - **Filed, not fixed: #259.** `canvasRead` was non-zero on **all 90 runs** across three
    sessions while `shadowFallbackShare` printed **0.0% on all 90** — `coverage()` sent every
    calculation down the `needsCanvas` path and the pixel sampler then answered no edges. Both
    halves are per-run output, not a median. Unverified against real MapTiler tiles, which is
    why it is a filing and not a fix.
  - **The reproducibility estimate is itself unstable.** Two sessions of three runs produced
    near-opposite orderings of which scenario reproduces best. Across-session spans land
    between ~2% and ~25% on every row, so **treat a before/after movement under ~25% as noise**
    on all four scenarios, or raise the repeat counts first. Do not quote a per-row figure.
  - **#243 folded in.** The `maxDetourFactor` sweep is published: 1.25 → 2.0 buys 5.8 pp of
    shadow for 61 pp of extra walking and triples search time. **The constant is unchanged** —
    #243 is `track-h` and H3 picks a value against the curve. The sweep runs in Node against
    `paretoRoutes` because `useNavigation` never passes the option, and varying it from the
    browser would have meant adding a production seam.
  - **Name collision settled:** `npm run bench` stays the vitest shadow-sampling benchmark;
    the route benchmark is `npm run bench:route`. **#254** should keep that split when it ports
    the vitest benchmark.
- **Filed by G2, none fixed:** **#259** (`track-a`, the canvas read above), **#264**
  (`track-a`, why warm is slower than cold — the cause is a hypothesis, not a result), and four
  against this track: **#261** the benchmark's variance definition has no test and its only
  drift guard never runs in CI; **#262** `MAX_HISTORY = 20` silently caps any benchmark at 20
  repeats; **#263** the repeat counts are too low to estimate the benchmark's own run-to-run
  span, which is what forces the ~25% noise floor above and blocks on #262; **#265** the
  Node-only sweep still pays for a full browser build; **#266** `benchCold` re-registers its
  network stubs each repeat. **#256 is stale as filed** — the fields it calls unused are read
  by the `console.table` below them — and carries a comment recommending it be closed as
  not-a-defect.
- **Next action:** **G3** — the bundle budget (#57). It is the smallest remaining item, it now
  has a committed table to check against, and it is where regression *gating* belongs; G2
  deliberately gates nothing. **G0** (routing-quality eval) remains the better filler task and
  can run concurrently.
- **Last verified:** 2026-09-09 on `feat/g2-route-benchmark`, **Node 24.21.0** — lint 0 errors /
  51 warnings (the known backlog, unchanged), typecheck 0, **564 tests in 49 files**, build 0
  (maplibre chunk unchanged), `npm run e2e` **both** projects green (`smoke` 18.2 s, `smoke-live`
  50.6 s against real MapTiler tiles — which is what proves the `metrics.ts` getter change is
  safe for the smoke test's `latest` read), and `npm run bench:route` run three times end to end,
  ~5.4 min each. Previously 2026-09-09 on `main` — lint 0 (51 warnings,
  the known backlog), typecheck 0, 550 tests in 48 files, coverage 0, build 0 (maplibre chunk
  954.47 kB / 257.76 kB gzip, unchanged from Node 20), and `npm run e2e` **both** projects
  green: `smoke` 16.9 s and `smoke-live` 44.3 s against real MapTiler tiles. Previously
  2026-09-08 on the #205 branch, four gates plus `smoke`, and the search path driven by hand
  against `npm run dev`: typing "brooklyn bridge" and pausing 3 s fires no geocode at all,
  Enter fires exactly one request to `/__nominatim?endpoint=search&…`, five matches render,
  and taking the top one recentres the map on its bounding box

---

## Why this track exists

**Until G1, nothing had ever executed this app in a browser automatically.** The vitest suite
runs in `environment: "node"`. G1's smoke test now covers shadow rendering, the timeline drag
and one end-to-end route calculation. Still covered by no check: the streaming route preview,
camera-free shadow probes, GeoTIFF export, the PWA shell (#35). The performance baseline (`docs/notes/performance-baseline.md`) says outright
that TTI and route-calc timings are missing because no browser binary was available.

With one agent making one PR at a time, that was survivable. With six tracks in parallel it
isn't: Track A will claim a worker made routing faster, Track B will claim guidance works,
Track D will claim a chart matches the map — and nothing can check any of it.

Second job: **the three contested files**. `useNavigation.ts` (1445 lines),
`MapView.tsx` (1377), `page.tsx` (932) are wanted by every track at once. Until they're split,
the cross-track compatibility matrix in `docs/tracks/README.md` is full of ⚠️.

## What already exists

- **CI** (`.github/workflows/ci.yml`): lint → typecheck → test → build, then the browser smoke
  test, on every PR and push to `main`. Still no secrets required — the build inlines missing
  `VITE_*` as `undefined`, the test suite is hermetic, and the smoke test's keyless project
  stubs every request it makes. **Keep it that way: fork PRs never receive secrets.**
- **Biome** (`biome.json`) — recommended set as errors, with `noNonNullAssertion`,
  `noExplicitAny`, `noApproximativeNumericConstant` off by design. **The a11y backlog is gone:**
  nine a11y rules are now `error` and pass. 52 warnings remain, led by `useExhaustiveDependencies`
  (17), `noArrayIndexKey` (11), `useOptionalChain` (6). Biome's diagnostic cap truncates what is
  *printed*, not the exit code — verified: an error behind the warning backlog still exits 1.
- **`window.__umbraMetrics`** (`app/lib/metrics.ts`) — phase timings (`graphFetch`,
  `canvasRead`, `shadowSample`, `dijkstra`, `total`), p50/p95 aggregates over the last 20 runs,
  three KPIs (route compute ms, shadow-coverage gain pp, path-length delta %), and `clearMetrics`
  to reset between scenarios. **The instrumentation for G2 already exists; only the harness that
  drives it is missing.**
- **The A3 agreement suite** (`app/lib/shadowField/__tests__/agreement/`) — the template every other
  eval-shaped checkpoint here should copy: a fixture corpus, a *scored* metric rather than a
  boolean, committed ceilings that only ever come down, and the number printed on every run so it
  is visible while passing. 150 cases, ~235 ms, pure Node.
- **`app/lib/routing.ts`** exports `paretoRoutes`, and `metrics.ts` exports `computeDerivedKpis`.
  Both are pure and already composed in production — which is what makes G0 cheap.
- **`app/lib/overpass.ts` cannot be imported outside a Vite build.** It reads
  `import.meta.env.DEV` at module scope (line 9), which is `undefined` in plain Node, so a
  Playwright spec or any Node-side harness that imports it throws on load. The Overpass *parser*
  lives inside `fetchRoutingGraph` and has no pure seam, so a Node harness that needs a
  `RoutingGraph` has to construct one — `e2e/fixtures/overpassGrid.ts:overpassGridGraph()` is
  the worked example. `routing.ts`, `shadowSampling.ts` and `app/lib/shadowField/**` are all env-free
  and import fine.
- **A multi-waypoint route is a different algorithm, not a longer one.** With `via` waypoints
  `useNavigation.ts:1263` leaves `paretoRoutes` entirely and runs a plain `dijkstra` per leg at
  several shadow strengths, returning a single route with no shadow-gain KPI. Any benchmark, eval
  or claim that says "routing" needs to say which of the two it measured.
- **A working browser, locally.** #121 says no Chromium runs here; that is stale for local work.
  The cached Playwright Chromium starts once `libnss3`, `libnspr4` and `libasound2` are
  side-loaded without sudo (`apt-get download` → `dpkg-deb -x` → `LD_LIBRARY_PATH`); verified
  2026-09-04 on Chromium 136. CI still needs its own setup — that is G1, not this note.
- **Dependabot** (`.github/dependabot.yml`) with the maplibre/suncalc pins encoded as `ignore`.
- `docs/notes/performance-baseline.md`, `docs/notes/touch-target-audit.md`.

## Hard invariants that bite this track

- **maplibre-gl pinned at 5.9.0** and **suncalc at 1.x** — Dependabot is configured to stop
  proposing them (#118). Any dependency work must preserve those ignores. #60 (unfreeze
  maplibre via `patch-package`) is a real option but it is a *proposal*, not a licence.
- CI must keep working **without secrets** for anyone without repo access.
- `MapView` only via `React.lazy` (invariant #4) — G6's split must not introduce a static import.

---

## Checkpoints

### G0 — Routing quality eval  *(added by #165)*
**Goal.** Nothing measures whether a shadow-aware route is *worth taking*. `metrics.ts` states
three KPI targets — route compute < 3 s, shadow-coverage gain > 10 pp, path-length overhead
< ~40% — and all three live only in comments. Make the two that are about quality fail.
**Approach.** The A3 agreement suite's shape, applied to routing, in pure Node. A fixture corpus
of synthetic street grids × sun positions; feed each to `paretoRoutes` with shadow from
`ShadowField`, then score the result with the `computeDerivedKpis` the app already uses — so the
eval measures the same numbers the product reports, not a parallel definition of them. Print the
aggregate every run the way `agreement.test.ts` does, and commit ceilings just above what the
corpus reports today.
**Acceptance.** `npm test` prints a routing-quality line; thresholds are enforced; a deliberate
cost-model regression trips them; adding a fixture is a data change, not a code change. Under a
second, no browser, no secret, no flake budget.
**Files.** `app/lib/__tests__/routeQuality/**`. **Size.** Small–Medium. **Coordinate with Track
A** — A owns the cost model and what the fixtures contain, G owns the harness and the reporting.
**Where it sits now.** #165 argued this belonged before G1; G1 has since landed, so the argument
that survives is the cheaper one — same kind of value as G2, at a fraction of the cost and none of
the flake risk, in pure Node with no browser and no secret. **G2 still outranks it** (A5, H and P
are all waiting on a committed route benchmark), but G0 is the better filler task and it
establishes the KPI discipline the benchmark will reuse.

### G1 — Browser smoke test ✅ **landed — but its CI path still waits on the secret**
**Goal.** One automated run that actually loads the app. Closes **#35**.
**Approach.** Playwright with a WebGL-capable Chromium (`--use-gl=angle --use-angle=swiftshader`
for headless WebGL2), `VITE_MAPTILER_API_KEY` as a repo secret, running against `vite preview`
on the built `dist/`. **One** test: load → shadow layer paints (assert canvas pixels contain
blue-dominant pixels using `isBlueDominantShadowPixel`'s own thresholds — reuse the predicate,
don't restate it) → drag the timeline → shadows change → calculate a two-point route → a route
line renders.
**Acceptance.** Green in CI on a PR; skipped-with-a-clear-message when the secret is absent, so
forks aren't broken; runtime under ~3 minutes; flake budget stated (retry once, then fail).
**Files.** `e2e/**` (new), `.github/workflows/ci.yml`, `playwright.config.ts`. **Size.** Large.
**Delivered against acceptance:** the skip path is green in real CI (notice printed, three steps
skipped) and the flake budget and runtime hold locally; "green in CI" for the *test* path is
outstanding until #173 adds the secret, and nothing here can close that from inside a PR.

### G2 — Route benchmark ✅ **landed**
**Goal.** Nobody may claim a perf win without a number. Unblocks **#37**, gates **A5**.
**Approach.** A scripted 2-point and 5-point calculation in the G1 browser, reading
`window.__umbraMetrics.summary`. Commit the baseline into
`docs/notes/performance-baseline.md` (it explicitly asks for exactly this). Fixed viewport,
fixed coordinates, fixed date/time, cache-warm and cache-cold variants.
**Acceptance.** Reproducible numbers with variance stated; baseline committed; a documented
command any track can run before/after its change.
**Files.** `e2e/bench/**`, `docs/notes/performance-baseline.md`. **Size.** Medium.
**Delivered against acceptance:** reproducible numbers with variance stated (p50/p95, a spread
figure, the raw per-run series printed, zero retries), the baseline committed with the machine
named, and `npm run bench:route` documented in the note. **Not delivered, deliberately:** TTI.
#37 asks for TTI *and* route-calc; G2's acceptance names route calculation only, and the note
now says TTI is outstanding rather than half-measuring it. **#243's sweep is in the same PR** —
same fixture, one parameter varied.

### G3 — Bundle budget ← **start here**
**Goal.** Stop silent regression of a 1.6 MiB `dist/` with a 953 kB maplibre chunk. Closes **#57**.
**Approach.** Per-chunk gzip ceilings checked in CI against the committed table in the perf
baseline; fail on regression beyond a stated tolerance.
**Acceptance.** CI fails on a deliberate regression test; the ceiling is documented with the
reason (4G, one-handed, outdoors).
**Files.** `.github/workflows/ci.yml`, a small check script. **Size.** Small.

### G4 — Shadow accuracy harness ✅ **delivered by Track A**
Track A built this while landing A3. `app/lib/shadowField/__tests__/agreement/` has the fixture format
(`fixtures.ts`), the runner and metric (`harness.ts`) and the enforced ceilings
(`agreement.test.ts`: mean 0.04, p90 0.05, severe share 0.04), it prints
`shadow-field agreement: …` on every run, and adding a city is a data change. That is G4's
acceptance, met.

**Residual scope, if any:** tracking the number *over time* rather than per-run — CI has no memory,
so a slow drift that never crosses a ceiling is invisible. Fold that into G2's baseline file rather
than reviving this as a checkpoint. **The division of labour stands and applies to G0 too:** Track
A owns what accuracy means; G owns how it is run and reported.

### G5 — A11y baseline
**Goal.** A number where there has never been one. Closes **#39**, plans **#40**.
**Approach.** axe-core in the G1 browser across the main screens; record the score.
**The Biome half of this is already done** — the five a11y PRs (#90, #92, #94, #96, #98) burned
the backlog down and the nine a11y rules are now `error` in `biome.json` and passing, so there is
no warning list left to group. What Biome cannot see is what remains: contrast in sunlight, focus
order, live-region announcements, and whether a control is reachable one-handed. That is the axe
run plus the judgement `docs/notes/touch-target-audit.md` and the `interface-reviewer` agent
already apply by hand.
For the assistant, the baseline must cover panel open/close, labelled composer, progress and
error announcements, cancellation, receipt traversal, plan completion, and focus return—not only
the page at rest. C15 owns fixes and the manual screen-reader/keyboard workflow; G5 owns the shared
axe/browser machinery and prevents regressions after C15 lands.
**Acceptance.** Score recorded in `docs/notes/`; CI reports it; the findings axe raises that Biome
structurally cannot are filed. After C15, the full agent journey has zero serious/critical axe
violations, and a deliberate missing label/live-region relationship makes CI fail. **Size.**
Medium (was sized when the burn-down was still open).

### G6 — Seam work ← **the unblocker; run it alone**
**Goal.** Stop six tracks from queueing on three files.
**Approach.**

| File | Lines | Split into |
|---|---:|---|
| `app/hooks/useNavigation.ts` | 1445 | `useRouting` (the calculate pipeline), `useTrip` (waypoints/legs/saved), `useSketch` |
| `app/components/MapView.tsx` | 1377 | per-feature layer modules registered by a small registry (route, sketch, transit, assistant pins, guidance) |
| `app/page.tsx` | 932 | stays a composition root; each track contributes one hook + one panel |

Pure refactor, no behavior change, one file per PR, tests green at every step.
**G6(a) recorded choice:** mode settings (`navMode`, `routeMode`, `travelMode`,
`shadowPreference`), `handleMapClick`/`handleClear`/`handleExportRoute`/
`handleCalculateRoute` and `canTransit` stay in the facade — each spans trip,
sketch and routing, and the facade IS that seam. `filteredRoutes` and the
selected-route derives live in `useRouting` (`routeMode` arrives as a value).
Trip↔routing construct in opposite orders, so trip reads routing back lazily
through `NavSeam` (event-time only); render-time values travel as explicit args.
**Acceptance.** No behavior change (the routing tests and `useNavigation.test.tsx` pass
unmodified); each track's future edits land in a file it owns; `MapView` still only imported via
`React.lazy`; the compatibility matrix in `docs/tracks/README.md` is updated to drop the ⚠️s
this removes.
**Files.** the three contested files. **Size.** Large ×3. **Announce before starting; other
tracks pause edits to these files while it's in flight.**

### G7 — Repo hygiene, batched
The p4 cluster, one PR each, taken *between* larger items and never instead of them:
~~**#52** LICENSE~~ ✅, ~~**#50** doc drift~~ ✅ (see the re-scope below),
~~**#53** `.env.example`~~ ✅, **#55** PR/issue templates + CODEOWNERS, **#48**
formatter repo-wide + `format:check` in CI, **#51** prune 27 stale branches, **#56**
CHANGELOG/tags, **#54** repo cruft, **#58** branch protection decision.

**⚠️ #50 is mostly stale — re-check it before working it (verified 2026-09-07).** It was filed
as four bullets and three have since been resolved a different way:
- *"root `CLAUDE.md` points at per-directory `CLAUDE.md` files that don't exist"* — **resolved
  by `.claude/rules/`.** The path-scoped rules replaced them, and root `CLAUDE.md` now says so
  explicitly. **Do not create those six files.** An earlier version of this brief called #50 the
  cluster's first priority and "a dependency of every track's session boot"; that is no longer
  true. `AUTONOMOUS_GOAL.md` §1 gap 7 and §5 step 3 still carry the old framing and should be
  corrected in the same PR.
- *"points at `tools/tailor/`"* — root `CLAUDE.md`'s repo map already marks it gone.
- *"`AGENTS.md` points at `docs/kb/INDEX.md`"* — `AGENTS.md` no longer exists.
- *"says env lives in `.env.local`; the repo uses `.env`"* — **resolved with #53.** Both files
  now say `.env` and point at the committed `.env.example`, and the README's last stale
  promise — a `CLAUDE.md` in every source directory — was replaced by the `.claude/rules/`
  line that is actually true. **That was #50's fourth and last live bullet, so #50 is closed.**

**Priority within the cluster: #52 (LICENSE) first** — it is what a public repo without one
looks wrong for, and Track P's public surface depends on it.

### G8 — Security and provider-policy baseline
**Done — the two provider-policy defects (#205).** Nominatim went behind `api/nominatim.js`
(dev: the Vite `/__nominatim` proxy), which is the only place a `User-Agent` can be set —
the header is [forbidden to `fetch`](https://fetch.spec.whatwg.org/#forbidden-header-name),
so the one three client files sent had never reached Nominatim or Overpass. Search moved to
explicit submit, because [the OSMF policy](https://operations.osmfoundation.org/policies/nominatim/)
lists autocomplete under unacceptable use. Invariant #6 now describes what the platform
actually permits, and `app/components/__tests__/providerPolicy.test.ts` plus component tests
in `SearchBar.test.tsx` / `WaypointInput.test.tsx` keep both halves from regressing.

**Done — #32 and #33.** MapTiler allowed HTTP origins are set in the dashboard; Foursquare
service keys carry no origin restriction at all, so that key moved server-side into
`api/fsq.js` (#218/#219). The vite/vitest advisories were cleared by #213.

**Done — the dependency-bump policy**, below. It is the rule set Dependabot's backlog is
triaged against, so a re-raised PR is closed against a written decision instead of a fresh
argument.

**Agent gateway follow-through belongs to C14, not a reopened G8.** G8's provider-policy and
dependency baseline does not prove production agent controls. C14 must replace client-selected
upstream payloads with a server-owned release/policy, add a privacy-minimized durable quota across
instances, capability and generation bounds, cancellation, versioned promotion, monitoring, and
rollback rehearsal. G verifies those controls in CI/security tests; C owns their semantics.

#### Dependency-bump policy

**1. Two pins are invariants, not preferences.** `maplibre-gl` is `ignore`d outright and
`suncalc` / `@types/suncalc` are `ignore`d for majors in `.github/dependabot.yml`, because
hard invariants #1 and #2 in root `CLAUDE.md` depend on the exact versions: maplibre 5.10+
changes `Texture.update` so the shadow simulator crashes WebGL2, and suncalc 2.x is an ESM
rewrite with named exports only that also installs a second copy alongside the simulator's
`^1.9.0` and skews solar math. **Dependabot's groups only cover minor and patch**, so without
those `ignore`s a major still arrives as its own PR — any dependency work must preserve them.

**2. `npm audit fix --force` must never be run on this repo.** It resolves the maplibre
advisory by installing 6.8.0, which breaks the shadow renderer — a silent product regression
in exchange for a green audit line. Fix advisories with a targeted `npm install pkg@version`
after checking the advisory actually reaches our code path.

**3. A major with no security driver is declined by default.** It is a deliberate change with
its own PR and its own verification, not triage. `typescript` 7.0.2 (#112) was closed on
exactly this ground — TS 7 is the compiler rewrite, and taking it because a bot offered it is
how a week disappears.

**4. A major blocked by the runtime is deferred to the runtime, not fought.** vitest 5 needs
Node `^22.12`, jsdom 30 needs `^22.22.2`, and `@types/node` 26 would describe Node 26 APIs to
`tsc` while CI runs Node 20 — so #140/#141/#142 were closed as one decision, not three.
**#215 (raise CI's Node) was the single unlock** — done, and it landed on **24**, not the 22 the
issue proposed, because production was already there. It came *after* Wave 0 and *before* G2 so
the benchmark's baseline is measured on the runtime it will keep. **Corollary the bump earned:**
check what the deploy platform actually runs before picking a version. CI had been verifying
Node 20 for a runtime that has never run this app.

**4b. A bump that breaks a *tool* is still a breaking change, even when every test passes.**
vitest 5 removes the `bench` API; the 550-test suite is green on it because `*.bench.ts` sits
outside the test glob on purpose. The gate that caught it was `tsc`, and the gate that would
have caught it later was a human running `npm run bench` during a performance claim. Split the
port from the bump (#254) rather than growing one PR into both.

**5. Security bumps are taken, and one PR may clear several.** #213 cleared the vite/vitest
advisories on Node 20 in one change, which is why #81, #82 and #139 were closed as superseded
rather than merged.

**6. Close a declined PR with the reason in the comment.** Dependabot re-raises; the point of
this list is that the decision is looked up, not re-derived.

**Files.** `docs/tracks/TRACK_G.md`.
**Size.** Small.
**Why it is worth doing properly:** reading a provider's terms and finding your own code in
violation is a professional instinct that is hard to fake and easy to verify — and *"our
politeness header was silently dropped the whole time"* is a genuinely good bug story.

---

## Subagent plan

- **G7 is the one place the "fire a swarm" pattern genuinely fits**: LICENSE, `.env.example`,
  PR templates, and the six `CLAUDE.md` files are fully independent files. Four to six builders,
  each in its own worktree, each opening its own small PR. Give each one the explicit file list.
- **G1 and G6 are strictly solo.** G1 is fiddly environment work; G6 rewrites shared files.
- **G0 is solo but small.** It is one new test directory touching no production file, so it can run
  concurrently with anything — including G1 — without a collision.
- **Scout** for environment questions ("what flags does headless Chromium need for WebGL2 in
  GitHub Actions in 2026?") — bounded, and the answer changes often enough to be worth checking
  rather than remembering.
- **Verifier on G6, mandatory.** A pure refactor that changed behavior is the worst outcome
  available here, and it's invisible in a green test suite that never covered the behavior.

## Risks

1. **Flaky browser tests are worse than none.** They train everyone to ignore CI. Budget for
   determinism: fixed viewport, fixed date, fixed coordinates, network stubbing where possible,
   one retry then fail.
2. **G6 changing behavior while claiming not to.** Mitigation: land G1/G2 *before* G6 so the
   refactor has something to prove itself against.
3. **Secret handling.** `VITE_MAPTILER_API_KEY` in CI must not leak into logs or fork PRs.
4. **Hygiene as procrastination.** G7 is satisfying and low-risk, which makes it the easiest
   way to spend a week without moving the product. One PR at a time, between real work.
5. **A synthetic corpus only ever tells you about itself.** G0's grids and A3's three cities are
   regular by construction, which is what isolates the thing being measured — and also why a green
   number is not evidence about real Manhattan geometry. Treat these as regression detectors, not
   as proof of accuracy, and say which one you mean when quoting a number.
6. **Thresholds drifting upward.** A ceiling raised to make a failure go away converts an eval into
   decoration. A3 already states the rule — they come down as the product improves, and raising one
   is a product decision, not a fix. G0 inherits it.
7. **What none of this covers.** Every checkpoint here measures something countable. Whether a
   shadow reads clearly in bright sun, or a route is legible on a phone held one-handed, stays a
   human judgement — `interface-reviewer` and the touch-target audit are the answer, and no green
   number should be allowed to imply otherwise.

## Out of scope / hand-offs

- What accuracy *means* → **Track A** (G runs the harness, A defines the fixtures).
- Feature work of any kind. If a G checkpoint needs a feature to test, stub it or test what exists.

# Umbra — Agent Guide (canonical entry)

Umbra is a personal open-source shadowed-route navigation project. It is an independent personal project.
Browser-based sun-shadow simulation with shadow-aware pedestrian + transit routing.
React 19 + Vite 5 + TypeScript + Tailwind v4 + MapLibre GL. Everything runs client-side
except four thin serverless proxies (`api/fsq.js`, `api/agent.js`, `api/overpass.js`,
`api/nominatim.js`).
Deployed: https://shademapnav.vercel.app

**Read order (keep context small):** this file → the "Where to edit what" table → the file.
**Choosing *what* to work on is a different question:** `docs/ROADMAP.md` is the golden
roadmap — every track's checkpoints plus the `docs/research/` findings, merged into one
Now/Next/Later checklist with the reason each item exists. Read it before starting new work,
not before editing a file.
The per-area constraints load themselves: `.claude/rules/` is path-scoped, so opening
`app/lib/routing.ts` pulls in the routing rule and nothing else. Don't go looking for
per-directory `CLAUDE.md` files — that's what the rules replaced. See `.claude/README.md`
for the whole agent setup.

## Commands

```bash
npm install
npm run dev        # Vite dev server → http://localhost:5173
npm test           # vitest run — app/{lib,services,hooks,components}/__tests__/**
npm run typecheck  # tsc --noEmit
npm run lint       # biome lint — blocks on errors, ~80 known findings are "warn"
npm run format     # biome format --write (never yet run repo-wide; see biome.json)
npm run build      # vite build → dist/
npm run e2e        # playwright test — one browser smoke test; no API key needed
```

`npm run e2e` needs its browser installed once: `npx playwright install --with-deps chromium`
(CI does this itself). Without sudo — WSL, say — Chromium fails to start on missing `libnss3`
and friends; every one of them ships inside the miniconda install already on this machine, so
`LD_LIBRARY_PATH=$HOME/miniconda3/lib npx playwright test` is enough, and MapLibre's WebGL2
renders on SwiftShader. See `docs/notes/browser-verification.md`.

It runs two projects. `smoke` serves a synthetic basemap style whose `maptiler_planet` geojson
source carries the building footprints (`e2e/fixtures/basemapStyle.ts`), so it needs no key and
runs on every PR, forks included. `smoke-live` repeats the same assertions against real MapTiler
tiles and appears only when `VITE_MAPTILER_API_KEY` is set — it is the only check that the app
still parses MapTiler's real `building` schema.

Lint config is `biome.json` (Biome replaced ESLint, whose config had zero rules and
matched zero `.ts` files). Rules the codebase intentionally violates — `noNonNullAssertion`
(`routing.ts` leans on `!`), `noExplicitAny` (maplibre interop), `noApproximativeNumericConstant`
(solar constants) — are `off`. Large real backlogs (a11y, `useExhaustiveDependencies`)
are `warn` so they surface without blocking. Everything else in Biome's recommended set
is an error and will fail CI.

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on every PR to
`main` and every push to `main`, then the browser smoke test. It needs no secrets: the
build inlines missing `VITE_*` vars as `undefined`, the test suite is hermetic (no
network, no env), and the smoke test's `smoke` project stubs every request it makes.

Env (`.env` — copy `.env.example`): `VITE_MAPTILER_API_KEY` (required), `VITE_FOURSQUARE_API_KEY`
(place popups — **dev only**; production reads server-only `FSQ_API_KEY` inside `api/fsq.js`
and the browser sends no Foursquare credential at all. Foursquare service keys support no
origin restriction, so the key must not reach the bundle; the `import.meta.env.DEV` guard in
`foursquare.ts` is what keeps it out).

AI assistant (Umbra Assistant, `app/lib/agent/`): **Google Gemini free tier only** (Cerebras was
dropped on 2026-09-11, #301). Dev reads `VITE_GEMINI_API_KEY` through the Vite `/__gemini` proxy;
prod reads server-only `GEMINI_API_KEY` in `api/agent.js`. Both take a comma-separated key pool.
`npm run eval:agent` replays the scenarios against the real model. Everything else — per-role
models, determinism, grounding, the Gemini quirks — is in `.claude/rules/agent-loop.md`, which
loads when you open the agent code.

## Hard invariants (breaking any of these breaks the app)

The mechanical ones are **enforced**, not merely requested: `.claude/hooks/guard-invariants.sh`
runs on every `Edit`/`Write` and denies the edit. #5 escalates to a prompt instead, because it
is a judgment call. A hook denial is not an obstacle to route around with `sed` — it means the
approach needs to change.

1. *(Retired.)* `maplibre-gl` was pinned at exactly `5.9.0` for
   `mapbox-gl-shadow-simulator`, which crashed on 5.10+. Nothing imported the simulator any
   more, so the pin and the package went with the move to MapLibre 6. The number is kept so
   the invariants below keep theirs.
2. **`suncalc` and `earcut` stay declared direct `dependencies`.** The shadow code imports
   them directly (`LocalShadowAdapter.ts`, `offscreenShadow.ts`, `sunPosition.worker.ts` for
   suncalc; `shadowField/geometry.ts`, `shadowField/shadowIndex.ts` for earcut), alongside
   `@types/suncalc` / `@types/earcut`. earcut also arrives transitively via `maplibre-gl`, but
   dropping either back to a transitive-only dep re-breaks both the build and `tsc`.
   **`suncalc` also stays on `1.x`.** 2.x is an ESM rewrite exporting only named
   functions, so the `import SunCalc from "suncalc"` in `sunPosition.worker.ts`,
   `LocalShadowAdapter.ts`, and `offscreenShadow.ts` fails the Vite/rollup build
   ("default is not exported by node_modules/suncalc/index.js"). The suncalc major is held
   back in `.github/dependabot.yml`.
3. **Map must keep `canvasContextAttributes: { preserveDrawingBuffer: true }`** —
   shadow sampling and GeoTIFF export read the canvas back.
4. **`MapView` is only imported via `React.lazy`** in `app/page.tsx` (code-splits MapLibre).
   Never import it statically from app code (type-only imports are fine).
5. **Shadow detection couples to shadow color.** Routing and assistant spot checks decide
   "shadowed" with the shared `isBlueDominantShadowPixel` predicate:
   `r + g + b < 600 && b - ((r + g) / 2) > 18 && b > ((r + g) / 2) * 1.15`.
   The shadow colors in `LocalShadowAdapter.ts` must stay blue-dominant enough to
   satisfy that predicate after compositing over the basemap.
6. **Nominatim and Overpass requests need a `User-Agent` header — and only a server
   can send one.** `User-Agent` is a
   [forbidden header name](https://fetch.spec.whatwg.org/#forbidden-header-name): the
   browser drops it from `fetch` silently, so client code that sets it looks compliant
   and is not. Both services are reached through same-origin proxies that set it
   server-side — `api/nominatim.js` and `api/overpass.js` in production, the
   `/__nominatim` and `/__overpass` Vite proxies in dev. No code under `app/` may set the
   header or name `nominatim.openstreetmap.org` outside a comment;
   `app/components/__tests__/providerPolicy.test.ts` fails if either reappears, and the
   `PreToolUse` hook denies both — plus stripping the header back out of a proxy. The same
   OSMF policy forbids **autocomplete**, so no geocode may fire from a keystroke handler
   — search runs on an explicit submit.
7. **Never read or edit `.worktrees/`** — an orphaned, stale checkout (gitignored, not a
   registered worktree). Same for any `oldbuild/` copy you encounter.

## Repo map

| Path | What lives there | Read before editing |
|---|---|---|
| `app/page.tsx` | Root component: composes hooks + layout; owns only small UI state | `.claude/rules/components-and-map.md` |
| `app/main.tsx` | Entry; BrowserRouter (`/`, `/about`) | — |
| `app/hooks/` | All real state: `useShadowTime`, `useNavigation` facade over `useTrip`/`useSketch`/`useRouting`, `useAppState` (phase FSM) | `.claude/rules/hooks-and-state.md` |
| `app/components/` | UI components incl. `MapView` (map + layers) | `.claude/rules/components-and-map.md` |
| `app/lib/` | Pure TS: routing, overpass, trainGraph, shadow sampling, exports | `.claude/rules/routing-and-shadow.md` |
| `app/lib/shadow/` | Local WebGL shadow renderer (CustomLayerInterface) | `.claude/rules/shadow-renderer.md` |
| `app/services/` | Third-party API wrappers (Foursquare) | `.claude/rules/external-apis.md` |
| `app/workers/` | `sunPosition.worker.ts` — sun-position worker used by the shadow renderer (Vite `?worker` import) | `.claude/rules/shadow-renderer.md` |
| `api/` | Vercel serverless proxies: Foursquare (`fsq.js`, server-side key + prod CORS), Gemini (`agent.js`, server-side key pool + model allowlist), Overpass (`overpass.js`), Nominatim (`nominatim.js`, server-side `User-Agent`) | `.claude/rules/external-apis.md` |
| `.claude/` | Agent config: enforced invariants (hooks), path-scoped rules, agents, skills | `.claude/README.md` |

## Where to edit what

| Task | Edit points |
|---|---|
| Shadow rendering (look, correctness, perf) | `app/lib/shadow/LocalShadowAdapter.ts` |
| Timeline slider, play/pause, date/time input | `app/components/TimelineSlider.tsx`, `app/hooks/useShadowTime.ts` |
| Walking-route algorithm, cost model, Pareto | `app/lib/routing.ts` (+ `__tests__/routing.test.ts`) |
| Route UX: waypoints, calc flow, cards, save/export | `app/hooks/useTrip.ts` (trip state), `app/hooks/useRouting.ts` (pipeline), `app/components/DirectionsPanel.tsx` (`useNavigation.ts` stays a thin facade — see `.claude/rules/hooks-and-state.md`) |
| Sketch / draw-route mode | `app/hooks/useSketch.ts` (`calculateSketchRoute`), `MapView.tsx` (sketch layers) |
| Train/transit routing | `app/lib/trainGraph.ts`, `app/hooks/useRouting.ts` (`calculateRoute`) |
| Search, geocoding, place details | `app/components/SearchBar.tsx`, `app/services/foursquare.ts` |
| Map layers, markers, popups, 3D | `app/components/MapView.tsx` (read `.claude/rules/components-and-map.md` first) |
| Sun-exposure mode, GeoTIFF export | `app/components/AccumulationPanel.tsx` |
| Screen flow / app phases | `app/hooks/useAppState.ts`, `app/page.tsx` |
| Layout, sidebar, bottom sheet, responsive | `app/components/AppShell.tsx`, `app/page.tsx` |
| Build, deploy, env, proxies | `vite.config.ts`, `vercel.json`, `api/` |

## State model (30 seconds)

`page.tsx` composes three hooks and passes props down — components hold no app state:
- `useShadowTime` — date/time, slider mode, play animation, map center/zoom/UTC offset, `mapRef`
- `useNavigation` — thin facade over `useTrip` (waypoints/legs/saved), `useSketch`
  (draw mode + sketch pipeline) and `useRouting` (route-calculation pipeline);
  owns only mode settings and cross-group handlers, returns the same object as before
- `useAppState` — UI phase FSM: `IDLE → PLACE_DETAIL → DIRECTIONS → NAVIGATING → ARRIVAL`

Map instance flows up once via `onMapReady(map)` into a ref (never state).

## Verification

- Run `/gates` — all four, in order, with the real output. It records the result that the
  `Stop` hook and the status line read, so the session cannot end on an unearned "tests pass".
- UI/map changes: also verify in `npm run dev` (shadows render, slider drags, route
  calculates). `npm test` never opens a browser; the only automated browser run is
  `npm run e2e`, one smoke test that loads the built app, checks shadows paint and retime,
  and calculates a route. It runs in CI on every PR. It covers that path and nothing else, so
  if you can't look, say the check is outstanding rather than letting green gates imply it.
- Before a PR opens: `/checkpoint` walks the definition of done and gets a cold review from
  the `verifier` agent.

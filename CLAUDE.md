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
npm run lint       # biome lint — blocks on errors, ~180 known findings are "warn"
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
`foursquare.ts` is what keeps it out). `VITE_SHADEMAP_API_KEY` / `VITE_TRANSITLAND_API_KEY` are vestigial — unused.

AI assistant (Umbra Assistant, `app/lib/agent/`): uses a **free** LLM — **Google Gemini
only**, free tier, through its OpenAI-compatible endpoint (Cerebras was dropped on 2026-09-11:
every key 402'd, #301). Key: https://aistudio.google.com/apikey. dev `VITE_GEMINI_API_KEY`
(via the Vite `/__gemini` proxy); prod `GEMINI_API_KEY` (server-only, via `api/agent.js`).
- **One shared key pool.** List every key comma-separated in `VITE_GEMINI_API_KEY` (and/or
  numbered `_1/_2/_3` dev, `_1.._9` prod) — the client (dev) and `api/agent.js` (prod)
  round-robin across the pool and fail over to the next key on 429/5xx and on 401/403, so a
  dead key never ends a turn. Each key brings its own free quota. All roles draw the one pool.
- **Per-role model (not key):** the loop does its tool-use research with the "research" model,
  then writes the final answer with the "response" model. `VITE_GEMINI_RESEARCH_MODEL`
  (default `gemini-3.5-flash-lite`) / `VITE_GEMINI_RESPONSE_MODEL` (default
  `gemini-3.1-flash-lite` — it grounded 25/25 live; `gemini-3.6-flash` took 29 s a call); base
  override `VITE_GEMINI_MODEL`. If both resolve to the same model,
  `rolesShareConfig()` makes the loop skip the separate write call (the research answer IS the
  answer). Prod accepts only the models in `api/agent.js`'s allowlist (+ `GEMINI_ALLOWED_MODELS`).
- **Two Gemini quirks live in `llmClient.ts`:** the endpoint rejects `seed`, and Gemini 3
  attaches a thought signature (`extra_content`) to every tool call that must be sent back
  verbatim — the IR carries it as `functionCall.extra`. Drop it and every second tool step 400s.
The loop is tuned for determinism: temperature 0, `parallel_tool_calls: false`,
`MAX_STEPS` 8 (the happy path needs ~5 tool turns through plot_points — a lower cap strands the
loop before pins reach the map), and a tightly-scoped system prompt (shadow-day-planning only).
**Determinism by pre-injection:** `get_current_context` is NOT a tool — the map center / local
time / location-known status is plain app state, so `agentLoop.ts` reads it once per turn (via
the still-present `executeTool("get_current_context")` executor) and appends it to the system
prompt, saving a guaranteed LLM round-trip. The final write call uses a separate, tool-free
system prompt so a reasoning response model never narrates uncallable tools into the answer.
The agent loop runs client-side (it orchestrates tools needing the live map canvas:
geocoding, the solar model, on-canvas shadow sampling, time/camera, the routing pipeline).
The loop speaks one neutral IR (`LlmContent`/`LlmPart`); `llmClient.ts` translates it to/from
the OpenAI chat-completions shape Gemini's compatible endpoint expects. `npm run eval:agent`
replays the C1 scenarios against the real model (see `docs/notes/agent-live-eval-2026-09-11.md`).

## Hard invariants (breaking any of these breaks the app)

The mechanical ones are **enforced**, not merely requested: `.claude/hooks/guard-invariants.sh`
runs on every `Edit`/`Write` and denies the edit. #5 escalates to a prompt instead, because it
is a judgment call. A hook denial is not an obstacle to route around with `sed` — it means the
approach needs to change.

1. **`maplibre-gl` stays pinned at exactly `5.9.0`.** v5.10+ changes `Texture.update`
   so `mapbox-gl-shadow-simulator`'s `{width,height}` call crashes WebGL2
   ("Overload resolution failed").
2. **`LocalShadowAdapter.ts` directly imports `suncalc` and `earcut`.** Both arrive
   transitively too (via `mapbox-gl-shadow-simulator` and `maplibre-gl`), but PR #10
   pinned them as direct `dependencies` alongside `@types/suncalc` / `@types/earcut`,
   so the import is typed and survives a provider-package swap. Keep them declared —
   dropping either back to a transitive-only dep re-breaks both the build and `tsc`.
   **`suncalc` also stays on `1.x`.** 2.x is an ESM rewrite exporting only named
   functions, so the `import SunCalc from "suncalc"` in `sunPosition.worker.ts`,
   `LocalShadowAdapter.ts`, and `offscreenShadow.ts` fails the Vite/rollup build
   ("default is not exported by node_modules/suncalc/index.js"). Independently,
   `mapbox-gl-shadow-simulator` depends on `suncalc ^1.9.0`, so bumping ours to 2.x
   installs a *second* copy and skews solar math between our sampling and the
   renderer. Both this and the maplibre pin are enforced in `.github/dependabot.yml`.
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
| ~~`tools/tailor/`~~ | Gone. The resume-tailor CLI was spec'd but never built; its leftover `@anthropic-ai/sdk`/`openai`/`commander` deps were dropped. `zod` is still declared but unimported. | — |

## Where to edit what

| Task domain | Read | Edit points |
|---|---|---|
| Shadow rendering (look, correctness, perf) | `app/lib/shadow/LocalShadowAdapter.ts` |
| Timeline slider, play/pause, date/time input | `app/components/TimelineSlider.tsx`, `app/hooks/useShadowTime.ts` |
| Walking-route algorithm, cost model, Pareto | `app/lib/routing.ts` (+ `__tests__/routing.test.ts`) |
| Route UX: waypoints, calc flow, cards, save/export | `app/hooks/useTrip.ts` (trip state), `app/hooks/useRouting.ts` (pipeline), `app/components/DirectionsPanel.tsx` (`useNavigation.ts` stays a thin facade — see `.claude/rules/hooks-and-state.md`) |
| Sketch / draw-route mode | `app/hooks/useSketch.ts` (`calculateSketchRoute`), `MapView.tsx` (sketch layers) |
| Train/transit routing | `app/lib/trainGraph.ts`, `app/hooks/useRouting.ts` (`calculateRoute`) |
| Search, geocoding, place details | `app/components/SearchBar.tsx`, `app/services/foursquare.ts` |
| Map layers, markers, popups, 3D | `.claude/rules/components-and-map.md` | `app/components/MapView.tsx` |
| Sun-exposure mode, GeoTIFF export | `app/components/AccumulationPanel.tsx` |
| Screen flow / app phases |  `app/hooks/useAppState.ts`, `app/page.tsx` |
| Layout, sidebar, bottom sheet, responsive |  `app/components/AppShell.tsx`, `app/page.tsx` |
| Build, deploy, env, proxies | `vite.config.ts`, `vercel.json`, `api/fsq.js` |

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

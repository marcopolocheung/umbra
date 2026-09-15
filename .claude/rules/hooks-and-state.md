---
paths:
  - "app/hooks/**"
---

# Hooks — where all the state actually lives

Four hooks, three of which are the app's entire state model:

- **`useShadowTime`** — date/time, slider mode, play animation, map centre/zoom/UTC offset,
  and `mapRef`
- **`useNavigation`** — thin facade over the three hooks below; owns only mode
  settings (`navMode`, `routeMode`, `travelMode`, `shadowPreference`), the
  cross-group handlers (`handleMapClick`, `handleClear`, `handleExportRoute`,
  `handleCalculateRoute`), `canTransit`, and the return-object contract
  (`useNavigationKeys.test.ts` pins its key set — never add, remove or rename
  a key without updating page.tsx, useAgent and that test together)
- **`useTrip`** (`app/hooks/useTrip.ts`) — waypoints A/B + labels, via stops,
  pending slot, user location, saved routes, and their handlers
- **`useSketch`** (`app/hooks/useSketch.ts`) — sketch points, draw mode, and
  the sketch route pipeline
- **`useRouting`** (`app/hooks/useRouting.ts`) — calculated routes, the
  route-calculation pipeline, the camera flatten/restore pair, and the C4/C5
  agent plumbing (plan revisions, route-plan jobs, receipts)
- Pure module-level helpers live in `app/lib/navigationHelpers.ts`
- **`useAppState`** — the UI phase machine: `IDLE → PLACE_DETAIL → DIRECTIONS → NAVIGATING →
  ARRIVAL`
- **`useAgent`** — the assistant's client-side loop wiring

`page.tsx` composes them and passes props down. Components hold no app state. If a component
needs to *set* something, it gets a callback from here — it does not grow its own copy.

## The map ref is a ref

The map instance arrives once via `onMapReady(map)` and lives in a ref, never in state.
Putting it in state re-renders the whole tree on every map event.

## useNavigation is split; MapView and page are still contested

`useNavigation.ts` is now a ~490-line facade over `useTrip` / `useSketch` /
`useRouting`, wired through explicit args plus one event-time seam (`NavSeam`
in `useRouting.ts` — both pipelines share a generation counter, so neither
side may take the other as a construction arg; reads through the seam are
event-time only). Keep changes narrow, and never delegate an edit to the
facade wiring or to `useRouting`'s pipeline to a subagent — concurrent edits
do not merge, and the routing pipeline is where a plausible wrong change does
the most damage. `MapView.tsx` and `page.tsx` are still contested (G6b/c).

Its phase transitions and the `useAppState` machine must stay consistent: a route that
calculates but leaves the phase in `DIRECTIONS`, or an `ARRIVAL` reachable only by a button
tap, are the kind of gap that looks fine in a diff and is obvious in use.

## Tests

Logic changes here need tests — `app/hooks/__tests__/` already covers `useAppState` and
`useNavigation`. The suite runs in `environment: "node"`, so hook tests exercise logic, not
rendering. Test the state transitions and the pipeline's decisions, not React internals.

`useExhaustiveDependencies` is `warn`-level, deliberately: the backlog is real and surfaces
without blocking CI. That is not permission to add new violations — a missing dependency in a
hook that drives the map produces a stale closure holding a dead map instance.

## Async and lifecycle

Route calculation, geocoding and shadow sampling are all async and all cancellable in practice
— the user moves the map, changes the time, or picks a different destination mid-flight. Make
sure an in-flight result that arrives late cannot overwrite newer state. Geolocation is
one-shot `getCurrentPosition` today; `watchPosition` appears nowhere in `app/` yet.

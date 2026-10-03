# Street names on the routing graph (B2)

**2026-10-03.** B2 keeps OSM `name=*` on every **Overpass** routing edge and
threads it into `Maneuver.streetName`, so guidance can name the street ("turn
right onto Via Roma") instead of only a bearing.

## What changed

- `GraphEdge` gains `name?: string` (`app/lib/routing.ts`).
- `overpass.ts` copies `way.tags.name` into the edge tags — the same pattern that
  already preserves `highway`/`surface`/`cycleway`/`bicycle`/`foot`. Set on both
  directions.
- `streetNamesAlong(graph, nodeIds)` turns a node path into a per-segment name
  list from the graph's edges; `generateManeuvers(nodes, legIndex, names?)` sets
  each maneuver's `streetName` to the street the walker **proceeds along** (the
  one turned onto), not the one left. Omit `names` and maneuvers carry no name,
  as before.

## The memory measurement

The checkpoint asks for the extra string's memory cost to be **measured, not
guessed**, because dense-city graphs are large. The baseline matters: on `main`
the edge object has **no `name` key at all**, so B2 adds one property slot to
every edge, named or not.

Measured with `node --expose-gc`, each shape in its own process, building 400,000
edges exactly as `buildRoutingGraphFromElements` does (an `edgeTags` object
literal spread into the edge) over ways sharing 2,000 street-name strings, with
the edge array held live across the final GC:

| shape | bytes/edge (Node 20.20 / 24.20) |
|---|---|
| `main` (no `name` key) | 142.9 / 143.1 |
| B2 (`name` key) | 166.8 / 167.1 |

**B2 costs 24 bytes per edge, about 9.6 MB per 400,000 edges** — stable across
three runs on Node 20 and two on Node 24. It is one more in-object property on
every edge, named or not. The number depends on how the edge is built: a harness
that adds the key differently (e.g. `Object.assign` after a partial literal) can
land both shapes in the same V8 size class and read ~0, and a harness that lets
the array be collected before reading `heapUsed` also reads ~0. An earlier draft
of this note reported ~0 and then "~1 to ~29 bytes, noisy"; both came from such
harness artefacts, and are corrected here.

The shared strings themselves are negligible: 2,000 unique names beside 400,000
edges. The cost is the slot, and unnamed edges pay it too.

## What this does not claim

- **Overpass graph only.** The static NYC routing path
  (`app/lib/navigationData/`) does not carry `name` — its shard contract and
  adapter drop all tags — so NYC routes get no names until that path is
  extended (#255). The sketch path's `cloneRoutingGraph` in `app/lib/navigationHelpers.ts` also drops
  tags (pre-existing); the `cloneRoutingGraph` in `overpass.ts` copies whole edges and keeps `name`.
- It measures the **edge** cost, not the whole graph build.
- It does not wire `name` into the UI — B2 threads it into the maneuver; naming
  the street on screen is B6's instruction surface.

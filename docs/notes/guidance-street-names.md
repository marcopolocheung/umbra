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

Measured with `node --expose-gc`, building 400,000 edges with 2,000 shared
street-name strings, comparing the `main` edge shape against the B2 shape:

| method | Δ bytes/edge |
|---|---|
| each shape in its own process, `heapUsed` after GC | ~1 |
| both shapes in one process, forced GC between, repeated | ~24–29 |

Heap measurement at this scale is noisy — V8 rounds object sizes to 8-byte
classes, so the extra slot may or may not bump the class, and the two figures
disagree by an order of magnitude. The honest reading: **it is one reference
slot per edge, single-digit to low-tens of bytes, ≲12 MB per 400,000 edges in
the worst run** — not literally free. The earlier draft of this note claimed
"~0 bytes/edge" from a measurement that held the object shape constant (it
compared `name: ""` against a real name, both already B2-shaped); that baseline
was wrong and the claim is corrected here.

The shared strings themselves are negligible: 2,000 unique names beside 400,000
edges. The cost is the slot, and unnamed edges pay it too.

## What this does not claim

- **Overpass graph only.** The static NYC routing path
  (`app/lib/navigationData/`) does not carry `name` — its shard contract and
  adapter drop all tags — so NYC routes get no names until that path is
  extended. Filed separately. `cloneRoutingGraph` also drops tags (pre-existing).
- It measures the **edge** cost, not the whole graph build.
- It does not wire `name` into the UI — B2 threads it into the maneuver; naming
  the street on screen is B6's instruction surface.

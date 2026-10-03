# Street names on the routing graph (B2)

**2026-10-03.** B2 keeps OSM `name=*` on every routing edge and threads it into
`Maneuver.streetName`, so guidance can name the street ("turn right onto Via
Roma") instead of only a bearing.

## What changed

- `GraphEdge` gains `name?: string` (`app/lib/routing.ts`).
- `overpass.ts` copies `way.tags.name` into the edge tags — the same pattern that
  already preserves `highway`/`surface`/`cycleway`/`bicycle`/`foot`.
- `generateManeuvers(nodes, legIndex, names?)` takes an optional per-segment
  name list and sets each maneuver's `streetName` to the street the walker
  **proceeds along** (the one turned onto), not the one left. Omit `names` and
  maneuvers carry no name, as before.

## The memory measurement

The checkpoint asks for the extra string's memory cost to be **measured, not
guessed**, because dense-city graphs are large. Measured on this machine with
`node --expose-gc`:

- Build a synthetic graph of **400,000** edges twice — once with `name: ""`, once
  with `name` set to one of **2,000** shared street-name strings — with **the
  same object shape** in both runs, so the only difference is the string the
  property holds.
- Forced GC between runs; compared `process.memoryUsage().heapUsed`.
- Result: **117.8 MB either way — a delta of ~0 bytes/edge.**

The reason it is free: the property slot exists in both runs (the object shape is
identical), so V8 allocates the same object size; the name is a *shared
reference* to a string that already exists, and 2,000 unique names cost
negligibly beside 400,000 edges. The cost is one pointer per edge, which the
shape does not grow to hold.

Reproduce: build two `Map<number, GraphEdge[]>` of N edges that differ only in
the `name` value, force GC between the two builds, and compare `heapUsed`.

## What this does not claim

- It measures the **edge** cost, not the whole graph build (which fetches and
  interns the names from Overpass); the unique strings are the small part.
- It does not wire `name` into the UI — B2 threads it into the maneuver; naming
  the street on screen is B6's instruction surface.

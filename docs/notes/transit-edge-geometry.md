# Per-edge transit geometry — is it buildable, and what does the straight chord cost?

**Measured 2026-09-17** over all seven NYC GTFS feeds the pipeline builds from, with
`docs/notes/scripts/transit-edge-geometry.py` (stdlib only, no repo dependency):

```sh
python3 docs/notes/scripts/transit-edge-geometry.py ~/shade-prep-data-nyc-transit/gtfs_subway
```

This note is the evidence behind **item F** in `docs/handoffs/TRANSIT_NEXT.md`. It answers four
questions, and the fourth is the one that decides the wire format.

---

## Why this was measured at all

`buildTrainDrawData` (`app/lib/trainGraph.ts:1261`) draws each ride as a straight chord between
two stop coordinates, because the shards ship no route geometry — a deliberate decision in #385.
That PR justified stop-to-stop on **length**: straight-line came to 93% of the true street path
on the four Brooklyn routes it could check, "uniform, explainable and close enough."

Length was the wrong statistic. A chord can have almost exactly the right length and still run
down the wrong streets, and what a rider sees — and what any future sampler along the drawn line
would read — is *where* the line is, not how long it is.

## 1. Does an edge slice cleanly out of its shape?

Yes, essentially always. **`shape_dist_traveled` is absent from every one of the seven feeds**, in
both `shapes.txt` and `stop_times.txt`, so the GTFS "best case" (slice by published distance) does
not apply and it has to be done by projection. That costs nothing here, because MTA's shape points
run through the stops:

| feed | directed edges | stop→shape snap, median | p95 | max | edges that would not slice |
|---|---|---|---|---|---|
| `gtfs_subway` | 2,084 | **0.0 m** | 0.0 m | 103.3 m | 0 |
| `gtfs_m` | 2,781 | 8.1 m | 13.4 m | 20.7 m | 3 |
| `gtfs_bx` | 2,735 | 7.1 m | 11.8 m | 16.3 m | 4 |
| `gtfs_q` | 2,053 | 7.3 m | 10.9 m | 17.5 m | 6 |
| `gtfs_si` | 4,639 | 8.4 m | 13.5 m | 24.3 m | 1 |
| `gtfs_busco` | 4,459 | 8.8 m | 13.8 m | 23.2 m | 6 |
| `gtfs_b` | 5,603 | 7.3 m | 11.6 m | 18.7 m | 12 |

**24,354 edges, 32 failures (0.13%).** Subway shape points coincide with the stop coordinates
exactly; bus shapes are the street centreline and a stop sits ~8 m off it at the kerb, which is
itself worth knowing (see *Limitations*).

The 32 are edges whose second stop projects **before** the first along the shape — a shape that
loops or doubles back past the same point. They need a stated fallback, not a fix: **keep the
straight chord for an edge that does not slice monotonically.** Absence is not a licence to guess,
the same precedent as `changeSec` (#384) and `structure` (#411).

## 2. Do the several shapes serving one edge agree?

**Yes — and this is the finding that makes per-edge geometry possible at all.**

Most edges are served by more than one shape: 74.9% on subway, 38.9–59.0% across the bus feeds.
That looks like #385's pattern problem surviving the move to per-edge, because it is the same
fact — the A train has 12 shapes in direction 0, the 5 has 21.

It does not survive. Over 250 sampled multi-shape edges per feed, the **sliced length was
identical across every shape serving that edge**: median spread 0.0 m in all seven feeds, worst
single case 0.3 m, and zero edges anywhere above 50 m.

So the ambiguity #385 measured is a **route-level** ambiguity, created by picking one
representative shape per `route:direction` and making it stand for every trip. Between two
*adjacent stops*, every pattern runs the same track. Per-edge geometry is well defined, and it
does not inherit the defect that killed per-route geometry.

## 3. What does the straight chord actually cost?

Length is fine. **Path is not.**

| feed | straight ÷ track length, median | lateral deviation median | p90 | >100 m | >200 m | max |
|---|---|---|---|---|---|---|
| `gtfs_subway` | 0.999 | 16 m | 212 m | **20.5%** | 10.5% | 1,862 m |
| `gtfs_busco` | 0.998 | 14 m | 149 m | **15.5%** | 6.5% | 4,659 m |
| `gtfs_si` | 0.996 | 14 m | 128 m | **13.8%** | 6.1% | 6,165 m |
| `gtfs_q` | 0.997 | 13 m | 109 m | **11.5%** | 3.5% | 1,242 m |
| `gtfs_bx` | 0.996 | 12 m | 72 m | 6.4% | 1.1% | 1,433 m |
| `gtfs_b` | 1.000 | 9 m | 48 m | 4.0% | 1.1% | 1,821 m |
| `gtfs_m` | 1.000 | 9 m | 41 m | 2.9% | 0.7% | 901 m |

*Lateral deviation* is the **maximum** perpendicular distance from the drawn chord to any shape
point between the two stops — how far off the line strays at its worst point on that hop.

Two things fall out, and both contradict what `TRANSIT_NEXT.md` item E currently says:

- **Subway is the worst feed, not the safe one.** One subway edge in five is drawn more than
  100 m — a long Manhattan block — off the track it claims to be. The tail is express and
  river-crossing running: the worst are `SI`, `FX`, `6X`, all of which skip stops, so the chord
  cuts across whatever lies between.
- **"Bus on a street" is not uniformly the problem either.** Manhattan (2.9%) and Brooklyn (4.0%)
  are genuinely fine — a dense grid with ~200 m stop spacing leaves a chord little room to stray.
  Staten Island (13.8%), Bus Company (15.5%) and Queens (11.5%) are as bad as the subway.

The median edge is fine everywhere (9–16 m). This is a **tail** defect: a small, visible,
consistently-located minority of hops drawn badly wrong, not a uniform blur.

## 4. What would shipping it cost?

This is what decides the wire format, and naive JSON is not affordable.

| feed | interior points | JSON arrays @5dp | gzipped | **encoded polyline** | gzipped |
|---|---|---|---|---|---|
| `gtfs_subway` | 44,124 | 899 KB | 128 KB | **120 KB** | 30 KB |
| `gtfs_m` | 18,860 | 388 KB | 70 KB | **83 KB** | 33 KB |
| `gtfs_bx` | 25,607 | 525 KB | 85 KB | **100 KB** | 43 KB |
| `gtfs_q` | 25,312 | 518 KB | 93 KB | **96 KB** | 40 KB |
| `gtfs_si` | 81,868 | 1,670 KB | 338 KB | **289 KB** | 98 KB |
| `gtfs_busco` | 96,719 | 1,971 KB | 342 KB | **323 KB** | 106 KB |
| `gtfs_b` | 37,263 | 767 KB | 138 KB | **160 KB** | 78 KB |
| **all seven** | **329,753** | **6.58 MB** | 1.17 MB | **1.14 MB** | 0.42 MB |

A Manhattan route already fetches all seven shards — 9.21 MB (item D). As JSON coordinate arrays
the geometry adds **6.58 MB, +71%**, which is not a thing to do to a first load that is already
the open question in item D. As Google encoded polyline at precision 5 (~1.1 cm, far finer than
the 8 m the bus stops themselves sit off the centreline) it adds **1.14 MB, +12.4%** — and
`subway.json`, the only shard most sessions load, grows 1.16 MB → 1.28 MB.

**So F ships an encoded polyline, not a coordinate array.** That is a 5.8× difference and it is
the difference between "additive field" and "blocked on item D".

## Limitations

- **Deviation is a maximum, not a mean.** One bad corner puts an edge in the >100 m bucket even if
  the rest of the hop is exact. That is the right statistic for "is the drawn line in the wrong
  place" and the wrong one for "how much of the ride is misplaced".
- **Agreement (§2) is sampled**, 250 multi-shape edges per feed, not exhaustive. The result was
  0.0 m in all seven, so the risk of the unsampled remainder differing is low, but it is not nil.
- **One shape per edge** was used for §3 and §4, chosen deterministically (`sorted(...)[0]`).
  §2 is what licenses that.
- **The projection frame is locally planar**, exact enough over a single shape segment at NYC
  latitudes; it is not a general geodesic and should not be lifted for a different city without
  re-checking.
- **A bus shape is the street centreline.** Slicing it perfectly still does not put the line on
  the pavement the rider walks, and the ~8 m offset is roughly half a carriageway. This matters if
  anyone ever samples shade along the drawn line: at a low sun angle the two sides of a street are
  not the same place. Geometry fixes the *drawing*; it does not by itself earn a shade claim.
- **Edge counts here are per-feed** and derived from `stop_times.txt` directly. The pipeline's own
  published counts differ (it aggregates and shards differently) — these are the GTFS-side numbers,
  not shard numbers.

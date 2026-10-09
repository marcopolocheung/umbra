# Is the free global canopy raster reachable from Umbra? — measured 2026-09-09

**Taken the same day as the A7 census**, which established that OSM is the wrong completeness
layer for canopy (`canopy-coverage-2026-09-09.md`: ~23% of Madrid's inventoried street trees,
~1.0% of Singapore's). This note answers the follow-on question — *can Umbra actually read the
Meta/WRI canopy height map, from a browser, at route scale, for free?* — before A8 is planned
around it.

**Transport: yes, cheaply, and from the browser directly. Vintage: with one catch that lands
squarely on Madrid.**

Everything below was measured against the live S3 objects, not read off a dataset card.
Re-check before quoting; Meta has already published one incompatible version.

## There are two datasets and they are not interchangeable

| | v1 `alsgedi_global_v6_float` | v2 `dinov3_global_chm_v2_ml3` |
|---|---|---|
| container | BigTIFF | TIFF |
| layout | **striped**, `RowsPerStrip=1` | **tiled 512×512** |
| overviews | **none** | **7 levels** + 1-bit mask |
| grid | 65536² per z9 quadkey | 32768² per z10 quadkey |

**v1 is not a COG.** v2 is. Any plan built on v1 needs a preprocessing pipeline; on v2 it does
not. Use v2 (`s3://dataforgood-fb-data/forests/v2/global/dinov3_global_chm_v2_ml3/`).

## Resolution — spatial and height are different numbers

- **Spatial:** 1.19 m/px in Web Mercator, so **0.91 m/px ground at Madrid's latitude** and
  finer nearer the poles. The 16384 overview is **1.82 m/px ground** there — the level to use
  for pedestrian shade, and roughly the 2–2.5 m a route sampler needs.
- **Height:** `BitsPerSample=8`, `SampleFormat=1`. **uint8 — canopy height in whole metres.**
  There is no sub-metre height in the distributed product, whatever the v1 path's `_float`
  suffix suggests. "Sub-metre canopy data" would be an incorrect description.

## Transport cost, over the real Madrid tile

Summed from the actual `TileByteCounts` of `chm/0331110121.tif` at the 1.82 m level:

| area around the A3 Madrid centre | COG tiles | compressed |
|---|---:|---:|
| 0.5 km box | 2 | **41 KB** |
| 2 km box | 9 | **260 KB** |
| 5 km box (25 km²) | 42 | **1.4 MB** |

A 5 km × 200 m route corridor lands around 200–400 KB. That is route-sized and needs no
preprocessing, no mirror and no storage.

**But whole tiles are not an option.** The first tiles in the bucket are ~2 MB and they are
mostly nodata; the ones over cities are not:

| | Madrid | Singapore | Kent, WA |
|---|---:|---:|---:|
| `chm/<quadkey>.tif` | 84.6 MB | 87.5 MB | **271.8 MB** |

Range reads are mandatory, not an optimisation.

## CORS: Meta's own endpoint refuses the browser, and a mirror does not

Meta's S3:

```
OPTIONS + Origin + Access-Control-Request-Headers: range   →  403 Forbidden
GET     + Origin + Range                                    →  206, no Access-Control-Allow-Origin
```

`Range` is not a CORS-safelisted request header, so every read preflights and every preflight
fails. A browser cannot read **`dataforgood-fb-data`** directly. CORS is a browser-only rule —
`curl`, Node and a Vercel function are all unaffected — so this was never about whether the
data is reachable, only about who does the reaching.

**It is moot, because `source.coop` serves the same objects with CORS open.** The Taylor
Geospatial rebuild ([`taylor-geospatial/meta-chm-v2`](https://github.com/taylor-geospatial/meta-chm-v2))
republishes Meta's COGs under CC-BY-4.0 without copying the pixels:

```
https://data.source.coop/tge-labs/meta-chm-v2/chm/<quadkey>.tif
  GET + Origin + Range  →  206, access-control-allow-origin: *
  OPTIONS preflight     →  204, allow-headers: *
```

Verified byte-identical to Meta's object over the Madrid tile — same 84,604,237 bytes, same
sha256 over the first 256 KB. Their live viewer reads these with `geotiff.js` in the browser
and no server at all, which is exactly the shape Umbra needs.

**So the default path is browser-direct, and the proxy is insurance rather than a build item.**
source.coop is a research organisation's republication; Meta's S3 is the authority and has no
CORS. If that endpoint disappears, a thin `api/canopy.js` byte-range passthrough restores the
capability without any other change — worth writing down, not worth building first.

## Vintage — and the catch that lands on Madrid

`metadata/<quadkey>.geojson` carries an `acq_date` per imagery polygon. S3's `LastModified`
(2026) is the upload, not the capture, and must never be quoted as currency.

| | polygons in tile | acquisition |
|---|---:|---|
| Madrid | 4 | **all 2020-02** |
| Kent, WA | 4 | 2019-07, 2019-08 ×3 |
| Singapore | 30 | 17 distinct months, **2015-01 → 2019-10** |

Three things follow.

**1. Madrid's imagery is leaf-off, and Madrid is a deciduous city.** February, in a city whose
street planting is dominated by plane trees. A canopy-height model reading winter imagery over
bare crowns will *under*-detect exactly the canopy A7 exists to find — and it will do so
silently, because the raster reports a height, not a confidence. This interacts badly with
`canopy.ts`'s own seasonal model: a leaf-off *observation* and a leaf-on *query* are different
things, and multiplying summer transmittance onto a winter-derived crown extent would be
wrong twice over. **A8c must check this before Madrid numbers are quoted anywhere.**

**2. One tile is not one date.** Singapore's single tile is a mosaic of 30 polygons spanning
almost five years. A `CanopyTile { heights, observationDate }` shape is wrong; the date is a
property of a *region within* a tile.

**3. The date metadata is expensive to fetch.** The GeoJSONs are 4.7 MB (Kent), 8.3 MB
(Madrid) and 24.4 MB (Singapore) — for 4, 4 and 30 polygons. Reading one date currently costs
more bytes than reading the canopy. A8a needs an answer for this (simplify server-side and
cache, or derive a coarse per-region date table once) rather than fetching them per tile.

## What this does not establish

Nothing here says the raster is *correct*, and one failure mode matters more than the rest for
an app about dense cities: **the model may read buildings as canopy.** A 40 m tower predicted
as 40 m of canopy would be double-counted — once as an opaque building caster, once as a 0.9
canopy caster — while simultaneously making that building's shadow *softer* than it is. That
is A8c's job, and A8c is a gate on routing, not a step towards it.

## Reproducing

Public, anonymous, read-only; no AWS account.

```bash
BASE=https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3
curl -s "$BASE/metadata/0331110121.geojson" | jq '[.features[].properties.acq_date]'   # Madrid
curl -sI "$BASE/chm/0331110121.tif"                                                     # size
curl -s -H 'Range: bytes=0-262143' "$BASE/chm/0331110121.tif" -o head.bin               # IFD chain

# The same object, CORS-open, which is the one the browser uses:
MIRROR=https://data.source.coop/tge-labs/meta-chm-v2/chm
curl -s -D - -o /dev/null -H 'Origin: https://shademapnav.vercel.app' \
     -H 'Range: bytes=0-65535' "$MIRROR/0331110121.tif" | grep -i access-control
```

Quadkey is zoom 10, standard Web Mercator, `chm/<quadkey>.tif`.

---

# A8a — the transport prototype, measured in a browser, 2026-09-10

Everything above was measured with `curl` and Node. This section is the same
questions asked from the place that actually has to answer them: a page, using
`geotiff.js`, against `source.coop`, with no server of any kind. **It confirms the
estimates and adds four things the header-arithmetic could not see.**

Reproduce with `npm run bench:canopy` (`e2e/canopy.config.ts`). It talks to
a third-party host, so it never runs in CI and its timings belong to one machine —
these are a WSL2 laptop on a domestic connection, 2026-09-10, where a single
796-byte range read from `source.coop` took **1.5-3.5 s**. Read the byte columns as
exact and the millisecond columns as latency-bound.

Code: `app/lib/canopyRaster/` (`tiles.ts` is the arithmetic and is unit-tested with
no network; `canopyCog.ts` is the network shell). **A8a has no routing effect, no
UI and no consumer** — nothing here reaches `ShadowField`, and nothing should
before A8c answers #279.

## It works, and the estimate holds exactly

One AOI: the A3 Madrid corpus centre, three box sizes, read at the 16384 overview.

| AOI | raster | m/px | COG tiles | payload | requested | transferred | overhead | round trips | vs whole tile |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5 km box | 276x276 | 1.82 | 2 | 41.2 KB | 56.4 KB | 56.4 KB | 1.37x | 25 | <0.1% |
| 2 km box | 1101x1101 | 1.82 | 9 | 259.7 KB | 275.0 KB | 275.0 KB | 1.06x | 46 | 0.3% |
| 5 km box | 2751x2751 | 1.82 | 42 | 1430.5 KB | 1446.0 KB | 1446.0 KB | 1.01x | 145 | 1.8% |

- **payload** — compressed COG tiles the window overlaps, summed from
  `TileByteCounts`. The floor a perfect reader would transfer.
- **requested / transferred** — the byte ranges `geotiff` asked for, against what
  the responses carried. Counted from the `Range` request header and each
  response's `Content-Length`, not by reading bodies: `source.coop` sends no
  `Timing-Allow-Origin` so Resource Timing reports zero sizes cross-origin, and
  cloning bodies undercounts once Chromium's cache is involved. These are
  **body** bytes — 25-145 sets of response headers are not counted, so real wire
  cost is somewhat above the figure, most visibly on the smallest AOI.

**The estimate above was right to the tile.** 2 / 9 / 42 tiles and 41 KB / 260 KB /
1.4 MB were summed from the Madrid tile's byte counts before any of this existed;
the browser transfers 41.2 KB / 259.7 KB / 1430.5 KB of payload over exactly those
tile counts.

**Requested equals transferred on every read** — but read that as narrower than it
sounds. For a `206`, `Content-Length` *is* the requested range length, so the
equality is close to structural; what it actually rules out is the one failure that
would matter, a server ignoring `Range` and returning `200` with all 84 MB. The
three AOIs also read one `.tif` in one browser session, so Chromium may serve some
ranges from cache with `Content-Length` intact; the byte columns should be read as
"what the library asked for and was given", not as a wire trace.

**Overhead is a fixed cost, not a rate.** The gap between payload and transferred
is **~15.5 KB at every AOI size** — 15.2 / 15.3 / 15.5 KB — because it is the IFD
chain walk, which does not grow with the window. So it is 37% of a 0.5 km box and
1% of a 5 km one. **A8b should cache the opened `GeoTIFF`, not just decoded
tiles**: reopening a tile pays that walk again, and it is 19 of the read's round
trips.

*(An earlier version of this table read ~19 KB and one request higher on every row.
That was `payloadBytesFor` asking for the whole `TileByteCounts` array via
`loadValue`, which calls `loadAll()` — something `readRasters` never does, since it
resolves entries individually. The measurement was spending a round trip and 4,096
bytes and then reporting them as transport cost. It now reads the same entries with
`loadValueIndexed` after the read, where they are already resolved, and fetches
nothing.)*

## Time, round trips and memory

| AOI | open | read + decode | total | round trips | raster | heap held over baseline |
|---|---:|---:|---:|---:|---:|---:|
| 0.5 km box | 13049.3 ms | 1171.0 ms | 14222.0 ms | 25 | 74.4 KB | 2204.9 KB |
| 2 km box | 4098.2 ms | 2856.6 ms | 6955.0 ms | 46 | 1183.8 KB | 7299.7 KB |
| 5 km box | 2793.7 ms | 16100.0 ms | 18894.0 ms | 145 | 7390.6 KB | 8804.9 KB |

**The cost is round trips, not bytes, and the round trips are worse than they look.**
1.4 MB is nothing; 145 sequential range requests at 1.5-3.5 s each is everything.
The count is exactly **`3 x tiles + 19`** on all three rows, and both halves of that
are actionable:

- **Three requests per tile, not one.** `readRasters` resolves `TileOffsets[i]` and
  `TileByteCounts[i]` as *separate* **4-byte** HTTP range requests before fetching
  the tile itself. Two thirds of the per-tile round trips move eight bytes.
- **Nineteen for the open**, over the file's 14 IFDs — not the "seven-ish" a COG
  header walk suggests.

**The reason is one unset option.** `fromUrl(url, {}, signal)` leaves `blockSize`
`undefined`, and `maybeWrapInBlockedSource` returns the raw source unwrapped when it
is — so **there is no block cache at all**, and `maxRanges` defaults to `0`, so
there are no multi-range requests either. A8b's first lever is therefore not a
bigger cache but *any* cache: setting `blockSize` would fold each tile's three
requests into one or two, and `maxRanges` would batch what remains. Do not read the
milliseconds as a device budget — they are a domestic connection to a research
mirror, and `open` varied 2.8-13.0 s across runs while every byte column was
identical on all six.

**Memory is the raster plus 1.4-6.1 MB, and that overhead is not a constant.**
Against rasters of 74.4 KB / 1183.8 KB / 7390.6 KB the reader holds 2204.9 KB /
7299.7 KB / 8804.9 KB, so the excess is 2.1 / 6.0 / 1.4 MB — not monotonic in AOI
size, with the 2 km box the worst case rather than the largest one. No model is
offered for that here; what matters for A8b is the ceiling, which is roughly the
raster plus a few megabytes. The figure is what the reader *retains* with the
raster live, against a `HeapProfiler.collectGarbage` baseline — **not** the
transient peak inside `readRasters`, which nothing available in a browser can see.
The checkpoint asked for peak memory and this is not that; the substitute is stated
rather than dressed up.

Two instruments were discarded getting there, both worth not repeating: polling
`performance.memory` inflated decode **5-7x** (with `--enable-precise-memory-info`
every read does real work, so the instrument landed inside its own measurement — it
is now read exactly twice), and CDP's `Runtime.getHeapUsage` counts only the V8
heap, so `ArrayBuffer` backing stores are invisible to it and the 7.4 MB raster
reported as **1.0 MB**, *falling* as the AOI grew.

## Two traps that would have shipped silently

**1. `geotiff`'s own overview selection cannot be used on this file.** Its
`readRasters({ bbox, resX })` picks a level by filtering IFDs on the
reduced-resolution bit of `NewSubfileType`. GDAL writes this dataset's **mask**
overviews as `1 | 4 = 5`, which passes that filter — so its candidate list is seven
height levels interleaved with seven 1-bit all-ones mask levels, and its loop stops
at the first level *finer* than the request. Asking it for 1.8 m over the Madrid
tile returns **full resolution** (4x the pixels); a slightly different request
returns a **mask**, which decodes perfectly cleanly and is entirely ones. Both
failures are silent. `selectOverview` in `tiles.ts` therefore selects explicitly and
excludes mask IFDs on `NewSubfileType & 4`, and the benchmark asserts the decoded
band has a height range that is neither empty nor saturated, because that is what
distinguishes a height raster from a mask after the fact.

The published IFD layout, for the record: `0` heights at 32768², `1` the full-res
mask, `2-7` height overviews 16384 down to 512, `8-13` the matching mask overviews.

**2. Latitude decides which overview answers, so Singapore costs 4x Madrid.**
Resolution selection has to happen in *ground* metres, and the dataset's levels are
1.19 m/px in Web Mercator. At Madrid that is 0.91 m native and 1.82 m at the 16384
level, so a 2 m pedestrian target lands on the overview. At Singapore, 1.3°N, the
same levels are 1.19 m and 2.39 m — the overview is *too coarse* for a 2 m target,
so the read drops to native resolution and costs **four times the pixels and
roughly four times the bytes for the same ground area**. The expensive city is not
the one latitude-naive arithmetic would predict, and A8b's tile store inherits this.

## `acq_date`: the answer this note asked A8a for

The problem as stated above: the date metadata is 4.7 MB (Kent), 8.3 MB (Madrid)
and 24.4 MB (Singapore), so reading one date costs more than reading the canopy.
Two measurements settle it, and the second one is the decisive one.

**The dates are not what is large.** Every feature's `properties` in a tile sum to
**105-781 bytes** — a single `acq_date` key and nothing else. The imagery footprint
outlines are **99.997%** of each file: 198,332 coordinate pairs across Madrid's four
polygons, 586,086 across Singapore's thirty. There is nothing to stream or paginate;
the payload is a shape nobody needs at runtime.

**And a browser cannot fetch them at all.** `source.coop` republishes `chm/` and
**not** `metadata/`, which returns `NoSuchKey`; Meta's own bucket has the files and
sends no CORS headers. So unlike the COGs, this is not a size problem that a range
read would fix — it is unreachable from the page at any size. *(This also narrows
what the shelved `api/canopy.js` fallback (#280) would be for: the COGs do not need
it, and the metadata cannot use a range read even with it.)*

**So the dates are resolved once, offline, and shipped.**
`scripts/canopy-acq-index.mjs` fetches each tile's GeoJSON in Node — where neither
size nor CORS applies — rasterizes the acquisition polygons onto a 128x128 grid per
tile (~306 m per cell) and run-length encodes it. `app/lib/canopyRaster/acqDate.ts`
reads that index; `acquisitionAt(lon, lat)` is a lookup with no I/O.

| tile | source GeoJSON | polygons | coordinate pairs | distinct dates | resolvable | index | reduction | cells covered | overlapping | disagreement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Madrid | 8.27 MB | 4 | 198,332 | 2 | 2 | 1,966 B | **4208x** | 100.0% | 0.0% | 0.20% |
| Singapore | 24.39 MB | 30 | 586,086 | 26 | 24 | 6,114 B | **3990x** | 100.0% | 0.0% | 1.90% |
| Kent, WA | 4.72 MB | 4 | 112,143 | 2 | 2 | 1,357 B | **3476x** | 100.0% | 0.0% | 0.17% |

**37.4 MB of GeoJSON becomes a 9,822-byte committed file** — 9,437 B of it the
three tiles' own data, the rest the index's header — and the browser fetches none
of it. *Disagreement* is against the same polygons rasterized 4x finer: the error is
a band one cell wide along each imagery seam, which is why Singapore's 26 dates and
98 rings cost ten times Madrid's two and six. Reproduce the table with
`node scripts/canopy-acq-index.mjs --report`; the committed index regenerates
byte-identical.

*Resolvable* is the honest limit of a 128x128 grid: **two of Singapore's thirty
imagery footprints are smaller than one ~306 m cell and paint no cell at all**, so
that tile advertises 26 dates of which 24 can ever be returned by a lookup. The
full list is kept as-is because it is the truth about the *tile*; a caller that
needs the date at a *place* gets one of the 24.

Three things this fixes or confirms:

- **One tile is genuinely not one date, and now the code says so.** The index is
  spatial, so Singapore's single tile resolves to different dates in different
  places across its 2015-01-17 to 2019-10-25 span. A `CanopyTile { observationDate }`
  would have been wrong there by up to five years.
- **Madrid's leaf-off problem is now queryable.** `acquisitionAt` over the corpus
  centre returns **2020-02**, and a unit test asserts it, so A8c cannot quote a
  Madrid canopy number without the winter date being in front of whoever quotes it.
- **Overlapping footprints never arose.** Where polygons overlap the generator takes
  the latest acquisition, since the mosaic does not record which source image a
  pixel came from. On all three tiles the overlap is **0.0%**, so the rule is
  declared but never exercised — worth knowing before trusting it elsewhere.
- **Sub-cell footprints are dropped, and the index says how many.** See *resolvable*
  above. A finer grid recovers them at a roughly linear cost in bytes; whether that
  is worth it is A8b's call, and 128 was chosen against the disagreement column.

Only the three A3 corpus tiles are indexed. Indexing the world is a preprocessing
pipeline, and whether Umbra wants one is A8b/A8c's call, not A8a's.

## What A8a still does not establish

Unchanged, and worth repeating because everything above is encouraging and none of
it is evidence of correctness: **nothing here says the raster is right.** The model
may read buildings as canopy (**#279**), and the Madrid tile's winter imagery may
under-detect the deciduous canopy A7 exists to find (**#281**). Both are **A8c**,
which is a gate on routing rather than a step towards it, and A8a commits Umbra to
nothing.

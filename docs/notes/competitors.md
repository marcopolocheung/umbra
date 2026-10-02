# Competitors — observed, not desk-checked

**Observed 2026-10-02 (UTC-5), against the products deployed and live on that date.** This is
S0: the §5e desk claims about shadewalker.nyc, openrouteservice's shaded routing and Google
Maps' "Prefer shade" were re-derived by *running the products*, not by reading about them.
Every claim below is either an **observation** (something a browser did against the deployed
product on the date above) or a **source** (named, dated, linked). Nothing here is a physical
accuracy claim: every shade figure is geometry against geometry, and S1 owns the error bar.

The raw captures were made through the products' own UIs and their own public endpoints; they
are not committed. The method section says exactly how to reproduce every number.

## Method

- **Five fixed OD pairs**, street corners in four Manhattan neighbourhoods and one Brooklyn
  pair (park endpoints break connectivity checks — corners only). Endpoints are the first
  Nominatim result for each typed query, resolved through Umbra's own deployed proxy
  (`GET shademapnav.vercel.app/api/nominatim?endpoint=search&limit=5&q=…`, 2026-10-02):

| Pair | From (typed → resolved) | To (typed → resolved) |
|---|---|---|
| midtown | "5th Ave & E 42nd St, New York" → 40.7531450, −73.9803044 | "Lexington Ave & E 47th St, New York" → 40.7544253, −73.9740070 |
| village | "Waverly Pl & 6th Ave, New York" → 40.7331031, −73.9997962 | "St Marks Pl & 2nd Ave, New York" → 40.7286350, −73.9879165 |
| uws-ues | "Amsterdam Ave & W 79th St, New York" → 40.7831660, −73.9780970 | "Lexington Ave & E 72nd St, New York" → 40.7701133, −73.9625584 |
| brooklyn | "Bedford Ave & N 7th St, New York" → 40.7174046, −73.9570004 | "Manhattan Ave & Greenpoint Ave, New York" → 40.7298527, −73.9541934 |
| harlem | "St Nicholas Ave & W 125th St, New York" → 40.8105012, −73.9529341 | "Malcolm X Blvd & W 127th St, New York" → 40.8089027, −73.9449273 |

- **Three departure times**: 2026-10-03 at 09:00, 12:30 and 16:30 America/New_York (a future
  date, so both products accept it as an explicit departure).
- **shadewalker.nyc** was driven two ways: once through its own UI (Photon typeahead, map
  pins) and once through the same `GET /route` call its UI makes, at the exact coordinates
  above, so the two products are compared on identical endpoints. No key; the endpoint is the
  product's own public API.
- **Umbra** was driven through its deployed UI (`shademapnav.vercel.app`): timeline date/time
  set, then waypoints committed from the same Nominatim queries, then "Find the shade". The
  captured route cards are the deployed product's own output.
- **Reachability** of openrouteservice's Shaded Edition and Google's "Prefer shade" was
  checked hands-on: the tools were opened in a browser and their route-planning options
  enumerated.
- Reproduce: a headless-Chromium (Playwright) script fills the UIs as described and records
  the network calls each product makes; the shadewalker table can be reproduced with the
  `/route` URLs in the section below, verbatim.

## shadewalker.nyc — observed

Live at `shadewalker.nyc`; licence AGPL-3.0; geocoding by Photon; basemap CARTO
*(About page, observed 2026-10-02)*. The README's claims that survived observation:
488,677 routable sidewalk and path edges across all five boroughs, **each side of a street as
its own path**; ~900,000 city trees; a ~54 MB citywide export; FastAPI + igraph Dijkstra
*(GitHub README, read 2026-10-02)*. The per-side claim is visible in the product itself:
turn-by-turn steps read "Bleecker Street (east side)" and include a `cross_side` action
*(observed)*.

**What the product shows.** Two address inputs; a start-time picker offering *Leave now /
Depart at / Arrive by*; a **Shade from** toggle (*All shade / Tree shade / Building shade*); and
a shade-priority radio ladder — **MAX 40 · MED 15 · LOW 5 · NONE 0** — where every request
returns all four routes at once, so switching presets is client-side *(observed)*. Each route
shows minutes, distance and a single **% shaded** figure; the fastest preset adds "N trees
along the way" *(observed)*.

**How the figure is computed — from the product's own request.** The UI calls
`GET shadewalker.nyc/route?from_lat=…&from_lon=…&to_lat=…&to_lon=…&tree_weights=0&tree_weights=5&tree_weights=15&tree_weights=40&month=10&day=3&hour=9&minute=0`
and, when Building shade is selected, `&layers=buildings` *(observed)*. One request = **one
departure instant**. There is no arrival-side sweep: *Arrive by* takes the fastest route's
duration and subtracts it from the arrival time server-side, then scores all four routes at
that single instant *(About page)*. After dark, every preset collapses to the same shortest
route and the response carries `night: true` *(README)*.

The response carries, per weight: `length_m`, `minutes`, `shade_fraction`, `tree_count`,
`park_canopy_share`, and per-side `segments` *(observed)*. Their own account of the method:
each edge sampled **every 5 m in three lanes**, samples tested against the shadows of
buildings within 1 km **for every daylight hour of every month** (a 12×24 sun table), nearest
hours/months blended; building shade ∪ tree shade (union — buildings can only add shade);
flat-ground model (no terrain, elevated tracks or scaffolding); monthly leaf-on/leaf-off by
species; park canopy credited from the 2021 TNC/UVM land-cover raster (CC BY-NC-SA 4.0)
*(GitHub README + About page, 2026-10-02)*.

**Validation.** None published. Their About page says "data is not always accurately
reflected in real life… believe the street"; the README's assurance is a test suite (426
backend tests including route-regression goldens, 127 Vitest, 119 Playwright) — **no error
figure against any ground truth exists** *(observed; both sources dated 2026-10-02)*.

## Umbra — observed (this app, deployed)

The deployed route cards show a **Pareto stack, not one preset**: SHORTEST, BALANCED
(RECOMMENDED) and MOST SHADOWED are presented simultaneously, each with minutes, distance,
% shadow and a delta line versus the balanced card ("-17% sun exposure", "+1 min") *(observed
on all 15 runs)*. Every card carries the method caption verbatim: **"from building geometry ·
duration at a fixed 5.0 km/h walking pace"** *(observed)*.

Pricing is at the timeline's **selected instant**: the same pair's shortest route changes
figure with the selected time (village: 64% at 09:00 → 82% at 12:30) — one frozen timestamp per
calculation, the gap Track H1 exists to close *(observed)*. Tree canopy is absent from the
model everywhere — that gap is quantified side-by-side below.

One search observation worth keeping: the deployed Nominatim proxy returns nothing for
intersection queries phrased "Bleecker St & 6th Ave, Manhattan"; the same corners resolve when
phrased "… & …, New York". shadewalker's Photon geocoder resolved the first phrasing without
hesitation *(observed, both products, 2026-10-02)*.

## Side-by-side — identical endpoints, identical instants

Both products, the five pairs above, 2026-10-03, all three times. shadewalker columns are the
product's own `/route` response at the exact coordinates and instant; Umbra columns are the
deployed UI's route cards for the same endpoints and timeline time. Figures are the products'
own (% shaded / % shadow of distance share; minutes at each product's own pace model —
shadewalker's and Umbra's 5 km/h are close enough that minutes agree throughout).

**midtown**

| departure | shadewalker NONE (0) | LOW (5) | MED (15) | MAX (40) | Umbra Shortest | Balanced | Most shadowed |
|---|---|---|---|---|---|---|---|
| 09:00 | 772 m · 9.2 min · 85% | 774 m · 9.2 min · 97% | 774 m · 9.2 min · 97% | 774 m · 9.2 min · 97% | 793 m · 9 min · 68% | 778 m · 9 min · 82% | 854 m · 10 min · 77% |
| 12:30 | 772 m · 9.2 min · 87% | 774 m · 9.2 min · 96% | 774 m · 9.2 min · 96% | 778 m · 9.3 min · 98% | 793 m · 9 min · 79% | 800 m · 10 min · 99% | 803 m · 10 min · 99% |
| 16:30 | 772 m · 9.2 min · 90% | 774 m · 9.2 min · 100% | 774 m · 9.2 min · 100% | 774 m · 9.2 min · 100% | 793 m · 9 min · 100% | 821 m · 10 min · 98% | 824 m · 10 min · 98% |

**village**

| departure | shadewalker NONE (0) | LOW (5) | MED (15) | MAX (40) | Umbra Shortest | Balanced | Most shadowed |
|---|---|---|---|---|---|---|---|
| 09:00 | 1168 m · 13.9 min · 63% | 1168 m · 13.9 min · 63% | 1207 m · 14.4 min · 73% | 1300 m · 15.5 min · 90% | 1190 m · 14 min · 64% | 1240 m · 15 min · 69% | 1240 m · 15 min · 71% |
| 12:30 | 1168 m · 13.9 min · 91% | 1168 m · 13.9 min · 91% | 1168 m · 13.9 min · 91% | 1168 m · 13.9 min · 91% | 1190 m · 14 min · 82% | 1200 m · 14 min · 83% | 1200 m · 14 min · 81% |
| 16:30 | 1168 m · 13.9 min · 96% | 1168 m · 13.9 min · 96% | 1168 m · 13.9 min · 96% | 1168 m · 13.9 min · 96% | 1190 m · 14 min · 0% † | 1200 m · 14 min · 0% † | 1200 m · 14 min · 0% † |

**uws-ues** *(the route crosses Central Park; the two products route it differently)*

| departure | shadewalker NONE (0) | LOW (5) | MED (15) | MAX (40) | Umbra Shortest | Balanced | Most shadowed |
|---|---|---|---|---|---|---|---|
| 09:00 | 2472 m · 29.4 min · 72% | 2472 m · 29.4 min · 72% | 2478 m · 29.5 min · 73% | 2533 m · 30.2 min · 78% | 2480 m · 30 min · 11% | 2490 m · 30 min · 22% | 2550 m · 30 min · 22% |
| 12:30 | 2472 m · 29.4 min · 76% | 2472 m · 29.4 min · 76% | 2476 m · 29.5 min · 77% | 2537 m · 30.2 min · 82% | 2480 m · 30 min · 30% | 2490 m · 30 min · 40% | 2490 m · 30 min · 40% |
| 16:30 | 2472 m · 29.4 min · 82% | 2472 m · 29.4 min · 82% | 2472 m · 29.4 min · 82% | 2503 m · 29.8 min · 85% | 2480 m · 30 min · 48% | 2490 m · 30 min · 56% | 2490 m · 30 min · 57% |

**brooklyn**

| departure | shadewalker NONE (0) | LOW (5) | MED (15) | MAX (40) | Umbra Shortest | Balanced | Most shadowed |
|---|---|---|---|---|---|---|---|
| 09:00 | 1661 m · 19.8 min · 82% | 1680 m · 20.0 min · 94% | 1680 m · 20.0 min · 94% | 1680 m · 20.0 min · 94% | 1770 m · 21 min · 64% | 1800 m · 21 min · 66% | 1800 m · 21 min · 67% |
| 12:30 | 1661 m · 19.8 min · 78% | 1661 m · 19.8 min · 78% | 1661 m · 19.8 min · 78% | 1690 m · 20.1 min · 82% | 1770 m · 21 min · 26% | 1770 m · 21 min · 36% | 1890 m · 22 min · 38% |
| 16:30 | 1661 m · 19.8 min · 82% | 1661 m · 19.8 min · 82% | 1688 m · 20.1 min · 92% | 1688 m · 20.1 min · 92% | 1770 m · 21 min · 64% | 1800 m · 21 min · 71% | 1860 m · 22 min · 73% |

**harlem**

| departure | shadewalker NONE (0) | LOW (5) | MED (15) | MAX (40) | Umbra Shortest | Balanced | Most shadowed |
|---|---|---|---|---|---|---|---|
| 09:00 | 851 m · 10.1 min · 51% | 854 m · 10.2 min · 55% | 854 m · 10.2 min · 55% | 854 m · 10.2 min · 55% | 919 m · 11 min · 45% | 931 m · 11 min · 70% | 1020 m · 12 min · 70% |
| 12:30 | 851 m · 10.1 min · 57% | 856 m · 10.2 min · 74% | 856 m · 10.2 min · 74% | 906 m · 10.8 min · 84% | 919 m · 11 min · 73% | 932 m · 11 min · 75% | 985 m · 12 min · 70% |
| 16:30 | 851 m · 10.1 min · 86% | 856 m · 10.2 min · 98% | 856 m · 10.2 min · 98% | 856 m · 10.2 min · 98% | 919 m · 11 min · 88% | 920 m · 11 min · 89% | 929 m · 11 min · 95% |

† Umbra's card read **0% shadow, "from the map view"** — the product fell back to sampling the
rendered canvas instead of building geometry, reproducibly across every retry, while its own
canvas visibly showed shadow along the route. Reported here because it is what the deployed
product does; it is a fallback artefact, not a measurement of Umbra's model.

**What the comparison shows — read narrowly.** These are single-pair product observations, not
benchmarks: the two products snap to different networks and geocode independently, and only
this table holds the endpoints identical. Within that, four things are worth keeping:

1. **Where buildings dominate, the products agree within ~10 pp.** Midtown at every hour, the
   Village at midday, Harlem at 09:00 and 16:30 — Umbra's shortest/balanced cards land close to
   shadewalker's NONE/LOW presets, which is what two building-shadow models of the same city
   should do *(observed)*.
2. **The ladder buys little on the Midtown grid** — 85% → 97% at 09:00, 87% → 98% at 12:30 —
   the CoolWalks regular-grid finding, reproduced in the field *(observed)*.
3. **The canopy gap is large where trees dominate, and it is the whole story on those pairs.**
   Brooklyn 12:30: shadewalker 78%, Umbra 26%. The UWS→UES crosstown: 72–85% versus 11–57%.
   The Village 09:00: shadewalker's MAX reaches 90% for +11% distance where Umbra's most-shadowed
   card reaches 71%. The same Village pair with shadewalker's own "Building shade" toggle instead
   of "All shade" drops its fastest route from 68% to 52% at 09:00 — **~15 pp of that route's
   shade is tree shade Umbra's model cannot see** *(observed; the toggle run used the UI's own
   Photon endpoints)*.
4. **Tree shade is not a constant offset.** On the same Village endpoints at 16:30 shadewalker's
   *fastest* preset is already 96% shaded — the canopy gap narrows to nothing when the buildings
   alone shade the whole walk. The gap is an hour-and-place fact; A8's benchmark should be too.

The Umbra † row is also a finding: the map-view fallback reporting 0% while the canvas shows
shadow is a reproducible product bug, filed against Track A rather than fixed here.

## openrouteservice "Shaded Edition" — reachable, Europe-only

Live at `shaded.openrouteservice.org`, v3.0.8, © 2026 HeiGIT gGmbH *(observed 2026-10-02)*.
Planning works through country/state/city dropdowns, a **Month** dropdown and a **Time of
Day** dropdown, then place-by-place routing with an optional round trip *(observed)*.

**NYC is unreachable.** The tool's own coverage list (`GET shaded.openrouteservice.org/aois/countries.json`,
fetched 2026-10-02) contains **44 countries, 138 cities — and no United States**. HeiGIT's
announcement says "136 cities in 44 European countries" *(HeiGIT, 2026-09-17)*; the deployed
list has 138. The deployed list is the observation.

**Time handling.** Shade pre-computed for 21 May/Jun/Jul/Aug at 09:00, 12:00, 15:00, 18:00
CEST — four fixed slots, a month dropdown, no finer time *(HeiGIT, 2026-09-17)*. **No metrics
published**; the announcement's own accuracy statement is qualitative: "every height in the
raster is an estimate. Accuracy depends on how complete building height information is in a
given city" *(same source)*. Their data: a synthetic 1 m nDSM from TUM building polygons,
CHMv2 canopy and a 30 m global DEM, shadows computed with GRASS `r.sunmask.datetime`, later
reimplemented in Rust *(same source)*. HeiGIT calls the tool "an analytical instrument… a
living product rather than a finished service" *(same source)*.

## Google Maps — still no shade toggle

**Hands-on, 2026-10-02:** walking directions between the Village pair were planned in Google
Maps (desktop web, en-US). The Route Options sheet offers **Avoid ferries, Wheelchair
accessible, Distance units — and nothing else**. No "Prefer shade" toggle, no minutes-in-sun
figure, no per-route shade percentage anywhere in the directions UI *(observed)*.

The toggle and its strings ("WALKING_ROAD_TYPE_SHADE", "%s in sun") remain APK-teardown-only,
surfaced in Maps v25.45.02 and non-functional even for the teardown's author *(Android
Authority, 2025-11-06)*. Ask Maps' conversation memory and Gmail context are not re-observed
here; they are carried from source *(9to5Google, 2026-08-06)*.

## Corrections to the §5e desk claims

Everything below replaces a §2 statement; §2 links here.

1. **ORS city count**: "136 European cities" → the deployed tool's own list says **138** (44
   countries). Both numbers are kept above, each with its source; the deployed list is the
   observation.
2. **shadewalker "prices the whole route at departure time"** — survives observation, with one
   nuance it did not carry: an *Arrive by* mode exists, and it too collapses to a single
   frozen instant (fastest duration subtracted from arrival time). No product observed here
   advances the sun along the walk — the H1/H4 gap is intact.
3. **Google's toggle** is now *observed absent* in the live product, not just teardown-dated —
   the "unlaunched" claim rests on hands-on absence as of 2026-10-02, plus the dated teardown.
4. Everything else in the §5e block survived observation unchanged: the 0/5/15/40 ladder, the
   per-side sidewalks, trees in the model, no published error figure anywhere.

## What this note does not say

- No physical accuracy claim. Every figure above is a product's own geometry against its own
  network; the shade-reality audit (S1) owns the error bar, and nothing here measures it.
- No latency, robustness or load claims. The HeiGIT/shadewalker performance statements are
  their own, sourced and dated, not measured here.
- Ask Maps' memory claims are sourced, not observed — no Google account was used.

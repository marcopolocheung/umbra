# How rain shelter is estimated

Method version: **rain-wind-v2**, which falls back to **rain-vertical-v0** whenever the
wind forecast cannot answer. The UI links here so that every rain figure can be
re-derived from this page. Status: **experimental**. None of these numbers is measured
ground truth — they are priors, stated as ranges where the source evidence is a range,
and the app says "unknown" rather than inventing a dry street.

## What the app computes

A street-graph edge carries a **shelter factor** (0–1): the share of rainfall its sidewalk
blocks. For vertical-rain v0 the computation is:

1. Sample each sidewalk every ~25 m at a 4 m lateral offset, exactly where the shadow
   sampler samples (`ShadowField.sampleEdges`).
2. At each point ask: *what geometry is overhead?*
   - **A building footprint overhead** (arcade, colonnade, overhang mapped into the
     building polygon) → shelter 1.
   - **A tree crown overhead** → shelter = the rain-opacity prior below.
   - **Nothing** → shelter 0.
3. Average over the edge; both sidewalks are valued separately, so a route can pick the
   covered side of a street.

The geometry comes from the same sources as shadow: the NYC static building shards where
they exist, MapTiler tiles, and Overpass buildings and canopy, with the canopy raster
deliberately excluded (its opacity is a light-transmittance number; using it would claim
a dryness this model has not established).

## The priors and their honest ranges

| Quantity | Value used | Published range it expresses |
|---|---|---|
| Rain intercepted by a crown in leaf | 0.4 | ~0.2–0.6 — throughfall varies with species, leaf area, event intensity and how long it has been raining |
| Rain intercepted by a crown out of leaf | 0.1 | ~0.0–0.2 — bare branch geometry still deflects a little |
| Raindrop fall speed | 9 m/s | Terminal velocities span roughly 7–10 m/s across drop sizes; 9 is the round figure the v1 tilt uses |
| Building wall shelter (v1, wind only) | geometry only | Walls block along the raindrop ray; the wind report driving that ray is a model value at 10 m, *not* the wind between canyon walls (see v1) |

The crown values are read from the crown's existing **light** opacity (0.9 in leaf,
0.3 out, per `canopy.ts`) through a straight ramp — the crown already decides seasonality
from its leaves; rain only re-weights it.

**The drip caveat.** A leafed crown is not a roof. It intercepts first, then drips —
long rain events soak through, and the drip line can be wetter than open ground for a
while. The 0.4 prior is the generous end of what the literature supports; the UI does not
promise "dry under this tree", it reports a fraction with an experimental badge.

## Conditions and reporting

Rain is a shelter simulation assuming rain is falling. It does not predict whether
precipitation occurs. The default wind source is the forecast hour nearest the target
within the shared freshness limit. If that row lacks a usable direction or speed, the
context uses a clearly labelled vertical-rain fallback. Users can choose a fixed
wind-from bearing and non-negative speed in metres per second; manual values stay fixed
when the timeline moves. A blue pixel means the receiver is
protected in both sun and rain.

The route reports sheltered distance and unscaled rain-exposed minutes. Unknown geometry
earns no shelter credit and is kept separate from exposed distance. Transit summaries
separate outdoor access, egress, transfers and surface waits from riding time; enclosed
vehicle riding is counted as sheltered only when the explicit vehicle assumption applies.

## Provenance and the unknown rule

Every figure carries where it came from (`shelterSource`), with the same vocabulary as
shadow: *from building geometry*, *from tree canopy*, *mixed sources*, or *source unknown*.
**Absent never reads as dry**: an edge the geometry cannot speak for contributes to the
unknown total, earns no shelter credit, and is never promoted to a confident exposed or
sheltered claim.

## v1 — wind-driven rain (wired, with a stated fallback)

The direction of rain is a wind report away: a drop arrives along a ray tilted
`atan(wind / fall speed)` from vertical, from the meteorological wind-from bearing.
Wind-driven shelter at a point is then *the shadow engine's problem with that ray as the
sun* — same casters, same index, with the ray azimuth rotated 180° (shadows fall
downwind). The vertical v0 is the `wind ≈ 0` limit of that formula, identical to within
the 89.5° clamp that keeps `tan(90°)` finite. One caveat is designed in: building-backed
answers below a 70° ray elevation pay a 0.85 confidence dock, because the wind that
steepens the ray is measured above the canyon it claims to describe.

The route uses the forecast hour nearest the trip time at the midpoint of its first and
last stops, from
the same cached fetch every other weather figure reads (D2); if the response carries no
wind direction, the calculation stays vertical and the card says so. The card reports
the wind it actually priced: from-bearing, speed, and resulting tilt.


## What this model does not know, stated on purpose

- `covered=*`, bridge decks, awnings and bus-stop shelters are **not queried** yet; some
  real dry corridors will be invisible to it.
- Wind channeling between buildings, gusts, and umbrella users.
- Snow and sleet: precipitation phase is deliberately not modelled here.

## Where it lives

`app/lib/rain/direction.ts`, `opacity.ts`; the sampler is `ShadowField.sampleRainEdges`;
routing costs and metrics are the `"rain"` objective in `app/lib/routing.ts`. The
fixture tests in `app/lib/rain/__tests__/` pin the physical sign conventions (the lee
side is sheltered, the windward side is not) so they cannot be silently inverted.

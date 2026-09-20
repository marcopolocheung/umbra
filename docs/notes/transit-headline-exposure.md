# What a transit card's "% shadow" is about (item C)

The decision behind the headline figure on a transit route card, and behind what the
heat score and the UV dose count for a transit trip. Written before the code, as
`docs/handoffs/TRANSIT_NEXT.md` item C asked: this is a modelling change and should be
its own decision rather than a side effect.

## What it was

Three numbers on a transit card each described something narrower than they looked:

| Figure | Where | What it actually covered |
|---|---|---|
| `N% shadow` chip and bar | `RouteCard.tsx`, from `RouteOption.shadowCoverage` | the two walking legs, distance-weighted |
| `N min in sun` | `routeExposureLine` | walking-leg metres ÷ walking speed |
| heat score, UV dose | `RouteConditionsLine`, from `routeExposureMinutes` | the same walking minutes, nothing else |

`routeExposureMinutes` was `distance ÷ speed`, and a transit option's `distanceM` is its
walk distance only. So the ride and the wait were not under-counted, they were **absent**:
a rider standing six minutes at a bus stop in full sun added zero minutes to the dose.
The per-leg facts to do better already existed — `waitExposure` (#423) samples the
shadow at the boarding stops, and `aboveGroundShare` / `sunExposureCoverage` (#411,
#414) measure the ride's track.

## The question, answered

**Do stationary minutes belong in a dose model built from distance? Yes — because the
dose model was never built from distance.** `dose()` takes minutes. A minute at UV
index *u* delivers `u × 0.015` SED whether the person is walking or standing still
(`heat-model.md`). Distance was only ever how the adapter *obtained* minutes, and that
conversion is right for one thing: a walk at one speed. It is the same bug
`transit-cost-seconds.md` found in the router — "distance and time are only
interchangeable at a fixed speed" — surfacing a second time in the exposure path.

So exposure is counted in **seconds**, and a stationary second counts exactly as a
walking one does.

That settles the unit. It does not settle *which* seconds, and that is where the three
parts of a transit trip differ.

### Walking legs — counted, as before

Sampled per edge, distance-weighted, converted at walking speed. Unchanged.

### The wait at a bus stop — counted

A rider waiting at a stop is a person in the open. `waitExposure.shadow` is the same
kind of measurement as a walking leg's shadow — the shadow at a point, from the same
field — so the two are one physical quantity and can share one sum, weighted by their
seconds. This is the part item A made measurable and nothing spent.

It inherits A's own floor unchanged: `waitExposure.shadow` is absent when less than
`MIN_WAIT_COVERAGE` of the waiting seconds got a confident answer, and above it A's
share stands for the whole wait, exactly as the leg line already quotes it.

**An unanswered wait makes the trip's figure unknown — all of it.** The tempting
alternative is to measure the share over the answered seconds and let it stand for the
rest, as 3B does for the ride. Here that is the #393 inversion in a new place: a
fully shaded walk beside six minutes at a stop nobody could see would read as six
shaded minutes, and a stop in full sun is exactly what a bus rider is worried about.
3B's rule leans on coverage being carried beside the figure; nothing on this card
carries it. So there is no floor on the outdoor time — one unanswered stop and the
card says unknown.

The unsheltered-stop assumption stays where A put it — the producer's own note, passed
through by `riderFacingNotes`. It is not a discount on the figure. Today that note is
only a tooltip on the schedule line, which a touch screen never shows (#435).

### The wait on a subway platform — not counted, and said

A deliberately left it unmodelled: a platform is usually underground and sampling the
street above it answers a different question. That holds here. The seconds are not
added, and the card says the wait is not counted. This is not free shade: elevated
platforms in Queens and the Bronx are open to the sky, and nothing in the published
data says which platform a rider is on. A number would have to be invented; a sentence
does not.

### The ride — not in the headline, not in the dose, and said

The ride already has its own words on the card: "Underground", "75% above ground",
"Track mostly unknown". Those state the **track** fact, which a passenger can check.
Folding the ride into the headline would need the rider's exposure, and the rider's
exposure is the track fact times `RAIL_VEHICLE_EXPOSURE = 0.25` — the settled rule under
3B is that a seat is not a pavement, and blending a model constant into a percentage
that means "share of pavement in building shadow" is precisely how the two would stop
being separable again.

For the **dose**, the ride is left out and the card says so, rather than counting it at
0.25. That constant is this codebase's "windowed surface vehicle" routing weight, and it
is explicitly *not for buses* (`trainGraph.ts`). It was never checked against
*erythemal* UV. Window glass is generally understood to absorb much of the UVB that
dominates erythemal weighting, which suggests the constant would overstate a seated
rider's burning UV — but no transmission figure is sourced here, and open bus windows
would undo it. A dose built on an unsourced figure is the thing `heat-model.md` exists
to prevent.

What leaving it out costs: nothing for an underground ride, which gets no UV. For an
elevated rail ride and for **every bus ride** — both are in daylight behind glass — the
dose is understated by an amount this model cannot bound. That is why the omission is
stated beside the figure rather than left silent.

Tunnel minutes must not enter as *shadow* minutes either: `dose()` charges a shadowed
minute 20–60% of full sun for the diffuse sky, and a tunnel has no sky.

The **heat score** is a felt temperature for someone outdoors. A seated rider in a car
is not in that model, so ride minutes are not in its sun share. The wait is.

## What the card now says

`% shadow` on a transit card is **the share of the rider's measured time outdoors —
walking, and waiting at a stop the app samples — spent in shadow**. For a walk route
that is all of its time, so the two cards compare like with like. The chip reads
`N% shadow on foot` for transit, because a bare `N% shadow` beside a 20-minute subway
ride reads as a claim about the ride.

`N min in sun`, the heat score's sun share and the dose all come from the same seconds,
so the card cannot state three different trips.

**With a stop unanswered, it is unknown.** The chip reads `shadow unknown` in a dashed
outline rather than the filled style of a measurement, the bar is a dashed track rather
than an empty one (which would read as full sun), the minutes say unknown, and the heat
score and dose are not computed.

Every transit card names the scope in words beside its minutes — *walk and stop wait
only; ride not counted* for a sampled bus wait, *walk only; wait and ride not counted*
otherwise — and the conditions panel repeats it beside the dose.

One thing this does not claim: a walking leg always counts as answered. The router
gives an edge with no shadow source a shadow of 0, so an unsampled block is counted as
sun. That errs away from shade, which is the safe direction, but it is not
"measured".

## What this does not change

- **`distanceM` stays the walk.** It is walking distance on every consumer that reads
  it, and the exposure path no longer depends on it for transit.
- **The ride is not sampled along its drawn line.** Item F's rule stands: shading along
  the ride comes from published `structure`, and sampling the ride geometry is a
  different answer that owes its own justification.
- **Other surfaces that print `shadowCoverage`** — the navigation panel's list, the
  status and arrival panels, saved routes, the shade-preference slider — do not know
  the unknown state, and with a stop unanswered they print the walks' share. They were
  out of this change's scope; #434.

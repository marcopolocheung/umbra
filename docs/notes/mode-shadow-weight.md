# Mode speed vs shadow weight (E2 derivation)

Why the routing cost does **not** scale `shadowStrength` with speed, and which
terms genuinely vary between walk (1.4 m/s) and bike (4.5 m/s).

## The cancellation

E1's edge cost (`routing.ts`, `dijkstra`):

```
cost = modeAdjustedDistanceM × (1 − shadowStrength × shadowFactor × 0.7 × solarIntensity)
     + crossingPenaltyM
```

TRACK_E §E2's premise was: a cyclist accumulates ~⅓ the dose per metre, so the
shadow term should scale with exposure *time*. Write the cost in cost-time
units by dividing by the mode speed `v` (cost-time equals trip time on plain
edges; on penalized or discounted bike edges it is the search's internal
currency, which is all the argmin cares about):

```
time = modeAdjustedDistanceM / v × (1 − shadowStrength × shadowFactor × 0.7 × I)
     + crossingPenaltyM / v
```

`1/v` multiplies **both** the shade benefit (a detour metre avoided) and the
detour cost (a detour metre spent). A uniform per-mode scale factor does not
move the argmin over routes: on plain edges, where both modes price distance
identically, walk and bike rank the same candidate paths identically through
this term. (E1's penalties and discounts already differentiate the modes on
non-plain edges — that divergence is E1's, not E2's.) Scaling
`shadowStrength` by speed would therefore not model physics — it would just
relabel the slider per mode. So E2 deliberately does **not** touch the
`shadowStrength` term or the 0.7 saving cap (which is likewise
speed-invariant: it bounds cost, not dose).

## What actually varies with speed

1. **The metre-denominated constants.** `DETOUR_FLAT_M` (250 m Pareto flat
   allowance) and the caller-passed `crossingPenaltyM` (15 m in the app) are
   walk-metres: at 1.4 m/s they are worth ~179 s and ~11 s. Charged unchanged
   to a bike, the same numbers are worth ~56 s and ~3 s — crossings become
   nearly free, so bike routes would zigzag across intersections chasing shade
   that is not worth the stop. Both are therefore scaled by
   `v_mode / v_walk` inside `routing.ts` (`speedRatioVsWalk` in
   `travelMode.ts`), converting the walk-metre allowance into the same *time*
   allowance per mode. Walk's ratio is exactly 1, so walk behavior is
   byte-identical; the Pareto remaining-cost heuristic is untouched and stays a
   lower bound (the scaled flat only loosens the prune relative to the same
   mode unscaled, never below a completable optimum, so pruning stays sound).
2. **Dose vs score (Track D owns both definitions; E2 only passes inputs).**
   D3's dose (`heat/dose.ts`) consumes absolute minutes, so a bike route
   correctly reports ~⅓ the dose per metre — via `routeExposureMinutes` at the
   route's own speed, which E1 already wired. D4's heat score (`heat/score.ts`)
   consumes the sunlit *share* of minutes, where speed cancels by construction:
   it is an intensity, not a dose, and reads the same for both modes on the
   same geometry. Neither definition changes here.
3. **Convective cooling.** A cyclist's airflow genuinely changes felt heat at
   equal sun share, but that is physiology inside D4's score, not geometry
   inside the route search. Filed against track-d; not modeled here.

## Consequence for the acceptance bar

Walk and bike converge on route choice through the shadow term itself — that
is the honest result, not a failure to differentiate. The sensibly different
choices E2 demonstrates come from the terms above: time-normalized crossings
(bike avoids a crossing-heavy "shortcut" walk takes) and the time-normalized
Pareto flat (bike's front admits a longer shadowed detour that exceeds walk's
time budget), composed with E1's penalties and prohibitions. No weighting was
added to force divergence beyond what this supports.

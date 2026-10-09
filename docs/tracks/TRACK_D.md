# Track D — Heat & Timing

> **Charter:** turn a blue-pixel fraction into something a body understands — UV dose, burn
> time, a heat score — and answer the question the incumbents aren't answering: **when should
> I go?**

**Class:** Adjacent. **Runs alongside:** B, C, E, G freely; coordinate with A on the sweep API (A6).

---

## Current state

- **Active checkpoint:** **D0 is done** — it merged as #204, and #225 followed it. D3 (PR
  #189), D4 (PR #196) and D2 (PR #188) have all merged too. Next is **#197** (the D1 hourly
  strip never renders on mobile), which the bullet below says to fix before D5; **D5** after
  that.
- **D0 was also a Track H prerequisite, and that block is now cleared.** `timezone.ts:8` used
  to guess the UTC offset from longitude with no DST; an hour of clock error is ~15° of sun, so
  H1 would have priced every edge's traversal against a wrong sky and H4 would have published a
  gap measured on a bad input. The offset is now a real IANA zone resolved per date
  (`docs/notes/timezone.md`).
- **Done:**
  - D1 — `HourlyExposureStrip` + `useHourlyExposure` render the day's shadow for the selected
    route under the tradeoff line, in both route surfaces. Closes #47.
  - D2 — `weather.ts` fetches every hourly variable in one cached call and returns
    `WeatherHour[]`; the cloud badge, the dose and the heat score share that one request.
  - D4 — `app/lib/heat/score.ts` scores the selected route 0–100 on felt temperature and
    renders it beside the tradeoff line, with `docs/notes/heat-score.md` linked from the UI.
    Closes #194.
  - D0 — the offset is now a function of place **and date**: an IANA zone from a lazily
    loaded boundary dataset, and DST rules from the runtime's own tz database via `Intl`.
    Closes #204. #225 followed it, putting sunrise/sunset on the same SunCalc model that
    draws the shadows and removing the `+ 12` minute constant behind a 5:40 AM marker whose
    real value was 5:26.
- **Open PRs:** none in this track.
- **⚠️ D3 and D4 are not actually done, and it is not a code problem.** Both acceptance criteria
  require the method to be *linked from the UI*, and those links point at
  `docs/notes/heat-model.md` and `docs/notes/heat-score.md` on the **public mirror**, which lags
  `origin/main` — so the link 404s in production (**#199**). That fix is **Track P's P1**. A
  health-adjacent number with a dead method link is worse than no number: do not mark D3/D4 done
  until the links resolve publicly.
- **The conditions row is one row, decided in D3.** D3 and D4 each added a card above the
  route options; together they stacked two `Experimental` badges and two near-identical method
  links, and disagreed in tone about the same weather ("strong heat stress" over a benign
  "4–5 min of full sun"). `RouteConditionsLine` replaces both: one badge, one method link, heat
  first because it is the figure that varies between the options below, dose second. Verified
  in a browser at 1280x900 and 375x667 — one visible badge, one visible link.
- **Before building on D0's timezone work,** three things. `longitudeToUtcOffsetMin` survives
  only as the fallback used while the boundary chunk loads. The zone lookup is **~5% wrong by
  offset on inhabited points**, clustered on borders — stated in `docs/notes/timezone.md`
  rather than in the UI, which D0's acceptance allows. And the offset is **derived, never
  stored**: `useShadowTime` recomputes it from `(zone, date)`, so nothing may cache it across
  a date change.
- **Also open against this track:** #197 — the D1 hourly strip **never renders on mobile**. A
  shipped feature nobody on a phone can see; fix it before D5.
- **Decisions made:**
  - D1 samples Track A's `ShadowField.sweep`, not the canvas, so the day sweep never moves the
    camera. One hour per animation frame until A6 makes a sweep cheaper than N samples.
  - `bestTime.ts` keeps ownership of the schedule (which hours, labels, timezone); the hook
    only fills in the measurements.
  - The strip is passed into `DirectionsPanel` and `FloatingRouteCards` as a rendered node,
    so the mobile and desktop surfaces share one instance and one sweep.
  - **`WeatherHour`'s measured fields are `number | null`, not `number`** — a deviation from
    this brief's original sketch. Open-Meteo can omit a variable, and a dose computed from a
    fabricated `uvIndex: 0` would read as a safe hour rather than an unknown one.
  - The forecast cache is keyed by location (~1.1 km cells) with a 1-hour TTL, not by target
    hour: one response already spans 8 days, so moving the timeline is a cache hit.
  - **The heat score scales with shortwave radiation, not UV index** — another deviation from
    the contract this brief sketched, and the method id is `shadow-radiation-v1` rather than
    `shadow-uv-v1` so it does not name a variable the model never reads. The UV share of global
    shortwave runs ~3.1% in January to ~7.8% in June, so a UV-scaled sun penalty would
    under-weight winter sun by more than 2× and mis-rank the same street across seasons. UV
    stays the right input for D3's dose, where erythema is the effect being estimated.
    `WeatherHour` gained `shortwaveWm2` on the same single request.
  - **Open-Meteo's `apparent_temperature` already contains a solar term** —
    `0.70 × 0.1 × max(0, shortwave − 550) / (0.75·wind + 10)`, up to ~2.5 °C — computed from
    grid-cell radiation with no local shading. `score.ts` subtracts it before adding a
    shadow-aware penalty, or a fully shadowed route would still be charged for sunshine.
  - The score is an **intensity, not a dose**: it says how hot the walk feels, not how much
    heat it accumulates. Duration is already on screen as "+4 min" and "3 min in sun", and
    folding it in would rank a long shadowed walk worse than a short scorching one silently.
  - `HeatScore` lives in `score.ts`, not `heat/types.ts`, only to avoid a certain conflict
    with #189 in a file both branches append to. Worth collapsing once #189 lands.
  - **`WeatherHour.windMs` was km/h.** Open-Meteo answers in km/h unless asked, and D4 is the
    first consumer to divide by that number — inside Steadman's own formula, where the unit
    is m/s. `weather.ts` now sends `wind_speed_unit=ms` and a test pins it.
  - **The shadow-only score does not borrow the word "Heat".** 70 on the felt-temperature ramp
    is ≈35 °C; 70 in shadow-only mode is 70% of the walk in sun. The UI reads "61% of this walk
    is in sun · no weather forecast — heat not scored" instead, and `heatBand()` puts UTCI's
    category name in front of the scored number so a first-time reader gets a word, not an
    index. The category is published; the even 20 points between categories are not.
  - `useWeatherHour` deliberately passes **no `AbortSignal`**. `fetchWeatherForecast` memoizes
    the *promise*, so aborting on cleanup cancelled the fetch for every other consumer and
    stranded the next effect run on the already-rejecting cached entry — the heat line stuck
    on "no forecast" after a pan or an hour-crossing drag. A stale-result flag is the correct
    cancellation for a shared cache, and a signal-aware test pins the regression.
- **Blocked on:** nothing (D6 still wants A6)
- **Next action:** D5 — `SettingsPanel.tsx`, `app/lib/heat/profile.ts`. Both `dose()` and
  `heatScore()` already take their person-dependent inputs as an explicit argument with no
  default, so D5 is the first caller rather than a retrofit.
- **Known limitation to close in D4/D6:** "most shadowed around 7 PM" is true but weakly useful
  near sunset, where everything ties at fully shadowed. D4's `sunPenaltyC` is the weighting the
  D1 series needs — it goes to zero after dark, which is exactly the tie-break missing today.
- **Last verified:** 2026-09-08, 468 tests / 38 files green merged with `main` (main baseline 439/36). D4 confirmed in a browser
  (Playwright, fixture basemap) on all four paths: with a stubbed 900 W/m² / 34 °C apparent
  forecast the card reads "EXPERIMENTAL · strong heat stress / Heat 69 · feels about 35 °C
  walking this"; with wind missing it drops to "about 34 °C — air temperature only"; with
  Open-Meteo unreachable it stops saying "Heat" at all and reads "61% of this walk is in sun
  · no weather forecast — heat not scored"; and at 375×667 the mobile sheet scores the row
  rather than degrading it. The method link's hit box measures 108×44 px.

---

## Why this track exists

Two facts, side by side:

1. **The engine for "best time to go" is already in the repo and reaches no user.**
   `app/lib/bestTime.ts` exports `buildHourlyExposureSeries()` (sweeps a day at a configurable
   step, 6:00–20:00 by default, timezone-correct via `fromMapLocal`/`toMapLocal`) and
   `bestExposureSample()`. It has tests (`__tests__/bestTime.test.ts`). It has **zero importers
   outside its test file**. PR #108 landed the library and stopped.
2. **The app's only heat metric is `shadowCoverage: 0..1`.** Nobody's body has a unit for that.
   The 2026 research consensus (ASU Cool Routes on mean radiant temperature; CoolPath on UTCI
   at 2 m; CoolPaths on street-scale PET) is that the meaningful quantity is radiant/thermal
   load — and every free input for a decent approximation is one Open-Meteo call away.

"When" is also the retention question. A route answer is used once; a "best window this
morning" answer is checked daily by runners, dog walkers, and stroller parents.

## What already exists

- **`app/lib/bestTime.ts`** — the sweep, with a `ShadowCoverageSampler = (date) => number`
  injection point. It doesn't care where shadow comes from, so it works today with the canvas
  sampler and switches to Track A's `sweep()` for free.
- **`app/services/weather.ts`** — Open-Meteo integration already shipped for cloud cover:
  `fetchCloudCoverForecast()` + `nearestCloudCover()` with a ±90 min match window, `forecast_days: 7`,
  `past_days: 1`, no API key. **Extend this file; don't start a second weather client.**
- **`shadowSampling.ts:computeSolarIntensity()`** — the existing sun-strength scalar, already
  feeding the routing cost model (`dijkstra`'s `solarIntensity` option, `routing.ts:340`).
- **`AccumulationPanel.tsx`** + the GeoTIFF export — sun-exposure accumulation over a window
  already renders; the visual language for "exposure over time" exists.
- **`RouteTradeoffSummary.tsx`** — where "+4 min, −62% sun" lives today; the heat score joins it.

## Hard invariants that bite this track

- **Honesty is a feature** (AUTONOMOUS_GOAL guardrail). Every number this track shows must
  have a written method and a stated uncertainty. A heat score with false precision is worse
  than no heat score.
- **No medical framing.** Burn time is an estimate with error bars for a sun-sensitive person
  to use as *context*, never advice. Say "estimate", show the assumption (skin type, UV,
  altitude ignored), and never phrase it as a safe limit.
- **Free-tier only.** Open-Meteo: no key, ~10k calls/day non-commercial. One cached hourly
  fetch per location, shared by every consumer in the app.

## The contract this track publishes

`app/lib/heat/types.ts`:

```ts
export interface WeatherHour {
  time: Date; uvIndex: number; tempC: number;
  humidityPct: number; windMs: number; cloudPct: number; apparentTempC: number;
}

export interface SunDose { sed: number; burnMinutes: number | null; uncertainty: "low" | "medium" | "high" }

export interface HeatScore {
  score: number;              // 0–100, comparable across route options
  method: "shadow-uv-v1";      // versioned — the UI links to docs/notes/heat-model.md
  inputs: Partial<WeatherHour> & { sunMinutes: number };
  confidence: number;
}

export function dose(sunMinutes: number, uv: number, profile: UserProfile): SunDose;
export function heatScore(route: RouteOption, weather: WeatherHour, profile: UserProfile): HeatScore;
```

---

## Checkpoints

### D0 — Real timezones  *(added 2026-09-07; take before D6)*
**Goal.** Civil time that is actually civil time. **This track's charter is "when should I go";
a wrong local hour makes every answer it gives wrong.**
**The defect.** `app/lib/timezone.ts:8` is `Math.round(lng / 15) * 60` — the UTC offset guessed
from longitude, rounded to whole hours, with no DST. Its own docstring admits ±90 min for
India (+5:30), Iran (+3:30) and China (uniform +8 across ~60° of longitude). D1's acceptance
already claims "timezone correct away from the user's own", and it is not.
**Approach.** Resolve a geographic IANA zone, then apply date-specific offset rules including
DST. Keep `toMapLocal` / `fromMapLocal`'s signatures so no caller changes — the helpers and
their tests are fine; only the offset source is wrong. **Budget the bundle cost against G3**: if
a full tz-boundary dataset blows it, ship a coarse zone lookup plus a documented accuracy
statement and say which one shipped. A stated ±15 min is honest; a silent ±90 min is not.
**Acceptance.** DST-transition tests pass for three zones with different rules (US, EU, southern
hemisphere); India and China are correct; the existing `timezone.test.ts` cases still pass; the
bundle delta is recorded; if the lookup is coarse, the UI or the method doc says so.
**Files.** `app/lib/timezone.ts`, its tests. **Size.** Medium.
**Why it matters beyond correctness:** time zones are the canonical "did they actually think
about this" question, and here the time axis *is* the product's differentiator — a shadow
recommendation for "7 PM" that is really 7:30 PM is wrong about the one thing the app claims to
know.

### D1 — Ship the orphan
**Goal.** The hourly exposure chart reaches a user. Closes **#47**.
**Approach.** Feed `buildHourlyExposureSeries` with the existing shadow sampler for the
*selected route*, render a compact hour strip ("70% shadowed before 10am, 25% at 2pm"), tap an
hour to set the timeline to it (`useShadowTime.setDate` / `handleSliderChange` already exist).
Live in `DirectionsPanel` beneath the tradeoff line, collapsed by default on mobile.
**Acceptance.** Chart matches the map: tapping 14:00 sets the timeline to 14:00 and the map's
visible shadow agrees with the bar; timezone correct away from the user's own (`timezone.ts`
has the helpers and tests); keyboard navigable; reduced-motion respected. Sampling 14 hours
must not freeze the UI — sample lazily/incrementally until A6 lands.
**Files.** exposure-chart component (new), `DirectionsPanel.tsx` (⚠️ Track E owns — coordinate),
`app/lib/bestTime.ts`. **Size.** Medium.

### D2 — Generalize weather ingestion
**Goal.** One cached hourly weather record for the whole app.
**Approach.** Extend `weather.ts` to request `uv_index`, `temperature_2m`,
`relative_humidity_2m`, `wind_speed_10m`, `apparent_temperature`, `cloud_cover` in one call;
return `WeatherHour[]`; cache by rounded lat/lng + hour; keep the existing ±90 min matching.
**Acceptance.** One network call serves cloud badge + UV + heat score; existing cloud-cover
tests still pass; a failed/absent forecast degrades every consumer gracefully (the app must
work with no weather at all).
**Files.** `app/services/weather.ts`, tests. **Size.** Small–medium.

### D3 — Exposure → dose
**Goal.** Minutes in sun become a number a sun-sensitive person can act on. Closes **#63**.
**Approach.** `app/lib/heat/dose.ts`: standard erythemal dose from UV index × exposed minutes ×
a skin-type factor; burn-time estimate as a range. Document every assumption in
`docs/notes/heat-model.md` (no altitude/albedo/clothing modelling; cloud attenuation via D2;
shadow attenuation is not zero — diffuse sky radiation still reaches you, and the model must
say so rather than pretending shadow is 100% protection).
**Acceptance.** Pure, unit-tested, with a table of expected values for known UV/skin
combinations; ranges not point values; `docs/notes/heat-model.md` exists and the UI links to it.
**Files.** `app/lib/heat/**`, `docs/notes/heat-model.md`. **Size.** Medium.

### D4 — Route-level heat score
**Goal.** Compare route options on heat, not geometry.
**Approach.** Combine sun-exposure minutes, UV, air temp, humidity, and wind into one 0–100
score per option — a documented UTCI-flavoured approximation, explicitly **not** a claim of
physical exactness. Sits beside the tradeoff sentence: "+4 min, −62% sun, heat 38 vs 61".
**Acceptance.** Method and limits written down and linked from the UI; the score orders route
options the same way a human would on obvious cases (all-shadow vs all-sun at noon); degrades
to shadow-only when weather is unavailable, and says which mode it's in.
**Files.** `app/lib/heat/score.ts`, `routeTradeoff.ts`, `RouteTradeoffSummary.tsx`. **Size.** Medium.

### D5 — Personal profile
**Goal.** The same route is a different problem for different people.
**Approach.** Local-only settings (no accounts): skin sensitivity, heat tolerance, pace
(overrides the mode speed), "I burn easily" / "I overheat" toggles. Feeds `dose()`, `heatScore()`,
and the routing shadow weight. Persist in `localStorage` beside saved routes.
**Acceptance.** Changing the profile visibly changes dose, score, and route ranking; defaults
are neutral; nothing is transmitted anywhere; a11y-clean form (labels are associated — PR #96's
pattern).
**Files.** `SettingsPanel.tsx`, `app/lib/heat/profile.ts`. **Size.** Medium.

### D6 — Best-time surfaces
**Goal.** Make "when" a first-class answer, not a chart buried in a panel.
**Approach.** "Best window today" on the home screen and on every saved route; a compact hour
strip; cloud-aware phrasing ("shadow matters less at 14:00 — 90% cloud"); switch the sampler to
Track A's `sweep()` so a 14-hour answer is instant.
**Acceptance.** Home screen answers "when should I go?" without the user calculating a route
first; the answer changes correctly with date, place, and profile.
**Files.** best-time components, `page.tsx` (⚠️ contested, keep it ≤20 lines). **Size.** Medium.
**Wants A6.**

### D7 — Morning routine
**Goal.** The habit loop. Part of **#64**.
**Approach.** With a saved commute (Track E's E8) and the PWA shell (already shipped), an
opt-in local notification: "today: most shadowed commute window 8:10–8:40, UV high after 11."
**Acceptance.** Opt-in only, one notification per day maximum, trivially disabled, correct
when the user travels. Verify what a PWA can actually schedule on iOS before promising it —
if it can't, ship the in-app morning card instead and say so in the brief.
**Files.** `public/sw.js`, notification module. **Size.** Large. **Needs Track F's F4 (offline/PWA depth).**

### D8 — MRT-grade upgrade *(no longer a stretch — re-scope pending, #247)*
With Track A's A9 (sky view factor, surface class), build a defensible MRT approximation and
compare it against published SOLWEIG outputs for one city block. Publish the delta honestly in
`docs/notes/heat-model.md` — including where we're worse. That comparison is also the most
credible thing this project could show an urbanist.

**Literature (2026-09-09, ROADMAP §5c).** Three corrections to the sizing above, from Buo et al.
2026 — the paper behind "ASU Cool Routes":
- **SOLWEIG splits in two, and we already own the expensive half.** Geometry (sky view factor,
  shadow volumes per sun position) is costly but computed **once per area** — that is **A6 + A9**.
  The radiation balance (six-directional fluxes → MRT) is **cheap per query** and only needs a
  live forecast. Their four-hours-per-24-h figure is dominated by redoing geometry hourly, which
  A6 exists to avoid.
- **Their blocker was LiDAR, not compute** — and it has a free global substitute at lower
  fidelity: OSM/vector-tile heights (BSM), the Meta/WRI 1 m canopy raster (CDSM — already A8's
  plan), Copernicus/SRTM (DEM, terrain only). *How much fidelity is lost is precisely what this
  checkpoint publishes.*
- **The stated comparison target is not public.** Their data statement is "available on request",
  so "compare against published SOLWEIG outputs" is blocked on a data request. Compare against
  their **published validation statistics** instead (d = 0.73, RMSE 8.4 °C, MBE −2.0, ISO 7726's
  ±5 °C band exceeded).

Also **#246** — the threshold-excess thermal dose, which is smaller and independent of this.

---

## Subagent plan

- **D2 and D3 are swarm-able** (disjoint: one is a service wrapper, one is pure math) once
  `WeatherHour` is committed.
- **Scout** for the science: "what erythemal dose formula do the standard references use, and
  what's the accepted skin-type factor table?" — bounded, high-value, and it keeps citations
  out of the implementation context.
- **D1, D4, D6 are solo** — shared UI surfaces.
- **Verifier on D3 and D4.** Health-adjacent numbers deserve a cold reader checking the
  method against the doc.

## Risks

1. **False precision.** "Burn time: 23 minutes" is a lie dressed as help. Ranges, uncertainty
   labels, and a linked method — or don't ship the number.
2. **Shadow ≠ zero exposure.** Diffuse sky radiation is real; a model that zeroes shadowed minutes
   overstates the benefit of the app's own routing. Get this right or the whole track loses trust.
3. **Weather call amplification.** Every panel wanting its own fetch will blow the free tier.
   One cache, one owner (D2).
4. **Sampling cost before A6.** A 14-hour sweep on the canvas sampler is 14 renders. Sample
   lazily in D1 and don't let the chart block the UI.

## Out of scope / hand-offs

- Shadow geometry and the sweep API → **Track A**.
- Route cost weighting → **Track E** (D supplies the profile weights; E applies them).
- Saved commutes → **Track E** (E8). PWA notification plumbing → **Track F** (F4).
- Medical advice, of any kind, ever.

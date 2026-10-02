# Photo chronolocation — the solver (S4a)

**Claim, kept narrow:** this automates the manual ShadeMap chronolocation
workflow — pin where the photo was taken, mark an object's top, base and shadow
tip, and read date and time off the sun model. No open, automated tool does
this; the novelty is in the execution, not in any new solar physics.

## Method

`app/lib/chronolocation/solver.ts` is the whole solver, and it is pure:

1. **Marks → observation** (`observeShadow`). The three pixel marks plus the
   photo's framing (camera heading, approximate hfov, width) become two numbers:
   the shadow's *travel azimuth* (degrees from true north) and the
   *length-over-height ratio*. Every mark is converted to a **bearing angle
   through the pinhole model** — `atan((2x/width − 1) · tan(hfov/2))` — never a
   linear share of the frame, so perspective scales cancel to first order in
   the ratio. The one thing the marks cannot fix is camera pitch (the horizon is
   not marked); the ratio is deliberately uncorrected for it, and the tolerance
   absorbs it for near objects — the instruction the panel (S4b) will give.
2. **Sweep** (`solveChronolocation`). Every local day of the year, every 2
   minutes of daylight, through suncalc (pinned 1.x, the same engine the shadow
   renderer uses). An instant matches when the predicted sun azimuth is within
   ±2.5° of the observed azimuth's opposite bearing **and** the predicted
   `1/tan(altitude)` is within ±7% of the observed ratio. Below 2° solar
   altitude and above a 20× ratio the sweep does not look — the ratio explodes
   there and no mark is worth that much.
3. **Windows, not dates.** Matching days are clustered (gap ≤ 3 days) into
   seasonal windows. The honest physics: the sun's declination is the only
   seasonal signal in one shadow, and it changes slowly, so a single shadow
   dates a photo to a **window of days on each side of the solstice** — at the
   default tolerances, roughly ±2–4 weeks — never to a single day. Every solar
   position recurs on two dates symmetric about a solstice, so two windows is
   the expected answer; one window means the truth fell in the solstice weeks
   where the two sides merge; three or more means the observation does not
   discriminate and the solver abstains (`ambiguous-geometry`).
   The *time of day* is what one shadow pins sharply: the best day's matching
   run is a contiguous band of minutes, typically 8–16 wide at these
   tolerances.
4. **Cross-check** (`crossCheckBand`). If a `ShadowField` (plus the pinned
   location) is supplied, seven minutes of the best day's band are sampled at
   the photo point: any material geometric shadow (> 0.15) where the photo
   shows the marked object in sun is a `conflict` on that candidate — the
   candidate keeps its numbers but carries the flag, and the panel can rank
   the pair by it. All-low-confidence samples read `inconclusive`, no field
   reads `no-coverage`.
5. **Abstention.** Overcast light and no measurable shadow
   (`marksShowNoShadow`: a tip within 2 px of the base) are reported, never
   guessed past. A year with no matching instant returns `no-match` with the
   nearest miss, so the caller can say how far off the observation was.

Tolerances: azimuth ±2.5°, ratio ±7%. These are *pixel-mark* tolerances, not
measurement tolerances — they are what hand-placed marks on a real photo are
worth. The ratio tolerance is deliberately tight because the ratio is the only
seasonal signal; doubling it roughly doubles the window width, and at ±25% the
two windows merge into one 103-day blob across the whole solstice (measured),
which is the overclaim this design refuses.

## What it must beat (from TRACK_S.md) — and what has and has not been shown

- **A Gemini vision time guess on the same photos.** Not shown: needs the photo
  set. A vision model given a photo can guess time-of-day from light color and
  shadows, but it cannot produce a date, and its time guess is unbounded near
  noon. The solver returns a bounded time band *and* two date windows. This is
  an argument, not a measurement — the PR says so.
- **GT-Loc's published 2.72 h mean error** (street-view chronolocation,
  holistic). GT-Loc guesses time from the whole image; this solver measures a
  marked shadow. On geometric fixtures the time band is 8–16 minutes wide —
  two orders tighter — but fixture marks are exact where photo marks are not,
  so this comparison only becomes honest with the photo set.
- **A human doing the manual ShadeMap workflow on a subset.** Not shown: needs
  the photo set and the human.

## Evaluation status — plainly

**The field evaluation is outstanding.** TRACK_S.md's eval needs a
self-collected NYC photo set (60+, trusted EXIF times, stratified by solar
elevation and season, including overcast shots that must abstain). I cannot
collect it; the owner can. What exists now is **geometric fixtures** only
(`app/lib/chronolocation/__tests__/solver.test.ts`, 15 tests): a round trip
through the real sun model at NYC in summer and spring (the truth's date is
inside the first window, the best day is the truth's day, the time band covers
the truth minute, the two windows straddle the solstice), abstention paths,
timezone-correct date labels, and the ShadowField cross-check consistent and
conflict cases against a real `createGeometryShadowField`. Fixtures prove the
sweep, the clustering, the honest window width, and the cross-check; they say
nothing about real photos. **Filed issue** for the photo-set evaluation so it
has a home: see the PR body.

## What S4b will add

Photo intake, point marking on the photo, the pin on the map, and the shell
mount. The solver's `ShadowMarks`/`PhotoFrame`/`solveChronolocation` interface
is the contract between them. Overcast photos abstain *before* a sweep runs
(`marksShowNoShadow`) so the user learns why immediately.

## Honesty limits (recorded so nobody has to rediscover them)

- One shadow dates a photo to a window, never a day. Any UI that shows a single
  date without a range is overclaiming, and the window-width test exists so a
  future narrowing has to confront the tolerance math.
- The camera's pitch is not marked, so the ratio is uncorrected for
  foreshortening along the view axis. Small for near objects, meaningful for
  far ones — the panel must instruct "mark a near, prominent object".
- suncalc's azimuth convention (0 = south, positive west) cost this checkpoint
  its longest debugging hour; the sweep's comparison comment is load-bearing.

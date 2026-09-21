# UX laws and the frontend-design skill, applied to Umbra

*Design research — U-track working note, 2026-09-20. Facts and law statements are
conventional; the per-surface applications are inferred and marked where confidence
splits. Companion to `docs/design/language.md` (the law) — this note proposes, the
language doc disposes.*

## Why this note exists

U3 finished the structural redesign of the route card. This note asks the next
question the owner raised: what would make the UI not just tidy but *distinctive* —
and what do the classical UX laws actually prescribe for the surfaces Umbra already
has? It also reads `.claude/skills/frontend-design/SKILL.md` as a critique lens and
records where the current UI trips its calibration list.

The laws are not independent. Most collapse into three jobs a walking UI must do:
**cut the decision space** (Hick, Occam, Pareto, Miller), **make the next touch
reachable and predictable** (Fitts, target distance, Jakob, Postel, Tesler), and
**keep the person oriented across time** (Von Restorff, serial position, peak-end,
Zeigarnik, Doherty). The per-law map below is grouped that way.

---

## Part 1 — The laws, mapped to Umbra's surfaces

### Cutting the decision space

**Hick's law** — decision time grows with the number of options. *Applied:* the
route stack already ranks (Recommended eyebrow) and states each card's trade-off in
one line — that is Hick-minimization: the user parses one comparison instead of N
metric sets. Remaining application: the assistant panel should never list more than
three itinerary options; the timeline's play/slide/date triad is already three
controls, and adding a fourth (e.g. speed) belongs behind a single "pace" affordance,
not a new visible control. *Inferred, medium confidence.*

**Miller's law** — chunking; ~4 items per perceptual group. *Applied:* the card's
verdict row (label + duration), shade row (bar + % + distance), trade-off line and
caption are four chunks, right at the limit. The collapsed metric grid (4 tiles) is
the selected-card chunk — fine, because it is only visible when requested. Watch
the DirectionsPanel reopened form: waypoint inputs, mode selector, shade-preference
slider, rain toggle, and the calculate button are five groups; the trip bar
collapsing them is also a Miller win. *Confident.*

**Occam's razor / Pareto principle** — the 80/20 of card content is duration +
shade %; everything else is detail. The U3 collapse already encodes this. The
remaining Pareto surface is the map itself: most sessions need only the timeline
and one card; the floating controls (3D, share, rain toggle) could live behind a
long-press or a single "more" control if the viewport ever feels crowded on small
phones. *Inferred; file before doing.*

### Making the touch reachable and predictable

**Fitts's law** — time to target grows with distance and shrinks with size.
*Applied:* the ≥44px floor in the design law is Fitts's floor; but Fitts also
rewards *edges and corners* on touch screens — the bottom sheet's collapsed state
(80px) is the prime thumb-zone real estate, which is why the trip bar belongs there.
The most-pressed control in DIRECTIONS phase is the card itself (select), and the
cards fill the sheet's full width: correct. The start button being full-width at
the bottom of the selected card is the textbook Fitts placement. *Confident.*

**Minimize target distance (space between related targets)** — related actions
should sit adjacent. *Applied:* Save / GPX / GeoJSON share a row on the selected
card; the trip bar's Edit affordance is the bar itself (whole-bar target). Watch
item: the reopened form's mode tabs (Walk/Transit) sit above the shade slider;
they are unrelated controls separated by unrelated content — grouping mode with
the Calculate button would shorten the decision→action path. *Inferred, medium.*

**Jakob's law** — users expect your map app to work like the map apps they know.
*Applied:* Umbra's deviations from convention must earn their keep. The amber-
means-sun rule is a deviation that pays (it encodes data), but the trip bar's
"Edit" reveal is a *less* conventional pattern than a visible form — it leans on
Jakob by keeping search, waypoints and the calculate button visually conventional
when the form is open. Do not further exoticize the form. *Confident.*

**Postel's law** — be liberal in what you accept. *Applied:* search accepts
messy input ("nyc library"), waypoint pins accept map-long-press imprecision, and
the assistant accepts vague day-trip prose. Where it must be tightened: numeric
inputs (pace overrides, if ever exposed) should accept "20 min/mi" and "12 km/h"
without error states. The one place NOT to be liberal: shadow claim precision —
the UI states uncertainty rather than accepting an under-specified query and
inventing a confident number. *Confident.*

**Tesler's law** — complexity doesn't disappear, it moves. *Applied:* the U3
collapse moved complexity from the user's eye (every card showed everything) to
the component (selected card renders detail). The designer's complexity budget
went into `routeTradeoff.ts` so the user's complexity budget buys a glance. Any
further "simplification" of the card (e.g. hiding the provenance caption) would
move complexity *back* onto the user as distrust. *Confident.*

### Keeping the person oriented across time

**Von Restorff effect** — the distinct thing is remembered. *Applied:* the design
law already spends distinctiveness carefully: amber appears exactly once (the
now-marker), the Recommended eyebrow appears exactly once (the recommended card).
Two isolated elements is the ceiling — a third always-on accent would dilute both.
*Confident.*

**Serial position effect** — first and last items are remembered best. *Applied:*
route order is rank order, so the first card is the recommendation — but the last
card is also primacy-privileged, and it's the weakest option. If the stack ever
grows past three cards, the partial/failed route notice should move *above* the
weakest viable card, not trail the stack. Also: within a card, the caption (last
line) is provenance — exactly where end-position memory wants the disclaimer. *Confident.*

**Peak-end rule** — journeys are remembered by their peak and their end. *Applied:*
the arrival moment (`ArrivalPanel`) is the end, and it is currently the least
designed surface in the flow — a plain summary. A single deliberate moment there
(what the walk *earned*: "you walked 340 m and spent 2 of 6 minutes in sun")
is the cheapest peak-end investment in the app. *Inferred; candidate for a
future checkpoint.*

**Zeigarnik effect** — interrupted tasks are remembered; in-progress indicators
exploit this. *Applied:* the calculating state (`routeProgress` stages) already
narrates its steps; the right use is to keep the trip bar showing the *current*
trip while the user edits waypoints (in-progress state visible), which the
collapse does by keeping the bar during recalculation. Do not add spinners
anywhere a stage line can speak instead. *Confident.*

**Doherty threshold** — response < 400ms feels productive. *Applied:* routing
takes seconds (Overpass, transit graph), so the app's actual lever is *perceived*
progress: staged status lines and the already-present skeleton states. The
timeline drag is the 400ms-critical path — any added work in its pointer pipeline
(more layer updates per frame) directly violates this law. Measure before adding
timeline features. *Confident.*

### Gestalt family (proximity, similarity, Pragnanz, uniform connectedness)

**Law of proximity** — nearness implies grouping. *Applied:* the card's caption
parts joined with " · " read as one chunk because they share a line and type size;
the metric tiles group by 8px gaps against the card's 12px outer rhythm. Watch:
the reopened form stacks SavedRoutesSection directly above waypoint inputs with
equal spacing — they are different *kinds* of content and need a stronger divider
than spacing alone. *Confident.*

**Law of similarity** — alike things look alike. *Applied:* all route cards share
identical skeleton (verdict row, shade row, trade-off, caption) so the *differences*
(duration, shade %) are what pop — similarity is what makes the comparison work.
The rain mode card is deliberately the same skeleton with dry% — correct. *Confident.*

**Law of Pragnanz** — ambiguity resolves to the simplest stable reading. *Applied:*
the shade bar is the card's one continuous visual variable; everything else is
text. A card with two bars (shade + heat) would force a split reading; the
conditions block stays in the selected card partly for this reason. *Confident.*

**Uniform connectedness** — connected regions are seen as one. *Applied:* the
selected card's `border-left` + L2 shadow binds the expanded detail to its card —
the detail region visibly belongs to the card, not to the sheet. The journey-legs
list uses numbered circles as connective regions across leg rows. *Confident.*

---

## Part 2 — The frontend-design skill as a critique lens

The skill optimizes for distinctiveness; the language doc optimizes for restraint.
Read together, the skill's calibration list (its "AI slop tells") is a checklist
Umbra can run over its own components. Honest self-audit as of U3:

| Skill's "generic tell" | Umbra today | Verdict |
|---|---|---|
| Cream + serif + terracotta default | Canopy palette, data-first | Not present |
| Near-black + acid accent | No | Not present |
| Broadsheet hairlines, zero radius | Hairlines exist, but radius 12/16/20 is part of the registry | Partial — watch hairline overuse in the sheet |
| Identical rounded cards, one radius, same shadow | Cards share a skeleton deliberately (similarity law) — but hierarchy is expressed: selected card = border-left + L2, unselected = hairline | OK |
| Tracked ALL-CAPS eyebrows | The Recommended eyebrow is all-caps tracked | **Trip wire** — it is one eyebrow, load-bearing (Von Restorff), and the skill allows deliberate choices; keep, but never add a second |
| 'A · B · C' middle-dot meta strings | The caption line is exactly this | **Trip wire** — the dots join three provenance facts; defensible as one chunk (proximity), but if a fourth fact is ever appended, switch to a second line |
| '→' in buttons | The trip bar uses → *as data* (origin→destination) | OK — it is the content, not decoration |
| Mono face for small data labels | None | OK |
| Fade-up entrances per section | None; motion is response-only | OK |
| Numbered markers on non-sequences | Journey legs are a real sequence | OK |

The skill's "spend boldness in one place" reading for Umbra: the boldness is the
**shadow bar** — the one continuous color variable on every card. Everything else
stays quiet. That is the element a visitor should remember.

The skill's writing rules are already half-adopted (active voice, "Find Shadowed
Route", plain error text). The gap: the design law's copy section (U5 scope) has
not run the assistant's answers or PlaceDetail through the "one element, one job"
test yet — U5's checkpoint is where the skill's writing section has most to give.

---

## Part 3 — Sourced digest: what shipped products do (landscape scout, 2026-09-20)

Findings verified against primary pages the same day; inferred items labelled.

**Time as the scrub dimension for route conditions.** Google Maps' Immersive View
for Routes overlays route + simulated weather + traffic in one scrubbable view —
time-of-day is how you read conditions, not just departure ([Google, 2023-11-02](
https://blog.google/products-and-platforms/products/maps/google-maps-immersive-view-routes/)).
Umbra already couples the timeline to the *map's* shadows; the un-shipped half is
coupling it to the *card's* numbers — dragging time re-rendering the trade-off
line and shade bar. That is the one structural idea here worth a checkpoint
conversation. *Inferred translation; the shipped pattern is verified.*

**Aggregate shade over a window, not one instant.** ShadeMap ships "shadow
accumulation" maps — a static raster of shade-hours over a window
([shademap.app](https://shademap.app/)). Umbra's per-instant rendering has no
card-level analogue; the HourlyExposureStrip is the natural home for a
"shade total for this trip window" figure. Verified pattern, inferred translation.

**Qualitative qualifiers beat raw deltas at a glance.** Transit flags
"squeaky-tight transfers or long walks" in the option list itself
([transitapp.com](https://transitapp.com/)) — the verdict is pre-digested in the
card, not computed by the user from numbers. Umbra's trade-off line already does
this; the borrowing is its *voice*: a named condition ("long walk between
stops") where a raw "+12 min" is doing two jobs. U5 copy scope. *Verified pattern,
inferred translation.*

**Hairline, text-only disclosure is the idiomatic progressive-disclosure form.**
Apple Maps' feature blocks use explicit "Open to read more" toggles with no
chevron chrome ([apple.com/maps](https://www.apple.com/maps/)); its HIG Materials
page is the canonical translucent-layering spec for content over maps
([HIG](https://developer.apple.com/design/human-interface-guidelines/materials)).
Matches Umbra's collapsed card as-built; nothing to change, one thing confirmed.

**Sun-arc on the map, not in a panel.** SunCalc draws a thin sun-path curve with
time ticks directly over the map ([suncalc.org](https://www.suncalc.org/)). A
small sun-arc glyph in the timeline (horizon line + sun dot at the slider's time)
would make "morning vs afternoon shade" instant without a legend. *Verified
pattern, inferred translation; U4 timeline scope, and Doherty-constrained — see
Part 1.*

**Pre-emptive, time-anchored guidance.** Transit GO's step guidance leads with
"when to leave for the stop, when your destination is approaching"
([transitapp.com](https://transitapp.com/)). The assistant panel and navigating
state can lead with one time-anchored verdict ("Leave 13:40 — sun behind you on
5th Ave") instead of instruction lists. *Verified pattern, inferred translation;
Track C/B scope.*

Unverified (flagged, not sourced): Citymapper's starred-best-route UI, Komoot's
surface-chip legends — marketing pages carry no checkable UI detail. Apple's
"Liquid Glass" (2025) is real but no fetchable citation was found; its
translucency principle is already covered by the HIG Materials page above.

**Net:** the Canopy language matches shipped industry patterns (verdict-first
cards, hairline disclosure, timeline-coupled data). The one genuinely additive
idea is the shade-hours aggregate (ShadeMap's accumulation raster translated to
the strip); the one structural idea is time-scrubbable card numbers.

---

## Part 4 — What this means next

Nothing here reopens U3. The note exists so the U4 (timeline + sheet choreography)
and U5 (copy) sessions can pull from it:

1. **U4:** Fitts (edge targets), Doherty (timeline pointer pipeline), proximity
   (divider above the form), serial position (stack order past 3 cards).
2. **U5:** the skill's writing section + peak-end (arrival copy), Miller (assistant
   option cap of three), Postel (accept messy pace/format input in copy tone).
3. **Filed, not built:** floating-controls Pareto consolidation; ArrivalPanel
   "what the walk earned" moment.

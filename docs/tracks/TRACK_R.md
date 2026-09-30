# Track R — Umbra Redesign 2.0

> **Charter:** move Umbra from Canopy (light paper, Inter, hairlines) to Umbra redesign 2.0 —
> occult civic ephemera printed on warm black: cream ink, one signal-orange accent that *is*
> the sun, a five-step ramp per meaning, hand-placed plates with hard unblurred shadows, print
> texture, and a deadpan tour-guide voice — without losing a single grounded number or any
> outdoor legibility.

**Class:** Product. **Runs:** strictly **sequential** — one session, one checkpoint, one PR,
exactly like Track U, whose design wave this succeeds. It edits the contested files
(`page.tsx`, `MapView.tsx`, `AppShell.tsx`, `DirectionsPanel.tsx`) by design, so no other track
may edit those while an R checkpoint touching them is in flight. Track U and Track R never run
at the same time.

**Reference:** `/home/wslunusn/portfolio/umbra_redesign_2.0.html` is the design-language
reference (tokens, type roles, plate/tilt/shadow geometry, texture, motion, voice, the Umbra
mapping). R0 copies it into the repo; from then on the in-repo copy is canonical.

**Naming (binding):** this work is called **"Umbra redesign 2.0"** everywhere — code, commits,
branches, PRs, issues, docs. Never name an outside product, studio or platform as its
inspiration; the public mirror publishes everything here.

---

## Current state

- **Active checkpoint:** R1 — registry and enforcement, next after R0's merge.
- **Done:** R0 — decision record, canonical spec, contrast table, reference and day/night
  vignettes; owner approved #120 for merge on 2026-09-29.
- **Open PRs:** none; R0 merged as #120.
- **Decisions made:** D1–D5 in `docs/design/decision.md` are owner-approved. Sun = signal
  orange; shade = cool; route = neutral cased line; UI theme may be overridden, while the
  basemap follows solar altitude. `docs/design/language.md` becomes binding with #120's merge.
- **Blocked on:** #91 — five pre-existing navigation-hook test failures also reproduced on
  unchanged `umbra/main`; R1 needs a green four-gate run before its PR can be ready.
- **Next action:** start R1 from merged `main` and coordinate #91 before opening its PR.
- **Last verified:** 2026-09-29; lint, typecheck, build, design:check, browser renders and
  mirror-guard pass; 1647 tests pass and 5 fail on the branch, with the same 5 on `main` (#91).

---

## Decisions R0 must settle (owner's call)

| # | Decision | Proposed default |
|---|---|---|
| D1 | Semantic mapping | Sun = signal orange ramp (the accent and the sun become one). Shade = cool ramp, aligned with the painted map shadow. Route = cream (night) / ink (day) line with a dark casing. Alternative: keep route blue, move shade to teal. |
| D2 | Theme model | Day theme (paper ground, warm ink) while the sun is up; night theme (warm black, cream) after sunset, driven by the app's solar model at the selected time. A manual UI override is allowed; the basemap follows solar altitude independently, so the dark basemap never carries daylight shadow pixels. R0 records the exact rule in `docs/design/decision.md`. |
| D3 | Fonts | Openly licensed only, self-hosted. Display: chiseled face (candidate Grenze). Label: wide stamped grotesque (candidate Archivo Expanded 800). Body: Jost. Numbers: a clean tabular heavy sans, never the display face. |
| D4 | Ornament boundary | Tilt, plates, grain and stamps only on labels, headings and story cards. Numbers, inputs, map controls and columnar content stay square, untextured and unrotated. Texture never over the map canvas. |
| D5 | Icons | Keep Material Symbols through R8 restyled to the new weights; R9 replaces the Umbra-core glyphs (sun, shade, tree, rain, transit, walk) with an original sigil set. |

---

## Guardrails (all checkpoints)

- **Never merge.** Every PR stays open for the owner's visual review; merging is sign-off.
- Every UI PR carries before/after phone shots (390×844) in **both themes** once R2 lands,
  under `docs/design/shots/r<n>/`. PR prose ≤4 sentences.
- `interface-reviewer` on any diff touching `app/components/**` or `app/page.tsx`;
  `grounding-auditor` whenever copy, labels or user-facing numbers change; `verifier` before
  every PR; `/gates` and `npm run design:check` green.
- CLAUDE.md invariant #5 binds every palette and basemap change: the painted shadow must stay
  blue-dominant under `isBlueDominantShadowPixel` after compositing. Re-run the canvas tests.
- Copy rules survive unchanged: verdict first, every number traceable with its uncertainty,
  no marketing adjectives, 11px caption floor, ≥44px touch targets.
- Focus stays visible on clipped plates (inner stroke; outlines get clipped). Reduced motion
  removes stamps and wipes; reduced transparency removes grain.
- No third-party brand assets, fonts or artwork — openly licensed fonts and original drawings
  only.

---

## Checkpoints

### R0 — decision record + canonical spec (docs-only PR)

Acceptance:
- The reference document lands in the repo (`docs/design/redesign-2.0/reference.html`).
- `docs/design/decision.md` gains a redesign 2.0 section settling D1–D5, with rendered day and
  night vignettes of the route card, timeline, search pill and arrival card committed under
  `docs/design/candidates/redesign-2.0/`.
- A contrast table: every text tier (cream 100/50/30/20%) and every data hue on both grounds,
  with the minimums the outdoor standard needs (body tier likely rises above 50%).
- `docs/design/language.md` is drafted for 2.0 but marked "adopted on merge"; the owner's
  merge is the sign-off.

Why docs-only: a palette is decided once; code against an unchosen mapping is rework.

### R1 — registry + enforcement

Acceptance:
- `app/globals.css` `@theme` carries the 2.0 roles for both themes (ground, ink, cream tiers,
  signal ramp, cool ramp, line quartets, category ramps, danger), plus tilt, hard-shadow,
  plate and motion tokens. Canopy-only tokens are deleted, not left dead.
- Fonts self-hosted (`@fontsource` or local files), preloaded; the Google Fonts links for
  Inter/Inter Tight leave `index.html`.
- `scripts/verify/design-tokens.mjs` learns the new rules (no literal rotations, blurred
  shadows or radii outside the registry); `design:check` exits 0.
- `.claude/rules/design-language.md`, `interface-reviewer` and `/design-audit` state the 2.0
  rules; the shot harness captures day and night.

### R2 — theme engine

Acceptance:
- Day/night switch driven by the solar model at the selected map time, with a manual override
  in Settings, persisted. State lives in a hook, not in `page.tsx` beyond wiring.
- The whole app renders legibly in both themes through role tokens; before/after shot matrix
  for every screen in the harness.
- Tests cover the switch thresholds (sun altitude, override precedence).

### R3 — primitives

Acceptance:
- Leaf components under `app/components/ui/`: Plate (irregular quad, inner stroke), Kicker,
  Tag, LineBullet, StampBadge, GrainSurface, plus motion utilities (stamp, ink-mask reveal).
- Each has a unit test and a visible focus state; none rotate interactive hit areas.

Parallelizable: one `builder` per primitive (disjoint new files).

### R4 — the map

Acceptance:
- Custom day basemap style (warm paper land, muted fields) and night style, swapped by theme;
  pins, popups, legend and route line (with casing) restyled.
- Invariant #5 re-verified on both styles; `shadowSampling` calibration and canopy water
  thresholds rechecked against the new basemap colors; `npm run e2e` (smoke and smoke-live)
  green.
- Main session only — `MapView.tsx` is contested.

Why its own checkpoint: a basemap change can silently break shadow detection; it must not
ride along with anything else.

### R5 — route cards and directions

Acceptance:
- `RouteCard`, `FloatingRouteCards`, `DirectionsPanel`, `NavigationStatusPanel` as transit
  strips: kicker plate, verdict, split bar, line bullets on transit legs.
- The card still fits the sheet's first snap point at 390×844; every number keeps its
  provenance; `grounding-auditor` clean.

### R6 — timeline and sheet

Acceptance:
- `TimelineSlider` as a timetable ruler with the sun-path diagram; `BottomSheet`, `SolarPill`,
  `DaySlider`; `HourlyExposureStrip` as a departures board.
- Drag and snap behaviour unchanged; touch audit updated.

### R7 — search, place detail, assistant

Acceptance:
- `SearchBar` results as a directory listing; `PlaceDetail` as a guidebook entry;
  `AssistantPanel` itinerary as a numbered day-trip leaflet with matching pins.
- Search behaviour and provider policy unchanged (`providerPolicy` test green).

Parallelizable: leaf panels via `builder`; `page.tsx` wiring stays in the session.

### R8 — arrival, saved routes, empty states, voice

Acceptance:
- `ArrivalPanel` as a postcard stamped with the umbra disc; `SavedRoutesSection` as ticket
  stubs; every empty state gets a kicker/title pair.
- Voice pass across the app: personality lives in kickers and empty states only;
  `grounding-auditor` on the full diff.

### R9 — icons, motif, motion, cleanup

Acceptance:
- Original sigil set for the Umbra-core glyphs; the umbra disc used for logo, now-marker, user
  dot and arrival stamp.
- Stamp and ink-reveal motion on verdicts and arrival, off under reduced motion.
- The About page as a poster layout that reflows on phones.
- `/design-audit` clean; no Canopy leftovers.

---

## Agent plan

| Work | Who |
|---|---|
| Inventories before R1 and R4 (every literal, every component on the old recipe, every basemap-color assumption) | 2–3 `scout`s in parallel, read-only |
| R0, R1, R2, R4, R5, R6, R8 | Main session, in order |
| R3 primitives, R7 leaf panels, R9 icons | `builder` per disjoint file set, in worktrees |
| Every PR | `interface-reviewer`, `verifier`; `grounding-auditor` when copy or numbers change; `scribe` for findings |

## Risks

- **Shadow detection** (invariant #5) on a restyled basemap — contained by R4 standing alone.
- **Sunlight legibility** of cream tiers, small tilted labels and texture — contained by R0's
  contrast table and D4.
- **Phone performance** of extra fonts, texture images and clip-paths — measure in R1 and R3
  on a throttled profile.
- **Contested files** shared with other tracks — schedule R2, R4, R5 and R7 wiring when no
  other session is editing `page.tsx` or `MapView.tsx`.

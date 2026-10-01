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

- **Active checkpoint:** #149 — transit line coins on the map, awaiting owner review.
  Owner's final pick, after four rounds (studies: swelling, shields, the coin, then six
  "line weld" studies in the artifact "Umbra Line Welds" with a research report): the
  **pressure bulb with a keyline**. The coin (31px, the line's published colour) is welded
  into its 5px line: one outline runs along the line's edges and turns into the coin through
  concave CAD fillets (`lib/lineBadges.weldOutline`), 4px at rest, swelling to 8 when gripped
  and drawn out toward the pull, up to 12 ahead and 3 behind (`bulbFillets`); a paper casing
  (warm black at night, `--color-map-casing`) strokes only the weld's two long edges and
  continues as a new GL casing under the whole ride (`train-route-lines-casing`, themed and
  ordered like the walking route's), so line and coin read as one cut-out shape. The ride is
  now opaque, so the weld meets it without a colour step. `components/lineCoinMarker.ts`
  redraws the weld each frame in the line's on-screen direction (rotation and tilt
  included); the marker is a zero-size anchor on the line with `subpixelPositioning` (no
  half-pixel seam) and a 44px grip riding on the coin. Because the map's stops and line lie
  under any DOM overlay, the weld is masked to the ride as drawn on screen (`rideWindow`, a
  wide band cut square at the ride's real ends, tilt included) and away from this ride's
  nearby stops (their drawn radius from `MapView`); the coin's disc stays unmasked so a
  dragged coin passes in front of a stop. Scale is measured on screen at the coin, and a
  resting coin keeps clear of sharp turns (`sharpTurns`) as of stops, since the weld is laid
  straight along the line. Motion is unchanged from the coin round except friction: the
  time slider's 0.009/ms plus 5% (`COIN_FRICTION` 0.00945, owner's tuning). Stops are ringed
  in their line's colour, board/exit a size up and named beside the ride; a resting coin slides
  clear of any stop; the terminus is not shown. DOM only for coin and names, never the canvas
  (#5); the stop rings and the new casing are canvas paint. The transit smoke test drags the
  coin off the line and proves by readback that it slid and still sits on the track.
- **R5 (merged):** R5a (#148) and R5b (#152). R5b adds `app/components/ui/Segmented.tsx`
  (`.umbra-segmented*`: square, 2px ink rule, selected = full ink inversion, ≥44px rows,
  inset focus, disabled on the 75% role with a strike), used by Walk/Transit, Sun/Rain,
  travel mode, wind source and Search/Draw; the Transit-off reason is a visible caption
  (#126's directions half). Every directions control is ≥44px; Find and ARRIVED share
  `.umbra-start-button` (uppercase). `NavigationStatusPanel` is a ticket: the route on a
  kicker plate, ruled cells that follow the card's rules exactly, and one itinerary (owner
  request): start pin, round dots on foot through each walk step, the line's bullet heading
  a solid bar in its colour that ends in a ring at the exit stop, dots on to the destination
  pin; the ride step names its wait so steps sum to Time.
- **Done:** R0 (#120), R1 (#122), R2 (#127), R3 (#132), R4a (#139), R4b (#141), R5a (#148) and
  R5b (#152) merged.
  R5a is the first consumer of R3's primitives: the option on a `Kicker plated`, `Tag` for
  Recommended (shade, or rain on rain cards; never orange), `LineBullet` per transit leg, and
  `Plate` now takes `button`/`a` (#128; a focused ink plate also takes the page-ink outline,
  since its cream band matches the page), though the start action ended up a square ink
  `.umbra-start-button` by owner call.
  `LineBullet accent` fills with the line's published colour; `lib/lineBulletInk.ts` picks the
  identifier ink by WCAG contrast (`--color-line-ink-{dark,light}`), or rings the identifier
  when neither reaches 4.5:1 (the 7's purple, the J/Z brown). The split bar is square and
  ink-ruled, shade against solid `--color-sun-signal`, with its basis stated under it
  (`routeSplitBasis`: distance for a walk, time outdoors for transit). After sunset at the
  route's own `evaluatedContext` time and place (`routeAfterSunset`, the theme's 0° rule),
  the card says "after sunset", draws no bar and drops the continuity/breaks cells and the
  per-leg shadow shares (`routeLegSummary(..., afterSunset)`); it used
  to read "100% shadow". A transit card's figure comes from its legs (`routeShadowShare`),
  because the route-level field goes stale after a refresh (#144). R4a adds `app/lib/basemapTheme.ts`:
  day (warm paper) and night (warm black) palettes, tokens `--color-basemap-{day,night}-*`,
  recoloured in place on the loaded outdoor-v2 style at `style.load` (never `setStyle`),
  classified by layer type/source-layer, and switched by `useUiTheme`'s `solar` through
  `MapView`'s `basemapTheme` prop — never the UI override. Invariant #5 rests on one bound:
  every basemap colour keeps warmth `(r+g)/2 − b` in −17..14, so sunlit ground is never
  blue-dominant, dawn shadow is detected, and a shadow's rim needs no more coverage than
  the harness grey (+0.05). Solar night now paints no shadow overlay or stale readback;
  rain protection and routing continue over the dark basemap. Night roads and paths use
  `#7c716a` and labels use `#fff9f3`; night stroke and text opacity are 1 and the loaded
  opacity returns in daylight. The palette also fixes two `main` faults: outdoor-v2's
  sunlit water was a false shadow, and its wood lost the dawn shadow. R4b moves every
  overlay to `--color-map-{day,night}-{route,casing,muted,sun}` (GL layers via
  `mapColor`/`applyOverlayTheme`; DOM via `--color-map-*` aliases under
  `html[data-basemap]`, set from `solar`): an opaque ink route on a paper casing by day,
  cream on warm black by night; sketch and station-connector lines cased the same way;
  A/B, sketch and assistant pins as one hollow/filled teardrop family
  (`app/components/mapPins.ts`, 44px square host, letter or number always shown); a
  reticle user dot; orange only on the sun diagram's daylight marks. No overlay colour is
  blue-dominant, so a drawn route no longer reads as shade (the old `#1d6ee0` did).
- **Open PRs:** #153 (fixes #149, transit line coins on the map). Follow-ups: #140 (Track G: unit flakes under load); #124, #125, #126 (R2);
  #130 (R3); #137 (labels in shade ~2:1), #138 (R6 sheet edge); #147 (night wording left in
  SolarPill, leg rows, route labels); #150 (waypoint × under 44px), #151 (segmented as radio); #154 (Track G: refresh timer after jsdom teardown); filed elsewhere from R5a: #144, #145 (E), #146 (A).
- **Decisions made:** D1–D5 in `docs/design/decision.md` are owner-approved and
  `docs/design/language.md` is binding. The route casing is paper by day, not dark
  (owner, R4b; `language.md` amended). Overlays follow the basemap theme, popups and
  panels the UI theme. R4a maps all trail and bike-route lines to the neutral path role (their
  magenta had no 2.0 meaning), and keeps outdoor-v2's residential wash translucent (`tint`).
- **Blocked on:** owner visual review of R5a (`docs/design/shots/r5/`). Owner calls settled
  in review and written into `language.md`: transit bars say "time outdoors share"; the
  start action is a square ink button with the hard shadow, not a clipped plate (D4); transit
  bullets keep each line's published colour (N yellow, L grey) so cards match the map.
  Still open from R4b: hollow A/filled B swap at night; the opaque night route covers labels.
- **Next action:** R6 — timeline and sheet (#138), after #149's review. #126 keeps its SettingsPanel/SaveRouteModal half.
- **Last verified (#149):** 2026-09-30 on Node 24; lint (0 errors), typecheck, 1,785 unit tests,
  build, design:check and e2e 16/16. The weld was checked on the live day and night maps at rest
  and mid-pull; a real-phone feel check is outstanding.
- **Last verified (R5b):** 2026-09-30 on Node 24; lint (0 errors), typecheck, 1,753 unit
  tests (one run hit the #140 `useNavigation` A4b flake; it passes alone and on re-run),
  build, design:check and e2e 16/16. Shots in `docs/design/shots/r5b/`.
- **Last verified (R5a):** 2026-09-30 on Node 24; lint (0 errors), typecheck, 1,742 unit
  tests, build, design:check and e2e 16/16 (smoke, smoke-live, nav-smoke). At 390×844 the
  selected card's verdict, bar and key sit inside the mid snap (bar ends ~y777 of 844 in the
  headless shot, ~31px lower than R4b); a real-phone check with browser chrome is outstanding.
- **Last verified (R4b):** 2026-09-30; lint (0 errors), typecheck, 1,711 unit tests
  (single run; #140 load flakes also on `main`), build, design:check and live-tile e2e
  16/16 pass, with the route-line pixel check now counting the day ink.
- **Last verified (R4a):** 2026-09-30 on Node 24; lint (0 errors), typecheck, 1,706 unit
  suite, build, design:check, diff check and live-tile e2e 16/16 pass. The live R4a
  phone frame reads 43.5% shadow pixels in daytime Sun, 0.0% at night in Sun mode,
  and visible rain protection at night. Rendered central road pixels read 3.36:1
  against park and cream label pixels read 15.3:1 against park; unit tests require
  roads and paths ≥3:1 and labels ≥4.5:1 across night ground and park surfaces.
  A real-phone outdoor look remains outstanding.
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

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

- **Active checkpoint:** R7c (#174), AssistantPanel as a numbered day-trip leaflet,
  stacked on R7b (PR #180). Verified place receipts receive the current map pin's
  number only while that pin is plotted; its 44px number focuses the exact map
  object. Ruled receipt lines preserve the source, age and confidence caption.
  The square 2px panel has an ink header band, square user turns and input, and
  44px reset, close, suggestion and send controls. Shots: `docs/design/shots/r7c/`.
- **R7b (open, #180):** PlaceDetail as a guidebook entry, stacked on R7a
  (PR #176). The entry is an `article`: a 44px Back row, the category on a tilted ink
  `Kicker` plate (fallback "Place"), the name as an `h2` in Grenze, then the square
  Directions start button directly under it (inside the first snap point), then a `dl`
  between 2px ink rules with one ruled line per fact the entry holds: Address always
  (with a 44px "Copy address" that says Copied / Copy failed, or "No address on file"),
  and Hours, Phone (`tel:`), Website, Rating ("9.1/10 · Foursquare") and Price only
  when present. Then one caption names what is missing ("Not shown here: hours, phone,
  website."), then the photo and an About `h3` when present. Removed: a fabricated "$$"
  price fallback, four "Photo" placeholders, four no-op action buttons, an empty
  accessibility row, empty review/description boxes and dead "People also search for"
  chips. In the app today only name, category, address and coordinates arrive
  (`handleSearchSelect`), so the fuller lines render only in tests; #178 carries the
  search row's hours, rating and photo through. Shots: `docs/design/shots/r7b/`
  (forced UI theme, because picking a place resets the time to now).
- **R7a (open, #176):** the first slice of R7 (search, place detail,
  assistant), split into R7a search (#172), R7b PlaceDetail (#173) and R7c assistant
  leaflet (#174). The search pill is one solid panel pill with a 2px ink rule and the hard
  offset shadow (no blur or translucency); while its field has focus a solid panel band and an ink ring wrap it (owner request: no map showing through); each icon in it
  is a square 44px target. Recent/Saved, the Foursquare typeahead and the merged submit
  results are one square directory: an ink header band (Archivo kicker: Recent, Saved,
  Places nearby or Directory, with an IBM Plex Mono "from map center" note when the row
  distances use the map center) labels each listbox. Each row shows the name (Jost 600), a dotted leader and the
  distance (Archivo Expanded tabular), with category/hours as an uppercase caption and a
  rating only where Foursquare gave one. The highlighted row inverts to ink, and the band keeps a
  2px panel foot so a highlighted first row never merges into it. Search logic, handlers,
  option ids and the provider policy are byte-for-byte unchanged; the generic pin/bookmark
  icon tiles are gone (they carried no information). Shots: `docs/design/shots/r7a/`.
  #171's fix (PR #179: Nominatim rows measured from the map center, not ~15,000 km away,
  and named by their OSM tag instead of a house number) is merged into this branch so
  the two PRs merge in either order. For R7b: `PlaceDetail` only ever
  receives name, category, address and coordinates (`handleSearchSelect`), yet renders
  a "$$" price fallback, four "Photo" placeholders, four no-op action buttons, an
  empty accessibility row and dead "People also search for" chips.
- **R6b (merged, #170):** the rest of R6. The phone sheet is square, with
  the timeline card's 2px ink top edge and an ink grip; drag, snaps and spring are
  unchanged. `SolarPill` is a square `Tag` and says "Sun down — no direct sun" on the
  route card's 0° rule (`routeAfterSunset`). It no longer calls night "low sun". It claims
  nothing about routing weight, because a direct walk's Pareto search never reads the
  intensity (#167). `HourlyExposureStrip` is a departures board: an ink header row, one
  button per hour column on a 2px ink rule, IBM Plex Mono 12-hour keys with an AM/PM row,
  the timeline's hour as an ink ticket key, and bars stepped by fifths through
  `--color-{sun,rain}-step-1..5`. Those tokens run light→darker by day and reverse at
  night, so the larger share is always the higher-contrast fill. A dash marks any hour
  without a reading, and "no reading" follows once sampling ends. The phone sheet now
  renders the board; it never had (umbrapriv #197, Track D). DaySlider was already
  redrawn in R6a. Shots: `docs/design/shots/r6b/`.
- **R6a (merged, #164):** the timetable ruler (first slice of R6). Ticks
  stand on a 2px ink rule with IBM Plex Mono hour labels in full ink under it, so the
  needle, which stops at the rule, never covers one. The band above is the real SunCalc
  altitude across the map-local day (`lib/sunPath.ts`, 0° on the rule, 90° at the top,
  replacing U4's stylised parabola). Night is a flat band wherever altitude ≤ 0°. The
  needle is orange with ink keylines while the sun is up and ink once it is down. Without
  a map place the ruler says so. The selected time is an ink ticket (no longer orange)
  with a Sun down cell when `solar` is night. The day-of-year ruler matches (44px; the
  seasonal sun/shade tints are gone). The card, buttons and Time/Date fields are square;
  an editing field takes a 2px ink border. The card keeps its 104px height. Drag, inertia
  and snap code is unchanged. Shots: `docs/design/shots/r6a/`.
- **#157 (merged, via #158):** show every boarding and transfer in the transit route card
  and navigation itinerary. The path already carries each line; the card had collapsed it
  to the first one. Walking turns now come from the access and exit routes rather than a
  fixed zero. The rail time, wait and exposure remain whole-trip figures; no per-line
  minutes are inferred. Each new boarding now flies a Transfer kicker flag from the
  change stop, with separate line-coloured shields for the arriving and departing stops
  and an arrow between them; the kicker is an arrow sign, tailed in the arriving line's colour,
  headed in the boarded line's, with Transfer in cream on ink. Same-station changes need no explicit transfer edge. The
  flag is a pointer-free DOM overlay and clamps inside the map. The longer itinerary keeps
  Start Navigating at the phone sheet foot and resets the sheet to its top on phase changes.
  Before/after phone shots in both themes are in `docs/design/shots/transit-transfer/`.
  A check of the supplied
  live route is outstanding after the local street-data request returned 503.
- **#155 (merged):** kicker flags at transit station doors.
  Each ride's board and exit door now has a compact dot and a dotted leader in the line's
  colour, leading to a ringed ink shield with the line coin and station name under a tilted
  Enter here / Exit here plate. The leader opens away from the train stop; the shield turns
  inward at a viewport edge so the instruction remains readable on a phone. Missing door
  data puts the flags on the board and exit stop dots. These are DOM overlays and never
  intercept map gestures. Day and night review shots are in `docs/design/shots/transit-badges/`.
  A real-phone feel check is outstanding.
- **R transit coin (merged):** #149, via PR #153.
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
- **Done:** R0 (#120), R1 (#122), R2 (#127), R3 (#132), R4a (#139), R4b (#141), R5a (#148),
  R5b (#152), the transfer itinerary (#158), R6a (#164) and R6b (#170) merged.
  R5a is the first consumer of R3's primitives: the option on a `Kicker plated`, `Tag` for
  Recommended (shade, or rain on rain cards; never orange), `LineBullet` per transit leg, and
  `Plate` now takes `button`/`a` (#128; a focused ink plate also takes the page-ink outline,
  since its cream band matches the page), though the start action ended up a square ink
  `.umbra-start-button` by owner call.
  `LineBullet accent` fills with the line's published colour; `lib/lineBulletInk.ts` picks the
  identifier ink by WCAG contrast (`--color-line-ink-{dark,light,white}`), or rings the identifier
  when none reaches 4.5:1. White fills the 7's purple and the J/Z brown. The split bar is square and
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
- **Open PRs:** R7b #180 (base R7a), R7a #176; #179 fixes #171 and is included in the R7a branch, but remains open and unmerged. R7b follow-ups: #177 (typeahead re-opens after a pick), #178 (place entry drops the row's hours/rating/photo; Directory distances freeze while panning), #181 (selected place pin and sheet offset, photo sizing, website scheme, shot coverage). R7a follow-up: #175 (row alignment, hours truncation, hover, focus vs highlight, grouping). R7c is active for #174. R6b follow-ups: #165 (design:check red on main: issue refs read as colours, three arbitrary offsets), #166 (Track D: night hours count as most shadowed), #167 (Track E: night Pareto detours), #168 (pill tiers stale after a time change), #169 (board column width, placement, desktop keys). R6a follow-up still open: #163 (ruler keyboard access). Older follow-ups: #140 (Track G: unit flakes under load); #124, #125, #126 (R2);
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
- **Next action:** owner review of R7a #176 and R7b #180, then R7c #174 in stack order. #126 keeps its SettingsPanel/SaveRouteModal half.
- **Last verified (R7c):** 2026-10-01 on Node 24; lint (0 errors, 79 baseline warnings),
  typecheck, 1,834 unit tests, build and e2e 11/11. design:check reports the 9
  findings already on main (#165), none new. The `interface-reviewer`,
  `grounding-auditor` and `verifier` reviews are clear; day and night 390×844
  and desktop before/after shots are in `docs/design/shots/r7c/`. The phone
  shot test taps stop 2 and verifies the map pin is visible after the leaflet closes.
- **Last verified (R7b):** 2026-10-01 on Node 24; lint (0 errors, 79 baseline warnings),
  typecheck, 1,833 unit tests, build and e2e 11/11. design:check
  reports the 9 findings already on main (#165), none new. Day and night 390×844 and
  desktop shots on the fixture basemap; a real-phone look and an `npm run dev` check of
  Copy are outstanding.
- **Last verified (R7a):** 2026-10-01 on Node 24; lint (0 errors, 80 baseline warnings),
  typecheck, 1,825 unit tests, build and e2e 11/11 (smoke and nav-smoke; no MapTiler key,
  so smoke-live did not run). design:check reports the 9 findings already on main (#165),
  none new. Day and night 390×844 shots plus desktop result shots on the fixture basemap;
  a real-phone look in sun and a keyboard-focus pass in `npm run dev` are outstanding.
- **Last verified (R6b):** 2026-10-01 on Node 24; lint (0 errors, 80 baseline warnings),
  typecheck, 1,824 unit tests, build and e2e 11/11 (smoke and nav-smoke; no MapTiler key,
  so smoke-live did not run). design:check reports the 9 findings already on main (#165),
  none new. Day and night 390×844 shots on the fixture basemap; a real-phone look in sun,
  rain-mode and desktop board shots are outstanding.
- **Last verified (R6a):** 2026-10-01 on Node 24; lint (0 errors, 80 baseline warnings),
  typecheck, 1,810 unit tests, build, design:check and e2e 11/11 (smoke and nav-smoke; no
  MapTiler key in the worktree, so smoke-live did not run). Day and night 390×844 shots on
  the fixture basemap; a real-phone look in sun is outstanding.
- **Last verified (#157):** 2026-10-01 on Node 24; lint (0 errors, 81 baseline warnings),
  typecheck, 1,806 unit tests, build, design:check and e2e 18/18. Day and night phone shots
  show filled 7 bullets, the change station, and the arrow-sign Transfer flag on the map. The supplied
  live route could not be checked locally because its street-data request returned 503;
  a real-phone feel check is outstanding.
- **Last verified (#155):** 2026-09-30 on Node 24; lint (0 errors, 81 baseline warnings),
  typecheck, 1,791 unit tests, build, design:check and e2e 16/16. Day and night shots show
  the station-door flags fully on screen; a real-phone feel check is outstanding.
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

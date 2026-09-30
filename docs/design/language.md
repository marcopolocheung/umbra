# Umbra redesign 2.0 — design language

**Adopted on merge of the R0 PR.** Until that merge, the Canopy version on `main` is binding. This file becomes Umbra's canonical visual spec at merge; [the R0 decision record](decision.md#umbra-redesign-20--r0-decision-2026-09-29) settles the choices and contrast calculations, and the [in-repo reference](redesign-2.0/reference.html) supplies the broader print vocabulary. R1–R9 move the app to this spec in order. During that migration, existing runtime values stay valid until their checkpoint replaces them; no docs-only change is a claim that the UI already changed.

## Meaning, surfaces, and theme

- **Sun/exposure/heat:** one signal-orange ramp. Orange means the sun, including the now-marker, sun share of a split bar, UV and heat data, and the arrival sun-time stamp. Orange is never a generic recommended badge, CTA or decorative line.
- **Shade:** cool blue ramp, visually aligned with the painted blue shadow. The map shadow renderer stays blue-dominant after compositing as required by `CLAUDE.md` invariant #5; R4 verifies every basemap and paint change. **Walking route:** neutral ink line on a paper casing by day, cream line on a warm-black casing by night (the casing always contrasts with the line; R4b, owner-approved), with separate start/end marks, so it does not borrow the shade hue. Route, pins and stops follow the basemap theme, not the UI override.
- **Trees/canopy:** green ramp. The existing map paint is a renderer constant until R4 calibrates it; app chips, cards and legend use the matching semantic role. **Rain/shelter:** purple ramp. **Danger/errors:** red ramp. Transit lines use their own published colours (the N stays yellow, the L grey) so a card matches the line the map draws; each line also has a letter/number bullet, and its identifier takes whichever ink reads at 4.5:1 on that colour, or sits in a ring of the colour when neither does. The blue, green and yellow quartets below remain the `LineBullet` primitive's reference bullets.
- **Grounds:** day paper `#EFE4D2` with panel `#F8EFDF` and ink `#1B1512`; night warm black `#0E0C0B` with panel `#171412` and cream ink `#F4E6D1`. Neither theme relies on transparent cards over the map for reading.
- **Automatic theme:** day when the app's solar altitude for the selected map place/time is above 0°, night at or below 0°. Settings may force either **UI** theme and persist it. The **basemap always follows solar altitude**, so forcing dark UI during the day retains the daylight basemap and its tested shadow pixels. The Settings copy must explain this scope. R2 implements the state and tests; R4 implements basemap switching.

### Five-step ramps and line quartets

These are source values; R1 registers role names, not generic color utilities. Steps are light / bright / base / dark / darker. Choose text steps by theme and test them on the actual surface: the contrast table in `decision.md` records every step on both grounds.

| Meaning | Light | Bright | Base | Dark | Darker | Text role |
|---|---|---|---|---|---|---|
| Sun | `#FFD18D` | `#F08A5D` | `#DD6638` | `#A8411A` | `#6F3806` | Night bright; day darker |
| Shade | `#BDCBFF` | `#7A9EDD` | `#4D75C3` | `#4156A0` | `#243265` | Night light on panels; day darker |
| Canopy | `#D3FC96` | `#97DA79` | `#649717` | `#4C7113` | `#1F3400` | Night bright; day darker |
| Rain | `#E7C8FF` | `#CE90FF` | `#8A55B3` | `#613484` | `#362147` | Night bright; day dark |
| Danger | `#FFB4A8` | `#ED4A4B` | `#D73232` | `#A91C25` | `#5F0C17` | Night light; day darker |

For actual transit line bullets, the reference quartets are blue `#60CDE3 / #10130D / #0C1B1D / #1A3237`, green `#97DA79 / #0E1A08 / #101B0A / #2C3D24`, and yellow `#FFE14D / #0B0B0B / #1F1C0C / #3C361A` (accent / badge ink / ground / plate). R1 may adapt the ground and plate to the day theme while preserving the line's identity and contrast. A colored line alone must never be the only distinction; show its identifier.

### Contrast and outdoor reading

- Small text must reach **4.5:1**, essential graphical boundaries **3:1**; primary reading targets **7:1**. Captions are **at least 11px**, including map metadata. Primary ink is 15.88:1 on night ground and 14.36:1 on day ground.
- Use full ink for primary numbers and copy. The reference's 50% cream is only 4.55:1 on night ground and 3.26:1 on day ground; its 30% and 20% tiers fail text contrast on both. The adopted body tier is at least 75% ink on a solid ground (9.11:1 night, 7.04:1 day), and it is retested on panels. The 30%/20% tiers are decorative only, never captions, placeholders or disabled labels needed to operate the app.
- For map overlays, use a solid ground and contrast against that ground. No grain or translucent veil covers the map canvas or obscures the path. If a data hue is too faint as text on one ground, use the theme's text step or ink-on-fill pair; do not rely on font weight to excuse a failing ratio.

## Type and composition

| Role | Face | Use |
|---|---|---|
| Display | Grenze 600 | Place names, postcard titles, guidebook headings. No outdoor numeric verdicts. |
| Stamped labels | Archivo Expanded 800 | Uppercase kickers, station/line bullets, short badges. Keep 11px floor. |
| Reading | Jost 400/500/600 | Body, controls, source and uncertainty lines. |
| Numbers | Archivo Expanded 800 with `font-variant-numeric: tabular-nums` | Duration, percent, time, distance and other aligned verdicts. Never tilt. |
| Compact numeric keys | IBM Plex Mono 400 | Timetable ticks and provenance when ≥11px and contrast passes. |

All four families use openly licensed, self-hosted font files. [The specimen source and licenses](candidates/redesign-2.0/preview.html) are committed with R0; R1 ships the production subset in `public/fonts/`, preloads it, and removes the Inter Google Fonts links. The preview is a design specimen, not a shipped component library.

Surfaces borrow recognizable printed formats: a route card is a transit strip, the timeline a timetable ruler, the hourly strip a departures board, the search list a directory, a place a guidebook entry, an itinerary a numbered leaflet, arrival a postcard, and saved routes ticket stubs. The format helps scanning; it does not add a second number or decorative metric. At 390×844 the selected route card still fits the sheet's first snap point after R5.

Use a small irregular quadrilateral for **decorative** kicker plates and stamps; tilt about 1° where it helps the pasted-paper feel. Shadows are offset with **zero blur**. Decorative grain stays inside paper surfaces. Numbers, inputs, map controls, route geometry, aligned rows and the map canvas are square, untextured and unrotated. Interactive hit areas stay rectangular and ≥44×44px even if their visual plate is clipped. A clipped focus target needs a visible inner focus stroke, because the outer outline may be cut away.

## Component recipes

- **Route card:** small neutral kicker plate → duration and shade verdict in square tabular numbers → cool/sun split bar with its basis stated (**distance share** for a walk, **time outdoors share** for a transit trip, whose figure weights walks and a sampled stop wait by seconds) → one plain trade-off line → source, scope and uncertainty caption. When the sun is below the horizon, omit the daylight shade percentage and split bar and say why. Recommendation is a shade or neutral label, never orange. Transit legs get line bullets with identifiers. The start action is a control: a square ink button with the hard offset shadow, never a clipped or tilted plate.
- **Timeline:** one selected local time, a sun-path diagram, and a timetable ruler. The orange dot is solar data; unsampled or unavailable periods have explicit labels rather than reading as zero. A day/night change follows selected time, not wall-clock time.
- **Search:** one solid search pill, ≥44px tall, with a directory-style result list. Provider policy remains binding: Nominatim runs on explicit submit, while permitted Foursquare suggestions may appear during typing. Never imply a missing rating or provider result exists.
- **Arrival:** postcard title and umbra-disc stamp above one sun-time verdict. Its caption keeps the fixed pace, walk scope, any excluded transit ride and shadow-estimate uncertainty with the number. If exposure is unknown, no bar or invented sun minutes appear.
- **Map:** day paper basemap and night style are an R4 change. Pins, popups, legend and neutral cased route line must remain legible over both. R4 reruns canvas tests for `isBlueDominantShadowPixel`, sampling calibration and canopy water thresholds before the dark basemap ships.

## Voice, icons, motion, and enforcement

The voice is a deadpan tour guide in **kickers and empty states only**. Verdict first, then what the number covers, then the method or uncertainty. No marketing adjectives. Every user-facing number has a traceable basis; the illustrative values in [R0 previews](candidates/redesign-2.0/day-phone.png) are explicitly labelled as examples, not app output. The existing route, search, assistant and arrival truth rules survive the visual migration.

Material Symbols remain through R8 with the new weights. R9 introduces original sun, shade, tree, rain, transit and walk sigils and repeats one original umbra disc across logo, now marker, user dot and arrival. No third-party brand assets or artwork. Motion is a 0.1/0.2/0.3-second stamp or ink reveal on a small number of verdict and arrival moments; reduced motion removes those effects. Reduced transparency removes grain. Neither preference hides focus, numbers or source text.

R1 makes `app/globals.css` the registry for these roles and updates `npm run design:check`; component work then consumes roles rather than literal hex, radius, rotation or shadow values. Every UI checkpoint ships 390×844 day/night shots after R2, reviews bright-sun legibility and focus, and runs the four project gates. R4 alone changes basemap colors, and R9 removes remaining Canopy names after the final audit. The owner merges each checkpoint separately; no session merges its own PR.

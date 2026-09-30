---
paths:
  - "app/**"
  - "index.html"
---

# Umbra redesign 2.0 design language

`docs/design/language.md` and its R0 decision record are binding. `app/globals.css`
registers the implemented roles. R1 applies the day palette and self-hosted type; the
`data-theme="night"` palette is available for preview, while R2 owns automatic switching.

## Meaning and reading

- Sun is signal orange and means actual sun, heat, or exposure. Shade is cool blue,
  canopy is green, rain/shelter is purple, and danger is red. A walking route is
  neutral ink/cream. Transit color always accompanies a line identifier.
- Day ground/panel/ink are `#EFE4D2` / `#F8EFDF` / `#1B1512`; night ground/panel/ink
  are `#0E0C0B` / `#171412` / `#F4E6D1`. Readable secondary text uses the 75% ink
  role, not the 50/30/20% decorative tiers.
- Text reaches 4.5:1, primary reading targets 7:1, and essential boundaries
  reach 3:1 on the actual solid surface. Captions are at least 11px. Touch targets
  are at least 44px. No grain or translucent veil covers the map canvas.
- Grenze 600 is for display words; Archivo Expanded 800 is for stamped labels and
  tabular numbers; Jost is body/controls; IBM Plex Mono is for compact keys at 11px
  or larger. Numeric verdicts are never set in Grenze or tilted.

## Geometry and motion

- Small tilts, clipped plates, and stamps belong on decorative labels, headings,
  and story cards. Numbers, inputs, map controls, route geometry, and aligned rows
  stay square, untextured, and unrotated. A clipped focus target needs an inner
  stroke; its hit area stays rectangular and at least 44px.
- Shadows have an offset and zero blur. Named radius, rotation, plate, shadow, and
  motion values live in `app/globals.css`; no literal geometry is added elsewhere.
  Reduced motion removes stamps and reveals; reduced transparency removes grain.
- The map renderer's current paints are pinned until R4. Any palette or basemap
  change reruns canvas tests for `isBlueDominantShadowPixel` after compositing.

## Enforcement and review

- `npm run design:check` tests and scans the registry. It rejects off-registry
  UI colors, numeric arbitrary Tailwind values, and literal radii, rotations,
  blurred shadows, or drop-shadows outside the registry.
- `interface-reviewer` checks UI diffs at 390×844 in day and night. `/design-audit`
  is a read-only inventory. Preserve verdict-first copy, sourced numbers, and
  uncertainty wording. Track R's owner reviews each checkpoint PR before merge.

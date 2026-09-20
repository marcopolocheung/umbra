---
paths:
  - "app/**"
  - "index.html"
---

# Design language

The canonical spec is `docs/design/language.md`; this file states how it is enforced.
Editing `app/**` means editing inside the Canopy language — the binding rules below are
the law, not a style preference.

## Binding rules (same words as language.md §Binding)

- **The one warm colour is sun data** — `--color-sun` `#A15C00` appears only where the
  sentence is about sun/exposure/heat (now-marker, solar pills, UV columns). Never chrome
  decoration.
- **Data states stay** route `#1D6EE0`, sun `#A15C00`, shade `#2A6A4E`, danger `#B3261E`;
  chrome (eyebrows, rank chips, selection, pins, CTAs) is ink/route/shade — no red, no
  decorative amber.
- **Surface rules:** paper canvas + raised white, hairlines preferred over shadows, L1/L2
  elevation only, radius 12/16/20 (+999 for the search pill and small status chips).
  Backdrop blur only on the over-map search pill at ≥70 % white.

## Enforcement path (U2 is landed — this is now mechanical)

1. **Registry.** Colours, radii, shadows, spacing and type live in `app/globals.css` `@theme`.
   No literal hex/rgba and no numeric arbitrary values (`rounded-[…]`, `w-[…px]`) outside it.
   Adding a token is fine: declare it in the registry **and** note the role in
   `docs/design/language.md` in the same PR.
2. **Gate.** `npm run design:check` (`node scripts/verify/design-tokens.mjs --all`) scans
   every `.tsx`/`.css` under `app/` and must exit 0 before a PR opens.
3. **Hook.** `.claude/hooks/lint-changed.sh` runs the same linter on the lines an edit just
   added (`--files <changed>`), so a new literal surfaces in-session; it reports, never blocks.
4. **Review.** `interface-reviewer` diffs UI changes against `docs/design/language.md` plus
   the outdoor standard. `/design-audit` is the read-only health pass.

## Mobile is the product

- Review at 390×844 first (`npm run shots`). Wide layouts must not break, but wave effort
  is phone-first. `interface-reviewer` constrains regardless of viewport.

## The look must not betray the claims

- Palette work respects CLAUDE.md invariant #5 (shadow colours stay blue-dominant under
  `isBlueDominantShadowPixel` after compositing). Test the canvas after palette changes.
- Text is part of the design: verdict-first, numbers traceable with uncertainty stated,
  no marketing fluff. When a UI number exists only in the language doc's inventory of
  prettiness, it's a regression.

## Process

- Any UI diff → `interface-reviewer` + before/after phone shots in the PR. Any changed
  user-facing number → `grounding-auditor`.
- Visual sign-off belongs to the owner for every PR in this track. Merging is the sign-off;
  do not self-merge.

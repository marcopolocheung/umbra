---
paths:
  - "app/**"
  - "index.html"
---

# Design language

The canonical spec is `docs/design/language.md`; this file states how it is enforced.
Editing `app/**` means editing inside the Strata (Carmine) language — the binding rules
below are the law, not a style preference.

## Binding rules (same words as language.md §Binding)

- **Carmine `--color-chrome` `#A40000` is chrome-only** — eyebrows, rank chip, selection,
  origin/destination pins. It never encodes a data state.
- **Data states stay** route `#155FD6`, sun `#B34A00`, shade `#187C46`, danger `#A11111`,
  on canvas `#F6F2E9` with ink `#211629`. No new hues per component.
- **No backdrop blur.** Surfaces are solid raised/canvas.

## Enforcement path (U2 is landed — this is now mechanical)

1. **Registry.** Colours, radii, shadows, spacing and type live in `app/globals.css` `@theme`.
   No literal hex/rgba and no numeric arbitrary values (`rounded-[…]`, `w-[…px]`) outside it.
   Adding a token is fine: declare it in the registry **and** note the role in
   `docs/design/language.md` in the same PR.
2. **Gate.** `npm run design:check` (`node scripts/verify/design-tokens.mjs --all`) scans
   every `.tsx`/`.css` under `app/` and must exit 0 before a PR opens. The gate is what the
   CI-adjacent `/gates` and the PR review look at.
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

---
paths:
  - "app/**"
  - "index.html"
---

# Design language

The canonical spec is `docs/design/language.md`. Until it exists (pre-U2), this file is
**advisory** — read it as "the wave is coming, do not add more debt."

## Tokens are the law (after U2)

- Colors, radii, spacing, shadows and type come from the token registry in `app/globals.css`.
  No literal hex/rgba outside it, no arbitrary `-[...]` sizes the scale doesn't define.
  Adding a token is fine: put it in `globals.css` and note the decision in
  `docs/design/language.md` in the **same PR**.
- `scripts/verify/design-tokens.mjs` is the mechanical check — `npm run design:check` gates,
  and the `lint-changed` hook reports every changed line that offends (it never blocks).

## Mobile is the product

- Review at 390×844 first (`npm run shots`). Wide layouts must not break, but wave effort
  is phone-first. Check `interface-reviewer` constrains regardless of viewport.

## The look must not betray the claims

- Palette work respects CLAUDE.md invariant #5 (shadow colours stay blue-dominant under
  `isBlueDominantShadowPixel` after compositing). Test the canvas after palette changes.
- Text is part of the design: verdict-first, numbers traceable with uncertainty stated,
  no marketing fluff. When a UI number exists only in the language doc's inventory of
  prettiness, it's a regression.

## Process

- Any UI diff → `interface-reviewer` + before/after shots in the PR. Any changed
  user-facing number → `grounding-auditor`.
- Visual sign-off belongs to the owner for every PR in this track. Merging is the sign-off;
  do not self-merge.

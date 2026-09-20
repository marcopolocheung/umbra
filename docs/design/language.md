# Umbra Design Language — canonical spec (Track U)

**Chosen: Strata — Carmine colourway** (owner's settled choice, review comments 2026-09-20;
see `docs/design/decision.md` §0, §2b and §6). The owner's merge of that decision PR is the
sign-off and this sentence records it. Until U2 lands this file is a skeleton; after U2 it is
the single source of truth and `.claude/rules/design-language.md` stops being advisory.

## Status: skeleton (U1)

U2 fills this file from the chosen candidate:

- **Roles** (surface / raised / ink / ink-muted / hairline / route-blue / sun-exposure /
  shade-good / danger + the one-accent rule from decision.md §4).
- **Scale** (radius 12/16/20 + 999 search-only; spacing; elevation L1/L2 + hairline preference).
- **Type** (Inter Tight display / Inter body, sizes, tracking, tabular numerals).
- **Icons & glass policy** (blur only on the over-map pill, ≥70 % white).
- **Copy voice** (verdict-first, numbers traceable with uncertainty stated, no marketing words —
  D6 is non-negotiable).
- **Component recipes** (route card, timeline, search pill from decision.md §4 vignettes).

Nothing in the app reads this file yet; app code must not change until this is landed by U2.

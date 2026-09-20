# Umbra Design Language — canonical spec (Track U)

**Chosen: Strata — Carmine colourway** (owner's settled choice, review comments 2026-09-20;
see `docs/design/decision.md` §0, §2b and §6). The owner's merge of that decision PR is the
sign-off and this sentence records it. This file is now the single source of truth for Umbra's
UI, and `app/globals.css` is its token registry — the two carry the same binding rules; change
them only together, in the same PR.

## Binding rules (make these explicit, then follow them)

1. **Carmine `--color-chrome` `#A40000` is chrome-only.** It marks *interface furniture* —
   eyebrows, the rank chip ("Recommended"), selection states, origin/destination (and
   waypoint) pins, primary actions. It **never encodes a data state**: no metric, route,
   sun/shade tier, warning or error is ever painted carmine.
2. **Data states have fixed colours.** Route `--color-route` `#155FD6`, sun `--color-sun`
   `#B34A00`, shade `--color-shade` `#187C46`, danger `--color-danger` `#A11111`, on cream
   canvas `--color-canvas` `#F6F2E9` with ink `--color-ink` `#211629`. A UI element that
   reports a number of sun, shade, rain or transit borrows the role colour, never a new one.
3. **Surfaces are solid.** Strata has no backdrop blur (`decision.md` §2, research note (c)):
   panels and popups are opaque `--color-raised`/`--color-canvas`, so glare cannot eat text.
   The two renderer colours the canvas tests pin — the shadow layer's blue and canopyPaint's
   sea-green `#2E8B57` — are data-plane constants, out of the chrome palette, and are not
   re-tinted (`app/lib/shadow/LocalShadowAdapter.ts`, `app/lib/canopyRaster/canopyPaint.ts`).
   The `--color-canopy-map` token exists only so the legend mirrors what the map paints.

## Colour roles (registry: `app/globals.css` `@theme`)

| Token | Value | Role |
|---|---|---|
| `--color-canvas` | `#F6F2E9` | App background, chip fills on raised cards |
| `--color-raised` | `#FFFFFF` | Cards, sheets, popups |
| `--color-raised-warm` | `#FFFDF7` | Second-level card / hover on canvas |
| `--color-ink` | `#211629` | Primary text (17.3:1 on raised) |
| `--color-ink-muted` | `#5B526A` | Secondary text (7.3:1) |
| `--color-ink-faint` | `#6E6280` | Placeholders, disabled glyphs (5.6:1) |
| `--color-hairline` | `#E8DFD0` | Borders; preferred over shadows |
| `--color-hairline-strong` | `#CBC3B6` | Focusable-outline borders, stronger dividers |
| `--color-chrome` | `#A40000` | **Chrome only** — rule 1 (8.1:1) |
| `--color-on-chrome` | `#FFFFFF` | Text on chrome |
| `--color-chrome-soft` / `-mid` | carmine 8% / 16% | Selection/eyebrow fills |
| `--color-route` | `#155FD6` | Route data: lines, transit fallback, links (5.8:1) |
| `--color-sun` | `#B34A00` | Sun/exposure data (5.4:1) |
| `--color-shade` | `#187C46` | Shade/tree/arrival data (5.2:1) |
| `--color-danger` | `#A11111` | Errors — a *state*, never confused with chrome red |
| `--color-route/sun/shade-strong, -soft, -mid` | — | Hover, soft-fill and over-map variants of the three data hues |
| `--color-on-route/sun/shade/danger` | `#FFFFFF` | Text on solid data fills |

`?soft` fills and any alpha wash are expressed as `color-mix(in srgb, var(--color-X) N%, transparent)`
or as `--color-X-soft` tokens — never as new literal `rgba()` values in components.

## Type scale (Inter only; `--font-sans`)

| Step | Token | Sizing | Use |
|---|---|---|---|
| Verdict | `--text-verdict` | 22 / 700, `-2%` tracking | The one display voice: the headline number |
| Body | `--text-body` | 15 / 22 | Paragraph text |
| Small | `--text-small` | 13 / 18 | Dense card reading |
| Eyebrow | `--text-eyebrow` | 11 / 600, uppercase, tracked | Section labels ("NAVIGATION ACTIVE") |
| Caption | `--text-caption` | 10, tabular | Map-adjacent metadata |

Numbers use `tabular-nums`. One family, one display step — no second typeface.

## Radius steps, spacing, elevation

- **Radius** is exactly **8 (controls) / 12 (cards) / 14 (sheet)**; search is a plain
  12-radius *rectangle*, never a pill. The registry pins every `rounded-*` utility onto the
  scale via `@theme` overrides, so components cannot invent their own radius.
- **Spacing** is a 4 px grid. `--spacing-sidebar: 408px` (and the `--spacing-legend` /
  `--spacing-panel-min` popover minimums) are the documented layout exceptions.
- **Elevation** is two levels only, with hairlines preferred over shadows:
  `--shadow-level-1: 0 1px 2px rgba(16,32,64,.10)` (inset/attached),
  `--shadow-level-2: 0 6px 18px rgba(16,32,64,.14)` (floating). The legacy
  `shadow-sm…2xl` names all resolve onto those same two levels.

## Icons

Material Symbols Outlined only (`index.html`), `FILL 0 / wght 400 / opsz 24` default, `FILL 1`
for the active/selected glyph, 16–24 px with a ≥44 px touch target around every glyph that is
pressable. Icon colour follows its element's role: ink at rest, carmine when the control is
chrome/active, the data hue when the glyph reads a metric.

## Copy voice (D6 is non-negotiable)

Verdict first (`18 min — 86% shaded`), the number with its scope second, method link third.
Every user-facing number must trace to a method with uncertainty stated; no marketing words,
no lie-flat adjectives. U5 fills out this section per surface; the guardrail binds all waves.

## Component recipes

- **Route card:** rank chip (carmine when recommended) → label + one trade-off line →
  verdict numbers → fixed metric strip (DIST · SHADE · UV) → provenance footnote. Selected
  card: carmine `border-left`, L2-level shadow; the shadow-coverage bar fills in shade green,
  never carmine.
- **Timeline:** one time readout; the now-marker is a carmine-diamond (selection, chrome);
  sunrise/sunset ticks are sun/route coloured data marks; day ticks are ink washes.
- **Search:** quiet raised rectangle, 12-radius, icon + input + actions; result rows on
  raised with hairline separators and carmine soft highlight.
- **Pins & popups:** origin/destination/waypoint pins are carmine chrome; user-location
  dot is route blue; popups are raised surfaces with a hairline border and L2 shadow,
  ink text (popup CSS lives in `globals.css` under MapLibre selectors).

## Enforcement path

- `npm run design:check` (`scripts/verify/design-tokens.mjs --all`) exits 0: no literal
  hex/`rgba()` and no numeric arbitrary values outside the registry, across `app/**`.
  Comments are stripped before scanning so issue references don't read as colours.
- `.claude/rules/design-language.md` applies per file; the `lint-changed` PostToolUse hook
  (where installed) reports offending changed lines immediately but never blocks.
- Phone before/after shots ship with the design PR under `docs/design/shots/u<n>/` — in this
  public mirror the U0 screenshot harness is deliberately not carried over, so the shot
  runner lives only in the private repo.

## Migration status

U2 replaced the Material 3 layer (`--md-*` tokens, glass helpers) with this registry, deleted
the superseded `NavigationPanel.tsx`, migrated every inventoried literal and made
`design:check` green. Component-level adoption of the type steps and of the wire-level
component recipes continues through U3–U6; until then this doc is the standard the
`interface-reviewer` compares diffs against.

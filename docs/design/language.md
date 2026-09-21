# Umbra Design Language — canonical spec (Track U)

**Chosen: Canopy** (owner's decision during the U2 review, 2026-09-20 — the sign-off recorded
for Strata/Carmine is superseded by this sentence; see `docs/design/decision.md` §0 and §4).
This file is the single source of truth for Umbra's UI, and `app/globals.css` is its token
registry — the two carry the same binding rules; change them only together, in the same PR.

Canopy is the restrained-structure / warm-truth synthesis: an evidence-first blue-green
foundation for the data, one warm allowance spent exactly where the product's metric is —
sun exposure — and zero decorative accents anywhere else.

## Binding rules (make these explicit, then follow them)

1. **The one warm colour is sun data.** `--color-sun` `#A15C00` appears only where the
   sentence is about sun/exposure/heat: the now-marker, solar-load pills, UV columns and
   sun figures. It is never chrome decoration — no amber eyebrows, tabs, badges or CTAs.
2. **Data states have fixed colours.** Route `--color-route` `#1D6EE0`, sun
   `--color-sun` `#A15C00`, shade `--color-shade` `#2A6A4E`, danger `--color-danger`
   `#B3261E`; chrome (eyebrows, rank chips, selection, pins, primary actions) stays in
   ink/route/shade — blue-green-ink, never warm, no red.
3. **Surfaces are paper + raised white.** Canvas `--color-canvas` `#F7F8F4`, cards and
   popups `--color-raised` `#FFFFFF`, ink `--color-ink` `#1C2321`. Backdrop blur is allowed
   on exactly one element — the over-map search pill at ≥70 % white — everything else is
   solid (research note (c): glare eats translucent text).
4. **Radius is 12 / 16 / 20, plus one 999 pill.** Controls/cards 12, larger cards 16, the
   sheet 20; the search pill (and small status chips) may be `rounded-full` and nothing
   else may. The registry pins the `rounded-*` utilities onto this scale.
5. **The renderer constants stay put.** The shadow layer's blue and canopyPaint's
   sea-green `#2E8B57` are data-plane colours pinned by canvas tests under CLAUDE.md
   invariant #5; `--color-canopy-map` exists only so the legend mirrors what the map paints.

## Colour roles (registry: `app/globals.css` `@theme`)

| Token | Value | Role |
|---|---|---|
| `--color-canvas` | `#F7F8F4` | Paper app background, chip fills on raised cards |
| `--color-raised` | `#FFFFFF` | Cards, sheets, popups |
| `--color-ink` | `#1C2321` | Primary text (16.0:1 on raised) |
| `--color-ink-muted` | `#525E58` | Secondary text (6.8:1) |
| `--color-ink-faint` | `#6C756D` | Placeholders, disabled glyphs (4.8:1) |
| `--color-hairline` | `#E2E7DF` | Borders; preferred over shadows |
| `--color-hairline-strong` | `#BFC8BC` | Focused/stronger dividers |
| `--color-route` | `#1D6EE0` | Route data, selection of route cards, links (4.8:1) |
| `--color-sun` | `#A15C00` | **Sun/exposure/heat only** (5.2:1) |
| `--color-shade` | `#2A6A4E` | Shade/tree/arrival data, the "go" CTA (6.4:1) |
| `--color-danger` | `#B3261E` | Errors — a state, not chrome |
| `--color-route/sun/shade-strong, -soft, -mid` | — | Hover, soft-fill and over-map variants of the three data hues |
| `--color-on-ink/route/sun/shade/danger` | light | Text on solid fills |

Soft fills and alpha washes are `color-mix(in srgb, var(--color-X) N%, transparent)` or the
`--color-X-soft` tokens — never new literal `rgba()` values in components.

## Type scale

| Step | Token | Sizing | Use |
|---|---|---|---|
| Verdict | `--text-verdict` | 22 / 700, Inter Tight, `-2%` tracking | The one display voice: the headline number |
| Body | `--text-body` | 15 / 22, Inter | Paragraph text |
| Small | `--text-small` | 13 / 18, Inter | Dense card reading |
| Eyebrow | `--text-eyebrow` | 11 / 600, Inter, uppercase, tracked | Section labels |
| Caption | `--text-caption` | 10, Inter, tabular | Map-adjacent metadata |

Numbers use `tabular-nums`. One display cut (Inter Tight) and one body font (Inter) —
see `index.html` fonts.

## Radius steps, spacing, elevation

- **Radius:** 12 (controls/cards) / 16 (large cards) / 20 (sheet); `rounded-full` exists for
  the search pill and small status chips only (rule 4).
- **Spacing:** 4 px grid; `--spacing-sidebar: 408px`, `--spacing-legend` and
  `--spacing-panel-min` are the documented layout exceptions.
- **Elevation:** two levels, hairlines preferred over shadows —
  `--shadow-level-1: 0 1px 2px rgba(28,35,33,.10)` (attached),
  `--shadow-level-2: 0 12px 28px rgba(28,35,33,.16)` (floating). The legacy
  `shadow-sm…2xl` names all resolve onto those two levels.

## Icons

Material Symbols Outlined only (`index.html`), `FILL 0 / wght 400 / opsz 24` default, `FILL 1`
for the active/selected glyph, 16–24 px with a ≥44 px touch target around every pressable
glyph. Icon colour follows its element's role: ink at rest, route blue where the control
selects route data, sun only when the glyph reads a sun metric.

## Copy voice (D6 is non-negotiable)

Verdict first (`18 min — 86% shaded`), the number with its scope second, method link third.
Every user-facing number must trace to a method with uncertainty stated; no marketing words,
no lie-flat adjectives. Per surface (U5):

- **Route card:** duration is the verdict row; the trade-off line prefers a named condition
  over a bare delta where the delta does two jobs ("long walk between stops, +12 min", the
  Transit-app voice) — the number quantifies, the name warns. The provenance caption joins
  at most three facts with " · "; a fourth starts a second line, never a fourth dot.
  Captions and tile labels sit at an **11px floor** — 9–10px is below outdoor legibility.
- **Assistant answers:** lead with the recommendation in one sentence, then the reasons;
  at most three itinerary options, best first (Miller). Receipt captions also 11px.
- **Place detail:** no fabricated data — a rating that does not exist is never shown as one,
  and an absent review source is one honest line, not invented bars and quotes.
- **Arrival:** one peak-end sentence states what the trip earned ("340 m route — 2 of 6 min
  in sun at a fixed 5.0 km/h pace"), stating the pace basis and, on a transit trip, the
  scope ("ride not counted") — neither travels with the number on its own.
- **Hourly strip:** "Sun by hour", verdict "most shadowed around 14:00", unsampled hours say
  "checking…" rather than reading as zero.

The guardrail binds all waves.

## Component recipes

- **Route card (U3):** recommended-only eyebrow (route blue — the ranking mark) → label +
  duration verdict (right, bold tabular) → shade verdict + coverage bar + distance → one
  trade-off line against the shortest complete route → provenance caption (source · scope ·
  stated pace). Everything else — metric tiles, legs, transit detail, the conditions/dose
  block, save/export — collapses into the selected card only, below a hairline divider.
  Selected card: route-blue `border-left`, L2 shadow; the shadow-coverage bar fills in
  shade green (route blue in rain mode); the card never uses warm colours for ranking.
  Actions are labelled buttons ≥44 px on the selected card — icon-only targets and
  hover menus are banned. Once options exist the planning form collapses to a one-line
  trip bar (Edit reopens it), so the stack starts inside the sheet's first snap point.
- **Timeline:** one time readout; the now-marker is the **only** amber element (sun data);
  sunrise/sunset ticks are sun/route coloured data marks; day ticks are ink washes. A thin
  sun-arc glyph rides the ruler (horizon line + quadratic sun path, sun dot at the slider's
  time, absent at night) — sun position, so it takes the sun hue; it is data, not chrome,
  and the only ornament-looking element the language allows (U4).
- **Search:** the one 999-radius pill, ≥70 % white with its allowed blur, route-blue
  highlight on the active row; result rows on raised with hairline separators.
- **Pins & popups:** origin pin ink, destination pin route blue, user-location dot route
  blue; popups are raised surfaces with a hairline border and L2 shadow, ink text
  (popup CSS lives in `globals.css` under MapLibre selectors).

## Enforcement path

- `npm run design:check` (`scripts/verify/design-tokens.mjs --all`) exits 0: no literal
  hex/`rgba()` and no numeric arbitrary values outside the registry, across `app/**`.
  Comments are stripped before scanning so issue references don't read as colours.
- `.claude/rules/design-language.md` applies per file; the `lint-changed` PostToolUse hook
  reports offending changed lines immediately but never blocks.
- `interface-reviewer` checks diffs against this doc plus the outdoor standard;
  `/gates` before any PR. Phone before/after shots ship with the design PR under
  `docs/design/shots/u<n>/` — in this public mirror the U0 screenshot harness is
  deliberately not carried over, so the shot runner lives only in the private repo.

## Migration status

U2 first landed Strata/Carmine and was reworked to Canopy at the owner's review (the
`--md-*` layer and glass helpers are deleted, `NavigationPanel.tsx` removed, every
inventoried literal migrated, `design:check` exits 0). Component-level adoption of the type
steps and of the wire-level component recipes continues through U3–U6; until then this doc
is the standard the `interface-reviewer` compares diffs against.

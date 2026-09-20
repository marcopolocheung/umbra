# Umbra design language — decision (Track U, checkpoint U1)

> **Status:** ready for owner review. **The merge of this doc's PR into `main` is the sign-off**
> (decisions D1/D2). Merging without edits accepts §6 `Recommendation` verbatim.
> Research this doc stands on: `docs/notes/design-research-*.md` (five files: tokens & lint,
> agent workflows, map hierarchy, verdict-first cards, geocoder presentation). Candidate
> assets are committed beside this doc under `docs/design/candidates/<name>/`.
> **Bounds that apply to every candidate:** honesty guardrail (D6), shadow colour stays
> blue-dominant under `isBlueDominantShadowPixel` (CLAUDE.md invariant #5), mobile 390×844
> first (D8), no app code in this PR.

## 1. The axis this decision is about

Restrained/evidence (Google Maps, Mapbox/Apple) versus playful/branded (Waze/Tzel), with
**Undercover** as the closest product kinship — a government shade-router that shows shortest,
most-shaded and recommended routes with shade % as the headline. The research notes (c), (d)
and (e) say the evidence side wins *inside the data*, and the playful side wins *in the chrome*;
Umbra's honesty guardrail forbids the playful side's usual cheap trick (voice-first confidence),
so a fair candidate competition differs from "pick the prettier one": the question is where
Umbra puts its one amber allowance without lying to a walking user in sunlight.

## 2. Candidate A — **Strata** (restrained pole)

*Evidence-first: a gray-blue world, one route blue, one amber topic. Sibling to Google's
25-tone rule ("more with less"), Mapbox Standard's "canvas for location data", Apple's muted
emphasis style.*

- **Palette chips** — `candidates/strata/palette.png`. Roles: canvas `#F5F7FA`, raised `#FFFFFF`,
  ink `#1A2230`, ink-muted `#4E5A6B`, hairline `#D9E0E8`, route/shadow-blue `#1D6EE0` (route only;
  the shadow layer itself is untouched by all candidates), sun/exposure `#9A6200`, shade-good
  `#2F7D4F`, danger `#B3261E`. Body-text pairs vs raised all pass WCAG AA 4.5:1
  (ink 15.96, ink2 7.00, route 4.82, sun 5.10, shadeok 5.04).
- **Type specimen** — `candidates/strata/type.png`. Inter only (matches shipped `index.html`);
  eyebrow 11/600 tracked uppercase; verdict 22/700 `-2%`; body 15/22; numbers 15 tabular-nums;
  one display voice = the verdict line.
- **Elevation / radius rules.** Two elevation levels only: L1 `0 1px 2px rgba(16,32,64,.10)`,
  L2 `0 6px 18px rgba(16,32,64,.14)`; hierarchy prefers 1px hairlines over shadows. Radius
  scale 8 (controls) / 12 (cards) / 14 (sheet); the search box is a 12-radius rectangle, not a
  pill. **No backdrop blur** anywhere — solid surfaces survive glare (research (c)).
- **Vignettes** — phone: `candidates/strata/vignette-phone.png`; route card:
  `vignette-route-card.png`; timeline: `vignette-timeline.png`; search pill: `vignette-search.png`.
  Route card is a ranked list card: rank chip → "MOST SHADED" + one trade-off line → verdict
  "18 min — 86% shaded" → fixed 3-column key/value strip (DIST · SHADE · UV SWAP) → provenance
  footnote. Timeline shows one time and visible coverage gaps. Search box = quiet white
  rectangle with icon, name, category, distance.
- **Mood references** — `candidates/strata/moodboard.png` + links: Google Maps *Exploring
  Color*; Mapbox *Standard core style*; Apple Maps HIG (muted emphasis); Undercover.
- **Character.** Legible in direct sun, zero style risk, zero personality debt. The route blue
  and the amber both keep meaning. Differentiation is limited to content quality.

## 3. Candidate B — **Helios** (playful pole)

*Waze/Tzel grammar: round type, city-block colour, a sun you can feel. Personality in the
chrome, and a hard rule — warm colours never carry body text, because they can't.*

- **Palette chips** — `candidates/helios/palette.png`. Roles: cream canvas `#FFF6E4`, raised
  `#FFFFFF`, indigo ink `#251B4A`, ink-muted `#574C80`, warm hairline `#EADBBD`, route orange
  `#FF8A1E`, sun `#FFB021`, shade-good teal `#1E9E62`, danger `#D92B2B`. **Honest contrast
  limits (computed, on the sheet):** orange 2.36:1, sun 1.83:1, teal 3.43:1 against white — all
  **fail** AA for body text. Helios is only viable if amber/orange/teal are decorative chips,
  map geometry, or ≥18.66px-bold print, and numbers that must read use indigo ink instead.
- **Type specimen** — `candidates/helios/type.png`. Outfit (rounded geometric) for display and
  verdicts 22–26/800, Inter for body 15/22; eyebrow lowercase tracked; the "sundial" vocabulary
  (Drag the sun · 42% shade) replaces quiet labels.
- **Elevation / radius rules.** Three levels + a flare: L1 `0 2px 0` chalk-line, L2
  `0 12px 28px rgba(37,27,74,.22)`, L3 sun-flare `0 14px 34px rgba(255,138,30,.35)` on the
  primary action only. Radius scale 14 / 22 / 26, pill 999 everywhere incl. search; 2px ring
  replaces shadow for selected options.
- **Vignettes** — `candidates/helios/vignette-phone.png`, `-route-card`, `-timeline`, `-search`.
  Same verdict-first copy as Strata (the honesty guardrail makes the *words* identical), dressed
  in cream, indigo and a warm rank chip; dark indigo search pill; playful sun-marker on the
  timeline.
- **Mood references** — `candidates/helios/moodboard.png` + links: Pentagram/Waze *Block by
  Block* (playful but systematically governed — illustration was re-drawn *into* a system);
  Tzel (draggable sun, shade % as hero); RainViewer 8.0 LIVE-badge energy.
- **Character.** The most differentiated and the most expensive: every warm-state usage needs a
  contrast verdict (research (c)), amber sits adjacent to the blue shadow layer all day, and a
  later rebrand-by-committee (the current P1 disease) is likelier because the style invites
  improvisation.

## 4. Candidate C — **Canopy** (evidence base, one warm allowance — the recommendation)

*Quiet by default, warm where the sun matters. Undercover's restraint for the data, Tzel's
shade-% hero for the one thing that deserves it; the warm accent is reserved for sun and
exposure metrics — the variables Umbra sells — and never for chrome decoration.*

- **Palette chips** — `candidates/canopy/palette.png`. Roles: paper canvas `#F7F8F4`, raised
  `#FFFFFF`, ink `#1C2321` (slightly warmer than Strata's), ink-muted `#525E58`, hairline
  `#E2E7DF`, route/shadow-blue `#1D6EE0`, sun/exposure `#A15C00`, shade-good `#2A6A4E`,
  danger `#B3261E`. Body pairs vs raised all pass AA: ink 16.01, ink2 6.77,
  route 4.82, sun 5.19, shadeok 6.42. **The rule that makes it work:** amber appears only where
  the sentence is about sun/exposure/heat (the "SUN" dial value, UV swap column, now-marker);
  shade/route/confidence stay blue-green-ink. One data accent, zero decorative accents.
- **Type specimen** — `candidates/canopy/type.png`. Inter Tight display (22/700, `-2%`) +
  Inter body 15/22; eyebrow 11/600 caps; numbers 15 tabular — Strata's discipline, slightly
  warmer display cut, one Newsreader-style italic allowance for the verdict lead-in
  (*"A cooler way home — 86% shaded"*) which must remain factual, never puffery (D6).
- **Elevation / radius rules.** Two levels: L1 `0 1px 2px rgba(28,35,33,.10)`, L2
  `0 12px 28px rgba(28,35,33,.16)`; hairlines preferred over shadows. Radius scale 12 / 16 / 20;
  **999-radius is allowed for exactly one element — the search pill** (and small status chips);
  everything else inherits the 12/16/20 scale. Backdrop blur only on the over-map pill at
  ≥70% white — RainViewer's rule ("glass only looks right when there is little of it").
- **Vignettes** — `candidates/canopy/vignette-phone.png`, `-route-card`, `-timeline`, `-search`.
  Route card: "MOST SHADED — 4 min longer · 2× less sun" → verdict "18 min — 86% shaded" →
  3-column strip (DIST 1.2 km · SHADE 86% · UV SWAP 44%) → method footnote; option 2 collapses
  to one comparison line ("14 min — 41% shaded"). Timeline: one time, the now-marker is the
  only amber element, coverage gaps stay gaps. Search pill: white 999-pill, icon, name,
  category, distance — the Undercover/shipped-product row anatomy from research (e).
- **Mood references** — `candidates/canopy/moodboard.png` + links: Undercover (three-route
  trade-off with shade % headlines); Apple Maps muted emphasis (data stands out against a
  desaturated map); Tzel (shade % as hero, borrowed once); dappled shade imagery.
- **Character.** The "restrained structure, warm truth" synthesis the axis was looking for:
  it keeps every AA number Strata keeps, spends its only warm allowance on the metric that
  *is* the product, and still reads as one voice in one hand in bright sun.

## 5. Side-by-side comparison (owner's decision surface)

| Axis | Strata | Helios | Canopy |
|---|---|---|---|
| Restrained → playful | 9.5 restrained | 2 restrained-ish, 8 playful | 6.5 — restrained, warm |
| Bright-sun legibility | Highest (all-static surfaces) | Lowest (amber low-contrast, needs large/bold everywhere) | High (amber wide-gamut `#A15C00`, AA body) |
| Shadow-coupling risk (inv. #5) | None — route blue separated | Amber sits next to blue shadow all day; ring/glow styles tempt mixing | None — one blue + one reserved amber |
| Honesty guardrail cost (D6) | Lowest — nothing to resist | Highest — playful copy invites fluff; every warm state needs a contrast pass | Medium — one italic lead-in, still factual |
| P1 (visual clamour) | Kills it | Risks new improvisation driven by plural accents | Kills it via single-accent rule |
| P2/P3 scannability (U3/U5/U6) | Strong; least emotional pull | Strong if ink-indigo numbers win | Strong; hairline-separated, router shared |
| U2 cost | Migrate ~35 offenders, 8 radii, delete `--md-*` ≈ one session | + contrast guardrails, ring styles, two typefaces ≈ one session plus verification | + one accent-reservation rule ≈ one session |
| Differentiation | None | The most (brand-first) | Measured — sells Umbra's metric, not its deco |

## 6. Recommendation

> **RECOMMENDATION: adopt Candidate C — "Canopy" — as Umbra's design language.**
> Quiet by default, warm only where the sun matters: it preserves every WCAG AA contrast a
> restrained system buys, keeps the blue shadow layer and the honesty guardrail intact, and
> still gives the product its one vivid hook (amber for sun/exposure) worth shipping.
> **Merge this PR to accept Canopy.** To choose Strata or Helios instead, name the alternative
> in one merge comment and merge — the first sentence of `docs/design/language.md` is edited
> to match before U2 starts.

Trade-offs, stated: adopting Canopy gives up Helios's brand-first aesthetic differentiation
(final row of §5) and Strata's zero-allowance simplicity; adopting Strata saves the smallest
amount of U2 work but leaves Umbra visually anonymous next to any municipal shade app;
adopting Helios maximizes distinctiveness but makes warm-theme states permanently
verification-heavy and increases the risk that P1 (self-clamour) returns. Canopy is the only
candidate whose single accent is defined by data semantics rather than taste — which is the
part a lint (U2) can enforce without a committee.

**U2 cost mechanics** (whichever wins): register the palette as semantic tokens in
`app/globals.css` Tailwind `@theme`, delete superseded `--md-*` tokens, migrate the inventoried
literals (`NavigationPanel.tsx:233,799`, `DirectionsPanel.tsx:21,31,504,558`,
`app/about/page.tsx:5`, popup styles), tighten `npm run design:check` to ban raw colours and
off-scale radii (the Primer/Shopify pattern from `design-research-tokens-and-lint.md`), and
make `docs/design/language.md` canonical.

## 7. What the merge unblocks

- `docs/design/language.md` (skeleton in this PR) gets its first sentence as the recorded
  choice — that merge is the sign-off this track has been waiting for (D1/D2).
- U2 proceeds: the chosen candidate's palette/type/radius/elevation rules become the token
  registry and canonical spec; U3–U6 then inherit one language instead of re-deriving it.
- The research notes stay as the sourcing layer the reviewer can check line-by-line.

## Assumptions recorded

- Image generation tooling was unavailable in this session, so candidate visuals are
  code-rendered composites (HTML/SVG → PNG at 2×, phone 390×844) rather than AI-generated art;
  they are the source of truth for palette/type/radii since they share the exact token hex/px
  values in this doc, and mood references link the shipped products themselves.
- Verified-vs-inferred labelling follows the `landscape-scout` contract in all five notes;
  where a source page carried no date, the note says so and dates the access instead.
- The three route numbers used in vignettes (86% / 41% shade, 18 / 14 min, 1.2 km, UV 44%)
  are illustrative renderings, not claims about Umbra's routing output.

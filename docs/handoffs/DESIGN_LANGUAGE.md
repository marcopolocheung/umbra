# DESIGN_LANGUAGE.md — the UI & Design Language wave (Track U)

Documents sized for **one new design session** each wave step. It exists because the roadmap
says *what*, and this file says *"here are the decisions, the references and the current UI
state — start here."* It is a snapshot and decays: re-check claims when you start a session.
If this file disagrees with the code, **the code wins** — fix it in the same PR.

- **Verified:** 2026-09-20 on `design/u2-strata-carmine` (U2, open for owner review):
  `npm run design:check` exits 0 — the `--md-*` layer (33 colour + 8 layout tokens) is
  deleted, **Canopy** is the registry in `app/globals.css` (the owner re-picked it during
  U2 review after a first pass in Strata/Carmine), every literal from the U0 inventory
  migrated, the deprecated `NavigationPanel.tsx` deleted, before/after phone shots in
  `docs/design/shots/u2/`. Merged design work supersedes older line refs here.
- **Track brief:** `docs/tracks/TRACK_U.md` (checkpoints + acceptance criteria). This handoff
  carries *why and where*; the brief carries *build that, like this*.

## Paste this to start a session (works where `/track` does not)

```
You own the Umbra UI & Design Language wave for this session (Track U). Read, in order:
docs/handoffs/DESIGN_LANGUAGE.md, root CLAUDE.md, docs/tracks/TRACK_U.md — then the files
your checkpoint names. Start from TRACK_U.md's "Current state" block, take the next
unfinished checkpoint U<n>, branch design/u<n>-<slug> from main, and work it end to end
per docs/tracks/README.md — implement with tests, run /gates, npm run design:check and
npm run shots, commit the curated phone screenshots under docs/design/shots/u<n>/, open a
PR with gh, never merge, and update the brief's Current state in the same PR. One
checkpoint = one PR. The wave is strictly sequential — do not start work another design
session is doing. Mobile 390x844 is the review standard; wide screens must not break but
are not a target. Do not ask me what to do next — pick the reasonable default and note
any assumption in the PR.
```

In an interactive session, `/track u` loads the same brief. The wave is **sequential**: one
design session at a time, because every checkpoint edits the contested files
(`page.tsx`, `MapView.tsx`, `AppShell.tsx`, `DirectionsPanel.tsx`) — that is the feature,
not a bug; concurrent design sections would not merge. Schedule the wave when other track
sessions are quiet around those files.

## 1. Decisions already made (owner, 2026-09-19)

| # | Decision |
|---|---|
| D1 | **Redesign is on the table.** The Material tokens are not sacred. The language is re-decided: research first, then a decision doc with **visual candidates**, then owner sign-off, then implementation. |
| D2 | **The owner reviews every design PR.** Nothing merges without visual sign-off. The PR body carries before/after phone screenshots. |
| D3 | **References** are the eight links in §5. Mine them for palette, map hierarchy, and tone. |
| D4 | Justification: **mix hiring-evidence reasoning and "cool polish"** — the track aims both, and keeps what survives product review. |
| D5 | **Biggest offenders first:** the navigation card (route options — "looks like AI slop and is confusing to use") and the bottom timeline controls + the search bar sliding window interplay. |
| D6 | Copy: **content over microcopy-first**, sessions may rewrite user-facing text freely within guardrails: every number traceable with uncertainty stated, **never lie-flat marketing words**. Assistants choose the rest; the honesty guardrail is non-negotiable. |
| D7 | **Search gets richer, for real:** Foursquare typeahead/autocomplete, richer result rows (category, hours, photo, rating), better assistant `search_places` results and pin presentation. **Dev and prod work against the same keys — Foursquare details are not dev-only.** The OSMF no-autocomplete invariant still stands: the *manual* search bar may autocomplete via Foursquare only, never via Nominatim (which anyway stays submit-triggered). |
| D8 | **Mobile is the product.** 390×844 first; wide layout must not break but gets low effort. |
| D9 | Research sources: anything reachable, web search included. Verified-vs-inferred labelling is *nice to have*, not required. |
| D10 | Tooling latitude: proposals are welcome — the owner reviews every PR anyway. **New dependencies and paid services need an explicit case in the PR.** |
| D11 | The harness is repo-local. Subagent fan-out follows existing repo rules (read-heavy only; never hand `page.tsx`/`MapView.tsx` to a subagent). |
| D12 | Sessions run **sequentially**, one checkpoint per PR. |

## 2. Standing context (a design session must know this)

- Umbra: shadowed-route navigation, fully client-side. React 19 + Vite + TS + **Tailwind v4**
  + MapLibre GL (pinned 5.9.0). Fonts in `index.html`: Inter (300–800) + Material Symbols
  Outlined. The map is the content; panels float over it.
- **The review standard already exists:** `.claude/agents/interface-reviewer.md` — outdoors,
  bright-sun, one-handed, walking; 44px touch targets (`docs/notes/touch-target-audit.md`).
  Palette work inherits the shadow-color coupling (CLAUDE.md invariant #5), a real constraint
  on map-side colour design.
- **The current design language is Canopy, canonical in `docs/design/language.md`**
  with the token registry in `app/globals.css`; the pre-U2 state it replaced was a
  half-adopted Material 3 layer (`--md-*` tokens + `.glass-panel`, helpers) and literals outside it:
  hardcoded hexes and `rgba()` inline styles in DirectionsPanel, NavigationPanel, SearchBar;
  two hand-rolled MapLibre popup styles pasted at the bottom of `globals.css`; radii from bare
  `rounded` to `rounded-2xl` mixed freely; `style={{...}}` token consumers sitting next to
  Tailwind utilities for the same job. That mismatch **is** pain point #1.
- **State model:** `page.tsx` composes three hooks; components hold no app state. Layout split:
  `AppShell.tsx` wide sidebar versus `BottomSheet.tsx` narrow. Design edits concentrate in
  `page.tsx` (~932), `MapView.tsx` (~1377), `useNavigation.ts` (~1445),
  `DirectionsPanel.tsx`, `TimelineSlider.tsx`, `SearchBar.tsx` (~451), `AssistantPanel.tsx`.
- **Honesty guardrail:** user-facing numbers must be traceable to a method with uncertainty
  stated (see `grounding-auditor`). A "prettier card" that drops the provenance links is a
  regression even if it looks better.
- **Verification is thin for UI:** `npm test` never opens a browser; `npm run e2e` covers one
  path and `e2e/rebrand.spec.ts` exists. Therefore every design PR needs `npm run shots`
  (this wave's phone screenshot tool, §7) plus an `interface-reviewer` pass.

## 3. The three pain points, filed

### P1 — the design language clamours with itself
Buttons, route/path styling, fonts, layout: several visuals coexisting (MD tokens, glassmorphism,
dark popups, amber accents handed out per-component, arbitrary radii). Making the language
**one thing** is U1–U3. Worst seats in the house:
- `DirectionsPanel.tsx` / `RouteCard.tsx` / `FloatingRouteCards.tsx` — the route-option card.
- `app/globals.css` tail — `sketch-point-popup` vs `nav-place-popup` styled differently.
- `NavigationPanel.tsx:233,799` dark menus; `DirectionsPanel.tsx:31` amber SolarPill;
  SearchBar's "MD3 floating pill" comment vs token usage elsewhere.

### P2 — informative text is lumpy and exhausting
Percentages, minutes, metres, dose, heat score stacked without a scannable hierarchy, and
method links that don't read as part of the same story. Target files: RouteCard,
`RouteConditionsLine.tsx`, transit/rain cards, `PlaceDetail.tsx`, `AssistantPanel.tsx`
answers. Content-first rewrite under the honesty guardrail; mobile reading order first.

### P3 — search is plain and the results are uninformative (manual and agent)
- Manual: `SearchBar.tsx` — submit-triggered Nominatim text rows only; Foursquare cannot
  autocomplete. `app/services/foursquare.ts` already has name/address/category/hours/rating/
  description/phone/website/photo available when a place is opened.
- Agent: `app/lib/agent/tools.ts` `search_places` (box-radius search `[0.015, 0.06]` deg,
  Nominatim ranking by importance, not distance — see its comment) and the plotted-pin
  presentation. Improvements must keep `npm run eval:agent` scenarios coherent and respect
  `grounding-auditor` on anything the assistant *says*.

## 4. References the owner picked (mine them before designing)

| Reference | Why |
|---|---|
| [Google Maps — Exploring Color](https://design.google/library/exploring-color-google-maps) | Best explanation of reducing visual complexity without reducing geographic complexity |
| [Mapbox Standard core style](https://www.mapbox.com/blog/standard-core-style) | Restrained 3D buildings/trees + map hierarchy |
| [Apple Maps HIG](https://developer.apple.com/design/human-interface-guidelines/maps) | Concrete rules for zoom hierarchy, muted maps, overlays |
| [Undercover case study](https://www.hack.gov.sg/2026/undercover/) | **Closest reference to this product** — shade + rain/shelter routing |
| [ShadeMap](https://shademap.app/) | Time manipulation + shadow visualisation |
| [RainViewer 8.0](https://www.rainviewer.com/uk/blog/radar-wins-the-map-screen.html) | Aggressively simplifying controls around a complex environmental map |
| [Waze — Pentagram](https://www.pentagram.com/work/waze) | Playful, branded navigation |
| [Tzel](https://www.tzel.app/) | Brand-forward shade-navigation |

The split to resolve, stated so the candidates contend honestly: **restrained/evidence
(Google/Maps, Mapbox/Apple)** versus **playful/branded (Waze, Tzel)**, with **Undercover** as
the closest product kinship to Umbra.

## 5. Session plan (one checkpoint = one PR, strictly in order)

| Step | Topic | Owner's review focus |
|---|---|---|
| U0 | Land the seeded harness (files in §7) after a read-through; tighten thresholds; this PR makes every later step cheaper | Does nothing change app behaviour |
| U1 | **Research + design-language candidates** — SOTA agent-workflow notes into `docs/notes/design-research-*.md`; decision doc with 2–3 candidates (palette, type specimen, component vignettes, mood moodboard) at `docs/design/decision.md` | Picks a candidate; that merge is the sign-off |
| U2 | Implement the chosen language in `app/globals.css`; delete superseded token names; migrate the worst offenders; `npm run design:check` exits 0; `docs/design/language.md` becomes canonical | The actual new look, first pass |
| U3 | Navigation card redesign (P1) | "No longer AI slop": hierarchy, glanceability |
| U4 | Timeline controls + search-bar/sheet sliding interplay (P1+P2), mobile | One-hand use, no occlusion fights |
| U5 | Copy & information architecture (P2) — verdict-first, method-links, uncertainty visible | Can a stranger read a card in 5 s |
| U6 | Search UX (P3) — manual Foursquare autocomplete + rich rows; agent search/pins | Search feels informative, agent stays grounded |

Each PR: `/gates`, `npm run shots`, curated screenshots committed to
`docs/design/shots/u<n>/` and linked from the PR body (GitHub resolves branch-relative
links). PR prose stays ≤4 sentences; image links and "what to look at" are part of the body.

## 6. Harness seeded with this handoff (this is what the sessions get for free)

| File | Does |
|---|---|
| `docs/tracks/TRACK_U.md` | The brief: charter, current state, checkpoints U0–U6 with acceptance criteria |
| `.claude/rules/design-language.md` | Path-scoped rule; advisory until `docs/design/language.md` exists, non-advisory after |
| `scripts/verify/design-tokens.mjs` | Token-registry lint; `npm run design:check` inventory mode; hook reports changed lines |
| `.claude/hooks/lint-changed.sh` | Now also reports new hardcoded colours/arbitrary sizes; never blocks (repo convention) |
| `playwright.shots.config.ts` + `e2e/shots/design-shots.spec.ts` | `npm run shots` — phone-viewport screenshots of key UI states into `out/shots/` |
| `.claude/skills/design-audit/SKILL.md` | `/design-audit` — inventory + shots + reviewer wiring in one procedure |
| `.claude/agents/interface-reviewer.md` | Gained a design-language section (checks diffs against `docs/design/language.md`) |
| `.claude/settings.json` | Pre-approves the new commands + WebFetch for the reference domains |
| `package.json` | `shots` and `design:check` scripts |

`out/` is gitignored — treat `out/shots/` as throwaway iteration. The curated four-to-six
shots that go into a PR are committed under `docs/design/shots/u<n>/`.

## 7. Verified, and how to re-check

- 2026-09-19, `main` @ `0a28a09`. Re-check the UI inventory with:
  `grep -c "md-" app/components/*.tsx`, `grep -rn "bg-\[#" app --include='*.tsx'`,
  and `node scripts/verify/design-tokens.mjs --all | head`.
- The brief's `Current state` block is the only state to trust for progress.

# Track U — UI & Design Language

> **Charter:** give Umbra one deliberate design language instead of the half-adopted,
> self-conflicting token layer it has today, then take the three UX pain points — visual
> clamour, lumpy information text, plain search — from "works but clashes" to "deliberate".
> The entry document for this track is `docs/handoffs/DESIGN_LANGUAGE.md` (decisions D1–D12,
> references, standing context). This brief says *how*: checkpoints, acceptance, verification.

**Class:** Product. **Runs:** strictly **sequential** — one session, one checkpoint, one PR.
It edits the contested files (`page.tsx`, `MapView.tsx`, `AppShell.tsx`, `DirectionsPanel.tsx`)
by design, so no other track session may be editing those concurrently; schedule the wave
accordingly. Subagents stay read-only here, per the repo rule.

---

## Current state

- **Active checkpoint:** U4 — timeline controls + sliding-panel interplay. Open for owner
  review on `design/u4-timeline-sheet` (branched from `design/u3-route-glance`, PR #63,
  because U4 edits the same surfaces U3 holds open; rebase onto main at U3's merge).
- **U3 (open, PR #63):** the route card reads as a ranking — recommended-only eyebrow,
  duration verdict, one trade-off line against the shortest complete route, provenance
  caption, detail collapsed into the selected card; planning form collapses to a trip bar.
  Its pre-existing findings for U4 (sub-44px segmented controls, floating stack's missing
  radiogroup) are fixed by U4; the hover-only rename/delete on saved routes and 9–10px
  card type remain for the scribe/U5.
- **U4's code:** sun-arc glyph on the timeline ruler (thin sun path + horizon, sun dot at
  the slider's time, sun hue, aria-hidden — data, not chrome); tick ruler memoised so
  drag-time re-renders move only the sun dot; the mobile timeline wrapper's stray
  `relative` removed (it beat `absolute` in Tailwind's output order — the whole card was
  offscreen at phone widths); the timeline rides above the sheet's collapsed band and the
  floating map controls ride the same choreography; the collapsed sheet's handle yields
  to 36px, content padding and stale scroll yield too, and the panel leads with the trip
  bar so the band shows it flush (43 of 44px rendered — the sheet's 1px border takes one;
  hit area intact); Walk/Transit, Sun/Rain and travel-mode segmented controls at 44px
  rows with `aria-pressed`; the mobile search pill is hidden during
  DIRECTIONS/NAVIGATING so it never slides over the navigation card; the partial/failed
  notice rides above the weakest viable card once the stack passes three options (serial
  position); SavedRoutesSection's divider is hairline-strong against the planning form
  (proximity); FloatingRouteCards gained the panel's `role="radiogroup"` + `aria-label`
  (the radiogroup-of-aria-pressed-buttons semantics are imperfect ARIA — pre-existing
  pattern, filed for the scribe). Touch-target audit updated in place. Review findings
  fixed in the same PR: controls/timeline overlap, stale-scroll band, drag-gate overlap.
- **Implemented:** U0 (harness, PR #465), U1 (research + candidates + sign-off, PR #470,
  port #51), U2 (Canopy language, port PR #60 / private #479 — merge = visual sign-off),
  U3 (PR #63, open).
- **Owner decisions** D1–D12 unchanged (`docs/handoffs/DESIGN_LANGUAGE.md` §1).
- **Blocked on:** owner review of U3 and U4; the wave is sequential from U5 on.
- **Next action:** owner review; then U5 (copy & information architecture).
- **Last verified:** 2026-09-20 (U4 session) — lint and typecheck clean (app scope; the
  `server/` typecheck errors pre-date this branch and exist on main), new unit tests green
  (sun-arc geometry, warning placement), `npm run design:check` exit 0. Drag-latency
  (Doherty, hermetic MutationObserver instrument, median of 30 discrete drags): U3 base
  ~232–287 ms at desktop; U4 ~109 ms at 390px — no regression; the memoised ruler and the
  un-occluded band both help. The U3 base phone timeline is offscreen (the stray
  `relative`), so its 390px number is unmeasurable — the fix is the point. Smoke e2e:
  the two smoke.spec tests pass; three rebrand.spec failures exist identically on the
  U3 base commit (pre-existing on this mirror, reproduce at 4a373cc).

---

## Guardrails (all checkpoints)

- **Never merge.** Every PR stays open for the owner's visual review; merging is the sign-off
  for U1 and the ongoing gate for the rest.
- Every UI PR carries before/after **phone** screenshots (390×844) committed under
  `docs/design/shots/u<n>/` and linked from the PR body. Prose ≤4 sentences.
- `interface-reviewer` runs on any diff touching `app/components/**` or `app/page.tsx`.
  `grounding-auditor` runs whenever user-facing numbers, labels or assistant-visible strings
  change (U5, U6 especially).
- `/gates` before any PR opens; `npm run design:check` from U2 onward must exit 0.
- Hard invariants from root `CLAUDE.md` bind palette work too — especially #5 (shadow colour
  must stay blue-dominant under `isBlueDominantShadowPixel`) and the OSMF no-autocomplete rule
  (manual search may autocomplete via Foursquare only).

---

## Checkpoints

### U0 — land the seeded harness

Acceptance:
- Harness files land on `main` unchanged in behaviour (no app code touched).
- `npm run shots` runs end-to-end at 390×844 and writes numbered PNGs to `out/shots/`.
- `node scripts/verify/design-tokens.mjs --all` prints a violation inventory on current code
  (non-zero exit expected at this commit — the inventory is the point).
- `.claude/hooks/lint-changed.sh` reports token findings on changed `.tsx`/`.css` lines
  without blocking edits.
- `settings.json` permissions, `/track u`, `session-brief.sh` mention, `docs/handoffs/README.md`
  row, and `docs/tracks/README.md` mention are consistent with each other.
- PR body notes what the harness does *not* enforce yet and why (registry is advisory until U2).

Why first: every later checkpoint leans on the shot runner and the lint; landing them as a
reviewed seam means no checkpoint re-derives a screenshot setup on its own.

### U1 — research + design-language candidates (docs-only PR)

Acceptance:
- `docs/notes/design-research-*.md`: what shipped products and current agent-workflow practice
  say about (a) encoding a design system as tokens a lint can check, (b) keeping AI sessions
  consistent on design (skills/rules/hooks patterns), (c) map-app hierarchy and colour under
  sunlight, (d) scannable "verdict-first" data cards, (e) geocoder search result presentation.
  Facts carry sources and dates where known; verified-vs-inferred labelling where confidence
  splits.
- `docs/design/decision.md`: 2–3 design-language candidates, each with palette chips, type
  specimen, elevation/radius rules, 2–3 component vignettes (route card, timeline, search
  pill), and a mood reference; a recommendation with trade-offs. Restrained (Google Map,
  Mapbox/Apple) vs playful (Waze/Tzel) must be a first-class axis; Undercover is the closest
  product kinship.
- Candidate assets are committed images under `docs/design/candidates/<candidate>/`
  (rendered vignettes, not only prose).
- The PR says which candidate is recommended and what each would cost in U2.
- Owner's merge **is** the sign-off; record the choice as the first sentence of
  `docs/design/language.md` (skeleton).

Why docs-only: palettes are decided once. Code written against a rejected palette is rework.

### U2 — implement the chosen language + enforcement

Acceptance:
- `app/globals.css` carries the chosen palette/type/radius/spacing/elevation as the token
  registry; `docs/design/language.md` is the canonical spec (roles, scale, icons, glass policy,
  copy voice, component recipes), and the chosen-candidate sentence sits at the top.
- Superseded `--md-*` tokens and helpers are deleted or renamed in the same PR; no dead tokens.
- Hardcoded literals from the U0 inventory migrate to the registry; `npm run design:check`
  exits 0.
- `.claude/rules/design-language.md` stops being "advisory until the doc exists" and states the
  enforcement path.
- Type remains legible outdoors per `interface-reviewer`; the shadow-colour coupling is
  re-verified (CLAUDE.md invariant #5) after palette changes and the canvas test still passes.

Why: the registry must exist before component waves, or each wave invents its own dialect again.

### U3 — the navigation card stops looking like AI slop

Acceptance:
- Route-option presentation (`DirectionsPanel.tsx`, `RouteCard.tsx`,
  `FloatingRouteCards.tsx`, `NavigationStatusPanel.tsx` as needed) redesigned in the U2
  language: one glance ranks the options, one line states the trade-off, details collapse away.
- The card fits 390×844 with the sheet at its first snap point; no new two-hand interactions.
- Before/after shots in the PR show the ranking story the old card lacked.
- Semantic content preserved: every number keeps its provenance/uncertainty affordance; run
  `grounding-auditor` if any label changes meaning — it must not.

### U4 — timeline controls + sliding-panel interplay

Acceptance:
- `TimelineSlider.tsx`, `BottomSheet.tsx` snap behaviour, and the path from search focus →
  results sheet → directions panel feel like one choreography at 390×844; the search bar no
  longer "slides open" over the navigation card ambiguously (owner: cumbersome).
- Touch/a11y re-audit on the changed surfaces, updating `docs/notes/touch-target-audit.md`
  rather than re-reporting it.
- Shot matrix in PR: search focused, results open, directions over search, timeline dragging.

### U5 — copy & information architecture

Acceptance:
- The hard-to-read surfaces (route cards, transit/rain cards, `PlaceDetail.tsx`, assistant
  answers, hourly strip labels) rewritten verdict-first: headline says what to do, body says
  the number and what it covers, footnote links the method page. Nothing marketing-voiced.
- Every user-facing number still traces to a method with uncertainty stated; `grounding-auditor`
  runs on the diff and its findings are resolved or filed.
- May split into two PRs (cards, then assistant/place text) if one PR would blur review.

### U6 — search: manual and assistant

Acceptance:
- Manual search gains Foursquare-backed typeahead/autocomplete (never Nominatim; OSMF policy,
  and the `providerPolicy` test stays green), richer result rows (category, hours, rating,
  photo) and distance-first ranking inside the chosen radius.
- Assistant `search_places` result presentation and plotted pins are redesigned in the same
  language; tool descriptions in `app/lib/agent/tools.ts` updated so the model uses anchors and
  retries well (its SEARCH_RADII comment is the pain).
- `npm run eval:agent` and any `search_places` unit tests stay green; `grounding-auditor` checks
  the assistant-visible strings.

---

## Harness (seeded with this track)

| File | Owns |
|---|---|
| `docs/handoffs/DESIGN_LANGUAGE.md` | Decisions, references, standing context, session prompt |
| `.claude/rules/design-language.md` | Per-file design constraints (advisory until U2) |
| `scripts/verify/design-tokens.mjs` | Token-registry enforcement; inventory mode |
| `playwright.shots.config.ts` + `e2e/shots/` | `npm run shots` phone screenshots |
| `.claude/skills/design-audit/SKILL.md` | `/design-audit` end-to-end procedure |
| `.claude/settings.json`, `package.json` | Permissions + `shots` / `design:check` scripts |

## Why this track exists

Umbra measures things almost nobody measures, and its interface currently undersells that.
The owner wants the best-looking version of it that can be managed without aesthetic drift:
one canonical language doc + a lint registry + a shot discipline means every future session —
not just this wave — starts closer to the intended look than to whatever the last session
pasted in. Pain P3 (search) also closes the gap between what Foursquare already sends
(name, category, hours, rating, photo) and what the UI shows: a plain text row.

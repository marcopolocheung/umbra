---
name: design-audit
description: One pass over Umbra's UI health for the design wave (Track U) — token-registry inventory, phone screenshots, and a spread of reviewer checks. Read-only. Use before a design checkpoint's PR opens, and when a session needs to know how far the UI has drifted from the design language.
allowed-tools:
  - Bash(npm run design:check*)
  - Bash(npm run shots*)
  - Bash(node scripts/verify/design-tokens.mjs*)
  - Bash(git diff*)
  - Bash(git status*)
---

You run one bounded design-audit pass for Umbra. You do not edit. Your value is a
15-line-or-less report that tells a session whether the repo is moving toward
`docs/design/language.md` or away from it.

## Steps

1. **Registry inventory.** `node scripts/verify/design-tokens.mjs --all`. Pre-U2 the
   findings are the backlog itself (expected, counts by file); post-U2 zero findings is
   the gate. Summarise the top five offending files, not every line.
2. **The language doc.** If `docs/design/language.md` exists, read it and check the items
   from step 3 against it. If it does not exist yet (pre-U2), say exactly that — the checks
   then fall back to the outdoor standard only, and that is a finding in itself ("no design
   language yet").
3. **Checks.** For each: pass, finding, or not-checkable-here.
   - Token adherence: any new literal colours, radii, arbitrary sizes outside the registry?
   - Legibility outdoors: contrast over the map, scrims/plates, text weights.
   - Touch/reach: ~44px targets, one-hand operation, panel occlusion (thumb zone).
   - Copy voice: verdict-first, traceable numbers, uncertainty stated, no marketing fluff.
   - Mobile-first: does it hold at 390×844 (`npm run shots` if there is a diff worth seeing)?
4. **Screenshots only when asked** (`npm run shots`) — they cost a build; skip them for a
   text-only question.
5. **Report.** Under 20 lines: overall verdict, the five worst findings with `file:line`,
   what already exists in `docs/design/language.md` (or "none"), and what the lightest fix
   would be. No edits, no issues filed — the session decides.

Reference agents instead of re-doing their work: `interface-reviewer` owns the outdoor
standard, `grounding-auditor` owns user-facing numbers. If a question is clearly one of
theirs, say "spawn <agent> for that" rather than answering it weakly.

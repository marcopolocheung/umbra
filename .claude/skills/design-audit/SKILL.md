---
name: design-audit
description: Read-only Umbra redesign 2.0 audit of token use, day/night phone shots, outdoor legibility, focus, and map safety.
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git diff*)
  - Bash(npm run design:check*)
---

# Design audit

Read `docs/design/language.md` and the current diff, then run `npm run design:check`.
Inspect the latest 390×844 day and night shots. Report `file:line` findings in
severity order; never edit files during this audit.

Check semantic roles (sun orange, shade blue, canopy green, rain purple, danger
red, neutral walking route, identified transit lines), contrast (4.5:1 text,
7:1 primary target, 3:1 essential boundaries), 11px captions, 44px targets,
focus on clipped plates, and font roles. Check that visual rotations and shadows
use registered values, numbers/controls stay square, and reduced motion or
transparency never hides core content. Inspect map overlays and confirm palette
changes retain the blue-dominant shadow pixel invariant. Separate R1 migration
work from later R2–R9 recipes when reporting.

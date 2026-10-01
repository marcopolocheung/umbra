# R8a arrival postcard review

`before/` is `main` after R7d; `after/` is this branch. Each case rides the real phase FSM (find → start → ARRIVED) on the fixture basemap: `arrival-day` and `arrival-night` are the 09:00 trip under each forced UI theme at 390×844, `arrival-sunset` the same trip at 22:00 (the sun is down where it was routed), and `desktop-arrival-*` the 1280×800 sidebar.

`arrival-sunset` is the grounding fix: `before/` says "under a minute in sun" with a shade bar for a walk the route card calls "after sunset"; `after/` says "After sunset" and draws no bar.

Capture again with `R8A_STAGE=after npm run shots -- e2e/shots/r8a-review.spec.ts`.

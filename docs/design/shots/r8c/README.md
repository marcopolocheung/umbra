# R8c empty states review

`before/` is the R8b branch; `after/` is this branch, on the fixture basemap at 390×844 in forced day and night UI themes: `idle-*` the idle sheet opened from its Trip pill, `search-empty-*` a submitted search both providers answer with nothing (stubbed), `assistant-empty-*` the assistant before its first message, and `desktop-idle-*` the 1280×800 sidebar.

`search-empty` is new behaviour: `before/` closes on nothing; `after/` says nothing came back, under a kicker/title pair. The address field's no-match line (unit-tested, not shot) moves from the danger colour to the caption tone; a failed search stays in danger.

Capture again with `R8C_STAGE=after npm run shots -- e2e/shots/r8c-review.spec.ts`.

# Touch Target Audit

Date: 2026-08-16 · re-audited 2026-09-20 (U4: timeline, bottom sheet, search/sheet interplay, directions form) · 2026-10-01 (R6a: timeline and day rulers; #162: phone control stack, no collapsed sheet; R6b: sheet edge, hourly board)

Scope: timeline slider, day slider, bottom sheet, hourly exposure board, and floating map controls for a heatwave user outdoors on a phone, one-handed. The 2026-09-20 pass re-audited exactly the surfaces U4 changed.

## Findings

| Surface | Result | Notes |
| --- | --- | --- |
| Time scrubber | Pass | Track is `h-11` (44px) and draggable across the full width. R6a redrew it as a timetable ruler (ticks on a 2px ink rule, labels under it, the real sun path above); every mark is `pointer-events: none`, and the drag, inertia and throttle code is unchanged. |
| Day scrubber | Pass | Track is 44px tall since R6a (was 48px), matching the time ruler, and draggable across the full width. |
| Timeline controls row | Fixed | Play, time/day toggle, time input, date input, and year controls now expose at least 44px height. |
| Bottom sheet drag handle | Pass | A 44px handle row and a 44px drag gate. #162 removed the 80px collapsed snap: the sheet is hidden, mid or full, so a swipe down from mid hides it. R6b squares the sheet and gives it a 2px ink top edge with an ink grip; the drag gate, snaps and spring are unchanged. |
| Hourly exposure board (R6b) | Partial | Each hour is one button spanning its whole column: 44px of bar plus the hour key and meridiem, about 78px tall. Fifteen hours share the card's width, so a column is about 20px wide at 390px, under 44px. Neighbours are adjacent hours and a mis-tap only moves the timeline one hour, which the ruler can correct; widening would mean fewer hours or a scroll. |
| Collapsed-sheet trip bar (U4) | Removed | The collapsed band is gone (#162). With the sheet hidden, a 44px Trip button sits on the left at 112px. |
| Floating map controls | Pass | 48px targets. On phones since #162: one right-hand stack of Hide interface (112px), 3D tilt (172px) and a vertical Sun/Rain switch with two 44px segments (232px). Zoom is pinch only and locate is in the search pill. |
| Segmented controls in the reopened directions form (U4) | Fixed | Walk/Transit tabs, Sun/Rain selector and Walk/Bike/Scoot travel tabs were `py-1` (~25px tall). All three now carry `min-h-11` rows (44px). Walk/Transit also gained `aria-pressed`. |
| Mobile search bar over directions (U4) | Fixed | The floating search pill no longer renders during DIRECTIONS/NAVIGATING — it previously sat half over the sheet's planning form and read as a search panel slid open over the navigation card. In IDLE/PLACE_DETAIL/ARRIVAL it is unchanged. |
| Floating map controls vs raised timeline (U4, review finding) | Fixed | #162: the stack starts at 112px, 8px clear of the 104px timeline card. The old 96/176px offsets assumed an 88px card and sat 8px under it. |

## Thumb Reach

Primary mobile actions stay in the bottom sheet or near the lower-right map edge, which keeps route entry, timeline control, and map controls in the one-handed thumb zone. The only intentionally full-width gestures are the timeline/day scrubbers, where horizontal dragging is the primary interaction.

## A11y notes (U4 pass)

- `FloatingRouteCards`' card stack now carries `role="radiogroup"` + `aria-label="Route options"`, matching the panel's stack (the smoke spec already queries that signature).
- The sun-path SVG is `aria-hidden` — the time readout is the accessible statement of the same fact; since R6a it also says "Sun down" when the ruler has no sun dot.
- The partial/failed notice is a `role="status"` pill inside the radiogroup's visual order.

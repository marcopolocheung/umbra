# Touch Target Audit

Date: 2026-08-16 · re-audited 2026-09-20 (U4: timeline, bottom sheet, search/sheet interplay, directions form)

Scope: timeline slider, day slider, bottom sheet, and floating map controls for a heatwave user outdoors on a phone, one-handed. The 2026-09-20 pass re-audited exactly the surfaces U4 changed.

## Findings

| Surface | Result | Notes |
| --- | --- | --- |
| Time scrubber | Pass | Track is `h-11` (44px) and draggable across the full width. U4 added the sun-arc glyph as `pointer-events: none` decoration inside the same 44px band — drag surface unchanged. |
| Day scrubber | Pass | Track is 48px tall and draggable across the full width. |
| Timeline controls row | Fixed | Play, time/day toggle, time input, date input, and year controls now expose at least 44px height. |
| Bottom sheet drag handle | Fixed | Pointer capture area increased from 32px to 44px, with a 44px handle row. U4: the *visual* handle row yields to 36px while the sheet is settled at the collapsed snap, so the 80px band fits the trip bar's full 44px target below it; the drag gate still accepts pointers in the top 44px. |
| Collapsed-sheet trip bar (U4) | Fixed | Previously the 80px collapsed band left the trip bar ~36px. With the 36px collapsed handle row, the bar's 44px minimum (`min-h-11`) now fits fully inside the band — prime thumb-zone (Fitts). |
| Floating map controls | Pass | Buttons are 48px square and remain bottom-right on mobile, above the bottom sheet. |
| Segmented controls in the reopened directions form (U4) | Fixed | Walk/Transit tabs, Sun/Rain selector and Walk/Bike/Scoot travel tabs were `py-1` (~25px tall). All three now carry `min-h-11` rows (44px). Walk/Transit also gained `aria-pressed`. |
| Mobile search bar over directions (U4) | Fixed | The floating search pill no longer renders during DIRECTIONS/NAVIGATING — it previously sat half over the sheet's planning form and read as a search panel slid open over the navigation card. In IDLE/PLACE_DETAIL/ARRIVAL it is unchanged. |

## Thumb Reach

Primary mobile actions stay in the bottom sheet or near the lower-right map edge, which keeps route entry, timeline control, and map controls in the one-handed thumb zone. The only intentionally full-width gestures are the timeline/day scrubbers, where horizontal dragging is the primary interaction.

## A11y notes (U4 pass)

- `FloatingRouteCards`' card stack now carries `role="radiogroup"` + `aria-label="Route options"`, matching the panel's stack (the smoke spec already queries that signature).
- The sun-arc SVG is `aria-hidden` — the time readout is the accessible statement of the same fact.
- The partial/failed notice is a `role="status"` pill inside the radiogroup's visual order.

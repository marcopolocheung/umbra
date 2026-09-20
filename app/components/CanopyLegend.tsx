import type { CanopyLegendState } from "../lib/canopyRaster/canopyLayer";
import {
  CANOPY_FILL_OPACITY,
  CANOPY_PAINT_MIN_HEIGHT_M,
} from "../lib/canopyRaster/canopyPaint";

/** The fill as the map shows it: composited over the basemap, not the raw colour. */
const SWATCH = `color-mix(in srgb, var(--color-canopy-map) ${
  Math.round(CANOPY_FILL_OPACITY * 100)
}%, var(--color-basemap-street))`;

const imageryMonth = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Says what the green fill is, whenever there is fill to explain.
 *
 * It is a model's estimate from satellite imagery, and the UI rule is that every
 * claim states its uncertainty. Where the imagery was flown with the trees bare
 * (issue 281), it says that too — and then shows even over an empty map, because there
 * the absence of green is not evidence of no trees.
 *
 * Kept to one line on a phone: it is permanent and sits over the map being read.
 */
export default function CanopyLegend({ state }: { state: CanopyLegendState | null }) {
  if (!state) return null;
  const { imagery } = state;

  return (
    <div
      // Phone: under the search bar and the shadow legend. Desktop: bottom-left above
      // the timeline, but past the 408 px sidebar (`AppShell.tsx`), which covers the
      // map's left edge whenever it is open — exactly when a route card is quoting
      // canopy. The map container spans the sidebar, so a centred plate slid under it.
      className="pointer-events-none absolute left-4 top-36 z-10 max-w-[calc(100%-2rem)] rounded-lg border px-3 py-1.5 text-xs shadow-lg md:top-auto md:bottom-36 md:left-[calc(408px+1rem)] md:max-w-legend"
      style={{
        background: "var(--color-raised)",
        borderColor: "var(--color-hairline)",
        color: "var(--color-ink)",
        fontFamily: "var(--font-sans)",
      }}
      role="note"
      data-testid="canopy-legend"
    >
      <div className="flex items-center gap-2 font-medium">
        <span
          className="h-4 w-4 shrink-0 rounded-sm border"
          style={{ background: SWATCH, borderColor: "var(--color-hairline-strong)" }}
          aria-hidden="true"
        />
        Estimated tree canopy (satellite)
      </div>
      <p className="mt-0.5 hidden leading-snug md:block" style={{ color: "var(--color-ink-muted)" }}>
        Modelled heights, {CANOPY_PAINT_MIN_HEIGHT_M} m and taller. Not a tree survey.
      </p>
      {imagery?.leafOff && (
        <p className="mt-0.5 leading-snug font-medium" style={{ color: "var(--color-sun)" }}>
          {imageryMonth(imagery.date)} imagery, trees bare: undercounts
        </p>
      )}
    </div>
  );
}

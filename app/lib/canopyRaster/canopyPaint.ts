/**
 * A8f — what the map paints from the canopy raster, and how it asks for it.
 *
 * A8d put the raster into `ShadowField`, so a route card quotes canopy shade over a
 * map that drew no tree (#275). This is the other half: the viewport's read of the
 * same raster, turned into an image the map can lay down. It has no map in it, so
 * everything here is tested in Node; `canopyLayer.ts` is the MapLibre shell around it.
 *
 * ## It paints canopy *extent*, not canopy *shadow*
 *
 * The raster is a height model: "vegetation this tall stands here". Painting that is
 * painting what the source is. Tree *shadow* in the WebGL renderer would be fractional
 * — a crown stops ~90% of the beam in leaf and ~30% out of it — and a fractional
 * shadow either fails `isBlueDominantShadowPixel` (the canvas fallback cannot see it)
 * or passes it (the fallback counts it as a full building shadow). That needs its own
 * acceptance criteria, #275 says so, and it would put the renderer in scope. Here the
 * renderer is untouched.
 *
 * ## Invariant #5 is why the colour is this colour
 *
 * The canvas fallback decides "shadowed" with `isBlueDominantShadowPixel` on the
 * composited canvas, and the fill sits *under* the shadow layer — above it, a green
 * wash over every shaded street would read as open sun. So building shadow now lands
 * on the fill instead of the basemap, and has to stay recognisable there.
 *
 * Compositing is linear, and each of the predicate's three tests is a half-space, so
 * for a given sun the backgrounds that a *fully covered* shadow pixel stays detectable
 * over form a convex set. A fill that is itself inside that set at both ends of the
 * shadow colour's range — the dark dawn blue and the lighter noon blue — keeps any
 * background that was already inside it inside, at any opacity. What that demands of
 * the fill is a small warmth, `(r + g) / 2 − b`: below ~28 or the dawn blue stops
 * reading as blue over it. A yellow-green — the obvious tree colour — fails that
 * outright, so the fill is a cool sea green. `canopyPaint.test.ts` pins both ends, and
 * the A3 agreement harness is re-run over it.
 *
 * The argument stops at a shadow's anti-aliased rim, where a pixel is only partly
 * covered: there the fill moves the coverage at which the pixel starts to count, by
 * under a fifth of a pixel either way at this opacity — also pinned by a test.
 *
 * The fill's warmth is also kept at or above zero, so it can never *create* a
 * blue-dominant pixel over the surfaces it lands on: sunlit canopy does not read as
 * shadow.
 */

import { inLeaf } from "../shadowField/canopy";
import { acquisitionAt } from "./acqDate";
import type { CanopyPatch, CanopyTileStore } from "./canopyTileStore";
import {
  CANOPY_TILE_ZOOM,
  type LonLatBbox,
  lonLatToMercator,
  mercatorToLonLat,
  quadkeysForBbox,
  tileXYForQuadkey,
} from "./tiles";

/**
 * The shortest canopy painted, in metres.
 *
 * A8c measured three thresholds, `>2`, `>3` and `>5` m. On uint8 whole-metre data
 * `>2` means `≥3`, and it is the one picked: it is the lowest A8c measured, so it
 * hides the least of what `ShadowField` marches (which casts from 1 m), and it was
 * already clean — 1.1–3.7% of building footprint reads as canopy at `>2` m, below
 * chance in every city. What it excludes is the 1–2 m band: hedges, shrubs and the
 * model's rounding of bare ground, none of which a pedestrian stands under.
 */
export const CANOPY_PAINT_MIN_HEIGHT_M = 3;

/** Sea green, `#2e8b57`. Warmth `(r + g) / 2 − b` = 5.5; see the module comment. */
export const CANOPY_FILL_RGB: readonly [number, number, number] = [46, 139, 87];

/**
 * How strongly the fill covers the basemap. The predicate holds at any value, so this
 * is legibility alone — and the role shrank when the shadow layer learned to paint
 * canopy protection (stage 2): the fill is the *location* layer now, not the shading.
 * Where a crown's protection is estimated, the blue-dominant shadow pass paints it,
 * the same palette buildings use; the fill only has to say "vegetation stands here",
 * which reads at 0.30 and stops competing with the protection it used to fake.
 */
export const CANOPY_FILL_OPACITY = 0.30;

/**
 * Below this zoom the layer paints nothing and reads nothing.
 *
 * The fill exists to explain a route card, which is read at street zoom; zoomed out,
 * a viewport asks for a region, and a threshold applied to a coarse overview says
 * little about any one street. The building layer's own floor is 12.
 */
export const MIN_CANOPY_ZOOM = 14;

/**
 * The largest area the layer reads, as a half-extent around the camera centre.
 *
 * Only a tilted camera reaches it: its bounds run toward the horizon, and the far
 * edge is where the fewest screen pixels cover the most ground.
 */
export const MAX_VIEW_HALF_M = 6000;

/** The image is read no finer than this many pixels across its longer side. */
const MAX_IMAGE_SIDE_PX = 1024;

/**
 * The route corridor's read resolution — `canopyCog.ts`'s `TARGET_GROUND_RES_M`.
 *
 * Restated rather than imported because `canopyCog.ts` imports `geotiff.js`, and this
 * module ships with the map; the test suite holds the two equal. Equal matters: it is
 * what makes a zoomed-in viewport read the same blocks the corridor does.
 */
export const CORRIDOR_GROUND_RES_M = 2.0;

/**
 * Lon/lat inset from a quadkey's edge, in degrees (~1 cm).
 *
 * `CanopyTileStore` rounds an area outward to whole pixels and opens every quadkey
 * the rounded window touches. An area clipped *exactly* to a quadkey's edge can land
 * a hair over it in floating point, and the store would then open the neighbour — the
 * one read per quadkey exists to avoid. A centimetre is far above floating-point error
 * and far below a pixel at any level.
 */
const QUADKEY_INSET_DEG = 1e-7;

/** One read of the viewport, confined to a single published quadkey. */
export interface ViewportRead {
  quadkey: string;
  aoi: LonLatBbox;
}

/**
 * The viewport as one read per zoom 10 quadkey.
 *
 * **Because a quadkey may not exist.** The dataset publishes a COG only for tiles
 * with land in them — mid-ocean quadkeys 404 (#289, probed 2026-09-10) — and the
 * store fails a whole read if any quadkey it spans cannot be opened, which is right
 * for a route corridor. A viewport over a harbour can straddle an unpublished tile,
 * so it reads each quadkey separately and paints whichever arrive. The missing one is
 * simply not painted, which is also what nodata looks like.
 */
export function viewportReads(bbox: LonLatBbox): ViewportRead[] {
  const reads: ViewportRead[] = [];
  for (const quadkey of quadkeysForBbox(bbox)) {
    const [west, south, east, north] = quadkeyLonLatBbox(quadkey);
    const aoi: LonLatBbox = [
      Math.max(bbox[0], west + QUADKEY_INSET_DEG),
      Math.max(bbox[1], south + QUADKEY_INSET_DEG),
      Math.min(bbox[2], east - QUADKEY_INSET_DEG),
      Math.min(bbox[3], north - QUADKEY_INSET_DEG),
    ];
    if (aoi[2] > aoi[0] && aoi[3] > aoi[1]) reads.push({ quadkey, aoi });
  }
  return reads;
}

/** Clip a bbox to a square of `halfM` metres around a centre. */
export function clampAround(bbox: LonLatBbox, centre: [number, number], halfM: number): LonLatBbox {
  const dLat = halfM / 111_320;
  const dLon = dLat / Math.cos((centre[1] * Math.PI) / 180);
  return [
    Math.max(bbox[0], centre[0] - dLon),
    Math.max(bbox[1], centre[1] - dLat),
    Math.min(bbox[2], centre[0] + dLon),
    Math.min(bbox[3], centre[1] + dLat),
  ];
}

/**
 * Ground metres per pixel to ask the store for.
 *
 * The corridor's own resolution whenever the view is small enough to afford it —
 * which is when the two consumers share blocks — and coarser as the view widens. The
 * store picks the coarsest level at or finer than this, and levels halve, so the
 * image stays under `2 × MAX_IMAGE_SIDE_PX` on its long side: ~4 MP at most, far
 * inside the store's pixel guard and any phone's texture limit.
 */
export function targetGroundResFor(bbox: LonLatBbox): number {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthM = (bbox[2] - bbox[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox[3] - bbox[1]) * 111_320;
  return Math.max(CORRIDOR_GROUND_RES_M, Math.max(widthM, heightM) / MAX_IMAGE_SIDE_PX);
}

/**
 * Read the viewport, one quadkey at a time, and keep whatever arrived.
 *
 * Rejects only on abort, so a caller can tell "superseded" from "nothing to paint";
 * every other failure is a quadkey left unpainted.
 */
export async function readViewport(
  store: Pick<CanopyTileStore, "read">,
  bbox: LonLatBbox,
  signal?: AbortSignal,
): Promise<CanopyPatch[]> {
  const targetGroundRes = targetGroundResFor(bbox);
  const settled = await Promise.allSettled(
    viewportReads(bbox).map(({ aoi }) => store.read(aoi, { targetGroundRes, signal })),
  );
  if (signal?.aborted) throw new DOMException("canopy viewport read superseded", "AbortError");
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/** An RGBA image of estimated canopy, and the lon/lat box its pixels cover. */
export interface CanopyImage {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  bbox: LonLatBbox;
  /** Pixels painted as canopy. Zero is a real answer: the model saw none here. */
  painted: number;
}

/**
 * Paint patches into one image on a Web Mercator pixel grid.
 *
 * Each patch is already a Mercator grid, so an image source with the union's four
 * corners lines up with the map exactly. Patches from neighbouring quadkeys are almost
 * always at the same level; the finest one sets the grid, and the rest are sampled onto
 * it by nearest pixel rather than assumed to align.
 *
 * A pixel is painted only where the model produced an answer *and* that answer is at
 * least `CANOPY_PAINT_MIN_HEIGHT_M`. Nodata is left clear, never read as bare ground.
 */
export function paintPatches(patches: CanopyPatch[]): CanopyImage | null {
  if (patches.length === 0) return null;

  const placed = patches.map((patch) => {
    const [minX, minY] = lonLatToMercator(patch.bbox[0], patch.bbox[1]);
    const [maxX, maxY] = lonLatToMercator(patch.bbox[2], patch.bbox[3]);
    return { patch, minX, minY, maxX, maxY, res: (maxX - minX) / patch.width };
  });

  const res = Math.min(...placed.map((p) => p.res));
  const minX = Math.min(...placed.map((p) => p.minX));
  const minY = Math.min(...placed.map((p) => p.minY));
  const maxX = Math.max(...placed.map((p) => p.maxX));
  const maxY = Math.max(...placed.map((p) => p.maxY));
  const width = Math.round((maxX - minX) / res);
  const height = Math.round((maxY - minY) / res);

  const rgba = new Uint8ClampedArray(width * height * 4);
  let painted = 0;
  const [r, g, b] = CANOPY_FILL_RGB;

  for (const { patch, ...box } of placed) {
    const x0 = Math.round((box.minX - minX) / res);
    const x1 = Math.round((box.maxX - minX) / res);
    const y0 = Math.round((maxY - box.maxY) / res);
    const y1 = Math.round((maxY - box.minY) / res);
    const scaleX = patch.width / (x1 - x0);
    const scaleY = patch.height / (y1 - y0);

    for (let y = y0; y < y1; y++) {
      const row = Math.min(patch.height - 1, Math.floor((y - y0 + 0.5) * scaleY)) * patch.width;
      for (let x = x0; x < x1; x++) {
        const source = row + Math.min(patch.width - 1, Math.floor((x - x0 + 0.5) * scaleX));
        const valid = patch.valid === null || patch.valid[source] === 1;
        if (valid && patch.heights[source] >= CANOPY_PAINT_MIN_HEIGHT_M) {
          const i = (y * width + x) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = 255;
          painted += 1;
        }
      }
    }
  }

  const [west, south] = mercatorToLonLat(minX, minY);
  const [east, north] = mercatorToLonLat(maxX, maxY);
  return { rgba, width, height, bbox: [west, south, east, north], painted };
}

/** When the imagery under a point was taken, and whether its trees were bare. */
export interface CanopyImagery {
  /** ISO date, e.g. `"2020-02-20"`. */
  date: string;
  /**
   * Taken outside the leaf season at this latitude, by `canopy.ts`'s own calendar.
   * The model then sees bare crowns and under-detects deciduous canopy (#281).
   */
  leafOff: boolean;
}

/**
 * The imagery date under a point, or `null` where this build does not know it.
 *
 * Only the three A3 corpus tiles are indexed (`acqDate.ts`), so `null` is the common
 * answer and means "unknown", never "recent" or "leaf-on". Madrid is indexed, and its
 * February imagery is the one the map must not hide: the fill there shows fewer
 * trees than stand. Correcting for it is A8e's; saying so is this checkpoint's.
 */
export function imageryAt(lon: number, lat: number): CanopyImagery | null {
  const acquisition = acquisitionAt(lon, lat);
  if (!acquisition) return null;
  // Untagged is `canopy.ts`'s deciduous default, the same assumption A8d makes.
  const taken = new Date(`${acquisition.date}T12:00:00Z`);
  return { date: acquisition.date, leafOff: !inLeaf({}, taken, lat) };
}

/** A zoom 10 quadkey's extent, in degrees. */
function quadkeyLonLatBbox(quadkey: string): LonLatBbox {
  const [x, y] = tileXYForQuadkey(quadkey);
  const n = 2 ** CANOPY_TILE_ZOOM;
  const lonAt = (tx: number) => (tx / n) * 360 - 180;
  const latAt = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lonAt(x), latAt(y + 1), lonAt(x + 1), latAt(y)];
}

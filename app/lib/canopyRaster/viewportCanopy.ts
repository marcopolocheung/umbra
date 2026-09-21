/**
 * The viewport canopy atlas (stage 2 of canopy shadows for sun and rain).
 *
 * One controller, reading through the same shared tile store the route corridor
 * and the green footprint use, that hands the shadow renderer a **prepared height
 * atlas**: the viewport plus a 400 m border of offscreen casters, geographically
 * aligned (the store stitches neighbouring quadkeys into one grid), coarsened only
 * as far as the 2048² atlas cap demands. Time and wind never re-read it — the march
 * direction changes, the geometry does not — so the atlas is cached per
 * (area, resolution) and stamped with a generation the renderer can discard against.
 *
 * The green footprint (`canopyLayer.ts`) keeps its own reader: it paints
 * progressively, quadkey by quadkey, while the renderer needs one aligned grid and
 * can wait a `moveend` for it. Both read through `sharedCanopyTileStore()`, so the
 * viewport and the corridor still dedupe against each other, and each keeps its own
 * `AbortController` — the store refcounts fetches, so cancelling the viewport never
 * cancels a corridor read waiting on the same blocks.
 */

import type { CanopyPatch, CanopyTileStore } from "./canopyTileStore";
import { sharedCanopyTileStore } from "./sharedStore";
import type { LonLatBbox } from "./tiles";
import { clampAround, MAX_VIEW_HALF_M, MIN_CANOPY_ZOOM } from "./canopyPaint";

/** The atlas's hard side cap. 2048² of height plus validity is ~5 MB. */
export const CANOPY_ATLAS_MAX_SIDE = 2048;

/**
 * Ground metres of *extra* reach read around the viewport, for casters standing
 * off-screen whose shadows fall into it. The march itself stops at `MAX_MARCH_M`
 * (400 m), so the border matches it: a caster further out than the march walks
 * cannot reach the viewport, and a border larger than the march wastes pixels.
 */
export const CANOPY_ATLAS_BORDER_M = 400;

/**
 * A prepared canopy height atlas, ready for upload or marching.
 *
 * `heights`/`valid` are copies, not the store's cached arrays: the store's cache
 * must survive this snapshot being transferred to a worker or released by the
 * renderer.
 */
export interface CanopyAtlas {
  heights: Uint8Array;
  valid: Uint8Array | null;
  width: number;
  height: number;
  bbox: LonLatBbox;
  metresPerPixel: number;
  /** Monotonic per controller; a snapshot is superseded when a larger one exists. */
  generation: number;
}

/**
 * Ground metres per pixel for a viewport atlas: the 2 m corridor resolution
 * wherever the view affords it, coarsened only as far as the 2048² cap demands.
 */
export function atlasGroundResFor(bbox: LonLatBbox): number {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthM = (bbox[2] - bbox[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox[3] - bbox[1]) * 111_320;
  const extentM = Math.max(widthM, heightM) + 2 * CANOPY_ATLAS_BORDER_M;
  return Math.max(2, extentM / CANOPY_ATLAS_MAX_SIDE);
}

/** The bbox actually read: the viewport padded by the caster border. */
export function atlasBboxFor(viewport: LonLatBbox, centre: [number, number]): LonLatBbox {
  const dLat = CANOPY_ATLAS_BORDER_M / 111_320;
  const dLon = dLat / Math.cos((centre[1] * Math.PI) / 180);
  const padded: LonLatBbox = [
    viewport[0] - dLon,
    viewport[1] - dLat,
    viewport[2] + dLon,
    viewport[3] + dLat,
  ];
  // The extent limit applies to the *viewport*, not the border: clipping what is
  // displayed must not clip the casters behind it.
  return clampAround(padded, centre, MAX_VIEW_HALF_M + CANOPY_ATLAS_BORDER_M);
}

/**
 * Copy a patch into an atlas-sized buffer, decimating only if the patch exceeds
 * the cap — which `atlasGroundResFor` prevents for reads that went through it,
 * but a hand-made patch (a test, a future caller with its own resolution policy)
 * must still be handled rather than trusted.
 *
 * Nearest-neighbour decimation, taking the top-left pixel of each block: the march
 * samples heights nearest-neighbour too, and the under-reporting direction of
 * dropping a tall pixel is the one this repo picks over inventing one (averaging
 * would grow a 1 m hedge into a 6 m caster wherever it shared a block).
 */
export function toAtlas(patch: CanopyPatch, generation: number): CanopyAtlas {
  const step = Math.max(1, Math.ceil(Math.max(patch.width, patch.height) / CANOPY_ATLAS_MAX_SIDE));
  if (step === 1) {
    return {
      heights: patch.heights.slice(),
      valid: patch.valid ? patch.valid.slice() : null,
      width: patch.width,
      height: patch.height,
      bbox: [...patch.bbox] as LonLatBbox,
      metresPerPixel: patch.metresPerPixel,
      generation,
    };
  }
  const width = Math.floor((patch.width + step - 1) / step);
  const height = Math.floor((patch.height + step - 1) / step);
  const heights = new Uint8Array(width * height);
  let valid: Uint8Array | null = null;
  if (patch.valid) valid = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = patch.width * row * step + col * step;
      const out = row * width + col;
      heights[out] = patch.heights[i];
      if (valid) valid[out] = patch.valid ? patch.valid[i] : 1;
    }
  }
  return {
    heights,
    valid,
    width,
    height,
    bbox: [...patch.bbox] as LonLatBbox,
    metresPerPixel: patch.metresPerPixel * step,
    generation,
  };
}

/** What the controller needs of the map — the slice tests can fake. */
export interface CanopyViewMap {
  getZoom(): number;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  getCenter(): { lng: number; lat: number };
}

export interface CanopyAtlasSnapshot {
  atlas: CanopyAtlas;
  /** The viewport the atlas was read for — smaller than `atlas.bbox` by the border. */
  viewport: LonLatBbox;
}

export interface CanopyViewportHandle {
  setEnabled(enabled: boolean): void;
  remove(): void;
}

/**
 * Reads the viewport atlas on demand and reports it with a generation.
 *
 * Deliberately *not* wired to map events itself: the shadow renderer owns when a
 * re-read is worth a `moveend` (and the debouncing that keeps interaction smooth),
 * the same way `canopyLayer.ts` owns its own `moveend`. What this owns is the
 * read: the border, the resolution policy, the coarsening, the abort, and the
 * "nothing changed here" cache.
 */
export function createCanopyViewportReader(
  opts: {
    getStore?: () => Promise<Pick<CanopyTileStore, "read">>;
    onAtlas: (snapshot: CanopyAtlasSnapshot | null) => void;
  },
): (map: CanopyViewMap) => Promise<void> {
  const getStore = opts.getStore ?? sharedCanopyTileStore;
  let controller: AbortController | null = null;
  let generation = 0;
  /** The last successful read, so a pan inside it at the same resolution is free. */
  let cached: { bbox: LonLatBbox; res: number; snapshot: CanopyAtlasSnapshot } | null = null;

  return async function readViewportAtlas(map: CanopyViewMap): Promise<void> {
    controller?.abort();
    controller = null;
    if (map.getZoom() < MIN_CANOPY_ZOOM) {
      cached = null;
      opts.onAtlas(null);
      return;
    }

    const bounds = map.getBounds();
    const centre = map.getCenter();
    const viewport = clampAround(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      [centre.lng, centre.lat],
      MAX_VIEW_HALF_M,
    );
    const res = atlasGroundResFor(viewport);
    if (cached && cached.res === res && bboxContains(cached.bbox, viewport)) {
      opts.onAtlas(cached.snapshot);
      return;
    }

    const ctrl = new AbortController();
    controller = ctrl;
    try {
      const store = await getStore();
      const bbox = atlasBboxFor(viewport, [centre.lng, centre.lat]);
      const patch = await store.read(bbox, {
        targetGroundRes: res,
        priority: "viewport",
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      generation += 1;
      const snapshot: CanopyAtlasSnapshot = {
        atlas: toAtlas(patch, generation),
        viewport: [...viewport] as LonLatBbox,
      };
      cached = { bbox, res, snapshot };
      opts.onAtlas(snapshot);
    } catch (error) {
      // Superseded by a newer read — which owns the listener now — or the read
      // failed, which the next request retries. Only a genuinely failed (not
      // aborted) read clears what the renderer previously had.
      if (!ctrl.signal.aborted) {
        cached = null;
        opts.onAtlas(null);
      } else {
        void error;
      }
    }
  };
}

function bboxContains(outer: LonLatBbox, inner: LonLatBbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

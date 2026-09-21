/**
 * A8f — the estimated-canopy fill on the map: the MapLibre shell around
 * `canopyPaint.ts`.
 *
 * One image source, re-read on `moveend` and painted under the basemap's water,
 * roads and buildings. The placement matters for invariant #5 — see `beforeIdFor`.
 *
 * It reads through `sharedCanopyTileStore()`, the store the route corridor already
 * uses, so the two consumers A8b was built for finally share one cache. Each viewport
 * read has its own `AbortController` and is aborted when the camera moves again; the
 * store refcounts its fetches, so aborting the viewport cannot cancel a corridor read
 * waiting on the same blocks.
 */

import type maplibregl from "maplibre-gl";
import {
  CANOPY_FILL_OPACITY,
  type CanopyImage,
  type CanopyImagery,
  MAX_VIEW_HALF_M,
  MIN_CANOPY_ZOOM,
  clampAround,
  imageryAt,
  paintPatches,
  readViewport,
  targetGroundResFor,
} from "./canopyPaint";
import type { CanopyTileStore } from "./canopyTileStore";
import { sharedCanopyTileStore } from "./sharedStore";
import type { LonLatBbox } from "./tiles";

export const CANOPY_SOURCE_ID = "canopy-estimate";
export const CANOPY_LAYER_ID = "canopy-estimate-fill";

/** What the legend needs: `null` while nothing is painted. */
export interface CanopyLegendState {
  imagery: CanopyImagery | null;
}

/**
 * The layer the fill goes directly beneath: the basemap's first water layer.
 *
 * Everything drawn after it — water, roads, bridges, buildings — covers the fill, and
 * that is deliberate. Water is the one basemap surface blue enough to sit at or past
 * the shadow predicate on its own: outdoor-v2's street-zoom water, ~(149, 201, 242),
 * already passes it, sunlit, on `main`. A fill mixed into it would be measured against
 * a surface that is already a false shadow, and no colour choice fixes that. Under the
 * water, the fill only composites with the landcover and landuse greens and greys the
 * colour was checked against (`canopyPaint.test.ts`). Covering by buildings is also
 * what `ShadowField` does: it subtracts the footprints from the raster before marching
 * it.
 *
 * `fallback` — the shadow layer — is for a style with no water layer. The fill must
 * never be drawn above the shadow layer while the camera is flat.
 */
function beforeIdFor(map: CanopyMap, fallback: string): string {
  for (const id of map.getLayersOrder()) {
    const sourceLayer = map.getLayer(id)?.sourceLayer;
    if (sourceLayer === "water" || sourceLayer === "waterway") return id;
  }
  return fallback;
}

export interface CanopyLayerHandle {
  /**
   * Off in Sun Exposure mode, whose GeoTIFF export writes the canvas out as it is
   * drawn: the fill stays out of an export it was never part of.
   */
  setEnabled(enabled: boolean): void;
  remove(): void;
}

/** The slice of `maplibregl.Map` the layer uses — what the tests fake. */
type CanopyMap = Pick<
  maplibregl.Map,
  | "on"
  | "off"
  | "getZoom"
  | "getBounds"
  | "getCenter"
  | "getSource"
  | "addSource"
  | "addLayer"
  | "getLayer"
  | "getLayersOrder"
  | "setLayoutProperty"
>;

export function attachCanopyLayer(
  map: CanopyMap,
  opts: {
    belowLayerId: string;
    enabled: boolean;
    /** Optional since the legend was removed; tests still assert on it. */
    onChange?: (state: CanopyLegendState | null) => void;
    /** Injected by tests; the app reads through the one shared store. */
    getStore?: () => Promise<Pick<CanopyTileStore, "read">>;
    /** Injected by tests, which have no canvas; the app encodes a PNG object URL. */
    encode?: (image: CanopyImage) => Promise<string>;
  },
): CanopyLayerHandle {
  const getStore = opts.getStore ?? sharedCanopyTileStore;
  const encode = opts.encode ?? toObjectUrl;
  let enabled = opts.enabled;
  let controller: AbortController | null = null;
  let objectUrl: string | null = null;
  /** What is on the map now, so a move inside it at the same resolution costs nothing. */
  let onMap: { bbox: LonLatBbox; targetGroundRes: number; painted: number } | null = null;
  let legendKey: string | null = null;

  /**
   * Tell the legend, only when what it says changed — every `moveend` would otherwise
   * re-render the map component for nothing.
   *
   * It is shown when there is fill to explain, or when the imagery was leaf-off: in
   * Madrid an empty map is *not* evidence of no trees, and that is worth saying.
   */
  function emit(painted: number, imagery: CanopyImagery | null): void {
    const state = painted > 0 || imagery?.leafOff ? { imagery } : null;
    const key = JSON.stringify(state);
    if (key === legendKey) return;
    legendKey = key;
    opts.onChange?.(state);
  }

  function hide(): void {
    if (map.getLayer(CANOPY_LAYER_ID)) map.setLayoutProperty(CANOPY_LAYER_ID, "visibility", "none");
    onMap = null;
    emit(0, null);
  }

  function show(url: string, image: CanopyImage, targetGroundRes: number, imagery: CanopyImagery | null): void {
    const [west, south, east, north] = image.bbox;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];
    const source = map.getSource(CANOPY_SOURCE_ID) as maplibregl.ImageSource | undefined;
    if (source) {
      source.updateImage({ url, coordinates });
    } else {
      map.addSource(CANOPY_SOURCE_ID, { type: "image", url, coordinates });
      map.addLayer(
        {
          id: CANOPY_LAYER_ID,
          type: "raster",
          source: CANOPY_SOURCE_ID,
          paint: { "raster-opacity": CANOPY_FILL_OPACITY, "raster-fade-duration": 0 },
        },
        beforeIdFor(map, opts.belowLayerId),
      );
    }
    map.setLayoutProperty(CANOPY_LAYER_ID, "visibility", "visible");
    // The previous image is decoded, or its load was just aborted by `updateImage`.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url;
    onMap = { bbox: image.bbox, targetGroundRes, painted: image.painted };
    emit(image.painted, imagery);
  }

  async function refresh(): Promise<void> {
    controller?.abort();
    controller = null;
    if (!enabled || map.getZoom() < MIN_CANOPY_ZOOM) {
      hide();
      return;
    }

    const bounds = map.getBounds();
    const centre = map.getCenter();
    const bbox = clampAround(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      [centre.lng, centre.lat],
      MAX_VIEW_HALF_M,
    );
    const targetGroundRes = targetGroundResFor(bbox);
    if (onMap && onMap.targetGroundRes === targetGroundRes && contains(onMap.bbox, bbox)) {
      emit(onMap.painted, imageryAt(centre.lng, centre.lat));
      return;
    }

    const ctrl = new AbortController();
    controller = ctrl;
    try {
      const store = await getStore();
      const image = paintPatches(await readViewport(store, bbox, ctrl.signal));
      if (ctrl.signal.aborted) return;
      // No quadkey answered — open ocean, or the host is unreachable. A legend over
      // an empty map would claim the canopy here was assessed and found absent.
      if (!image) {
        hide();
        return;
      }
      const url = await encode(image);
      if (ctrl.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      show(url, image, targetGroundRes, imageryAt(centre.lng, centre.lat));
    } catch {
      // Superseded by a newer read — which owns the map now — or the store's chunk
      // failed to load, which the next `moveend` retries.
      if (!ctrl.signal.aborted) hide();
    }
  }

  map.on("moveend", refresh);
  void refresh();

  return {
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      void refresh();
    },
    remove() {
      controller?.abort();
      map.off("moveend", refresh);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}

function contains(outer: LonLatBbox, inner: LonLatBbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

let scratch: HTMLCanvasElement | null = null;

/** Encode the image for an image source, reusing one scratch canvas. */
async function toObjectUrl(image: CanopyImage): Promise<string> {
  scratch ??= document.createElement("canvas");
  const canvas = scratch;
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d canvas unavailable");
  context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canopy image could not be encoded");
  return URL.createObjectURL(blob);
}

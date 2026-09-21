/**
 * Legacy raster rain helper retained for old fixtures and imports.
 *
 * Production rain rendering uses LocalShadowAdapter's shared geometry pipeline;
 * this viewport raster layer is intentionally not installed by the app.
 *
 * The legacy grid is a small canvas the GPU stretches with linear filtering, so adjacent
 * cells ramp into each other instead of abutting as hard GeoJSON edges. The value
 * behind each pixel is the same sheltered share the route cards pay for, priced here
 * at the map centre's wind (from-bearing, m/s).
 */

import type maplibregl from "maplibre-gl";
import type { BBox, RainGrid } from "../shadowField/ShadowField";
import { RAIN_WET_ALPHA, RAIN_WET_RGB } from "./rainComposite";

export const RAIN_LAYER_ID = "local-rain-layer";
export const RAIN_SOURCE_ID = "local-rain-source";
export const SHADOW_LAYER_ID = "local-shadow-layer";

/** Colors/rows for the sampled grid: fine enough for block-scale structure, coarse enough for one index-build per viewport update. */
export const RAIN_GRID_COLS = 128;
export const RAIN_GRID_ROWS = 80;

/**
 * The wash image as a straight (non-premultiplied) RGBA strip, one pixel per
 * grid cell: legacy wet blue at `RAIN_WET_ALPHA × exposed`, transparent under shelter.
 * Pure so the exposure→pixel mapping stays pinned by a test without a DOM.
 */
export function rainWashPixels(grid: RainGrid): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const { cols, rows, values } = grid;
  const data = new Uint8ClampedArray(new ArrayBuffer(cols * rows * 4));
  const r8 = Math.round(RAIN_WET_RGB[0] * 255);
  const g8 = Math.round(RAIN_WET_RGB[1] * 255);
  const b8 = Math.round(RAIN_WET_RGB[2] * 255);
  for (let i = 0; i < values.length; i++) {
    const exposed = Math.max(0, Math.min(1, 1 - values[i]));
    const a8 = Math.round(RAIN_WET_ALPHA * exposed * 255);
    const k = i * 4;
    data[k] = r8;
    data[k + 1] = g8;
    data[k + 2] = b8;
    data[k + 3] = a8;
  }
  return { data, width: cols, height: rows };
}

const drawInto = (canvas: HTMLCanvasElement, grid: RainGrid | null): void => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (!grid) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const { data, width, height } = rainWashPixels(grid);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
};

/** Clockwise from the top-left corner, as the canvas source expects. */
const coordinatesFor = (bounds: BBox): [[number, number], [number, number], [number, number], [number, number]] => [
  [bounds.west, bounds.north],
  [bounds.east, bounds.north],
  [bounds.east, bounds.south],
  [bounds.west, bounds.south],
];

const rainBoundsOf = (map: maplibregl.Map): BBox => {
  const b = map.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
};

const canvasFor = (map: maplibregl.Map, bounds: BBox): maplibregl.CanvasSource => {
  let source = map.getSource(RAIN_SOURCE_ID) as maplibregl.CanvasSource | undefined;
  if (!source) {
    const canvas = document.createElement("canvas");
    canvas.width = RAIN_GRID_COLS;
    canvas.height = RAIN_GRID_ROWS;
    map.addSource(RAIN_SOURCE_ID, {
      type: "canvas",
      canvas,
      animate: true,
      coordinates: coordinatesFor(bounds),
    });
    source = map.getSource(RAIN_SOURCE_ID) as maplibregl.CanvasSource;
  }
  return source;
};

/** Adds the legacy layer for compatibility fixtures; production does not call this. */
export function ensureRainMapLayer(map: maplibregl.Map): void {
  if (map.getLayer(RAIN_LAYER_ID)) return;
  canvasFor(map, rainBoundsOf(map));
  const beforeId = map.getLayer(SHADOW_LAYER_ID) ? SHADOW_LAYER_ID : undefined;
  map.addLayer(
    {
      id: RAIN_LAYER_ID,
      type: "raster",
      source: RAIN_SOURCE_ID,
      layout: {},
      paint: { "raster-opacity": 1 },
    },
    beforeId,
  );
}

export function setRainMapData(map: maplibregl.Map, grid: RainGrid | null, bounds: BBox): void {
  const source = canvasFor(map, bounds);
  drawInto(source.getCanvas(), grid);
  source.setCoordinates(coordinatesFor(bounds));
}

export function clearRainMapData(map: maplibregl.Map): void {
  const source = map.getSource(RAIN_SOURCE_ID) as maplibregl.CanvasSource | undefined;
  if (!source) return;
  drawInto(source.getCanvas(), null);
}

export function removeRainMapLayer(map: maplibregl.Map): void {
  try {
    if (map.getLayer(RAIN_LAYER_ID)) map.removeLayer(RAIN_LAYER_ID);
    if (map.getSource(RAIN_SOURCE_ID)) map.removeSource(RAIN_SOURCE_ID);
  } catch {
    // Style-update races can throw transiently; the next effect pass reconciles.
  }
}

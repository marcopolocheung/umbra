/**
 * The rain-shelter map surface.
 *
 * The renderer paints *sun* shadows and owns its own geometry pipeline; teaching it
 * rain would fork every pass it has. The rain layer instead rasterizes shelter with
 * `ShadowField.sampleRainGrid` (one resolution and index-build per viewport update,
 * the route sampler's exact semantics) and presents the result as a GeoJSON fill the
 * basemap draws — blue where direct rain reaches, untouched where geometry blocks it.
 *
 * A canopy or an arcade is therefore the *absence* of blue, which matches the route
 * cards: what the layer shows is the same shelter fraction the routing paid for,
 * priced here at the map centre's wind (from-bearing, m/s).
 */

import type maplibregl from "maplibre-gl";
import type { GeoJSON } from "geojson";
import type { BBox, RainGrid } from "../shadowField/ShadowField";
import { RAIN_WET_ALPHA, RAIN_WET_RGB } from "./rainComposite";

export const RAIN_LAYER_ID = "local-rain-layer";
export const RAIN_SOURCE_ID = "local-rain-source";
export const SHADOW_LAYER_ID = "local-shadow-layer";

export function rainGridFeatureCollection(
  grid: RainGrid,
  bounds: BBox,
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const lngStep = (bounds.east - bounds.west) / grid.cols;
  const latStep = (bounds.north - bounds.south) / grid.rows;
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  let k = 0;
  for (let r = 0; r < grid.rows; r++) {
    const north = bounds.north - r * latStep;
    const south = north - latStep;
    for (let c = 0; c < grid.cols; c++, k++) {
      const west = bounds.west + c * lngStep;
      const east = west + lngStep;
      features.push({
        type: "Feature",
        properties: { shelter: grid.values[k] },
        geometry: {
          type: "Polygon",
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Adds the layer above the street but under the shadow canvas and the labels. */
export function ensureRainMapLayer(map: maplibregl.Map): void {
  if (map.getLayer(RAIN_LAYER_ID)) return;
  if (!map.getSource(RAIN_SOURCE_ID)) {
    map.addSource(RAIN_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  const beforeId = map.getLayer(SHADOW_LAYER_ID) ? SHADOW_LAYER_ID : undefined;
  map.addLayer(
    {
      id: RAIN_LAYER_ID,
      type: "fill",
      source: RAIN_SOURCE_ID,
      layout: {},
      paint: {
        "fill-color": `rgb(${RAIN_WET_RGB.map((c) => Math.round(c * 255)).join(", ")})`,
          // Blue = the share of direct rain the cell does not block.
          "fill-opacity": ["*", ["-", 1, ["get", "shelter"]], RAIN_WET_ALPHA],
        "fill-outline-color": "rgba(37, 99, 235, 0)",
      },
    },
    beforeId,
  );
}

export function setRainMapData(
  map: maplibregl.Map,
  collection: GeoJSON.FeatureCollection<GeoJSON.Polygon>,
): void {
  const source = map.getSource(RAIN_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  source?.setData(collection);
}

export function removeRainMapLayer(map: maplibregl.Map): void {
  try {
    if (map.getLayer(RAIN_LAYER_ID)) map.removeLayer(RAIN_LAYER_ID);
    if (map.getSource(RAIN_SOURCE_ID)) map.removeSource(RAIN_SOURCE_ID);
  } catch {
    // Style-update races can throw transiently; the next effect pass reconciles.
  }
}

/** Colors/rows for the visible grid: coarse enough to sample fast, fine enough to read a block. */
export const RAIN_GRID_COLS = 64;
export const RAIN_GRID_ROWS = 40;

/**
 * H3b — the Sun Budget region on the map: one centreline per street segment,
 * proven streets solid on a paper casing, undecided ones a thin dashed line.
 * Dash, width and casing carry the difference, not colour.
 *
 * Above the shadow layer, with the routes (`NAVIGATION_LINES`): beneath it the
 * shadow's blue tinted the ink and a reachable shaded street read as more
 * shade. That is safe for invariant #5 — the routing fallback reads the
 * renderer's own framebuffer, not the canvas — and the ink and casing never
 * read as shadow on the canvas either (`reachLayer.test.ts`).
 */

import type * as maplibregl from "maplibre-gl";
import { mapColor } from "../basemapTheme";
import type { SunReachEdge } from "../sunReach";
import type { UiTheme } from "../uiTheme";
import type { ReachRegion } from "./mergeRegion";

export const REACH_SOURCE_ID = "sun-budget-reach";
export const REACH_PROVEN_CASING_ID = "sun-budget-reach-proven-casing";
export const REACH_PROVEN_LAYER_ID = "sun-budget-reach-proven";
export const REACH_UNDECIDED_LAYER_ID = "sun-budget-reach-undecided";
/** Bottom to top; `mapLayerOrder.ts` keeps them above the shadow, below the routes. */
export const REACH_LAYER_IDS = [REACH_PROVEN_CASING_ID, REACH_PROVEN_LAYER_ID, REACH_UNDECIDED_LAYER_ID] as const;

/** Thin when zoomed out so blocks stay blocks; street-width when zoomed in. */
const width = (z12: number, z16: number): maplibregl.ExpressionSpecification =>
  ["interpolate", ["linear"], ["zoom"], 12, z12, 16, z16];
export const REACH_UNDECIDED_OPACITY = 0.9;

export interface ReachLayerHandle {
  setRegion(region: ReachRegion | null, nodes: Map<number, { lat: number; lon: number }> | null): void;
  /** Off in Sun Exposure mode, whose GeoTIFF export writes the canvas as drawn. */
  setEnabled(enabled: boolean): void;
  setTheme(theme: UiTheme): void;
  remove(): void;
}

type ReachMap = Pick<
  maplibregl.Map,
  "getSource" | "addSource" | "addLayer" | "getLayer" | "setLayoutProperty" | "setPaintProperty"
>;

/**
 * One feature per street segment: both sidewalks and both directions are one
 * line on the map, and a segment proven by any of them is proven.
 */
export function reachFeatures(
  region: ReachRegion | null,
  nodes: Map<number, { lat: number; lon: number }> | null,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  if (!region || !nodes) return { type: "FeatureCollection", features };
  const segments = new Map<string, { lo: number; hi: number; state: "proven" | "undecided" }>();
  const add = (edges: SunReachEdge[], state: "proven" | "undecided") => {
    for (const edge of edges) {
      const lo = Math.min(edge.fromId, edge.toId);
      const hi = Math.max(edge.fromId, edge.toId);
      const key = `${lo},${hi}`;
      if (segments.get(key)?.state === "proven") continue;
      segments.set(key, { lo, hi, state });
    }
  };
  add(region.proven, "proven");
  add(region.undecided, "undecided");
  for (const { lo, hi, state } of segments.values()) {
    const a = nodes.get(lo);
    const b = nodes.get(hi);
    if (!a || !b) continue;
    features.push({
      type: "Feature",
      properties: { state },
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function attachReachLayer(map: ReachMap, opts: { theme: UiTheme; enabled?: boolean }): ReachLayerHandle {
  let theme = opts.theme;
  let enabled = opts.enabled ?? true;
  let hasFeatures = false;

  function applyVisibility(): void {
    const visible = enabled && hasFeatures ? "visible" : "none";
    for (const id of REACH_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible);
    }
  }

  function ensure(data: GeoJSON.FeatureCollection): void {
    const source = map.getSource(REACH_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    if (data.features.length === 0) return;
    map.addSource(REACH_SOURCE_ID, { type: "geojson", data });
    const layout: maplibregl.LineLayerSpecification["layout"] = { "line-cap": "round", "line-join": "round" };
    // Added on top; MapView's `reconcileMapLayerOrder` then files them under the routes.
    map.addLayer({
      id: REACH_PROVEN_CASING_ID,
      type: "line",
      source: REACH_SOURCE_ID,
      filter: ["==", ["get", "state"], "proven"],
      layout,
      paint: { "line-color": mapColor(theme, "casing"), "line-width": width(2.5, 7) },
    });
    map.addLayer({
      id: REACH_PROVEN_LAYER_ID,
      type: "line",
      source: REACH_SOURCE_ID,
      filter: ["==", ["get", "state"], "proven"],
      layout,
      paint: { "line-color": mapColor(theme, "route"), "line-width": width(1, 3.5) },
    });
    map.addLayer({
      id: REACH_UNDECIDED_LAYER_ID,
      type: "line",
      source: REACH_SOURCE_ID,
      filter: ["==", ["get", "state"], "undecided"],
      paint: {
        "line-color": mapColor(theme, "route"),
        "line-width": width(1, 2.5),
        "line-opacity": REACH_UNDECIDED_OPACITY,
        "line-dasharray": [1.5, 2],
      },
    });
  }

  return {
    setRegion(region, nodes) {
      const data = reachFeatures(region, nodes);
      ensure(data);
      hasFeatures = data.features.length > 0;
      applyVisibility();
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      applyVisibility();
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      if (!map.getLayer(REACH_PROVEN_LAYER_ID)) return;
      map.setPaintProperty(REACH_PROVEN_CASING_ID, "line-color", mapColor(theme, "casing"));
      map.setPaintProperty(REACH_PROVEN_LAYER_ID, "line-color", mapColor(theme, "route"));
      map.setPaintProperty(REACH_UNDECIDED_LAYER_ID, "line-color", mapColor(theme, "route"));
    },
    remove() {
      // The style is torn down with the map; nothing here outlives it.
    },
  };
}

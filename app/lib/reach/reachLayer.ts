/**
 * H3b — the Sun Budget region on the map: proven streets solid, undecided ones
 * thin and dashed. The two differ by dash and width, not colour alone.
 *
 * Both draw in the walking-route ink (`mapColor(theme, "route")`), the colour
 * the design language reserves for walks — thinner and lighter than a route,
 * and the route layers are hidden while Sun Budget is open. Placement matters
 * for invariant #5, as for the sheds — see `beforeIdFor`.
 */

import type * as maplibregl from "maplibre-gl";
import { mapColor } from "../basemapTheme";
import type { SunReachEdge } from "../sunReach";
import type { UiTheme } from "../uiTheme";
import type { ReachRegion } from "./mergeRegion";

export const REACH_SOURCE_ID = "sun-budget-reach";
export const REACH_PROVEN_LAYER_ID = "sun-budget-reach-proven";
export const REACH_UNDECIDED_LAYER_ID = "sun-budget-reach-undecided";

export const REACH_PROVEN_WIDTH_PX = 3;
export const REACH_PROVEN_OPACITY = 0.85;
export const REACH_UNDECIDED_WIDTH_PX = 1.5;
export const REACH_UNDECIDED_OPACITY = 0.6;
/** Each sidewalk on its own side of the street, as the street-type band does. */
const LINE_OFFSET_PX = 3;

/**
 * Beneath the basemap's first building layer, like the sheds and street types:
 * never above the shadow layer, whose blue the routing fallback reads off the canvas.
 */
function beforeIdFor(map: ReachMap, fallback: string): string {
  for (const id of map.getLayersOrder()) {
    if (map.getLayer(id)?.sourceLayer === "building") return id;
  }
  return fallback;
}

export interface ReachLayerHandle {
  setRegion(region: ReachRegion | null, nodes: Map<number, { lat: number; lon: number }> | null): void;
  setTheme(theme: UiTheme): void;
  remove(): void;
}

type ReachMap = Pick<
  maplibregl.Map,
  "getSource" | "addSource" | "addLayer" | "getLayer" | "getLayersOrder" | "setLayoutProperty" | "setPaintProperty"
>;

export function reachFeatures(
  region: ReachRegion | null,
  nodes: Map<number, { lat: number; lon: number }> | null,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  if (!region || !nodes) return { type: "FeatureCollection", features };
  const add = (edges: SunReachEdge[], state: "proven" | "undecided") => {
    for (const edge of edges) {
      const from = nodes.get(edge.fromId);
      const to = nodes.get(edge.toId);
      if (!from || !to) continue;
      features.push({
        type: "Feature",
        // Style spec: a positive line-offset is to the right of the line's direction.
        properties: { state, offset: edge.side === "right" ? LINE_OFFSET_PX : edge.side === "left" ? -LINE_OFFSET_PX : 0 },
        geometry: { type: "LineString", coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
      });
    }
  };
  add(region.proven, "proven");
  add(region.undecided, "undecided");
  return { type: "FeatureCollection", features };
}

export function attachReachLayer(map: ReachMap, opts: { belowLayerId: string; theme: UiTheme }): ReachLayerHandle {
  let theme = opts.theme;

  function ensure(data: GeoJSON.FeatureCollection): void {
    const source = map.getSource(REACH_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    if (data.features.length === 0) return;
    map.addSource(REACH_SOURCE_ID, { type: "geojson", data });
    const beforeId = beforeIdFor(map, opts.belowLayerId);
    const color = mapColor(theme, "route");
    map.addLayer(
      {
        id: REACH_PROVEN_LAYER_ID,
        type: "line",
        source: REACH_SOURCE_ID,
        filter: ["==", ["get", "state"], "proven"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color,
          "line-width": REACH_PROVEN_WIDTH_PX,
          "line-opacity": REACH_PROVEN_OPACITY,
          "line-offset": ["get", "offset"],
        },
      },
      beforeId,
    );
    map.addLayer(
      {
        id: REACH_UNDECIDED_LAYER_ID,
        type: "line",
        source: REACH_SOURCE_ID,
        filter: ["==", ["get", "state"], "undecided"],
        paint: {
          "line-color": color,
          "line-width": REACH_UNDECIDED_WIDTH_PX,
          "line-opacity": REACH_UNDECIDED_OPACITY,
          "line-dasharray": [2, 2],
          "line-offset": ["get", "offset"],
        },
      },
      beforeId,
    );
  }

  return {
    setRegion(region, nodes) {
      const data = reachFeatures(region, nodes);
      ensure(data);
      const visible = data.features.length > 0 ? "visible" : "none";
      for (const id of [REACH_PROVEN_LAYER_ID, REACH_UNDECIDED_LAYER_ID]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible);
      }
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      for (const id of [REACH_PROVEN_LAYER_ID, REACH_UNDECIDED_LAYER_ID]) {
        if (map.getLayer(id)) map.setPaintProperty(id, "line-color", mapColor(theme, "route"));
      }
    },
    remove() {
      // The style is torn down with the map; nothing here outlives it.
    },
  };
}

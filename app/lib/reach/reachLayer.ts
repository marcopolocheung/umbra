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
import type { SunReachEdge, SunReachWalk } from "../sunReach";
import type { UiTheme } from "../uiTheme";
import type { ReachRegion } from "./mergeRegion";

export const REACH_SOURCE_ID = "sun-budget-reach";
export const REACH_PROVEN_CASING_ID = "sun-budget-reach-proven-casing";
export const REACH_PROVEN_LAYER_ID = "sun-budget-reach-proven";
export const REACH_UNDECIDED_LAYER_ID = "sun-budget-reach-undecided";
/** Bottom to top; `mapLayerOrder.ts` keeps them above the shadow, below the routes. */
export const REACH_LAYER_IDS = [REACH_PROVEN_CASING_ID, REACH_PROVEN_LAYER_ID, REACH_UNDECIDED_LAYER_ID] as const;
/** #379: the walk behind a tapped street, drawn on the sidewalks it takes. */
export const REACH_WALK_SOURCE_ID = "sun-budget-walk";
export const REACH_WALK_CASING_ID = "sun-budget-walk-casing";
export const REACH_WALK_LINE_ID = "sun-budget-walk-line";
export const REACH_WALK_END_ID = "sun-budget-walk-end";
export const REACH_WALK_LAYER_IDS = [REACH_WALK_CASING_ID, REACH_WALK_LINE_ID, REACH_WALK_END_ID] as const;
/** The region steps back while a walk is shown, so the walk reads on top of it. */
export const REACH_DIMMED_OPACITY = 0.35;
/** A sidewalk's side, in pixels off the street's centreline. */
const WALK_SIDE_OFFSET_PX = 4;

/** Thin when zoomed out so blocks stay blocks; street-width when zoomed in. */
const width = (z12: number, z16: number): maplibregl.ExpressionSpecification =>
  ["interpolate", ["linear"], ["zoom"], 12, z12, 16, z16];
export const REACH_UNDECIDED_OPACITY = 0.9;
/**
 * Undecided streets (#381): short dashes when the search finished, long dashes
 * when it stopped early. Both keep roughly as much ink, so the streets the copy
 * says "may still be reachable" never fade to a hairline of dots.
 */
export const REACH_DASH = { approximate: [1.5, 2], "budget-exhausted": [4, 2] } as const;

export interface ReachLayerHandle {
  /** The outcome on screen; a search that stopped early dashes its undecided streets sparser. */
  setOutcome(outcome: "exact" | "approximate" | "budget-exhausted" | null): void;
  /** Draw the walk behind a tapped street (#379), or clear it with null. */
  setWalk(walk: SunReachWalk | null, nodes: Map<number, { lat: number; lon: number }> | null): void;
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
      // lo/hi name the street segment, so a tap can ask for the walk behind it (#379).
      properties: { state, lo, hi },
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The walk as one line per step on its sidewalk, and a point where it ends. */
export function walkFeatures(
  walk: SunReachWalk | null,
  nodes: Map<number, { lat: number; lon: number }> | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!walk || !nodes) return { type: "FeatureCollection", features };
  for (let i = 0; i + 1 < walk.nodeIds.length; i++) {
    const a = nodes.get(walk.nodeIds[i]);
    const b = nodes.get(walk.nodeIds[i + 1]);
    if (!a || !b) continue;
    const side = walk.sides[i];
    features.push({
      type: "Feature",
      // Style spec: a positive line-offset is to the right of the line's direction.
      properties: { offset: side === "right" ? WALK_SIDE_OFFSET_PX : side === "left" ? -WALK_SIDE_OFFSET_PX : 0 },
      geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
    });
  }
  const end = nodes.get(walk.nodeIds[walk.nodeIds.length - 1]);
  if (end) features.push({ type: "Feature", properties: { end: true }, geometry: { type: "Point", coordinates: [end.lon, end.lat] } });
  return { type: "FeatureCollection", features };
}

export function attachReachLayer(map: ReachMap, opts: { theme: UiTheme; enabled?: boolean }): ReachLayerHandle {
  let theme = opts.theme;
  let enabled = opts.enabled ?? true;
  let hasFeatures = false;
  let dash: keyof typeof REACH_DASH = "approximate";

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
        "line-dasharray": [...REACH_DASH[dash]],
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
    setWalk(walk, nodes) {
      const data = walkFeatures(walk, nodes);
      const source = map.getSource(REACH_WALK_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(data);
      else if (data.features.length > 0) {
        map.addSource(REACH_WALK_SOURCE_ID, { type: "geojson", data });
        const lines: maplibregl.FilterSpecification = ["==", ["geometry-type"], "LineString"];
        const layout: maplibregl.LineLayerSpecification["layout"] = { "line-cap": "round", "line-join": "round" };
        map.addLayer({
          id: REACH_WALK_CASING_ID, type: "line", source: REACH_WALK_SOURCE_ID, filter: lines, layout,
          paint: { "line-color": mapColor(theme, "casing"), "line-width": 8, "line-offset": ["get", "offset"] },
        });
        map.addLayer({
          id: REACH_WALK_LINE_ID, type: "line", source: REACH_WALK_SOURCE_ID, filter: lines, layout,
          paint: { "line-color": mapColor(theme, "route"), "line-width": 4.5, "line-offset": ["get", "offset"] },
        });
        // Where the walk ends: the street that was tapped.
        map.addLayer({
          id: REACH_WALK_END_ID, type: "circle", source: REACH_WALK_SOURCE_ID, filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 6,
            "circle-color": mapColor(theme, "route"),
            "circle-stroke-color": mapColor(theme, "casing"),
            "circle-stroke-width": 3,
          },
        });
      }
      const showing = data.features.length > 0;
      for (const id of REACH_WALK_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", showing && enabled ? "visible" : "none");
      }
      // The region steps back so the walk reads on top of it.
      const opacity = showing ? REACH_DIMMED_OPACITY : 1;
      for (const id of [REACH_PROVEN_CASING_ID, REACH_PROVEN_LAYER_ID]) {
        if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", opacity);
      }
      if (map.getLayer(REACH_UNDECIDED_LAYER_ID)) {
        map.setPaintProperty(REACH_UNDECIDED_LAYER_ID, "line-opacity", showing ? REACH_DIMMED_OPACITY : REACH_UNDECIDED_OPACITY);
      }
    },
    setOutcome(next) {
      const nextDash = next === "budget-exhausted" ? "budget-exhausted" : "approximate";
      if (nextDash === dash) return;
      dash = nextDash;
      if (map.getLayer(REACH_UNDECIDED_LAYER_ID)) {
        map.setPaintProperty(REACH_UNDECIDED_LAYER_ID, "line-dasharray", [...REACH_DASH[dash]]);
      }
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

/**
 * Street shade groups on the map (#321): the last calculated walk's sidewalks,
 * coloured sunny → shaded by their frozen signature type's group.
 *
 * It says what the shade model expects of each sidewalk across the year, not
 * the shade right now: it never changes with the time slider. Placement
 * matters for invariant #5, as for the sheds — see `beforeIdFor`.
 */

import type * as maplibregl from "maplibre-gl";
import { token } from "../css-tokens";
import type { StreetShadeGroup, StreetTypeSegment } from "../navigationData/signatureRoute";
import type { UiTheme } from "../uiTheme";

export const STREET_TYPE_SOURCE_ID = "street-shade-types";
export const STREET_TYPE_LAYER_ID = "street-shade-types-line";

const GROUPS: StreetShadeGroup[] = [1, 2, 3, 4];

/** Group colours per theme, light (sunny) to dark (shaded); the legend repeats them. */
export function streetTypeColor(theme: UiTheme, group: StreetShadeGroup): string {
  return token(`color-street-type-${theme}-${group}`);
}

/**
 * The band sits just outside the route's 7 px casing, on the walked side, so it
 * reads as that sidewalk at every zoom: a pixel offset, not a ground distance.
 */
const LINE_WIDTH_PX = 5;
const LINE_OFFSET_PX = 6;

/**
 * Beneath the basemap's first building layer, like the sheds: never above the
 * shadow layer, whose blue the routing fallback reads off the canvas.
 */
function beforeIdFor(map: StreetTypeMap, fallback: string): string {
  for (const id of map.getLayersOrder()) {
    if (map.getLayer(id)?.sourceLayer === "building") return id;
  }
  return fallback;
}

export interface StreetTypeLayerHandle {
  setSegments(segments: StreetTypeSegment[]): void;
  /** Off unless the user asked for it, and off in Sun Exposure mode (GeoTIFF export). */
  setEnabled(enabled: boolean): void;
  setTheme(theme: UiTheme): void;
  remove(): void;
}

type StreetTypeMap = Pick<
  maplibregl.Map,
  | "getSource"
  | "addSource"
  | "addLayer"
  | "getLayer"
  | "getLayersOrder"
  | "setLayoutProperty"
  | "setPaintProperty"
>;

function featureCollection(segments: StreetTypeSegment[]): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: segments.map((segment) => ({
      type: "Feature",
      // Style spec: a positive line-offset is to the right of the line's direction.
      properties: { group: segment.group, offset: segment.side === "right" ? LINE_OFFSET_PX : -LINE_OFFSET_PX },
      geometry: { type: "LineString", coordinates: [segment.from, segment.to] },
    })),
  };
}

function colorExpression(theme: UiTheme): maplibregl.ExpressionSpecification {
  const [c1, c2, c3, c4] = GROUPS.map((group) => streetTypeColor(theme, group));
  return ["match", ["get", "group"], 1, c1, 2, c2, 3, c3, 4, c4, c1];
}

export function attachStreetTypeLayer(
  map: StreetTypeMap,
  opts: { belowLayerId: string; enabled: boolean; theme: UiTheme },
): StreetTypeLayerHandle {
  let enabled = opts.enabled;
  let theme = opts.theme;
  let segments: StreetTypeSegment[] = [];

  function sync(): void {
    const visible = enabled && segments.length > 0;
    const source = map.getSource(STREET_TYPE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(featureCollection(segments));
    } else if (visible) {
      map.addSource(STREET_TYPE_SOURCE_ID, { type: "geojson", data: featureCollection(segments) });
      map.addLayer(
        {
          id: STREET_TYPE_LAYER_ID,
          type: "line",
          source: STREET_TYPE_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": colorExpression(theme),
            "line-width": LINE_WIDTH_PX,
            "line-offset": ["get", "offset"],
          },
        },
        beforeIdFor(map, opts.belowLayerId),
      );
    }
    if (map.getLayer(STREET_TYPE_LAYER_ID)) {
      map.setLayoutProperty(STREET_TYPE_LAYER_ID, "visibility", visible ? "visible" : "none");
    }
  }

  return {
    setSegments(next) {
      segments = next;
      sync();
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      sync();
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      if (map.getLayer(STREET_TYPE_LAYER_ID))
        map.setPaintProperty(STREET_TYPE_LAYER_ID, "line-color", colorExpression(theme));
    },
    remove() {
      // The style is torn down with the map; nothing here outlives it.
      segments = [];
    },
  };
}

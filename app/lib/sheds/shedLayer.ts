/**
 * Sidewalk sheds on the map (issue #85): a GeoJSON fill of the sheds the last route
 * calculation sampled, drawn where each shed stands — see `sheds.ts` for how the
 * drawn strip and the model's sheet come from one placement.
 *
 * It shows *where* sheds are, not their shade: the shadow renderer does not know about
 * them. Placement matters for invariant #5 — see `beforeIdFor`.
 */

import type * as maplibregl from "maplibre-gl";
import { token } from "../css-tokens";

export const SHED_SOURCE_ID = "sidewalk-sheds";
export const SHED_LAYER_ID = "sidewalk-sheds-fill";

/**
 * The fill: `--color-shed-map`, a neutral near-ink — never a warm hue, which is reserved
 * for sun data — at this opacity, which the Settings legend swatch repeats.
 * `shedLayer.test.ts` holds it to invariant #5 over the surfaces it lands on.
 */
export const SHED_FILL_COLOR = token("color-shed-map");
export const SHED_FILL_OPACITY = 0.3;

type ShedRing = [number, number][];

/**
 * The layer the fill goes directly beneath: the basemap's first building layer.
 *
 * Above roads and landuse, so a strip on a wide sidewalk drawn as road is still seen;
 * below buildings, so a strip that overshoots the building line disappears under it
 * rather than painting a roof. Never above the shadow layer: a shadow composited
 * under a grey fill would lose its blue and stop reading as shadow to the canvas
 * fallback. `fallback` — the shadow layer — is for a style with no building layer.
 */
function beforeIdFor(map: ShedMap, fallback: string): string {
  for (const id of map.getLayersOrder()) {
    if (map.getLayer(id)?.sourceLayer === "building") return id;
  }
  return fallback;
}

export interface ShedLayerHandle {
  /** Replace the drawn sheds — the rings of the latest calculation. */
  setRings(rings: ShedRing[]): void;
  /**
   * Off unless the user asked for it, and off in Sun Exposure mode, whose GeoTIFF
   * export writes the canvas out as it is drawn.
   */
  setEnabled(enabled: boolean): void;
  remove(): void;
}

/** The slice of `maplibregl.Map` the layer uses — what the tests fake. */
type ShedMap = Pick<
  maplibregl.Map,
  "getSource" | "addSource" | "addLayer" | "getLayer" | "getLayersOrder" | "setLayoutProperty"
>;

function featureCollection(rings: ShedRing[]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: "FeatureCollection",
    features: rings.map((ring) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    })),
  };
}

export function attachShedLayer(
  map: ShedMap,
  opts: { belowLayerId: string; enabled: boolean },
): ShedLayerHandle {
  let enabled = opts.enabled;
  let rings: ShedRing[] = [];

  function sync(): void {
    const visible = enabled && rings.length > 0;
    const source = map.getSource(SHED_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(featureCollection(rings));
    } else if (visible) {
      map.addSource(SHED_SOURCE_ID, { type: "geojson", data: featureCollection(rings) });
      map.addLayer(
        {
          id: SHED_LAYER_ID,
          type: "fill",
          source: SHED_SOURCE_ID,
          paint: {
            "fill-color": SHED_FILL_COLOR,
            "fill-opacity": SHED_FILL_OPACITY,
          },
        },
        beforeIdFor(map, opts.belowLayerId),
      );
    }
    if (map.getLayer(SHED_LAYER_ID)) {
      map.setLayoutProperty(SHED_LAYER_ID, "visibility", visible ? "visible" : "none");
    }
  }

  return {
    setRings(next) {
      rings = next;
      sync();
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      sync();
    },
    remove() {
      // The style is torn down with the map; nothing here outlives it.
      rings = [];
    },
  };
}

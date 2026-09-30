import type { LayerSpecification } from "maplibre-gl";
import { token } from "./css-tokens";
import type { UiTheme } from "./uiTheme";

/**
 * Umbra redesign 2.0 R4: the day (warm paper) and night (warm black) basemaps.
 *
 * Both recolour the loaded MapTiler style in place instead of swapping it with
 * `setStyle`, which would drop the shadow, canopy, shed and route layers stacked on
 * top. Layers are classified by type and source-layer, not by id, so the rules also
 * cover the e2e fixture style and survive MapTiler renaming a layer.
 *
 * The theme is `solarTheme`, never the UI override (decision D2), so the night palette
 * only ever carries the renderer's below-horizon shadow, never a daylight one.
 *
 * ## Invariant #5
 *
 * Every basemap layer sits under the shadow layer while the camera is flat, labels
 * included, so every colour here is a surface a shadow lands on. Each keeps warmth
 * `(r + g) / 2 − b` inside `WARMTH_RANGE`. Blends are linear, so anything the map
 * draws from these colours (anti-aliasing, fill opacity, the translucent `tint`, a
 * paint transition between the two themes) stays inside it too. That one bound gives
 * both directions: above −18 no sunlit pixel is blue-dominant, and below ~28 the
 * renderer's dawn blue still reads as shadow over it. The top is held at 14, not 28,
 * for a shadow's anti-aliased rim: a warmer surface makes a part-covered pixel need
 * more coverage before it counts. `basemapTheme.test.ts` checks all three against the
 * real predicate and every shadow colour from dawn to noon.
 */

export const WARMTH_RANGE = { min: -17, max: 14 } as const;

type Role =
  | "land"
  | "landuse"
  | "field"
  | "wood"
  | "water"
  | "tint"
  | "road"
  | "path"
  | "rail"
  | "building"
  | "edge"
  | "label"
  | "water-label"
  | "park-label";

const ROLES: readonly Role[] = [
  "land",
  "landuse",
  "field",
  "wood",
  "water",
  "tint",
  "road",
  "path",
  "rail",
  "building",
  "edge",
  "label",
  "water-label",
  "park-label",
];

function palette(theme: UiTheme): Record<Role, string> {
  return Object.fromEntries(ROLES.map((role) => [role, token(`color-basemap-${theme}-${role}`)])) as Record<
    Role,
    string
  >;
}

export const BASEMAP_PALETTES: Record<UiTheme, Record<Role, string>> = {
  day: palette("day"),
  night: palette("night"),
};

const FIELD_RE = /grass|scrub|park|cemetery|stadium|pitch|golf/i;
const WOOD_RE = /wood|forest|tree/i;
const RAIL_RE = /rail|lift|cable/i;
const PATH_RE = /path|steps|track|pedestrian|footway/i;

/** The role of a layer's main colour, or null for a layer type this leaves as MapTiler drew it. */
function mainRole(layer: LayerSpecification): Role | null {
  if (layer.type === "background") return "land";
  const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
  const id = layer.id;
  if (layer.type === "fill") {
    if (sourceLayer === "water") return "water";
    if (sourceLayer === "building" || id === "building") return "building";
    if (sourceLayer === "park") return "field";
    if (sourceLayer === "transportation") return "road";
    // outdoor-v2 draws residential as a 30% wash over the landcover beneath it.
    if (/residential/i.test(id)) return "tint";
    if (WOOD_RE.test(id)) return "wood";
    if (FIELD_RE.test(id)) return "field";
    return "landuse";
  }
  if (layer.type === "line") {
    switch (sourceLayer) {
      case "waterway":
        return "water";
      case "park":
        return "wood";
      case "contour":
      case "mountain_peak":
      case "boundary":
      case "landuse":
        return "edge";
      case "aeroway":
        return "road";
      case "trail":
        // Marked trails and bike routes keep their dash pattern; their hue goes, since
        // neither palette gives one a meaning.
        return /outline/i.test(id) ? "road" : "path";
      case "transportation":
        if (/ferry/i.test(id)) return "water";
        if (/outline/i.test(id)) return "road";
        // A railway's alternating dash is the road colour; every other rail part is rail.
        if (RAIL_RE.test(id)) return /railway.*dash/i.test(id) ? "road" : "rail";
        if (PATH_RE.test(id)) return "path";
        return "road";
    }
    return null;
  }
  if (layer.type === "symbol") {
    if (sourceLayer === "water_name" || sourceLayer === "waterway") return "water-label";
    if (sourceLayer === "park" || /park/i.test(id)) return "park-label";
    return "label";
  }
  return null;
}

/**
 * The colour paint properties to set on one basemap layer for a theme. Only
 * properties the style already declares are replaced, so no outline or halo appears
 * where MapTiler drew none.
 */
export function basemapPaint(layer: LayerSpecification, theme: UiTheme): Record<string, string> {
  const colors = BASEMAP_PALETTES[theme];
  const declared = ("paint" in layer ? layer.paint : undefined) ?? {};
  if (layer.type === "hillshade") {
    return {
      "hillshade-shadow-color": colors.edge,
      "hillshade-highlight-color": colors.land,
      "hillshade-accent-color": colors.landuse,
    };
  }
  const role = mainRole(layer);
  if (!role) return {};
  const byProperty: Record<string, string> =
    layer.type === "symbol"
      ? {
          "text-color": colors[role],
          "icon-color": colors[role],
          "text-halo-color": colors.land,
          "icon-halo-color": colors.land,
        }
      : {
          "background-color": colors[role],
          "fill-color": colors[role],
          "fill-outline-color": colors.edge,
          "line-color": colors[role],
        };
  const paint: Record<string, string> = {};
  for (const [property, color] of Object.entries(byProperty)) {
    if (property === `${layer.type}-color` || property in declared) paint[property] = color;
  }
  return paint;
}

/**
 * Recolour the basemap layers for a theme. `layers` is the style as loaded, captured
 * before any Umbra layer is added, so nothing of ours is touched.
 */
export function applyBasemapTheme(
  map: { getLayer(id: string): unknown; setPaintProperty(id: string, property: string, value: string): void },
  layers: readonly LayerSpecification[],
  theme: UiTheme
): void {
  for (const layer of layers) {
    if (!map.getLayer(layer.id)) continue;
    for (const [property, color] of Object.entries(basemapPaint(layer, theme))) {
      map.setPaintProperty(layer.id, property, color);
    }
  }
}

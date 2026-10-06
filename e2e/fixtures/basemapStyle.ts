/**
 * A synthetic MapLibre style that stands in for MapTiler's `outdoor-v2`, so the
 * smoke test can run without `VITE_MAPTILER_API_KEY` — and therefore on fork
 * PRs, which never receive secrets.
 *
 * The one thing the app actually needs from the basemap is building footprints:
 * the shadow renderer, the shadow providers and the building snapper all call
 * `querySourceFeatures("maptiler_planet", { sourceLayer: "building" })`. In the
 * maplibre-gl (5.9 and 6.12 alike) a tile's layers resolve as
 * `vtLayers._geojsonTileLayer || vtLayers[sourceLayer]`, so a *geojson* source
 * named `maptiler_planet` satisfies every one of those calls unchanged — the
 * `sourceLayer` argument is simply ignored for GeoJSON tiles.
 *
 * Two things about this style are load-bearing, not decoration:
 *
 * 1. The `fill` layer below must stay, and stay visible at the test's zoom.
 *    `Style.update` marks a source `used` only when some non-hidden layer in the
 *    layer order references it; an unreferenced source never tiles, and
 *    `querySourceFeatures` would return nothing at all.
 * 2. The colours must not be blue-dominant. Shadow detection is
 *    `isBlueDominantShadowPixel` (invariant #5), and the test's whole premise is
 *    that the unshadowed frame scores 0. Both colours here are pure greys, whose
 *    `b - avg(r, g)` is exactly 0 however anti-aliasing blends them; composited
 *    under the 0.7-alpha shadow they clear the predicate at every sun altitude.
 *    Change either one and re-check both directions.
 */

import type { StyleSpecification } from "maplibre-gl";

/** Ground. Pure grey: never reads as shadow on its own. */
const GROUND_COLOR = "#ebebeb";
/** Building footprints, a shadow darker so the fixture is legible in a trace. */
const BUILDING_COLOR = "#b4b4b4";

// The block grid shares its origin and pitch with the street grid in
// `overpassGrid.ts`, so the footprints land *between* the roads the router uses
// rather than on top of them.
const SOUTH = 40.7515;
const WEST = -73.9875;
const LAT_STEP = 0.0005; // ~55 m
const LNG_STEP = 0.0007; // ~59 m at this latitude

/** Half a street's width, in degrees: the footprint inset from each block edge. */
const STREET_INSET_LAT = 0.0001; // ~11 m
const STREET_INSET_LNG = 0.00013; // ~11 m

// The street grid only spans ~590 x 556 m, but at z17 and lat 40.75 the
// 1280x900 viewport covers ~1160 x 815 m. Extend the block grid past the roads
// so buildings — and their shadows — fill the frame the test samples.
const ROW_MIN = -3;
const ROW_MAX = 13;
const COL_MIN = -5;
const COL_MAX = 15;

// At 09:00 on the June solstice the sun sits ~37 degrees up, so a shadow runs
// ~1.33x the building's height: 24-96 m here, which reaches across the ~59 m
// blocks without burying the whole viewport in shadow. Staying under 100 m also
// keeps `prismsFromTileFeatures`'s tall-building filter out of the picture.
const MIN_HEIGHT_M = 18;
const MAX_HEIGHT_M = 72;

/** Deterministic pseudo-random height, so every run renders the same skyline. */
function blockHeightM(row: number, col: number): number {
  const mixed = Math.abs(Math.imul(row + 97, 73_856_093) ^ Math.imul(col + 41, 19_349_663));
  return MIN_HEIGHT_M + (mixed % (MAX_HEIGHT_M - MIN_HEIGHT_M + 1));
}

/**
 * Whether a block is left empty. A quarter of them are: an unbroken grid shadows
 * nearly the whole frame at both 09:00 and noon, which would leave the
 * "shadows moved" assertion comparing two almost identical masks.
 */
function isVacantLot(row: number, col: number): boolean {
  return (Math.abs(Math.imul(row + 13, 31) ^ Math.imul(col + 7, 17)) & 3) === 0;
}

interface BuildingFeature {
  type: "Feature";
  properties: { render_height: number };
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
}

/**
 * The footprints the style carries, as bare features. The detour sweep in
 * `e2e/bench/` builds its prisms from these, so the shadow it prices edges
 * against is the shadow the browser benchmark's map is drawing.
 */
export function fixtureBuildingFeatures(): BuildingFeature[] {
  return buildFootprints();
}

function buildFootprints(): BuildingFeature[] {
  const features: BuildingFeature[] = [];

  for (let row = ROW_MIN; row <= ROW_MAX; row++) {
    for (let col = COL_MIN; col <= COL_MAX; col++) {
      if (isVacantLot(row, col)) continue;

      const south = SOUTH + row * LAT_STEP + STREET_INSET_LAT;
      const north = SOUTH + (row + 1) * LAT_STEP - STREET_INSET_LAT;
      const west = WEST + col * LNG_STEP + STREET_INSET_LNG;
      const east = WEST + (col + 1) * LNG_STEP - STREET_INSET_LNG;

      features.push({
        type: "Feature",
        properties: { render_height: blockHeightM(row, col) },
        geometry: {
          type: "Polygon",
          // Closed ring, wound counter-clockwise, as a vector tile would give it.
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      });
    }
  }

  return features;
}

/**
 * The style the test serves in place of MapTiler's. No `glyphs` and no `sprite`:
 * nothing in the app requests either, and a style of background + fill layers
 * needs neither.
 */
export function fixtureBasemapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      maptiler_planet: {
        type: "geojson",
        data: { type: "FeatureCollection", features: buildFootprints() },
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": GROUND_COLOR },
      },
      // Load-bearing (see 1. above): without this layer the source never tiles.
      {
        id: "building",
        type: "fill",
        source: "maptiler_planet",
        paint: { "fill-color": BUILDING_COLOR },
      },
    ],
  };
}

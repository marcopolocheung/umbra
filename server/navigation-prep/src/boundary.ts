import type { GeoBounds } from "../../../app/lib/navigationData/shardContract";

/**
 * Documented NYC support boundary and the grid that shards the city.
 *
 * The city rectangle is the OSM administrative relation 175905 ("New York
 * City") bounding box as returned by Nominatim on 2026-09-19:
 * south 40.4765780, west -74.2588430, north 40.9176300, east -73.7002330.
 * Everything the producer keeps sits inside this rectangle plus
 * PREP_BUFFER_M: streets are retained when any node falls inside the padded
 * rectangle (ways are then kept whole so an edge entering the city from New
 * Jersey or Westchester never loses an endpoint), and the same padded
 * rectangle is the published manifest support bounds. Buildings cannot lie
 * outside the city rectangle; their per-shard caster-reach support expands
 * at most CASTER_REACH_M beyond it and therefore stays inside prep bounds.
 */

/** North-west corner of the user-facing NYC rectangle. */
export const NYC_BBOX: GeoBounds = Object.freeze({
  south: 40.476578,
  west: -74.258843,
  north: 40.91763,
  east: -73.700233,
});

export const NYC_OSM_RELATION_ID = 175905;
export const NYC_BBOX_CITATION =
  "OSM relation 175905 bounding box via Nominatim, fetched 2026-09-19";

/** How far the retention rectangle extends beyond the city rectangle. */
export const PREP_BUFFER_M = 1_500;

/**
 * How far outside a query a shadow caster is allowed to stand. Mirrors
 * `QUERY_PAD_M` in `app/lib/shadowField/ShadowField.ts` — the existing shadow
 * march caps caster reach at this distance and docks confidence near the
 * horizon, so the static dataset must not claim casters beyond it.
 */
export const CASTER_REACH_M = 400;

/** Below this altitude the shadow march no longer trusts shadow geometry. */
export const LOW_SUN_ALTITUDE_RAD = (10 * Math.PI) / 180;

/** Expands a rectangle by metres in every direction; longitude uses local scale. */
export function expandBounds(bounds: GeoBounds, meters: number): GeoBounds {
  const midLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.max(Math.cos(midLat), 0.2));
  return {
    south: bounds.south - dLat,
    west: bounds.west - dLon,
    north: bounds.north + dLat,
    east: bounds.east + dLon,
  };
}

/** The rectangle outside which nothing is retained: city plus prep buffer. */
export const PREP_BOUNDS: GeoBounds = expandBounds(NYC_BBOX, PREP_BUFFER_M);

/**
 * The grid over PREP_BOUNDS. z14 is the shipped default; z13 exists so a
 * measurement can compare the two before a generation is published.
 */
export type GridZoom = 13 | 14;

/**
 * Convert longitude/latitude to a z-level tile coordinate. Web-Mercator
 * tile maths, so cells are ~300 m at z14 near 40.7° N.
 */
export function tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function tileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

/** The [west-lng, north-lat] → [east-lng, south-lat] rectangle of a tile. */
export function tileBounds(x: number, y: number, z: number): GeoBounds {
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * (180 / Math.PI);
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / 2 ** z))) * (180 / Math.PI);
  const west = (x / 2 ** z) * 360 - 180;
  const east = ((x + 1) / 2 ** z) * 360 - 180;
  return { south, west, north, east };
}

export interface Grid {
  z: GridZoom;
  /** All cell coordinates covering PREP_BOUNDS, row-major. */
  cells: Array<{ x: number; y: number; bounds: GeoBounds }>;
}

/** Enumerates the grid cells that cover PREP_BOUNDS in deterministic order. */
export function makeGrid(z: GridZoom): Grid {
  const x0 = tileX(PREP_BOUNDS.west, z);
  const x1 = tileX(PREP_BOUNDS.east, z);
  const y0 = tileY(PREP_BOUNDS.north, z);
  const y1 = tileY(PREP_BOUNDS.south, z);
  const cells: Grid["cells"] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      cells.push({ x, y, bounds: tileBounds(x, y, z) });
    }
  }
  return { z, cells };
}

function cellKey(prefix: string, z: GridZoom, x: number, y: number): string {
  return `${prefix}/z${z}-${x}-${y}.json`;
}

export function streetCellKey(z: GridZoom, x: number, y: number): string {
  return cellKey("streets", z, x, y);
}

export function buildingCellKey(z: GridZoom, x: number, y: number): string {
  return cellKey("buildings", z, x, y);
}

/**
 * One retained route-sized sample per borough plus one cross-borough case.
 * Small enough to keep resident evidence, large enough to exercise street and
 * building shard selection and at least one route spill across seams.
 */
export interface BoroughSample {
  borough: string;
  bbox: GeoBounds;
  note: string;
}

export const BOROUGH_SAMPLES: BoroughSample[] = [
  {
    borough: "Manhattan",
    bbox: { south: 40.752, west: -73.987, north: 40.757, east: -73.982 },
    note: "Midtown blocks around the fixture cell",
  },
  {
    borough: "The Bronx",
    bbox: { south: 40.827, west: -73.931, north: 40.832, east: -73.923 },
    note: "Yankee Stadium / Grand Concourse blocks",
  },
  {
    borough: "Brooklyn",
    bbox: { south: 40.688, west: -73.992, north: 40.693, east: -73.982 },
    note: "Downtown Brooklyn blocks",
  },
  {
    borough: "Queens",
    bbox: { south: 40.755, west: -73.842, north: 40.761, east: -73.832 },
    note: "Flushing blocks around Main Street",
  },
  {
    borough: "Staten Island",
    bbox: { south: 40.639, west: -74.082, north: 40.646, east: -74.072 },
    note: "St. George near the ferry terminal",
  },
  {
    borough: "Cross-borough",
    bbox: { south: 40.69, west: -73.99, north: 40.76, east: -73.92 },
    note: "Downtown Brooklyn to Midtown Manhattan corridor",
  },
];

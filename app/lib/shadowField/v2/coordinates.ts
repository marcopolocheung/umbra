import { TILE_CELLS } from "./lattice";

/** Coordinate and tile ownership contract shared by all numeric paths. */
export const COORDINATE_CONVENTION_VERSION = "web-mercator-z18-cell-centre-v1";
export const NUMERIC_TILE_ZOOM = 18;
export const WEB_MERCATOR_WORLD_METRES = 2 * Math.PI * 6_378_137;

export interface MercatorMetres { east: number; north: number; }
export interface TileCoordinate { x: number; y: number; }

/** EPSG:3857 metres, east positive and north positive (unlike slippy y). */
export function lonLatToMercator(lng: number, lat: number): MercatorMetres {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat <= -85.05112878 || lat >= 85.05112878)
    throw new Error("coordinate outside Web Mercator");
  const east = (lng * Math.PI / 180) * 6_378_137;
  const north = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 360))) * 6_378_137;
  return { east, north };
}

export function mercatorToTile(point: MercatorMetres, zoom = NUMERIC_TILE_ZOOM): TileCoordinate {
  const n = 2 ** zoom;
  return {
    x: Math.floor(((point.east / WEB_MERCATOR_WORLD_METRES) + 0.5) * n),
    y: Math.floor((0.5 - point.north / WEB_MERCATOR_WORLD_METRES) * n),
  };
}

export function tileKey(x: number, y: number): string { return `${NUMERIC_TILE_ZOOM}/${x}/${y}`; }

/** The exact, half-open page owner; gutters are never owners. */
export function ownerTileForMercator(point: MercatorMetres): string {
  const tile = mercatorToTile(point);
  return tileKey(tile.x, tile.y);
}

export function metresPerTile(zoom = NUMERIC_TILE_ZOOM): number { return WEB_MERCATOR_WORLD_METRES / 2 ** zoom; }
export function metresPerCell(zoom = NUMERIC_TILE_ZOOM): number { return metresPerTile(zoom) / TILE_CELLS; }

export function tileCentreMercator(x: number, y: number, zoom = NUMERIC_TILE_ZOOM): MercatorMetres {
  const size = metresPerTile(zoom);
  return { east: (x + 0.5) * size - WEB_MERCATOR_WORLD_METRES / 2, north: WEB_MERCATOR_WORLD_METRES / 2 - (y + 0.5) * size };
}

export function assertCoordinateConvention(value: string): asserts value is typeof COORDINATE_CONVENTION_VERSION {
  if (value !== COORDINATE_CONVENTION_VERSION) throw new Error("unsupported coordinate convention");
}

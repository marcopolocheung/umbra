import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolygonalCoverage } from "./admission";
import { fileHash, requireRoot } from "./util";

export const SUPPORT_FILENAME = "nyc-five-borough-20km-support.geojson";

type PolygonCoordinates = number[][][];
type MultiPolygonCoordinates = number[][][][];

function polygonCoordinates(value: unknown, label: string): PolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} has malformed polygon coordinates`);
  for (const ring of value) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error(`${label} has malformed polygon coordinates`);
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2 || !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)))
        throw new Error(`${label} has malformed polygon coordinates`);
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) throw new Error(`${label} has malformed polygon coordinates`);
  }
  return value as PolygonCoordinates;
}

function polygonsFromGeometry(value: unknown, label: string): PolygonCoordinates[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must contain polygon geometry`);
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type === "Polygon") return [polygonCoordinates(geometry.coordinates, label)];
  if (geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0)
    throw new Error(`${label} must contain only Polygon or MultiPolygon geometry`);
  return geometry.coordinates.map((polygon) => polygonCoordinates(polygon, label));
}

export function supportGeometry(value: unknown): PolygonalCoverage {
  const document = value as { type?: string; geometry?: unknown; features?: Array<{ geometry?: unknown }> };
  const candidate = document.type === "Feature" ? document.geometry : document.type === "FeatureCollection" && document.features?.length === 1 ? document.features[0].geometry : document;
  const geometry = candidate as PolygonalCoverage;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") || !Array.isArray(geometry.coordinates)) throw new Error("support must be a single Polygon or MultiPolygon feature");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
  if (!polygons.length || polygons.some((polygon) => !Array.isArray(polygon) || !polygon.length || polygon.some((ring) => ring.length < 4 || ring.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))))) throw new Error("support has malformed polygon coordinates");
  return geometry;
}

/**
 * Parse the pinned borough boundary without broadening the source-support
 * contract above. NYC DCP publishes one polygonal feature per borough, so
 * aggregation needs their polygon members flattened into one MultiPolygon.
 * Ring order and interior rings are retained byte-for-value.
 */
export function boroughGeometry(value: unknown): { type: "MultiPolygon"; coordinates: MultiPolygonCoordinates } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("borough boundary must be polygonal GeoJSON");
  const document = value as { type?: unknown; geometry?: unknown; features?: unknown };
  let members: unknown[];
  if (document.type === "FeatureCollection") {
    if (!Array.isArray(document.features) || document.features.length === 0)
      throw new Error("borough boundary FeatureCollection must be nonempty");
    members = document.features.map((feature, index) => {
      if (!feature || typeof feature !== "object" || Array.isArray(feature) || (feature as { type?: unknown }).type !== "Feature")
        throw new Error(`borough boundary feature ${index} is malformed`);
      const geometry = (feature as { geometry?: unknown }).geometry;
      if (geometry === null || geometry === undefined) throw new Error(`borough boundary feature ${index} has no geometry`);
      return geometry;
    });
  } else if (document.type === "Feature") {
    if (document.geometry === null || document.geometry === undefined) throw new Error("borough boundary feature has no geometry");
    members = [document.geometry];
  } else {
    members = [document];
  }
  return {
    type: "MultiPolygon",
    coordinates: members.flatMap((geometry, index) => polygonsFromGeometry(geometry, `borough boundary member ${index}`)),
  };
}

export async function loadFrozenSupport(): Promise<{ path: string; hash: string; geometry: PolygonalCoverage }> {
  const root = requireRoot(); const path = join(root, "acquisition", SUPPORT_FILENAME);
  const manifest = JSON.parse(await readFile(join(root, "acquisition", "nyc-acquisition-manifest.json"), "utf8")) as { support?: { filename?: string; sha256?: string } };
  if (manifest.support?.filename !== `acquisition/${SUPPORT_FILENAME}` || !/^[a-f0-9]{64}$/.test(String(manifest.support.sha256))) throw new Error("frozen support acquisition manifest lacks the exact pinned support hash");
  const hash = await fileHash(path); if (hash !== manifest.support.sha256) throw new Error(`frozen support hash mismatch: expected ${manifest.support.sha256}, got ${hash}`);
  return { path, hash, geometry: supportGeometry(JSON.parse(await readFile(path, "utf8"))) };
}

export function polygons(geometry: PolygonalCoverage): number[][][][] { return geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][]; }
export function envelope(geometry: PolygonalCoverage): [number, number, number, number] {
  const points = polygons(geometry).flat(2); return [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))];
}
/** CHMv2's published COG grid is selected from the frozen support envelope.
 * This conservative intersection deliberately retains edge cells; pixel-level
 * validity remains governed by the frozen CHMv2 availability mask. */
export function intersectsSupport(tile: PolygonalCoverage, support: PolygonalCoverage): boolean {
  const a = envelope(tile); const b = envelope(support); if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) return false;
  return true;
}
export function canonicalSupportFeature(geometry: PolygonalCoverage): { type: "FeatureCollection"; features: Array<{ type: "Feature"; properties: Record<string, never>; geometry: PolygonalCoverage }> } {
  const normalRing = (ring: number[][]) => {
    const source = ring.slice(0, -1); const signedArea = source.reduce((area, point, index) => { const next = source[(index + 1) % source.length]; return area + point[0] * next[1] - next[0] * point[1]; }, 0);
    const open = signedArea < 0 ? [...source].reverse() : source; let start = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[start][0] || open[i][0] === open[start][0] && open[i][1] < open[start][1]) start = i;
    const ordered = [...open.slice(start), ...open.slice(0, start)].map(([x, y]) => [Number(x), Number(y)]); return [...ordered, [...ordered[0]]];
  };
  const normalPolygon = (polygon: number[][][]) => polygon.map(normalRing);
  const coordinates = geometry.type === "Polygon" ? normalPolygon(geometry.coordinates as number[][][]) : (geometry.coordinates as number[][][][]).map(normalPolygon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: geometry.type, coordinates } as PolygonalCoverage }] };
}

import type {
  GeoBounds,
  NavigationBuilding,
  NavigationBuildingShard,
  NavigationStreetEdge,
  NavigationStreetNode,
  NavigationStreetShard,
} from "../../../app/lib/navigationData/shardContract";
import {
  CASTER_REACH_M,
  PREP_BOUNDS,
  buildingCellKey,
  makeGrid,
  streetCellKey,
  tileX,
  tileY,
  type Grid,
} from "./boundary";
import type { GridZoom } from "./boundary";

import type { NormalizedBuilding } from "./buildings";
import type { StreetEdge, StreetGraph } from "./graph";

/**
 * Grid ownership. Streets: an edge belongs to the cell containing its
 * midpoint; both endpoints ship with the owner as nodes (ghost when outside
 * the cell), which is what lets the client merge seams by stable node id
 * without a halo. Buildings: a footprint belongs to the cell containing the
 * centroid of its largest ring, and publishes whole — its geometry bounds may
 * overlap neighbouring cells on purpose, so caster selection still finds it.
 */

export interface GeoPoint {
  lng: number;
  lat: number;
}

function cellOf(lng: number, lat: number, grid: Grid): { x: number; y: number } | null {
  const x = tileX(lng, grid.z);
  const y = tileY(lat, grid.z);
  return grid.cells.some((cell) => cell.x === x && cell.y === y) ? { x, y } : null;
}

/** Intersection of two rectangles (they overlap by construction). */
export function intersectBounds(a: GeoBounds, b: GeoBounds): GeoBounds {
  return {
    south: Math.max(a.south, b.south),
    west: Math.max(a.west, b.west),
    north: Math.min(a.north, b.north),
    east: Math.min(a.east, b.east),
  };
}

function containsBounds(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  );
}

/** Where the portion of a→b inside `rect` starts and ends, or null. */
function clipSegment(
  a: GeoPoint,
  b: GeoPoint,
  rect: GeoBounds,
  out: (point: GeoPoint) => void,
): void {
  // Liang–Barsky.
  let t0 = 0;
  let t1 = 1;
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const update = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    !update(-dx, a.lng - rect.west) ||
    !update(dx, rect.east - a.lng) ||
    !update(-dy, a.lat - rect.south) ||
    !update(dy, rect.north - a.lat)
  )
    return;
  const p0 = { lng: a.lng + t0 * dx, lat: a.lat + t0 * dy };
  const p1 = { lng: a.lng + t1 * dx, lat: a.lat + t1 * dy };
  out({ lng: p0.lng, lat: p0.lat });
  if (t1 > t0) out({ lng: p1.lng, lat: p1.lat });
}

function unionPoint(bounds: GeoBounds | null, point: GeoPoint): GeoBounds {
  if (!bounds) return { south: point.lat, west: point.lng, north: point.lat, east: point.lng };
  return {
    south: Math.min(bounds.south, point.lat),
    west: Math.min(bounds.west, point.lng),
    north: Math.max(bounds.north, point.lat),
    east: Math.max(bounds.east, point.lng),
  };
}

function expandBoundsForBuildings(bounds: GeoBounds): GeoBounds {
  const midLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  const dLat = CASTER_REACH_M / 111_320;
  const dLon = CASTER_REACH_M / (111_320 * Math.max(Math.cos(midLat), 0.2));
  return {
    south: bounds.south - dLat,
    west: bounds.west - dLon,
    north: bounds.north + dLat,
    east: bounds.east + dLon,
  };
}

// ─── Streets ───────────────────────────────────────────────────────────────

interface StreetCellAccumulator {
  targets: Array<{
    x: number;
    y: number;
    bounds: GeoBounds;
    nodes: Map<number, { id: number; lat: number; lon: number; isIntersection: boolean }>;
    edges: StreetEdge[];
    geometryBounds: GeoBounds | null;
    ghostNodes: number;
  }>;
  lookup: Map<string, number>;
}

export interface StreetShardingStats {
  cellsPublished: number;
  edgesDroppedOutsideSupport: number;
  ghostNodeRecords: number;
  seamEdges: number;
}

/** Groups the city graph into z-grid street shards. */
export function shardStreets(
  graph: StreetGraph,
  z: GridZoom,
): { shards: Map<string, NavigationStreetShard>; stats: StreetShardingStats } {
  const grid = makeGrid(z);
  const acc: StreetCellAccumulator = { targets: [], lookup: new Map() };
  for (const cell of grid.cells) {
    const bounds = intersectBounds(cell.bounds, PREP_BOUNDS);
    acc.lookup.set(`${cell.x},${cell.y}`, acc.targets.length);
    acc.targets.push({
      x: cell.x,
      y: cell.y,
      bounds,
      nodes: new Map(),
      edges: [],
      geometryBounds: null,
      ghostNodes: 0,
    });
  }
  const stats: StreetShardingStats = {
    cellsPublished: 0,
    edgesDroppedOutsideSupport: 0,
    ghostNodeRecords: 0,
    seamEdges: 0,
  };

  const nodeRecords = new Map<
    number,
    { id: number; lat: number; lon: number; isIntersection: boolean }
  >([...graph.nodes.values()].map((node) => [node.id, node]));

  for (const edge of graph.edges) {
    const fromCoord = graph.nodes.get(edge.from);
    const toCoord = graph.nodes.get(edge.to);
    if (!fromCoord || !toCoord) {
      stats.edgesDroppedOutsideSupport += 1;
      continue;
    }
    const mid = {
      lng: (fromCoord.lon + toCoord.lon) / 2,
      lat: (fromCoord.lat + toCoord.lat) / 2,
    };
    const owner = cellOf(mid.lng, mid.lat, grid);
    if (!owner) {
      stats.edgesDroppedOutsideSupport += 1;
      continue;
    }
    const target = acc.targets[acc.lookup.get(`${owner.x},${owner.y}`)!];
    target.edges.push(edge);
    for (const id of [edge.from, edge.to]) {
      const record = nodeRecords.get(id)!;
      if (!target.nodes.has(id)) {
        target.nodes.set(id, record);
        if (
          !containsBounds(target.bounds, {
            south: record.lat,
            west: record.lon,
            north: record.lat,
            east: record.lon,
          })
        ) {
          target.ghostNodes += 1;
        }
      }
    }
    const fromOwner = nearestCell({ lng: fromCoord.lon, lat: fromCoord.lat }, grid);
    const toOwner = nearestCell({ lng: toCoord.lon, lat: toCoord.lat }, grid);
    if (fromOwner && toOwner && (fromOwner.x !== toOwner.x || fromOwner.y !== toOwner.y)) {
      stats.seamEdges += 1;
    }
    clipSegment(
      { lng: fromCoord.lon, lat: fromCoord.lat },
      { lng: toCoord.lon, lat: toCoord.lat },
      target.bounds,
      (point) => {
        // Clamp to the cell plane: floating-point seam arithmetic must never
        // let a clipped intersection escape its owner cell by one ulp.
        const clamped: GeoPoint = {
          lat: Math.min(Math.max(point.lat, target.bounds.south), target.bounds.north),
          lng: Math.min(Math.max(point.lng, target.bounds.west), target.bounds.east),
        };
        target.geometryBounds = unionPoint(target.geometryBounds, clamped);
      },
    );
  }

  const shards = new Map<string, NavigationStreetShard>();
  for (const target of acc.targets) {
    if (target.edges.length === 0) continue;
    stats.cellsPublished += 1;
    const geometryBounds = target.geometryBounds ?? target.bounds;
    const nodes = [...target.nodes.values()].sort((a, b) => a.id - b.id);
    const edges = [...target.edges].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!containsBounds(target.bounds, geometryBounds)) {
      throw new Error(`cell ${target.x},${target.y}: geometry escapes its cell (clip bug)`);
    }
    shards.set(streetCellKey(z, target.x, target.y), {
      version: 1,
      dataset: "nyc-navigation",
      generation: "", // filled by the builder
      kind: "streets",
      geometryBounds,
      supportBounds: target.bounds,
      nodes: nodes.map((node) => ({
        id: node.id,
        lat: node.lat,
        lon: node.lon,
        isIntersection: node.isIntersection,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        distanceM: edge.distanceM,
        tags: edge.tags,
      })),
    });
    stats.ghostNodeRecords += target.ghostNodes;
  }
  return { shards, stats };
}

function nearestCell(point: GeoPoint, grid: Grid): { x: number; y: number } | null {
  return cellOf(point.lng, point.lat, grid);
}

// ─── Buildings ──────────────────────────────────────────────────────────────

function ringCentroid(ring: Array<[number, number]>): GeoPoint {
  let lng = 0;
  let lat = 0;
  for (const point of ring) {
    lng += point[0];
    lat += point[1];
  }
  return { lng: lng / ring.length, lat: lat / ring.length };
}

function largestRing(building: NormalizedBuilding): Array<[number, number]> {
  let best = building.rings[0];
  let bestArea = -1;
  for (const ring of building.rings) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area = Math.abs(area) / 2;
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

export interface BuildingShardingStats {
  cellsPublished: number;
  buildingsAssigned: number;
  buildingsOutsideGrid: number;
  seamFootprints: number;
}

export function shardBuildings(
  buildings: ReadonlyArray<NormalizedBuilding>,
  z: GridZoom,
): { shards: Map<string, NavigationBuildingShard>; stats: BuildingShardingStats } {
  const grid = makeGrid(z);
  const byCell = new Map<string, NormalizedBuilding[]>();
  const stats: BuildingShardingStats = {
    cellsPublished: 0,
    buildingsAssigned: 0,
    buildingsOutsideGrid: 0,
    seamFootprints: 0,
  };
  for (const building of buildings) {
    const centroid = ringCentroid(largestRing(building));
    const cell = cellOf(centroid.lng, centroid.lat, grid);
    if (!cell) {
      stats.buildingsOutsideGrid += 1;
      continue;
    }
    const key = `${cell.x},${cell.y}`;
    const bucket = byCell.get(key) ?? [];
    bucket.push(building);
    byCell.set(key, bucket);
    stats.buildingsAssigned += 1;

    // A footprint whose rings touch more than one cell counts as a seam caster.
    let crosses = 0;
    for (const ring of building.rings) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [lng, lat] of ring) {
        minX = Math.min(minX, tileX(lng, z));
        maxX = Math.max(maxX, tileX(lng, z));
        minY = Math.min(minY, tileY(lat, z));
        maxY = Math.max(maxY, tileY(lat, z));
      }
      if (maxX !== minX || maxY !== minY) crosses = 1;
    }
    stats.seamFootprints += crosses;
  }

  const shards = new Map<string, NavigationBuildingShard>();
  for (const cell of grid.cells) {
    const bucket = byCell.get(`${cell.x},${cell.y}`) ?? [];
    if (bucket.length === 0) continue;
    stats.cellsPublished += 1;
    const sorted = [...bucket].sort((a, b) => a.doittId - b.doittId);
    const published: NavigationBuilding[] = sorted.map((building) => ({
      id: String(building.doittId),
      rings: building.rings.map((ring) =>
        ring.map(
          ([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))] as [number, number],
        ),
      ),
      heightM: building.heightM,
      heightSource: building.heightSource,
      featureCode: building.featureCode,
      status: building.status,
    }));
    let geometryBounds: GeoBounds | null = null;
    for (const building of published) {
      for (const ring of building.rings) {
        for (const [lng, lat] of ring) {
          geometryBounds = unionPoint(geometryBounds, { lng, lat });
        }
      }
    }
    const bounds = geometryBounds!;
    shards.set(buildingCellKey(z, cell.x, cell.y), {
      version: 1,
      dataset: "nyc-navigation",
      generation: "",
      kind: "buildings",
      geometryBounds: bounds,
      supportBounds: expandBoundsForBuildings(bounds),
      buildings: published,
    });
  }
  return { shards, stats };
}

export type { GridZoom } from "./boundary";

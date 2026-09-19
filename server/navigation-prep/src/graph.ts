import type { RetainedWay } from "./pbf";

/**
 * Reproduces `buildRoutingGraphFromElements` in `app/lib/overpass.ts` from a
 * parsed PBF instead of Overpass JSON — same node registration, same
 * intersection rule, same closed-pedestrian skip, same bidirectional edge
 * emission, same tags, and the identical haversine for `distanceM`.
 * The only intentional additions are skipped-edge counts (evidence) and a
 * stable published edge id the client keeps but does not use for identity.
 */

export interface StreetNode {
  id: number;
  lat: number;
  lon: number;
  isIntersection: boolean;
}

export interface StreetEdge {
  id: string;
  from: number;
  to: number;
  distanceM: number;
  tags: RetainedWay["tags"];
}

export interface StreetGraph {
  nodes: Map<number, StreetNode>;
  edges: StreetEdge[];
  stats: {
    closedPedestrianWaysSkipped: number;
    segmentsMissingCoords: number;
    zeroLengthSegments: number;
    danglingEdges: number;
  };
}

/** The exact haversine in `app/lib/routing.ts` (R = 6371000 m). */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal =
    sinDLat * sinDLat + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinDLon * sinDLon;
  return R * 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

/**
 * Intersection membership: count each way once per distinct node. Closed
 * pedestrian plazas still count toward the flag — the client counts every way
 * the query returned before skipping the plaza geometry.
 */
function wayMembership(ways: RetainedWay[]): Map<number, number> {
  const count = new Map<number, number>();
  for (const way of ways) {
    const seen = new Set<number>();
    for (const id of way.refs) {
      if (!seen.has(id)) {
        seen.add(id);
        count.set(id, (count.get(id) ?? 0) + 1);
      }
    }
  }
  return count;
}

export function isClosedPedestrian(way: RetainedWay): boolean {
  const refs = way.refs;
  return refs.length >= 2 && refs[0] === refs[refs.length - 1] && way.tags.highway === "pedestrian";
}

export function buildStreetGraph(
  ways: RetainedWay[],
  coords: Map<number, [number, number]>,
): StreetGraph {
  const nodeWayCount = wayMembership(ways);
  const nodes = new Map<number, StreetNode>();
  const edges: StreetEdge[] = [];
  const stats: StreetGraph["stats"] = {
    closedPedestrianWaysSkipped: 0,
    segmentsMissingCoords: 0,
    zeroLengthSegments: 0,
    danglingEdges: 0,
  };

  for (const way of ways) {
    if (isClosedPedestrian(way)) {
      stats.closedPedestrianWaysSkipped += 1;
      continue;
    }
    for (const nid of way.refs) {
      const coord = coords.get(nid);
      if (!nodes.has(nid) && coord) {
        nodes.set(nid, {
          id: nid,
          lat: coord[1],
          lon: coord[0],
          isIntersection: (nodeWayCount.get(nid) ?? 0) >= 2,
        });
      }
    }
    for (let i = 0; i < way.refs.length - 1; i += 1) {
      const fromId = way.refs[i];
      const toId = way.refs[i + 1];
      if (fromId === toId) {
        stats.zeroLengthSegments += 1;
        continue;
      }
      const fromCoord = coords.get(fromId);
      const toCoord = coords.get(toId);
      if (!fromCoord || !toCoord) {
        stats.segmentsMissingCoords += 1;
        continue;
      }
      const distanceM = haversineMeters(fromCoord, toCoord);
      if (!(distanceM > 0)) {
        stats.zeroLengthSegments += 1;
        continue;
      }
      const base = `w${way.id}s${i}`;
      edges.push({ id: `${base}f`, from: fromId, to: toId, distanceM, tags: way.tags });
      edges.push({ id: `${base}r`, from: toId, to: fromId, distanceM, tags: way.tags });
    }
  }

  return { nodes, edges, stats };
}

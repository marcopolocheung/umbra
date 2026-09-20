/**
 * Promotes a spatial subway↔bus stub to a `walked` transfer when OpenStreetMap
 * says a pedestrian can actually make it.
 *
 * **What "walkable" means here.** A routed path over OSM's pedestrian ways from
 * one of the station's own doors (#430) to the bus stop, no longer than
 * `detourRatio` × the straight line between that door and the stop, plus
 * `detourSlackM`. The ratio is 1.5: a grid city's worst honest detour — the two
 * sides of a block against its diagonal — is √2, so anything past 1.5 is going
 * *around* something, an expressway, a rail cut, a park wall. The slack is
 * 50 m, for walking to the crosswalk and back, which a ratio alone punishes at
 * the short distances where most of these pairs sit (a door 20 m from the stop
 * across the street). Both are published in the manifest beside the result.
 *
 * Per direction, because doors are: leaving a station may use an exit-only
 * door, arriving may not. A station with no door on file validates nothing —
 * its point is the middle of a platform, and a walk from there is a guess of
 * exactly the kind this check exists to replace.
 *
 * The published walk is the in-station part, taken as the straight line from
 * the station's point to the door, plus the routed street part. Stairs and
 * fare control are not in OSM's footway graph, so the in-station part is an
 * under-estimate, and says so in the manifest note.
 */

import type { StopNode, TransferEdge } from "./model";
import { SPATIAL_WALK_MPS } from "./transfers";
import { haversineMeters } from "./util";

export const WALKED_DETOUR_RATIO = 1.5;
export const WALKED_DETOUR_SLACK_M = 50;
/**
 * How far a door or stop may sit from the pedestrian network and still join it.
 * A bus stop is ~8 m off the centreline and a door stands on the pavement; past
 * 20 m the join would be crossing something the network does not show.
 */
export const WALKED_SNAP_M = 20;

/** The same floor the spatial stubs use: no change is quicker than this. */
const MIN_TRANSFER_SEC = 30;

export interface WalkParams {
  detourRatio: number;
  detourSlackM: number;
  snapM: number;
  walkMps: number;
}

export const WALK_PARAMS: WalkParams = {
  detourRatio: WALKED_DETOUR_RATIO,
  detourSlackM: WALKED_DETOUR_SLACK_M,
  snapM: WALKED_SNAP_M,
  walkMps: SPATIAL_WALK_MPS,
};

/** One OSM pedestrian way: its node ids and their coordinates, in order. */
export interface FootwayWay {
  id: number;
  nodes: number[];
  /** Flat `[lat, lon, lat, lon, …]`, one pair per entry of `nodes`. */
  coords: number[];
}

export interface FootwayGraph {
  lat: Float64Array;
  lon: Float64Array;
  /** Neighbours of node i: `adjTo[adjStart[i]..adjStart[i+1]]`. */
  adjStart: Int32Array;
  adjTo: Int32Array;
  adjM: Float64Array;
  /** Segments as node-index pairs, bucketed by grid cell for snapping. */
  segA: Int32Array;
  segB: Int32Array;
  cells: Map<string, number[]>;
}

/** ~110 m of latitude: a 20 m snap never needs more than the 3×3 around it. */
const CELL_DEG = 0.001;
const cellKey = (x: number, y: number): string => `${x}:${y}`;

export function buildFootwayGraph(ways: FootwayWay[]): FootwayGraph {
  const index = new Map<number, number>();
  const lats: number[] = [];
  const lons: number[] = [];
  const edges: [number, number][] = [];
  for (const way of ways) {
    let previous = -1;
    for (let k = 0; k < way.nodes.length; k += 1) {
      const id = way.nodes[k] as number;
      let i = index.get(id);
      if (i === undefined) {
        i = lats.length;
        index.set(id, i);
        lats.push(way.coords[2 * k] as number);
        lons.push(way.coords[2 * k + 1] as number);
      }
      if (previous >= 0 && previous !== i) edges.push([previous, i]);
      previous = i;
    }
  }
  const lat = Float64Array.from(lats);
  const lon = Float64Array.from(lons);
  const degree = new Int32Array(lat.length + 1);
  for (const [a, b] of edges) {
    degree[a + 1] += 1;
    degree[b + 1] += 1;
  }
  for (let i = 1; i < degree.length; i += 1) degree[i] += degree[i - 1] as number;
  const adjStart = degree.slice();
  const fill = degree.slice(0, lat.length);
  const adjTo = new Int32Array(edges.length * 2);
  const adjM = new Float64Array(edges.length * 2);
  const segA = new Int32Array(edges.length);
  const segB = new Int32Array(edges.length);
  const cells = new Map<string, number[]>();
  edges.forEach(([a, b], s) => {
    const metres = haversineMeters(lat[a] as number, lon[a] as number, lat[b] as number, lon[b] as number);
    adjTo[fill[a]] = b;
    adjM[fill[a]] = metres;
    fill[a] += 1;
    adjTo[fill[b]] = a;
    adjM[fill[b]] = metres;
    fill[b] += 1;
    segA[s] = a;
    segB[s] = b;
    const x0 = Math.floor(Math.min(lat[a] as number, lat[b] as number) / CELL_DEG);
    const x1 = Math.floor(Math.max(lat[a] as number, lat[b] as number) / CELL_DEG);
    const y0 = Math.floor(Math.min(lon[a] as number, lon[b] as number) / CELL_DEG);
    const y1 = Math.floor(Math.max(lon[a] as number, lon[b] as number) / CELL_DEG);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = cellKey(x, y);
        const bucket = cells.get(key);
        if (bucket) bucket.push(s);
        else cells.set(key, [s]);
      }
    }
  });
  return { lat, lon, adjStart, adjTo, adjM, segA, segB, cells };
}

/**
 * Every network node a point can step onto: both ends of each segment passing
 * within `snapM`, each costed as the step to the segment plus the walk along it.
 *
 * Every segment rather than the nearest one, because NYC's pavements are mapped
 * as separate ways that do not always meet the crossing beside them; the
 * nearest segment is often a fragment that goes nowhere, and a stop on it
 * would fail for want of a join a pedestrian simply steps across.
 */
export function snapPoint(
  graph: FootwayGraph,
  lat: number,
  lon: number,
  snapM: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const kx = Math.cos((lat * Math.PI) / 180);
  const cx = Math.floor(lat / CELL_DEG);
  const cy = Math.floor(lon / CELL_DEG);
  const seen = new Set<number>();
  for (let x = cx - 1; x <= cx + 1; x += 1) {
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      for (const s of graph.cells.get(cellKey(x, y)) ?? []) {
        if (seen.has(s)) continue;
        seen.add(s);
        const a = graph.segA[s] as number;
        const b = graph.segB[s] as number;
        // Local planar projection, metres per degree of latitude.
        const ax = ((graph.lon[a] as number) - lon) * kx;
        const ay = (graph.lat[a] as number) - lat;
        const dx = ((graph.lon[b] as number) - lon) * kx - ax;
        const dy = (graph.lat[b] as number) - lat - ay;
        const length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
        const stepM = Math.hypot(ax + t * dx, ay + t * dy) * 111_195;
        if (stepM > snapM) continue;
        const segmentM = haversineMeters(
          graph.lat[a] as number,
          graph.lon[a] as number,
          graph.lat[b] as number,
          graph.lon[b] as number,
        );
        for (const [node, along] of [
          [a, t * segmentM],
          [b, (1 - t) * segmentM],
        ] as const) {
          const cost = stepM + along;
          if (cost < (out.get(node) ?? Infinity)) out.set(node, cost);
        }
      }
    }
  }
  return out;
}

/** Shortest distance from the sources to every node within `limitM`. */
function distancesFrom(graph: FootwayGraph, sources: Map<number, number>, limitM: number): Map<number, number> {
  const dist = new Map<number, number>();
  // Binary heap of [cost, node].
  const heap: [number, number][] = [];
  const push = (item: [number, number]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heap[parent] as [number, number])[0] <= item[0]) break;
      heap[i] = heap[parent] as [number, number];
      i = parent;
    }
    heap[i] = item;
  };
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number];
    const last = heap.pop() as [number, number];
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heap.length) break;
        const r = l + 1;
        const c = r < heap.length && (heap[r] as [number, number])[0] < (heap[l] as [number, number])[0] ? r : l;
        if ((heap[c] as [number, number])[0] >= last[0]) break;
        heap[i] = heap[c] as [number, number];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  for (const [node, cost] of sources) push([cost, node]);
  while (heap.length > 0) {
    const [cost, node] = pop();
    if (dist.has(node)) continue;
    if (cost > limitM) break;
    dist.set(node, cost);
    for (let e = graph.adjStart[node] as number; e < (graph.adjStart[node + 1] as number); e += 1) {
      const next = graph.adjTo[e] as number;
      if (!dist.has(next)) push([cost + (graph.adjM[e] as number), next]);
    }
  }
  return dist;
}

type Door = { lat: number; lon: number; exitOnly?: true };

/**
 * Why a stub stayed spatial. Counted, so the manifest can say. `detour` covers
 * both a path that is too long and no path at all: the search stops at the
 * longest walk any door is allowed, so past that the two look the same.
 */
export type Refusal = "noDoor" | "stopOffNetwork" | "doorsOffNetwork" | "detour";

export interface WalkedStats {
  /** Spatial stubs considered, one per direction. */
  candidates: number;
  walked: number;
  refused: Record<Refusal, number>;
  /** Stations with at least one walked change onto a bus stop, and off one. */
  stationsWalkedOut: number;
  stationsWalkedIn: number;
}

/**
 * The routed walk for one stub, or why there is none. Pure given the graph, so
 * `verify` runs the very same function to re-derive what `build` published.
 */
export function walkStub(
  graph: FootwayGraph,
  station: StopNode,
  stop: StopNode,
  leaving: boolean,
  params: WalkParams,
): { walkM: number } | { refused: Refusal } {
  const doors = (station.entrances ?? []).filter((door: Door) => leaving || !door.exitOnly);
  if (doors.length === 0) return { refused: "noDoor" };
  const stopSnap = snapPoint(graph, stop.lat, stop.lon, params.snapM);
  if (stopSnap.size === 0) return { refused: "stopOffNetwork" };

  const allowed = doors.map(
    (door) => params.detourRatio * haversineMeters(door.lat, door.lon, stop.lat, stop.lon) + params.detourSlackM,
  );
  // The graph is undirected (a pavement walks both ways), so one search from
  // the stop serves every door.
  const dist = distancesFrom(graph, stopSnap, Math.max(...allowed));
  let best: number | null = null;
  let anyDoorOnNetwork = false;
  doors.forEach((door, i) => {
    const doorSnap = snapPoint(graph, door.lat, door.lon, params.snapM);
    if (doorSnap.size > 0) anyDoorOnNetwork = true;
    let routed = Infinity;
    for (const [node, step] of doorSnap) {
      const reached = dist.get(node);
      if (reached !== undefined) routed = Math.min(routed, reached + step);
    }
    // Any door that makes it within its own allowance will do; the rider
    // uses whichever is shortest overall, in-station part included.
    if (!(routed <= (allowed[i] as number))) return;
    const walkM = haversineMeters(station.lat, station.lon, door.lat, door.lon) + routed;
    if (best === null || walkM < best) best = walkM;
  });
  if (best === null) return { refused: anyDoorOnNetwork ? "detour" : "doorsOffNetwork" };
  return { walkM: Math.round(best) };
}

export const walkedMinSec = (walkM: number, walkMps: number): number =>
  Math.max(MIN_TRANSFER_SEC, Math.ceil(walkM / walkMps));

/**
 * Rewrites each spatial stub the network can walk as `walked`, with its routed
 * `walkM` and the time that walk takes. Everything else passes through
 * untouched: a refused stub stays published as `spatial`, which the client
 * already refuses (#419).
 */
export function promoteWalkable(
  transfers: TransferEdge[],
  stops: StopNode[],
  graph: FootwayGraph,
  params: WalkParams = WALK_PARAMS,
): { transfers: TransferEdge[]; stats: WalkedStats } {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const stats: WalkedStats = {
    candidates: 0,
    walked: 0,
    refused: { noDoor: 0, stopOffNetwork: 0, doorsOffNetwork: 0, detour: 0 },
    stationsWalkedOut: 0,
    stationsWalkedIn: 0,
  };
  const out = new Set<string>();
  const into = new Set<string>();
  const promoted = transfers.map((transfer): TransferEdge => {
    if (transfer.kind !== "spatial") return transfer;
    const leaving = transfer.from.startsWith("subway:");
    const station = byId.get(leaving ? transfer.from : transfer.to);
    const stop = byId.get(leaving ? transfer.to : transfer.from);
    if (!station || !stop) return transfer;
    stats.candidates += 1;
    const result = walkStub(graph, station, stop, leaving, params);
    if ("refused" in result) {
      stats.refused[result.refused] += 1;
      return transfer;
    }
    stats.walked += 1;
    (leaving ? out : into).add(station.id);
    return {
      from: transfer.from,
      to: transfer.to,
      minSec: walkedMinSec(result.walkM, params.walkMps),
      kind: "walked",
      walkM: result.walkM,
    };
  });
  stats.stationsWalkedOut = out.size;
  stats.stationsWalkedIn = into.size;
  return { transfers: promoted, stats };
}

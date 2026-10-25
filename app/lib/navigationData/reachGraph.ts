/**
 * H3b: the time-aware walking graph Sun Budget searches, built from the
 * published NYC generation alone — streets plus the precomputed shade table.
 *
 * Outside that coverage the answer is `uncovered`, never an Overpass graph
 * with live shade: the live path needs the map canvas and takes seconds per
 * area, too slow under a slider (owner decision, 2026-10-22; follow-up filed).
 */

import {
  bfsReachable,
  type GraphEdge,
  haversineMeters,
  parallelSidewalkEdges,
  removeVirtualNode,
  type RoutingGraph,
  snapToEdge,
  snapToReachableEdge,
  swapSideAgainstCanonical,
} from "../routing";
import { utcOffsetMinAt } from "../timezone";
import { getTravelModePolicy, type TravelModeId } from "../travelMode";
import {
  acquireNavigationSnapshot,
  loadNavigationShadeShard,
  loadNavigationStreetShards,
  loadShadeSlotBlocks,
  selectNavigationShards,
  zoneAround,
} from "./remoteNavigation";
import { buildRoutingGraphFromStreetShards } from "./routingGraphAdapter";
import { SHADE_ZONE } from "./shadeSlots";
import {
  createShadeTableView,
  QUARANTINED_SHADE_GENERATIONS,
  type ShadeTableView,
  shadeSlotsForDeparture,
} from "./shadeTable";

/** H1's bucket width; the shade table is published at the same 15-minute grain. */
export const REACH_BUCKET_MS = 15 * 60_000;
const MAX_BUCKETS = 8;

export type ReachGraph =
  | { status: "uncovered"; reason: string }
  | {
      status: "ok";
      graph: RoutingGraph;
      startId: number;
      /** Where the search starts: the snapped point on the street, not the tap. */
      startPoint: [number, number];
      timeAware: { bucketMs: number; bucketCount: number };
      /**
       * Metres from the start to the nearest edge of the data when the graph
       * was cut there (#380), else null. A walk radius that reaches it may be
       * missing streets near the edge.
       */
      edgeM: number | null;
    };

/** A start piece this small is a stray fragment (a cut-off path), not a neighbourhood. */
const MIN_START_PIECE_NODES = 200;
/** Farther than this from a connected street and the start is not on the network. */
const MAX_SNAP_M = 100;

/**
 * The start, snapped onto the street network. A nearest-edge snap can land on
 * a fragment the data cuts off (a park path, a plaza), and a search from there
 * would honestly report a tiny region as `exact`; re-snap onto the largest
 * connected piece instead, as routing does (`snapRouteStopsToReachableEdges`).
 */
export function snapStart(
  center: [number, number],
  graph: RoutingGraph,
  travelMode: TravelModeId,
): number | null {
  const id = snapToEdge(center, graph, -1, travelMode);
  const piece = bfsReachable(graph, id, travelMode);
  if (piece.size >= MIN_START_PIECE_NODES) return id;
  let largest = piece;
  const seen = new Set(piece);
  for (const nodeId of graph.adj.keys()) {
    if (seen.has(nodeId)) continue;
    const other = bfsReachable(graph, nodeId, travelMode);
    for (const n of other) seen.add(n);
    if (other.size > largest.size) largest = other;
  }
  if (largest === piece) return id;
  if (id < 0) removeVirtualNode(graph, id);
  const fallback = snapToReachableEdge(center, graph, largest, -1, travelMode);
  return fallback && fallback.distM <= MAX_SNAP_M ? fallback.id : null;
}

/**
 * Per-sidewalk edges carrying H1's per-bucket shade from the table. Every
 * segment must be covered (`view.covers`); the caller checks.
 */
export function timeAwareGraphFromTable(
  graph: RoutingGraph,
  view: ShadeTableView,
  perBucket: number[],
): RoutingGraph {
  const series = (key: string, side: "left" | "right") =>
    perBucket.map((slot) => view.shadowFor(key, slot)?.[side] ?? 0);
  const adj = new Map<number, GraphEdge[]>();
  for (const [fromId, edges] of graph.adj) {
    const out: GraphEdge[] = [];
    for (const edge of edges) {
      const key = `${Math.min(fromId, edge.toId)},${Math.max(fromId, edge.toId)}`;
      const left = series(key, "left");
      const right = series(key, "right");
      for (const split of parallelSidewalkEdges(fromId, edge, left[0], right[0])) {
        // The traveller's side maps back to the canonical one the table stores.
        const canonical = swapSideAgainstCanonical(fromId, edge.toId, split.side!);
        out.push({ ...split, timeShadow: canonical === "left" ? left : right });
      }
    }
    adj.set(fromId, out);
  }
  return { nodes: graph.nodes, adj };
}

export async function buildReachGraph(args: {
  center: [number, number];
  /** How far a walk can go: sizes the street area. */
  timeBudgetSec: number;
  /** How long an outing can last, stops included: sizes the shade buckets. Defaults to `timeBudgetSec`. */
  horizonSec?: number;
  departure: Date;
  travelMode: TravelModeId;
  signal?: AbortSignal;
}): Promise<ReachGraph> {
  const { center, timeBudgetSec, departure, travelMode, signal } = args;
  const horizonSec = Math.max(timeBudgetSec, args.horizonSec ?? 0);
  const snapshot = await acquireNavigationSnapshot({ signal });
  if (!snapshot) return { status: "uncovered", reason: "no navigation dataset" };
  if (QUARANTINED_SHADE_GENERATIONS.has(snapshot.generation)) {
    return { status: "uncovered", reason: "shade generation quarantined" };
  }
  // Everything a walker can cover in the time budget, plus a margin for the
  // street grid's detours over the straight line.
  const radiusM = timeBudgetSec * getTravelModePolicy(travelMode).speedMps * 1.1;
  const support = snapshot.manifest.supportBounds;
  const inside = (lon: number, lat: number) =>
    lon >= support.west && lon <= support.east && lat >= support.south && lat <= support.north;
  if (!inside(center[0], center[1])) return { status: "uncovered", reason: "outside the shade table" };
  // Near the data's edge the walk radius pokes past it: cut the box there
  // rather than refuse a start that is itself covered (#380).
  const full = zoneAround(center[0], center[1], radiusM);
  const box = {
    south: Math.max(full.south, support.south),
    west: Math.max(full.west, support.west),
    north: Math.min(full.north, support.north),
    east: Math.min(full.east, support.east),
  };
  const clipped = box.south !== full.south || box.west !== full.west || box.north !== full.north || box.east !== full.east;
  const [lon, lat] = center;
  const edgeM = clipped
    ? Math.min(
        haversineMeters(center, [lon, support.south]),
        haversineMeters(center, [lon, support.north]),
        haversineMeters(center, [support.west, lat]),
        haversineMeters(center, [support.east, lat]),
      )
    : null;
  const selection = selectNavigationShards(snapshot.manifest, box);
  if (!selection || selection.shadeShards.length === 0) {
    return { status: "uncovered", reason: "outside the shade table" };
  }
  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, Math.ceil((horizonSec * 1000) / REACH_BUCKET_MS)));
  const { perBucket, slotIndices } = shadeSlotsForDeparture(
    departure,
    bucketCount,
    utcOffsetMinAt(SHADE_ZONE, departure),
  );
  const [streets, shadeShards] = await Promise.all([
    loadNavigationStreetShards(snapshot, selection.streets, { signal }),
    Promise.all(selection.shadeShards.map((ref) => loadNavigationShadeShard(snapshot, ref, { signal }))),
  ]);
  const blocks = await Promise.all(
    shadeShards.map((shard) => loadShadeSlotBlocks(snapshot, shard, slotIndices, { signal })),
  );
  const view = createShadeTableView(shadeShards.map((shard, i) => ({ shard, blocks: blocks[i] })));
  const streetGraph = buildRoutingGraphFromStreetShards(streets);
  // A street the table does not hold is dropped only when it crosses the data's
  // edge (#380); one wholly inside is a hole in the data, and refuses as before.
  const pastEdge = (id: number) => {
    const node = streetGraph.nodes.get(id);
    return !node || !inside(node.lon, node.lat);
  };
  for (const [fromId, edges] of streetGraph.adj) {
    const kept: GraphEdge[] = [];
    for (const edge of edges) {
      if (view.covers(`${Math.min(fromId, edge.toId)},${Math.max(fromId, edge.toId)}`)) kept.push(edge);
      else if (!(clipped && (pastEdge(fromId) || pastEdge(edge.toId)))) {
        return { status: "uncovered", reason: "shade table misses streets here" };
      }
    }
    streetGraph.adj.set(fromId, kept);
  }
  const graph = timeAwareGraphFromTable(streetGraph, view, perBucket);
  const startId = snapStart(center, graph, travelMode);
  if (startId === null) return { status: "uncovered", reason: "no connected street near the start" };
  const start = graph.nodes.get(startId)!;
  return {
    status: "ok",
    graph,
    startId,
    startPoint: [start.lon, start.lat],
    timeAware: { bucketMs: REACH_BUCKET_MS, bucketCount },
    edgeM,
  };
}

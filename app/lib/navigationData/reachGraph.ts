/**
 * H3b: the time-aware walking graph Sun Budget searches, built from the
 * published NYC generation alone — streets plus the precomputed shade table.
 *
 * Outside that coverage the answer is `uncovered`, never an Overpass graph
 * with live shade: the live path needs the map canvas and takes seconds per
 * area, too slow under a slider (owner decision, 2026-10-22; follow-up filed).
 */

import {
  type GraphEdge,
  parallelSidewalkEdges,
  type RoutingGraph,
  snapToEdge,
  swapSideAgainstCanonical,
} from "../routing";
import { routingEdgeBatch } from "../navigationHelpers";
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
      timeAware: { bucketMs: number; bucketCount: number };
    };

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
  timeBudgetSec: number;
  departure: Date;
  travelMode: TravelModeId;
  signal?: AbortSignal;
}): Promise<ReachGraph> {
  const { center, timeBudgetSec, departure, travelMode, signal } = args;
  const snapshot = await acquireNavigationSnapshot({ signal });
  if (!snapshot) return { status: "uncovered", reason: "no navigation dataset" };
  if (QUARANTINED_SHADE_GENERATIONS.has(snapshot.generation)) {
    return { status: "uncovered", reason: "shade generation quarantined" };
  }
  // Everything a walker can cover in the time budget, plus a margin for the
  // street grid's detours over the straight line.
  const radiusM = timeBudgetSec * getTravelModePolicy(travelMode).speedMps * 1.1;
  const box = zoneAround(center[0], center[1], radiusM);
  const selection = selectNavigationShards(snapshot.manifest, box);
  if (!selection || selection.shadeShards.length === 0) {
    return { status: "uncovered", reason: "outside the shade table" };
  }
  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, Math.ceil((timeBudgetSec * 1000) / REACH_BUCKET_MS)));
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
  if (!routingEdgeBatch(streetGraph).keys.every((key) => view.covers(key))) {
    return { status: "uncovered", reason: "shade table misses streets here" };
  }
  const graph = timeAwareGraphFromTable(streetGraph, view, perBucket);
  const startId = snapToEdge(center, graph, -1, travelMode);
  return { status: "ok", graph, startId, timeAware: { bucketMs: REACH_BUCKET_MS, bucketCount } };
}

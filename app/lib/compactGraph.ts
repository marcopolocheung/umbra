/**
 * Compressed-sparse-row (CSR) form of a `RoutingGraph` — the L3b search layout
 * (#263, plan on #270).
 *
 * The object graph keeps every node in a `Map` and every edge as an object, so
 * a search pays several hash lookups and a pointer chase per relaxation. This
 * stores the same graph as flat typed arrays indexed 0..n−1: node `i`'s
 * outgoing edges are `targets[offsets[i] .. offsets[i + 1])`, in exactly the
 * order `graph.adj.get(id)` lists them — search order, and therefore tie-breaks,
 * depend on that.
 *
 * Deliberately structure only: no destination, no travel mode, no objective.
 * Anything that depends on those (mode costs, crossing penalties, a heuristic)
 * is a per-search array the search builds over `edges`. That keeps one compact
 * graph usable by a one-to-one search (`paretoRoutes`) and a target-less
 * one-to-many search (H3's Sun Budget reachability), and transferable to
 * `app/workers/routing.worker.ts` (L3c) — the typed arrays transfer as buffers;
 * `indexOf` and `edges` do not, and L3c has to ship ids and edge attributes instead.
 */

import type { GraphEdge, RoutingGraph } from "./routing";

export interface CompactGraph {
  nodeCount: number;
  /** Index → graph node id. Float64, because OSM ids pass 2^31 and virtual snap ids are negative. */
  nodeIds: Float64Array;
  /** Graph node id → index. */
  indexOf: Map<number, number>;
  /** 1 when the node is in `graph.nodes` (has coordinates); edge-only ids get 0. */
  hasCoord: Uint8Array;
  lat: Float64Array;
  lon: Float64Array;
  /** 1 when `graph.nodes` marks the node an intersection. */
  isIntersection: Uint8Array;
  /** Length nodeCount + 1; node i's edges are offsets[i] .. offsets[i + 1]. */
  offsets: Int32Array;
  /** Edge → target node index. */
  targets: Int32Array;
  /** Edge → the source `GraphEdge`, for per-search attributes and result building. */
  edges: GraphEdge[];
}

/**
 * Build the CSR form. Every id the object graph can reach a search through —
 * `nodes` keys, `adj` keys and every edge target — gets an index, so a search
 * over the compact form sees the same graph a `Map` search does, including
 * edges that point at nodes without coordinates. `extraIds` adds ids that may
 * appear in neither (a search's start and end).
 */
export function toCompactGraph(graph: RoutingGraph, extraIds: number[] = []): CompactGraph {
  const indexOf = new Map<number, number>();
  const ids: number[] = [];
  const add = (id: number) => {
    if (!indexOf.has(id)) {
      indexOf.set(id, ids.length);
      ids.push(id);
    }
  };
  for (const id of graph.nodes.keys()) add(id);
  let edgeCount = 0;
  for (const [id, edges] of graph.adj) {
    add(id);
    edgeCount += edges.length;
    for (const edge of edges) add(edge.toId);
  }
  for (const id of extraIds) add(id);

  const nodeCount = ids.length;
  const nodeIds = new Float64Array(ids);
  const hasCoord = new Uint8Array(nodeCount);
  const lat = new Float64Array(nodeCount);
  const lon = new Float64Array(nodeCount);
  const isIntersection = new Uint8Array(nodeCount);
  for (const [id, node] of graph.nodes) {
    const i = indexOf.get(id)!;
    hasCoord[i] = 1;
    lat[i] = node.lat;
    lon[i] = node.lon;
    if (node.isIntersection) isIntersection[i] = 1;
  }

  const offsets = new Int32Array(nodeCount + 1);
  const targets = new Int32Array(edgeCount);
  const edges: GraphEdge[] = new Array(edgeCount);
  let e = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = e;
    for (const edge of graph.adj.get(ids[i]) ?? []) {
      targets[e] = indexOf.get(edge.toId)!;
      edges[e] = edge;
      e++;
    }
  }
  offsets[nodeCount] = e;
  return { nodeCount, nodeIds, indexOf, hasCoord, lat, lon, isIntersection, offsets, targets, edges };
}

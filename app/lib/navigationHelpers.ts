import type maplibregl from "maplibre-gl";
import type { GraphEdge, RoutingGraph } from "./routing";
import type { EdgeRef } from "./shadowField/ShadowField";

/**
 * Pure module-level helpers extracted verbatim from `useNavigation.ts` (G6a).
 * No behaviour change: the hook imports them from here instead of defining
 * them inline. No other module should grow a second copy — check here first.
 */

/**
 * How much to trust the pixel sampler when it answers instead of the field.
 *
 * A prior, not a measurement — deliberately below the tile prior (0.8), because the
 * canvas reads whatever the renderer painted at whatever zoom the camera happened to
 * be at. `SOURCE_BASE_CONFIDENCE` carries the same caveat for the geometric sources.
 * A3's agreement harness cannot justify a number here: it compares the field and the
 * sampler over *identical* prisms, so it measures their disagreement, not the
 * sampler's accuracy. That needs the corpus #121 was blocking.
 */
export const CANVAS_CONFIDENCE = 0.6;

/** Tilting is the one camera move that can provoke motion sickness. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How long to let the camera settle before reading the canvas anyway. */
export const CAMERA_SETTLE_TIMEOUT_MS = 1500;

/** One wall-clock budget shared by broad and exact-cell shadow readiness. */
export const ROUTE_READINESS_BUDGET_MS = 2500;

/**
 * Wait for the map to settle before the readback — but not forever. The timeline's
 * play mode advances the date every 50 ms, and each advance repaints the shadow
 * layer, so `idle` never arrives while it runs. `preserveDrawingBuffer` (invariant
 * #3) means the canvas still holds the last drawn frame, so sampling a frame late
 * beats hanging the calculation.
 */
export function waitForMapIdle(map: maplibregl.Map): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      map.off("idle", finish);
      resolve();
    };
    timer = setTimeout(finish, CAMERA_SETTLE_TIMEOUT_MS);
    map.once("idle", finish);
  });
}

export function routingEdgeBatch(graph: RoutingGraph): {
  refs: EdgeRef[];
  keys: string[];
  distances: number[];
  directedCount: number;
} {
  const refs: EdgeRef[] = [];
  const keys: string[] = [];
  const distances: number[] = [];
  const seen = new Set<string>();
  let directedCount = 0;
  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue;
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;
    for (const edge of edges) {
      if (edge.toId < 0) continue;
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;
      directedCount++;
      const lo = Math.min(fromId, edge.toId);
      const hi = Math.max(fromId, edge.toId);
      const key = `${lo},${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const loNode = fromId < edge.toId ? fromNode : toNode;
      const hiNode = fromId < edge.toId ? toNode : fromNode;
      keys.push(key);
      distances.push(edge.distanceM);
      refs.push({ from: [loNode.lon, loNode.lat], to: [hiNode.lon, hiNode.lat] });
    }
  }
  return { refs, keys, distances, directedCount };
}

export function routePlanFingerprint(
  from: [number, number] | null,
  to: [number, number] | null,
  via: [number, number][],
  dwell?: string,
): string {
  return JSON.stringify({ from, to, via, dwell: dwell ?? "" });
}

export function cloneRoutingGraph(graph: RoutingGraph): RoutingGraph {
  const nodes = new Map(graph.nodes);
  const adj = new Map<number, GraphEdge[]>();
  for (const [id, edges] of graph.adj) {
    adj.set(
      id,
      edges.map((e) => ({ toId: e.toId, distanceM: e.distanceM, shadowFactor: e.shadowFactor })),
    );
  }
  return { nodes, adj };
}

export function removeVirtualNode(graph: RoutingGraph, vid: number): void {
  const vidEdges = graph.adj.get(vid);
  if (vidEdges) {
    for (const e of vidEdges) {
      const ownerEdges = graph.adj.get(e.toId);
      if (ownerEdges) {
        for (let i = ownerEdges.length - 1; i >= 0; i--) {
          if (ownerEdges[i].toId === vid) ownerEdges.splice(i, 1);
        }
      }
    }
  }
  graph.nodes.delete(vid);
  graph.adj.delete(vid);
}

/**
 * Chooses where a `RoutingGraph` comes from: the published static street
 * shards when they serve the area being routed, Overpass otherwise.
 *
 * The published dataset is NYC-only, so preferring it unconditionally would
 * answer a Madrid route with Manhattan streets and no route at all. The static
 * graph is therefore attempted only once the manifest's verified support fully
 * covers the requested bbox, and Overpass remains the answer everywhere else —
 * including when the dataset is unreachable, corrupt, or unconfigured.
 *
 * Failure semantics, per the navigation handoff: any static failure discards
 * the whole static attempt and one complete Overpass graph is fetched instead.
 * A caller abort is not a static failure — it is rethrown without launching
 * fallback network work. Building shards are never requested here; they belong
 * to the static prism provider, so loading the streets must not pay for them.
 */

import { fetchRoutingGraph } from "../overpass";
import type { RoutingGraph } from "../routing";
import { buildRoutingGraphFromStreetShards } from "./routingGraphAdapter";
import {
  acquireNavigationSnapshot,
  loadNavigationStreetShard,
  selectNavigationShards,
  type NavigationRequestOptions,
  type NavigationSnapshot,
} from "./remoteNavigation";

function directedEdgeCount(graph: RoutingGraph): number {
  let count = 0;
  for (const edges of graph.adj.values()) count += edges.length;
  return count;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Returns the graph to route on — static NYC streets when they verify, the
 * existing Overpass graph otherwise.
 *
 * The Overpass fallback preserves `fetchRoutingGraph`'s own behavior exactly,
 * including its bbox cache: a static failure costs one Overpass request, and
 * a later identical request is served from that cache without refetching.
 *
 * Pass the route-scoped `options.snapshot` when the caller already acquired
 * one (the building provider binds the same snapshot, so one calculation
 * never mixes generations even if the pointer is promoted mid-flight).
 * `undefined` acquires internally, as before; an explicit `null` skips the
 * static attempt and goes straight to Overpass.
 */
export async function fetchBestRoutingGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
  options?: NavigationRequestOptions & { snapshot?: NavigationSnapshot | null },
): Promise<RoutingGraph> {
  const request: NavigationRequestOptions = { ...options, signal: options?.signal ?? signal };
  const overpass = (): Promise<RoutingGraph> =>
    fetchRoutingGraph(south, west, north, east, request.signal);
  const fallback = (reason: string): Promise<RoutingGraph> => {
    // Reason names shard keys and statuses only — never coordinates or route data.
    if (import.meta.env.DEV) console.log(`[navigation] static streets unavailable (${reason}); using Overpass`);
    return overpass();
  };

  let snapshot: NavigationSnapshot | null;
  if (options?.snapshot !== undefined) {
    snapshot = options.snapshot;
  } else {
    try {
      snapshot = await acquireNavigationSnapshot(request);
    } catch (error) {
      if (isAbort(error, request.signal)) throw error;
      return fallback("snapshot failed");
    }
  }
  // Unconfigured builds take the current path silently, exactly as before —
  // the dataset being off is the default, not a fallback.
  if (!snapshot) return overpass();

  const refs = selectNavigationShards(snapshot.manifest, { south, west, north, east });
  if (!refs) return fallback("outside support");

  try {
    const shards = await Promise.all(
      refs.streets.map((ref) => loadNavigationStreetShard(snapshot, ref, request)),
    );
    const graph = buildRoutingGraphFromStreetShards(shards);
    if (graph.nodes.size === 0) return fallback("empty static selection");
    if (import.meta.env.DEV) {
      console.log(
        "[navigation] using static streets:",
        `generation ${snapshot.generation},`,
        `${shards.length} shards,`,
        `${graph.nodes.size} nodes,`,
        `${directedEdgeCount(graph)} directed edges`,
      );
    }
    return graph;
  } catch (error) {
    if (isAbort(error, request.signal)) throw error;
    return fallback(error instanceof Error ? error.message : "street shard load failed");
  }
}

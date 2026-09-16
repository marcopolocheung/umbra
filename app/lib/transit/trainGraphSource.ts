/**
 * Chooses where a `TrainGraph` comes from: the published shards when they
 * serve the area being routed, Overpass otherwise.
 *
 * The published dataset is NYC-only, so preferring it unconditionally would
 * answer a Tokyo route with Manhattan stations and no transit option at all.
 * The graph is therefore accepted only once it is known to serve the requested
 * bbox, and Overpass remains the answer everywhere else — including when the
 * dataset is unreachable, stale or unconfigured.
 */

import { fetchTrainGraph, type TrainGraph } from "../trainGraph";
import { loadTransitDataset } from "./remoteTransit";
import { buildTrainGraphFromShards } from "./trainGraphAdapter";

/**
 * A transit option needs somewhere to board and somewhere to alight, so one
 * station inside the bbox is not enough to call the area served.
 */
function stationsWithin(
  graph: TrainGraph,
  south: number,
  west: number,
  north: number,
  east: number,
): number {
  let count = 0;
  for (const station of graph.stations.values()) {
    if (
      station.lat >= south &&
      station.lat <= north &&
      station.lon >= west &&
      station.lon <= east
    ) {
      count += 1;
      if (count >= 2) return count;
    }
  }
  return count;
}

/**
 * Returns the graph to route on, or `null` when neither source has one.
 *
 * Coverage can only be checked *after* the download, because the manifest
 * carries no per-shard extent (#388). So a user outside New York pays the full
 * pointer → manifest → shard round trip (~1 s, 1.09 MB) on their **first**
 * route calculation, serially, ahead of the Overpass call that actually answers
 * them — for a graph that is then discarded. Later calculations are cheap: the
 * shards are immutable and the module cache holds them. Per-shard bounds in the
 * manifest are what would remove the first hit as well, and that is #388.
 */
export async function fetchBestTrainGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
): Promise<TrainGraph | null> {
  try {
    const dataset = await loadTransitDataset({ subway: true }, signal);
    if (dataset) {
      const graph = buildTrainGraphFromShards([...dataset.shards.values()]);
      if (graph && stationsWithin(graph, south, west, north, east) >= 2) {
        if (import.meta.env.DEV)
          console.log(
            "[transit] using published shards:",
            `generation ${dataset.generation},`,
            `${graph.stations.size} stations`,
          );
        return graph;
      }
      if (import.meta.env.DEV)
        console.log("[transit] published shards do not serve this bbox; using Overpass");
    }
  } catch (e) {
    // Transit is a non-critical extra: a bad pointer, a failed digest or an
    // offline bucket must cost the walking route nothing.
    if (import.meta.env.DEV) console.warn("[transit] shard load failed, using Overpass:", e);
    if (signal?.aborted) return null;
  }

  return fetchTrainGraph(south, west, north, east, signal);
}

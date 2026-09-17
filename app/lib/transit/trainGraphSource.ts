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
 * The bbox goes to shard selection, so a manifest that publishes per-shard
 * bounds (#388) answers "does this dataset reach here?" from metadata and the
 * 1.09 MB subway shard is never requested outside New York. Against a manifest
 * that predates the field, selection falls back to kind and coverage is checked
 * after the download, as before: `stationsWithin` stays because it is the only
 * check for that case, and because bounds prove a shard's extent overlaps the
 * bbox, not that two stations sit inside it.
 */
export async function fetchBestTrainGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
): Promise<TrainGraph | null> {
  try {
    const dataset = await loadTransitDataset(
      { subway: true },
      { south, west, north, east },
      signal,
    );
    if (dataset) {
      // The manifest, not just the shards: `headwayDates` is what says which
      // calendar morning each table's hours 24+ describe.
      const graph = buildTrainGraphFromShards(
        [...dataset.shards.values()],
        dataset.manifest.headwayDates,
      );
      if (graph && stationsWithin(graph, south, west, north, east) >= 2) {
        // The manifest's own honesty statements travel with the graph, so the
        // card can say what timetable it is quoting (#410).
        graph.provenance = {
          generation: dataset.generation,
          notes: dataset.manifest.notes,
          schedulesAsOf: dataset.manifest.schedulesAsOf,
        };
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

/**
 * Builds a `TrainGraph` out of published transit shards.
 *
 * This replaces `fetchTrainGraph`'s *producer*, not its interface: everything
 * downstream — `trainDijkstra`, `findBestTrainRoute`, `buildTrainDrawData` —
 * consumes the same shape it always has.
 *
 * The cost model stays in **metres** here, using each edge's `distM`, so that
 * switching a route from Overpass to shards changes only where the data came
 * from and the two can be compared on the same O-D pair. The shards' real gift
 * is `medianSec`, `changeSec` and the headway table; spending it is a separate
 * slice, deliberately, so that when routes start differing it is obvious why.
 */

import type { TrainGraph, TrainGraphEdge, TrainMode, TrainStation } from "../trainGraph";
import { TRANSFER_PENALTY_M } from "../trainGraph";
import type { TransitShard } from "./shardContract";

/**
 * GTFS `route_type` → the modes the sun-exposure table prices.
 *
 * Bus (type 3) is deliberately absent. `TRAIN_SUN_EXPOSURE` has no bus figure,
 * and defaulting one to `subway` would claim a bus ride is fully shaded — so
 * bus shards are refused outright until the slice that models them lands.
 */
function routeTypeToMode(type: number): TrainMode | null {
  if (type === 0) return "light_rail"; // tram / streetcar / light rail
  if (type === 1) return "subway";
  if (type === 2) return "light_rail"; // commuter rail: at grade, windowed
  if (type === 12) return "monorail";
  return null;
}

/**
 * Builds the graph from every **subway** shard given.
 *
 * Returns `null` when no usable shard is present, matching `fetchTrainGraph`'s
 * contract that transit is a non-critical extra: the caller keeps its walking
 * route either way.
 */
export function buildTrainGraphFromShards(shards: TransitShard[]): TrainGraph | null {
  const usable = shards.filter((shard) => shard.kind === "subway");
  if (usable.length === 0) return null;

  const stations = new Map<string, TrainStation>();
  const adj = new Map<string, TrainGraphEdge[]>();
  const lineColors = new Map<string, string>();
  const lineNames = new Map<string, string>();
  const lineModes = new Map<string, TrainMode>();

  for (const shard of usable) {
    for (const route of shard.routes) {
      const mode = routeTypeToMode(route.type);
      if (mode === null) continue;
      if (!lineModes.has(route.id)) lineModes.set(route.id, mode);
      if (!lineNames.has(route.id)) lineNames.set(route.id, route.longName || route.shortName);
      // Shards ship a bare RRGGBB; every consumer here expects a CSS colour.
      if (!lineColors.has(route.id) && route.color) lineColors.set(route.id, `#${route.color}`);
    }
  }

  // A shard is self-contained, so it carries the far end of every edge it holds
  // — including bus stops reachable only by a spatial transfer. Those are not
  // routable without their own shard, so the graph is exactly the stops that
  // some edge actually serves.
  const stopIndex = new Map<string, TransitShard["stops"][number]>();
  for (const shard of usable) for (const stop of shard.stops) stopIndex.set(stop.id, stop);

  function ensureStation(id: string): TrainStation | null {
    const existing = stations.get(id);
    if (existing) return existing;
    const stop = stopIndex.get(id);
    if (!stop) return null;
    const station: TrainStation = {
      id: stop.id,
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      lines: [],
    };
    stations.set(id, station);
    adj.set(id, []);
    return station;
  }

  for (const shard of usable) {
    for (const edge of shard.edges) {
      // Routes the shard ships no colour or mode for cannot be drawn or priced.
      if (!lineModes.has(edge.route)) continue;
      const from = ensureStation(edge.from);
      const to = ensureStation(edge.to);
      if (!from || !to) continue;

      // `lines` has no shard equivalent; it is exactly "routes whose edges
      // touch this station", which is what the Overpass producer meant by it.
      if (!from.lines.includes(edge.route)) from.lines.push(edge.route);
      if (!to.lines.includes(edge.route)) to.lines.push(edge.route);

      // Published directed, and published both ways wherever service runs both
      // ways. Synthesising the reverse would invent service on the 14 stop
      // pairs that genuinely run one way only.
      adj.get(edge.from)!.push({
        to: edge.to,
        weight: edge.distM,
        type: "rail",
        line: edge.route,
      });
    }
  }

  for (const shard of usable) {
    for (const transfer of shard.transfers) {
      // Spatial transfers land on bus stops that no loaded edge serves, so they
      // drop out here on their own until bus shards load beside this one.
      if (!stations.has(transfer.from) || !stations.has(transfer.to)) continue;
      adj.get(transfer.from)!.push({
        to: transfer.to,
        weight: TRANSFER_PENALTY_M,
        type: "transfer",
      });
    }
  }

  if (stations.size < 2) return null;
  return { stations, adj, lineColors, lineNames, lineModes };
}

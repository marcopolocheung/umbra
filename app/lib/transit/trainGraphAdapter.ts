/**
 * Builds a `TrainGraph` out of published transit shards.
 *
 * This replaces `fetchTrainGraph`'s *producer*, not its interface: everything
 * downstream — `trainDijkstra`, `findBestTrainRoute`, `buildTrainDrawData` —
 * consumes the same shape it always has.
 *
 * Edges are priced in **seconds**, straight from the feed's scheduled
 * `medianSec`, and a transfer costs the `minSec` the agency publishes for it.
 * The two terms that depend on which route is being boarded — the wait for it,
 * and the feed's `changeSec` for changing to it inside one station — are
 * carried through here and charged by `trainDijkstra`, whose state is
 * `(station, route)` for exactly that reason.
 */

import {
  headwayKey,
  type TrainDayType,
  type TrainGraph,
  type TrainGraphEdge,
  type TrainHeadways,
  type TrainMode,
  type TrainStation,
} from "../trainGraph";
import type { HeadwayDates, TransitShard } from "./shardContract";

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

const DAY_TYPES = new Set<string>(["weekday", "saturday", "sunday"]);

function isDayType(value: unknown): value is TrainDayType {
  return typeof value === "string" && DAY_TYPES.has(value);
}

/**
 * Turns the shards' headway rows and the manifest's `headwayDates` into the
 * table `trainDijkstra` reads.
 *
 * `headwayDates` is what makes hours 24-27 readable at all: it names which day
 * type each table's small hours actually fall on, and without it an overnight
 * boarding goes unpriced rather than being charged some neighbouring morning's
 * frequency. The manifest publishes one block per *dataset*, `subway` beside
 * `bus`, which is not quite the shard's `kind`: a bus shard declares
 * `bus-shard`, and looking that up finds nothing.
 *
 * `coveredHours` is recorded beside the rows because a missing row only means
 * something where the table was looking. The published feed reaches hour 24 and
 * stops, so 1 a.m. is unknown to it, while 10 a.m. is an hour it describes in
 * full and its silence about a route there is a statement.
 */
function buildHeadways(shards: TransitShard[], headwayDates?: HeadwayDates): TrainHeadways {
  const medianSec = new Map<string, number>();
  const coveredHours = new Set<string>();
  const nextDayType = new Map<TrainDayType, TrainDayType>();

  for (const shard of shards) {
    for (const headway of shard.headways) {
      medianSec.set(
        headwayKey(headway.route, headway.direction, headway.dayType, headway.hour),
        headway.medianSec,
      );
      coveredHours.add(`${headway.dayType}|${headway.hour}`);
    }

    const dates = headwayDates?.[shard.kind === "bus-shard" ? "bus" : shard.kind];
    if (!dates || typeof dates === "string") continue;
    for (const [dayType, info] of Object.entries(dates)) {
      if (isDayType(dayType) && isDayType(info?.nextDayType)) {
        nextDayType.set(dayType, info.nextDayType);
      }
    }
  }

  return { medianSec, coveredHours, nextDayType };
}

/**
 * Builds the graph from every **subway** shard given.
 *
 * Returns `null` when no usable shard is present, matching `fetchTrainGraph`'s
 * contract that transit is a non-critical extra: the caller keeps its walking
 * route either way.
 */
export function buildTrainGraphFromShards(
  shards: TransitShard[],
  headwayDates?: HeadwayDates,
): TrainGraph | null {
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
    // Absent stays absent all the way to the router: 0 is a cross-platform
    // interchange and the 33 stations without the field priced no change at
    // all, which is not the same statement (#384).
    if (stop.changeSec !== undefined) station.changeSec = stop.changeSec;
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
        weightSec: edge.medianSec,
        type: "rail",
        line: edge.route,
        // The headway tables are directional, and this is what keys them.
        direction: edge.direction,
        // Absent stays absent: unknown is not "underground" (#393).
        ...(edge.structure ? { structure: edge.structure } : {}),
      });
    }
  }

  for (const shard of usable) {
    for (const transfer of shard.transfers) {
      // Spatial transfers land on bus stops that no loaded edge serves, so they
      // drop out here on their own until bus shards load beside this one.
      if (!stations.has(transfer.from) || !stations.has(transfer.to)) continue;
      // The agency's own published transfer time, not a stand-in.
      adj.get(transfer.from)!.push({
        to: transfer.to,
        weightSec: transfer.minSec,
        type: "transfer",
      });
    }
  }

  if (stations.size < 2) return null;
  return {
    stations,
    adj,
    lineColors,
    lineNames,
    lineModes,
    headways: buildHeadways(usable, headwayDates),
  };
}

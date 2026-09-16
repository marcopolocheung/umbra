/**
 * Shared edge builder: consecutive stop pairs per trip → median schedule
 * time per directed (from, to, route, direction). Used by subway and bus.
 */

import type { GtfsStopTime, GtfsTrip } from "./gtfs";
import type { RouteEdge } from "./model";
import { haversineMeters, median } from "./util";

export interface EdgeInput {
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  /** Node id → coords, for segment distances. */
  nodes: Map<string, { lat: number; lon: number }>;
  /** Raw GTFS stop_id → node id (parent mapping, identity, …). Null skips. */
  mapStop: (stopId: string) => string | null;
  routeKey: (trip: GtfsTrip) => string;
  maxKmh: number;
  minSamples?: number;
}

export interface EdgeStats {
  tripsSeen: number;
  pairsSeen: number;
  droppedSameNode: number;
  droppedNonPositive: number;
  droppedFast: number;
  droppedSparse: number;
  edgesKept: number;
}

export function buildEdges(input: EdgeInput): { edges: RouteEdge[]; stats: EdgeStats } {
  const minSamples = input.minSamples ?? 3;
  const byTrip = new Map<string, GtfsStopTime[]>();
  for (const entry of input.stopTimes) {
    const list = byTrip.get(entry.tripId) ?? [];
    list.push(entry);
    byTrip.set(entry.tripId, list);
  }
  const samples = new Map<string, { times: number[]; distM: number; direction: number; route: string; from: string; to: string }>();
  const stats: EdgeStats = {
    tripsSeen: 0,
    pairsSeen: 0,
    droppedSameNode: 0,
    droppedNonPositive: 0,
    droppedFast: 0,
    droppedSparse: 0,
    edgesKept: 0,
  };
  for (const trip of input.trips) {
    const list = byTrip.get(trip.tripId);
    if (!list) continue;
    stats.tripsSeen += 1;
    list.sort((a, b) => a.sequence - b.sequence);
    const route = input.routeKey(trip);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as GtfsStopTime;
      const curr = list[i] as GtfsStopTime;
      const from = input.mapStop(prev.stopId);
      const to = input.mapStop(curr.stopId);
      if (from === null || to === null) continue;
      stats.pairsSeen += 1;
      if (from === to) {
        stats.droppedSameNode += 1;
        continue;
      }
      const dt = curr.arrivalSec - prev.departureSec;
      if (!(dt > 0)) {
        stats.droppedNonPositive += 1;
        continue;
      }
      const a = input.nodes.get(from);
      const b = input.nodes.get(to);
      if (!a || !b) continue;
      const distM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      if (dt > 0 && (distM / dt) * 3.6 > input.maxKmh) {
        stats.droppedFast += 1;
        continue;
      }
      const key = `${from}\t${to}\t${route}\t${trip.direction}`;
      const slot = samples.get(key) ?? { times: [], distM, direction: trip.direction, route, from, to };
      slot.times.push(dt);
      samples.set(key, slot);
    }
  }
  const edges: RouteEdge[] = [];
  for (const slot of samples.values()) {
    if (slot.times.length < minSamples) {
      stats.droppedSparse += 1;
      continue;
    }
    edges.push({
      from: slot.from,
      to: slot.to,
      route: slot.route,
      direction: slot.direction,
      medianSec: Math.round(median(slot.times)),
      trips: slot.times.length,
      distM: Math.round(slot.distM),
    });
    stats.edgesKept += 1;
  }
  edges.sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : a.from < b.from ? -1 : 1,
  );
  return { edges, stats };
}

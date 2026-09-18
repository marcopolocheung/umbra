/**
 * Shared edge builder: consecutive stop pairs per trip → median schedule
 * time per directed (from, to, route, direction). Used by subway and bus.
 */

import type { GtfsStopTime, GtfsTrip } from "./gtfs";
import type { RouteEdge } from "./model";
import { encodePolyline, type ShapeSlice, sliceEdge } from "./shapeSlice";
import { cumulativeMeters, haversineMeters, type LatLon, median } from "./util";

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
  /**
   * Shape points by the key `shapeKey` returns. Given, each edge is sliced out
   * of its own shape and ships that slice; omitted, edges carry no geometry and
   * `distM` stays the straight-line haversine.
   */
  shapes?: Map<string, LatLon[]>;
  /**
   * Which shape a trip runs on. `shape_id` is unique only within one feed and
   * the bus graph pools six, so the pooled caller namespaces the key; the
   * default suits a single-feed caller.
   */
  shapeKey?: (trip: GtfsTrip) => string;
}

export interface EdgeStats {
  tripsSeen: number;
  pairsSeen: number;
  droppedSameNode: number;
  droppedNonPositive: number;
  droppedFast: number;
  droppedSparse: number;
  edgesKept: number;
  /** Kept edges shipping a sliced polyline. */
  geomShipped: number;
  /**
   * Kept edges whose shape doubled back between the two stops, so no sub-path
   * "between them" exists. They keep the straight chord. 32 of 24,354 in NYC.
   */
  geomUnsliced: number;
}

export function buildEdges(input: EdgeInput): { edges: RouteEdge[]; stats: EdgeStats } {
  const minSamples = input.minSamples ?? 3;
  const byTrip = new Map<string, GtfsStopTime[]>();
  for (const entry of input.stopTimes) {
    const list = byTrip.get(entry.tripId) ?? [];
    list.push(entry);
    byTrip.set(entry.tripId, list);
  }
  const samples = new Map<
    string,
    {
      times: number[];
      distM: number;
      direction: number;
      route: string;
      from: string;
      to: string;
      /** Every shape serving this edge; one is chosen deterministically below. */
      shapeKeys: Set<string>;
    }
  >();
  const shapeKey = input.shapeKey ?? ((trip: GtfsTrip): string => trip.shapeId);
  const cumulatives = new Map<string, number[]>();
  const stats: EdgeStats = {
    tripsSeen: 0,
    pairsSeen: 0,
    droppedSameNode: 0,
    droppedNonPositive: 0,
    droppedFast: 0,
    droppedSparse: 0,
    edgesKept: 0,
    geomShipped: 0,
    geomUnsliced: 0,
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
      const slot = samples.get(key) ?? {
        times: [],
        distM,
        direction: trip.direction,
        route,
        from,
        to,
        shapeKeys: new Set<string>(),
      };
      slot.times.push(dt);
      slot.shapeKeys.add(shapeKey(trip));
      samples.set(key, slot);
    }
  }
  const edges: RouteEdge[] = [];
  for (const slot of samples.values()) {
    if (slot.times.length < minSamples) {
      stats.droppedSparse += 1;
      continue;
    }
    const edge: RouteEdge = {
      from: slot.from,
      to: slot.to,
      route: slot.route,
      direction: slot.direction,
      medianSec: Math.round(median(slot.times)),
      trips: slot.times.length,
      distM: Math.round(slot.distM),
    };
    const slice = sliceFor(input, cumulatives, slot);
    if (slice === "unsliced") {
      stats.geomUnsliced += 1;
    } else if (slice) {
      edge.distM = Math.round(slice.alongTrackM);
      if (slice.interior.length > 0) {
        edge.geom = encodePolyline(slice.interior);
        stats.geomShipped += 1;
      }
    }
    edges.push(edge);
    stats.edgesKept += 1;
  }
  edges.sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : a.from < b.from ? -1 : 1,
  );
  return { edges, stats };
}

/**
 * The chosen shape's slice for one edge, `"unsliced"` when the shape doubles
 * back, or `undefined` when there is no shape to slice from.
 *
 * Most edges are served by several shapes — 74.9% on subway, 38.9-59.0% across
 * the bus feeds — which is exactly what sank per-route geometry in #385. It does
 * not sink this: between two adjacent stops every pattern runs the same track,
 * so the lowest shape key is as good as any and picking it by sort keeps the
 * build reproducible.
 *
 * The stops projected are the graph's own nodes, not the raw GTFS stops, because
 * that is what `distM` measures and what the client draws from. For subway they
 * are parent stations, whose coordinates the feed gives identically to their
 * directional children, so the projection lands in the same place either way.
 */
function sliceFor(
  input: EdgeInput,
  cumulatives: Map<string, number[]>,
  slot: { from: string; to: string; shapeKeys: Set<string> },
): ShapeSlice | "unsliced" | undefined {
  const shapes = input.shapes;
  if (!shapes) return undefined;
  const chosen = [...slot.shapeKeys].sort()[0];
  if (chosen === undefined) return undefined;
  const shape = shapes.get(chosen);
  if (!shape || shape.length < 2) return undefined;
  const from = input.nodes.get(slot.from);
  const to = input.nodes.get(slot.to);
  if (!from || !to) return undefined;
  let cum = cumulatives.get(chosen);
  if (!cum) {
    cum = cumulativeMeters(shape);
    cumulatives.set(chosen, cum);
  }
  return sliceEdge(shape, cum, from, to) ?? "unsliced";
}

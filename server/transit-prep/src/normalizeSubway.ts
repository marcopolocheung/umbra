/**
 * Step 3: normalize the subway feed. Nodes are parent stations
 * (location_type=1); directional children (101N/101S) map up to parents.
 * Transfers come from transfers.txt; nothing is inferred spatially here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEdges, type EdgeStats } from "./edges";
import {
  loadCalendar,
  loadCalendarDates,
  loadRoutes,
  loadShapes,
  loadStopTimes,
  loadStops,
  loadTransfers,
  loadTrips,
  type GtfsTrip,
} from "./gtfs";
import { computeHeadways } from "./headways";
import type { RepresentativeDates } from "./serviceCalendar";
import type {
  FeedVersion,
  HeadwayRow,
  RouteEdge,
  RouteInfo,
  ShapeMap,
  StopNode,
  TransferEdge,
} from "./model";
import { simplifyCapped } from "./simplify";

export const SUBWAY_MAX_KMH = 80;
export const SUBWAY_SHAPE_EPS_M = 15;
export const SUBWAY_SHAPE_CAP = 500;
export const SUBWAY_TRANSFER_FALLBACK_SEC = 180;

export interface SubwayNormalized {
  kind: "subway";
  feed: FeedVersion;
  stops: StopNode[];
  edges: RouteEdge[];
  routes: RouteInfo[];
  shapes: ShapeMap;
  headways: HeadwayRow[];
  transfers: TransferEdge[];
  stats: {
    parents: number;
    children: number;
    orphanStops: number;
    edges: EdgeStats;
    shapesKept: number;
    representativeDates: RepresentativeDates;
    unrepresentedServices: string[];
    sparseHeadwayBuckets: number;
  };
}

const routeKey = (trip: GtfsTrip): string => trip.routeId;

export async function normalizeSubway(
  root: string,
  workDir: string,
  feed: FeedVersion,
  referenceDate: string,
): Promise<SubwayNormalized> {
  const read = (file: string): Promise<string> => readFile(join(root, workDir, file), "utf8");
  const { stops } = loadStops(await read("stops.txt"));
  const { routes } = loadRoutes(await read("routes.txt"));
  const { trips } = loadTrips(await read("trips.txt"));
  const { stopTimes } = loadStopTimes(await read("stop_times.txt"));
  const { calendar } = loadCalendar(await read("calendar.txt"));
  const { dates } = loadCalendarDates(await read("calendar_dates.txt"));
  const { shapes } = loadShapes(await read("shapes.txt"));
  const { transfers } = loadTransfers(await read("transfers.txt"));

  const nodes = new Map<string, StopNode>();
  const childToParent = new Map<string, string>();
  let orphans = 0;
  for (const stop of stops) {
    if (stop.locationType === 1) {
      nodes.set(`subway:${stop.id}`, { id: `subway:${stop.id}`, name: stop.name, lat: stop.lat, lon: stop.lon });
      childToParent.set(stop.id, stop.id);
    }
  }
  let children = 0;
  for (const stop of stops) {
    if (stop.locationType === 1) continue;
    children += 1;
    if (stop.parent && nodes.has(`subway:${stop.parent}`)) {
      childToParent.set(stop.id, stop.parent);
    } else {
      // No usable parent: keep the stop as its own node rather than dropping
      // scheduled service. Counted so drift shows up in stats.
      orphans += 1;
      nodes.set(`subway:${stop.id}`, { id: `subway:${stop.id}`, name: stop.name, lat: stop.lat, lon: stop.lon });
      childToParent.set(stop.id, stop.id);
    }
  }
  const coords = new Map<string, { lat: number; lon: number }>();
  for (const [id, node] of nodes) coords.set(id, { lat: node.lat, lon: node.lon });

  const { edges, stats: edgeStats } = buildEdges({
    trips,
    stopTimes,
    nodes: coords,
    mapStop: (stopId) => {
      const parent = childToParent.get(stopId);
      return parent === undefined ? null : `subway:${parent}`;
    },
    routeKey,
    maxKmh: SUBWAY_MAX_KMH,
  });

  const transferEdges: TransferEdge[] = [];
  for (const transfer of transfers) {
    // transfer_type 3 is "not possible". validate throws on it; skipping here
    // too keeps the guarantee local, since normalize runs without validate.
    if (transfer.transferType === 3) continue;
    const from = childToParent.get(transfer.fromStopId);
    const to = childToParent.get(transfer.toStopId);
    if (from === undefined || to === undefined || from === to) continue;
    transferEdges.push({
      from: `subway:${from}`,
      to: `subway:${to}`,
      minSec: transfer.minTransferSec > 0 ? transfer.minTransferSec : SUBWAY_TRANSFER_FALLBACK_SEC,
      kind: "gtfs",
    });
  }

  // Representative shape per route+direction: the shape_id with most trips.
  const shapeVotes = new Map<string, Map<string, number>>();
  for (const trip of trips) {
    const key = `${trip.routeId}:${trip.direction}`;
    const votes = shapeVotes.get(key) ?? new Map<string, number>();
    votes.set(trip.shapeId, (votes.get(trip.shapeId) ?? 0) + 1);
    shapeVotes.set(key, votes);
  }
  const shapeMap: ShapeMap = {};
  for (const [key, votes] of shapeVotes) {
    let best = "";
    let bestVotes = -1;
    for (const [shapeId, count] of votes) {
      if (count > bestVotes) {
        best = shapeId;
        bestVotes = count;
      }
    }
    const points = shapes.get(best);
    if (!points) continue;
    shapeMap[key] = simplifyCapped(points, SUBWAY_SHAPE_EPS_M, SUBWAY_SHAPE_CAP).map(
      (p) => [p.lon, p.lat],
    );
  }

  const { headways, representativeDates, unrepresentedServices, sparseBuckets } = computeHeadways({
    trips,
    stopTimes,
    calendar,
    dates,
    referenceDate,
    routeKey,
  });

  return {
    kind: "subway",
    feed,
    stops: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges,
    routes: routes
      .map((route) => ({
        id: route.id,
        shortName: route.shortName || route.id,
        longName: route.longName,
        type: route.type,
        color: route.color,
        textColor: route.textColor,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    shapes: shapeMap,
    headways,
    transfers: transferEdges,
    stats: {
      parents: nodes.size - orphans,
      children,
      orphanStops: orphans,
      edges: edgeStats,
      shapesKept: Object.keys(shapeMap).length,
      representativeDates,
      unrepresentedServices,
      sparseHeadwayBuckets: sparseBuckets,
    },
  };
}

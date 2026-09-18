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
  StopNode,
  TransferEdge,
} from "./model";

export const SUBWAY_MAX_KMH = 80;
export const SUBWAY_TRANSFER_FALLBACK_SEC = 180;

export interface SubwayNormalized {
  kind: "subway";
  feed: FeedVersion;
  stops: StopNode[];
  edges: RouteEdge[];
  routes: RouteInfo[];
  headways: HeadwayRow[];
  transfers: TransferEdge[];
  stats: {
    parents: number;
    children: number;
    orphanStops: number;
    edges: EdgeStats;
    /** Parent stations given a change cost by a self-transfer row. */
    stationsWithChangeCost: number;
    /**
     * Stations served by more than one route that the feed prices no change
     * for. Changing lines there is still free; the count is the honest size of
     * the remaining gap.
     */
    multiRouteStationsWithoutChangeCost: number;
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
  const { transfers } = loadTransfers(await read("transfers.txt"));
  const { shapes } = loadShapes(await read("shapes.txt"));

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
  // Self-transfers (from === to) price a change between lines sharing this
  // station. They are not edges — both ends are the same node — so without
  // this they were dropped entirely and every in-station change was free.
  let stationsWithChangeCost = 0;
  for (const transfer of transfers) {
    if (transfer.fromStopId !== transfer.toStopId || transfer.transferType === 3) continue;
    const parent = childToParent.get(transfer.fromStopId);
    const node = parent === undefined ? undefined : nodes.get(`subway:${parent}`);
    if (!node || node.changeSec !== undefined) continue;
    // Verbatim, including 0: a cross-platform change genuinely costs nothing.
    node.changeSec = transfer.minTransferSec;
    stationsWithChangeCost += 1;
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
    shapes,
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

  const { headways, representativeDates, unrepresentedServices, sparseBuckets } = computeHeadways({
    trips,
    stopTimes,
    calendar,
    dates,
    referenceDate,
    routeKey,
  });

  const routesAt = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const node of [edge.from, edge.to]) {
      const seen = routesAt.get(node) ?? new Set<string>();
      seen.add(edge.route);
      routesAt.set(node, seen);
    }
  }
  let multiRouteStationsWithoutChangeCost = 0;
  for (const node of nodes.values()) {
    if (node.changeSec === undefined && (routesAt.get(node.id)?.size ?? 0) > 1) {
      multiRouteStationsWithoutChangeCost += 1;
    }
  }

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
    headways,
    transfers: transferEdges,
    stats: {
      parents: nodes.size - orphans,
      children,
      orphanStops: orphans,
      edges: edgeStats,
      stationsWithChangeCost,
      multiRouteStationsWithoutChangeCost,
      representativeDates,
      unrepresentedServices,
      sparseHeadwayBuckets: sparseBuckets,
    },
  };
}

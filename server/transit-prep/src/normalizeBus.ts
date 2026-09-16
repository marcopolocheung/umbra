/**
 * Step 4: normalize the 6 bus feeds into one pooled graph, sharded per
 * borough at build time. Stops dedupe by stop_id (validate asserts shared
 * ids agree on coords); route variants collapse to display routes on
 * route_short_name. Bus–bus transfers are free via shared stop ids.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEdges, type EdgeStats } from "./edges";
import {
  loadCalendar,
  loadCalendarDates,
  loadRoutes,
  loadStopTimes,
  loadStops,
  loadTrips,
  type GtfsCalendar,
  type GtfsCalendarDate,
  type GtfsStopTime,
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
} from "./model";

export const BUS_MAX_KMH = 60;

export interface BusNormalized {
  kind: "bus";
  feeds: FeedVersion[];
  stops: StopNode[];
  edges: RouteEdge[];
  routes: RouteInfo[];
  headways: HeadwayRow[];
  stats: {
    uniqueStops: number;
    stopRows: number;
    nameVariants: number;
    variants: number;
    displayRoutes: number;
    pooledTrips: number;
    edges: EdgeStats;
    representativeDates: RepresentativeDates;
    unrepresentedServices: string[];
    sparseHeadwayBuckets: number;
  };
}

export async function normalizeBus(
  root: string,
  workDirs: { feedId: string; dir: string }[],
  feeds: FeedVersion[],
  referenceDate: string,
): Promise<BusNormalized> {
  const registry = new Map<string, StopNode & { feeds: string[] }>();
  const routeById = new Map<string, { display: string; longName: string; type: number; color: string; textColor: string }>();
  // Priority order: NYCT borough feeds first, BusCo last, so first-wins
  // dedup keeps borough-surveyed coords for shared stops (validate bounds
  // the disagreement at SHARED_STOP_TOLERANCE_M).
  const ordered = [...workDirs].sort(
    (a, b) => (a.feedId === "bus-busco" ? 1 : 0) - (b.feedId === "bus-busco" ? 1 : 0),
  );
  let stopRows = 0;
  let nameVariants = 0;
  const trips: GtfsTrip[] = [];
  const stopTimes: GtfsStopTime[] = [];
  const calendar: GtfsCalendar[] = [];
  const dates: GtfsCalendarDate[] = [];
  const tripFeedOf = new Map<string, string>();

  for (const { feedId, dir } of ordered) {
    const read = (file: string): Promise<string> => readFile(join(root, dir, file), "utf8");
    const loaded = {
      stops: loadStops(await read("stops.txt")),
      routes: loadRoutes(await read("routes.txt")),
      trips: loadTrips(await read("trips.txt")),
      stopTimes: loadStopTimes(await read("stop_times.txt")),
      calendar: loadCalendar(await read("calendar.txt")),
      dates: loadCalendarDates(await read("calendar_dates.txt")),
    };
    // Route tables union by route_id (validate rejects conflicting rows).
    for (const route of loaded.routes.routes) {
      if (!routeById.has(route.id)) {
        routeById.set(route.id, {
          display: route.shortName || route.id,
          longName: route.longName,
          type: route.type,
          color: route.color,
          textColor: route.textColor,
        });
      }
    }
    for (const stop of loaded.stops.stops) {
      stopRows += 1;
      const id = `bus:${stop.id}`;
      const known = registry.get(id);
      if (!known) {
        registry.set(id, { id, name: stop.name, lat: stop.lat, lon: stop.lon, feeds: [feedId] });
      } else {
        if (!known.feeds.includes(feedId)) known.feeds.push(feedId);
        if (known.name !== stop.name) nameVariants += 1;
      }
    }
    // Loop-push: spread of million-element arrays blows the call stack.
    for (const trip of loaded.trips.trips) {
      trips.push(trip);
      tripFeedOf.set(trip.tripId, feedId);
    }
    for (const entry of loaded.stopTimes.stopTimes) stopTimes.push(entry);
    for (const service of loaded.calendar.calendar) calendar.push(service);
    for (const date of loaded.dates.dates) dates.push(date);
  }

  const coords = new Map<string, { lat: number; lon: number }>();
  for (const [id, node] of registry) coords.set(id, { lat: node.lat, lon: node.lon });
  const displayOf = (routeId: string): string => routeById.get(routeId)?.display ?? routeId;
  const routeKey = (trip: GtfsTrip): string => displayOf(trip.routeId);

  const { edges, stats: edgeStats } = buildEdges({
    trips,
    stopTimes,
    nodes: coords,
    mapStop: (stopId) => (registry.has(`bus:${stopId}`) ? `bus:${stopId}` : null),
    routeKey,
    maxKmh: BUS_MAX_KMH,
  });

  const { headways, representativeDates, unrepresentedServices, sparseBuckets } = computeHeadways({
    trips,
    stopTimes,
    calendar,
    dates,
    referenceDate,
    routeKey,
  });

  const byDisplay = new Map<string, { variants: number; info: { longName: string; type: number; color: string; textColor: string } }>();
  for (const info of routeById.values()) {
    const known = byDisplay.get(info.display);
    if (known) known.variants += 1;
    else byDisplay.set(info.display, { variants: 1, info });
  }
  const displayRoutes: RouteInfo[] = [...byDisplay.entries()].map(([display, { variants, info }]) => ({
    id: display,
    shortName: display,
    longName: info.longName,
    type: info.type,
    color: info.color,
    textColor: info.textColor,
    variants,
  })).sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    kind: "bus",
    feeds,
    stops: [...registry.values()]
      .map((node) => ({ ...node, feeds: [...node.feeds].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges,
    routes: displayRoutes,
    headways,
    stats: {
      uniqueStops: registry.size,
      stopRows,
      nameVariants,
      variants: routeById.size,
      displayRoutes: displayRoutes.length,
      pooledTrips: trips.length,
      edges: edgeStats,
      representativeDates,
      unrepresentedServices,
      sparseHeadwayBuckets: sparseBuckets,
    },
  };
}

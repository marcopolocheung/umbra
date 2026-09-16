/**
 * Step 2: validate every feed against pinned schemas and referential
 * integrity. Any failure throws; success writes evidence/validate-<ts>.json
 * with the counts later steps assert against.
 *
 * Observed upstream facts pinned here (fail on drift, not silent skew):
 * - subway shapes order: shape_id,sequence,lat,lon; bus: shape_id,lat,lon,sequence
 * - bus trips carry block_id; subway trips do not
 * - bus routes.txt is byte-identical across all 6 borough feeds
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertExactHeader, headerBody, parseCsv } from "./csv";
import {
  loadCalendar,
  loadCalendarDates,
  loadRoutes,
  loadShapes,
  loadStopTimes,
  loadStops,
  loadTransfers,
  loadTrips,
  type GtfsStop,
} from "./gtfs";
import { checkWorkTrees, readReceipts } from "./receipts";
import { FEED_SOURCES } from "./sources";
import { haversineMeters, requireRoot, writeJson } from "./util";

// NYC service area with margin (JFK east to Suffern-west coverage is not
// needed; LIRR/MNR are out of scope and absent from these feeds).
const LAT_MIN = 40.4;
const LAT_MAX = 41.1;
const LON_MIN = -74.5;
const LON_MAX = -73.4;

const STOPS_SUBWAY = ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"];
const STOPS_BUS = ["stop_id", "stop_name", "stop_desc", "stop_lat", "stop_lon", "zone_id", "stop_url", "location_type", "parent_station"];
// MTA Bus Co. ships a minimal stops table and a routes table with route_url.
const STOPS_BUSCO = ["stop_id", "stop_name", "stop_desc", "stop_lat", "stop_lon"];
const ROUTES_SUBWAY = ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color", "route_sort_order"];
const ROUTES_BUS = ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_color", "route_text_color"];
const ROUTES_BUSCO = ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color"];
const TRIPS_SUBWAY = ["route_id", "trip_id", "service_id", "trip_headsign", "direction_id", "shape_id"];
const TRIPS_BUS = ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "block_id", "shape_id"];
const STOP_TIMES_SUBWAY = ["trip_id", "stop_id", "arrival_time", "departure_time", "stop_sequence"];
const STOP_TIMES_BUS = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type", "timepoint"];
const CALENDAR = ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"];
const CALENDAR_DATES = ["service_id", "date", "exception_type"];
const SHAPES_SUBWAY = ["shape_id", "shape_pt_sequence", "shape_pt_lat", "shape_pt_lon"];
const SHAPES_BUS = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"];
const TRANSFERS = ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"];

export interface FeedValidation {
  id: string;
  stops: number;
  routes: number;
  trips: number;
  stopTimes: number;
  shapes: number;
  shapePoints: number;
  transfers: number;
  calendarServices: number;
  calendarExceptions: number;
  parentStations: number;
}

export interface ValidationReport {
  at: string;
  feeds: FeedValidation[];
  busRouteIds: number;
  busUniqueStops: number;
  busStopRows: number;
  /** Same stop_id, different coords across feeds (warning level, see below). */
  sharedStopConflicts: { stopId: string; feeds: string[]; disagreementM: number }[];
  maxSharedDisagreementM: number;
}

/**
 * Same stop_id may be surveyed metres apart by different agency pipelines
 * (NYCT borough feeds vs BusCo: typically <25 m; worst observed 101 m for
 * stop 404028, named W 220 ST by NYCT but W 219 ST by BusCo — adjacent
 * blocks, one shared id). Below this, the borough feed wins and the drift
 * is recorded. Above it, the id is probably reused for unrelated stops.
 */
export const SHARED_STOP_TOLERANCE_M = 150;

async function readHeader(root: string, workDir: string, file: string): Promise<string[]> {
  const text = await readFile(join(root, workDir, file), "utf8");
  return headerBody(parseCsv(text)).header;
}

function checkStops(stops: GtfsStop[], feedId: string): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const stop of stops) {
    if (seen.has(stop.id)) dupes.push(stop.id);
    seen.add(stop.id);
    if (stop.lat < LAT_MIN || stop.lat > LAT_MAX || stop.lon < LON_MIN || stop.lon > LON_MAX) {
      throw new Error(`${feedId} stops.txt: ${stop.id} outside NYC bbox (${stop.lat},${stop.lon})`);
    }
    if (stop.id === "") throw new Error(`${feedId} stops.txt: empty stop_id`);
  }
  if (dupes.length > 0) {
    throw new Error(`${feedId} stops.txt: duplicate stop_ids: ${dupes.slice(0, 10).join(", ")}`);
  }
}

export async function validate(): Promise<ValidationReport> {
  const root = requireRoot();
  await checkWorkTrees(await readReceipts());
  const report: ValidationReport = {
    at: new Date().toISOString(),
    feeds: [],
    busRouteIds: 0,
    busUniqueStops: 0,
    busStopRows: 0,
    sharedStopConflicts: [],
    maxSharedDisagreementM: 0,
  };
  const busRouteRows = new Map<string, { feed: string; row: string }>();
  const busStopCoords = new Map<string, { lat: number; lon: number; feeds: string[] }>();

  for (const source of FEED_SOURCES) {
    const dir = source.workDir;
    const read = (file: string): Promise<string> => readFile(join(root, dir, file), "utf8");
    const isSubway = source.kind === "subway";
    const isBusco = source.id === "bus-busco";
    assertExactHeader(`${source.id}/stops.txt`, await readHeader(root, dir, "stops.txt"), isSubway ? STOPS_SUBWAY : isBusco ? STOPS_BUSCO : STOPS_BUS);
    assertExactHeader(`${source.id}/routes.txt`, await readHeader(root, dir, "routes.txt"), isSubway ? ROUTES_SUBWAY : isBusco ? ROUTES_BUSCO : ROUTES_BUS);
    assertExactHeader(`${source.id}/trips.txt`, await readHeader(root, dir, "trips.txt"), isSubway ? TRIPS_SUBWAY : TRIPS_BUS);
    assertExactHeader(`${source.id}/stop_times.txt`, await readHeader(root, dir, "stop_times.txt"), isSubway ? STOP_TIMES_SUBWAY : STOP_TIMES_BUS);
    assertExactHeader(`${source.id}/calendar.txt`, await readHeader(root, dir, "calendar.txt"), CALENDAR);
    assertExactHeader(`${source.id}/calendar_dates.txt`, await readHeader(root, dir, "calendar_dates.txt"), CALENDAR_DATES);
    assertExactHeader(`${source.id}/shapes.txt`, await readHeader(root, dir, "shapes.txt"), isSubway ? SHAPES_SUBWAY : SHAPES_BUS);
    if (isSubway) {
      assertExactHeader(`${source.id}/transfers.txt`, await readHeader(root, dir, "transfers.txt"), TRANSFERS);
    }

    const { stops, problems: stopProblems } = loadStops(await read("stops.txt"));
    const { routes, problems: routeProblems } = loadRoutes(await read("routes.txt"));
    const { trips, problems: tripProblems } = loadTrips(await read("trips.txt"));
    const { stopTimes, problems: timeProblems } = loadStopTimes(await read("stop_times.txt"));
    const { calendar, problems: calendarProblems } = loadCalendar(await read("calendar.txt"));
    const { dates, problems: dateProblems } = loadCalendarDates(await read("calendar_dates.txt"));
    const { shapes, problems: shapeProblems } = loadShapes(await read("shapes.txt"));
    const loaderProblems = [...stopProblems, ...routeProblems, ...tripProblems, ...timeProblems, ...calendarProblems, ...dateProblems, ...shapeProblems];
    if (loaderProblems.length > 0) {
      const sample = loaderProblems.slice(0, 10).map((p) => `${p.file}:${p.row} ${p.message}`);
      throw new Error(`${source.id}: ${loaderProblems.length} row problems:\n${sample.join("\n")}`);
    }
    checkStops(stops, source.id);

    // Referential integrity. Services may be defined by calendar.txt rows,
    // by calendar_dates.txt exceptions alone (school-holiday variants), or both.
    const stopIds = new Set(stops.map((s) => s.id));
    const routeIds = new Set(routes.map((r) => r.id));
    const tripIds = new Set(trips.map((t) => t.tripId));
    const serviceIds = new Set([
      ...calendar.map((c) => c.serviceId),
      ...dates.map((d) => d.serviceId),
    ]);
    let bad = 0;
    for (const trip of trips) {
      if (!routeIds.has(trip.routeId)) bad += 1;
      if (!serviceIds.has(trip.serviceId)) bad += 1;
      if (!shapes.has(trip.shapeId)) bad += 1;
    }
    if (bad > 0) throw new Error(`${source.id}: ${bad} trip references dangle`);
    const byTrip = new Map<string, typeof stopTimes>();
    for (const entry of stopTimes) {
      if (!tripIds.has(entry.tripId)) bad += 1;
      if (!stopIds.has(entry.stopId)) bad += 1;
      const list = byTrip.get(entry.tripId) ?? [];
      list.push(entry);
      byTrip.set(entry.tripId, list);
    }
    if (bad > 0) throw new Error(`${source.id}: ${bad} stop_time references dangle`);
    for (const [tripId, list] of byTrip) {
      list.sort((a, b) => a.sequence - b.sequence);
      for (let i = 1; i < list.length; i += 1) {
        const prev = list[i - 1] as (typeof list)[number];
        const curr = list[i] as (typeof list)[number];
        if (curr.sequence === prev.sequence) {
          throw new Error(`${source.id}: trip ${tripId} repeats stop_sequence ${curr.sequence}`);
        }
        if (curr.departureSec < prev.arrivalSec) {
          throw new Error(`${source.id}: trip ${tripId} runs backwards at sequence ${curr.sequence}`);
        }
      }
    }
    if (isSubway) {
      const { transfers, problems } = loadTransfers(await read("transfers.txt"));
      if (problems.length > 0) throw new Error(`${source.id}: transfers.txt problems`);
      for (const transfer of transfers) {
        if (!stopIds.has(transfer.fromStopId) || !stopIds.has(transfer.toStopId)) {
          throw new Error(`${source.id}: transfer references unknown stop`);
        }
      }
      report.feeds.push({
        id: source.id,
        stops: stops.length,
        routes: routes.length,
        trips: trips.length,
        stopTimes: stopTimes.length,
        shapes: shapes.size,
        shapePoints: [...shapes.values()].reduce((n, list) => n + list.length, 0),
        transfers: transfers.length,
        calendarServices: calendar.length,
        calendarExceptions: dates.length,
        parentStations: stops.filter((s) => s.locationType === 1).length,
      });
    } else {
      // Route tables union by route_id across borough feeds (NYCT ships one
      // shared table; BusCo ships its own disjoint table). Same id with
      // different rows means the union strategy needs a conscious rethink.
      for (const route of routes) {
        const row = JSON.stringify(route);
        const known = busRouteRows.get(route.id);
        if (known && known.row !== row) {
          throw new Error(`route_id ${route.id} differs between ${known.feed} and ${source.id}`);
        }
        if (!known) busRouteRows.set(route.id, { feed: source.id, row });
      }
      for (const stop of stops) {
        report.busStopRows += 1;
        const known = busStopCoords.get(stop.id);
        if (!known) {
          busStopCoords.set(stop.id, { lat: stop.lat, lon: stop.lon, feeds: [source.id] });
        } else {
          known.feeds.push(source.id);
          const disagreementM = haversineMeters(known.lat, known.lon, stop.lat, stop.lon);
          if (disagreementM > 1e-6) {
            report.sharedStopConflicts.push({ stopId: stop.id, feeds: [...known.feeds], disagreementM: Math.round(disagreementM * 10) / 10 });
            report.maxSharedDisagreementM = Math.max(report.maxSharedDisagreementM, disagreementM);
            if (disagreementM > SHARED_STOP_TOLERANCE_M) {
              throw new Error(`stop ${stop.id} is ${Math.round(disagreementM)} m apart in ${known.feeds.join(",")} — shared id, different physical stops?`);
            }
          }
        }
      }
      report.feeds.push({
        id: source.id,
        stops: stops.length,
        routes: routes.length,
        trips: trips.length,
        stopTimes: stopTimes.length,
        shapes: shapes.size,
        shapePoints: [...shapes.values()].reduce((n, list) => n + list.length, 0),
        transfers: 0,
        calendarServices: calendar.length,
        calendarExceptions: dates.length,
        parentStations: 0,
      });
    }
  }

  // Cross-feed pins: shared-stop drift is recorded above (fatal past tolerance).
  report.busRouteIds = busRouteRows.size;
  report.busUniqueStops = busStopCoords.size;

  const path = join(root, "evidence", `validate-${Date.now()}.json`);
  await writeJson(path, report);
  return report;
}

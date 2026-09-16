/**
 * Typed GTFS Static loaders. Every loader takes parsed CSV rows and returns
 * records plus a list of validation problems; callers decide whether a
 * problem is fatal (validate) or filtered (normalize).
 *
 * Loaders stream rows (no retained matrix) and intern repeated ids, because
 * the largest file (Brooklyn stop_times, 155 MB / ~2.3 M rows) otherwise
 * exhausts the default heap on parsing alone.
 */

import { cell, eachCsvRow, requireColumns } from "./csv";

export interface Problem {
  file: string;
  row: number;
  message: string;
}

export interface GtfsStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  locationType: number;
  parent: string;
}

export interface GtfsRoute {
  id: string;
  shortName: string;
  longName: string;
  type: number;
  color: string;
  textColor: string;
}

export interface GtfsTrip {
  routeId: string;
  tripId: string;
  serviceId: string;
  headsign: string;
  direction: number;
  shapeId: string;
}

export interface GtfsStopTime {
  tripId: string;
  stopId: string;
  arrivalSec: number;
  departureSec: number;
  sequence: number;
}

export interface GtfsCalendar {
  serviceId: string;
  days: [number, number, number, number, number, number, number];
  startDate: string;
  endDate: string;
}

export interface GtfsCalendarDate {
  serviceId: string;
  date: string;
  exceptionType: number;
}

export interface GtfsShapePoint {
  lat: number;
  lon: number;
  sequence: number;
}

export interface GtfsTransfer {
  fromStopId: string;
  toStopId: string;
  transferType: number;
  minTransferSec: number;
}

export interface GtfsFeedInfo {
  version: string;
  startDate: string;
  endDate: string;
}

/** HH:MM:SS where HH may exceed 24 (trips past midnight). Returns seconds. */
export function parseGtfsTime(value: string, file: string, row: number): number {
  const match = value.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)$/);
  if (!match) throw new Error(`${file} row ${row}: bad time "${value}"`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Dedupe repeated id strings (a trip_id repeats on every stop_time row). */
function intern(cache: Map<string, string>, value: string): string {
  const known = cache.get(value);
  if (known !== undefined) return known;
  cache.set(value, value);
  return value;
}

function numberOr(
  raw: string,
  file: string,
  row: number,
  what: string,
  problems: Problem[],
): number | null {
  if (raw === "") {
    problems.push({ file, row, message: `empty ${what}` });
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push({ file, row, message: `bad ${what} "${raw}"` });
    return null;
  }
  return value;
}

/** Iterate data rows with resolved columns; throws on an empty file. */
function eachDataRow(
  file: string,
  text: string,
  expected: string[],
  onRow: (row: string[], columns: Map<string, number>, line: number) => void,
): void {
  let columns: Map<string, number> | null = null;
  let sawHeader = false;
  eachCsvRow(text, (row, line) => {
    if (!sawHeader) {
      sawHeader = true;
      columns = requireColumns(row, expected);
      return;
    }
    onRow(row, columns as Map<string, number>, line);
  });
  if (!sawHeader) throw new Error(`${file} has no header row`);
}

export function loadStops(text: string): { stops: GtfsStop[]; problems: Problem[] } {
  const file = "stops.txt";
  const stops: GtfsStop[] = [];
  const problems: Problem[] = [];
  let columns: Map<string, number> | null = null;
  let hasLocationType = false;
  let hasParent = false;
  eachCsvRow(text, (row, line) => {
    if (!columns) {
      columns = requireColumns(row, ["stop_id", "stop_name", "stop_lat", "stop_lon"]);
      // Optional columns (absent from the minimal MTA Bus Co. table).
      for (const name of ["location_type", "parent_station"]) {
        const index = row.indexOf(name);
        if (index >= 0) columns.set(name, index);
      }
      hasLocationType = columns.has("location_type");
      hasParent = columns.has("parent_station");
      return;
    }
    const cols = columns as Map<string, number>;
    const lat = numberOr(cell(row, cols, "stop_lat"), file, line, "stop_lat", problems);
    const lon = numberOr(cell(row, cols, "stop_lon"), file, line, "stop_lon", problems);
    if (lat === null || lon === null) return;
    stops.push({
      id: cell(row, cols, "stop_id"),
      name: cell(row, cols, "stop_name"),
      lat,
      lon,
      locationType: hasLocationType ? Number(cell(row, cols, "location_type") || "0") : 0,
      parent: hasParent ? cell(row, cols, "parent_station") : "",
    });
  });
  if (!columns) throw new Error(`${file} has no header row`);
  return { stops, problems };
}

export function loadRoutes(text: string): { routes: GtfsRoute[]; problems: Problem[] } {
  const file = "routes.txt";
  const routes: GtfsRoute[] = [];
  const problems: Problem[] = [];
  // Subway and bus feeds carry different route columns; accept the union.
  eachDataRow(file, text, ["route_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"], (row, columns, line) => {
    const type = numberOr(cell(row, columns, "route_type"), file, line, "route_type", problems);
    if (type === null) return;
    routes.push({
      id: cell(row, columns, "route_id"),
      shortName: cell(row, columns, "route_short_name"),
      longName: cell(row, columns, "route_long_name"),
      type,
      color: cell(row, columns, "route_color"),
      textColor: cell(row, columns, "route_text_color"),
    });
  });
  return { routes, problems };
}

export function loadTrips(text: string): { trips: GtfsTrip[]; problems: Problem[] } {
  const file = "trips.txt";
  const trips: GtfsTrip[] = [];
  const problems: Problem[] = [];
  const ids = new Map<string, string>();
  eachDataRow(file, text, ["route_id", "trip_id", "service_id", "trip_headsign", "direction_id", "shape_id"], (row, columns, line) => {
    const direction = numberOr(cell(row, columns, "direction_id"), file, line, "direction_id", problems);
    if (direction === null) return;
    trips.push({
      routeId: intern(ids, cell(row, columns, "route_id")),
      tripId: intern(ids, cell(row, columns, "trip_id")),
      serviceId: intern(ids, cell(row, columns, "service_id")),
      headsign: cell(row, columns, "trip_headsign"),
      direction,
      shapeId: intern(ids, cell(row, columns, "shape_id")),
    });
  });
  return { trips, problems };
}

export function loadStopTimes(text: string): {
  stopTimes: GtfsStopTime[];
  problems: Problem[];
} {
  const file = "stop_times.txt";
  const stopTimes: GtfsStopTime[] = [];
  const problems: Problem[] = [];
  const ids = new Map<string, string>();
  eachDataRow(file, text, ["trip_id", "stop_id", "arrival_time", "departure_time", "stop_sequence"], (row, columns, line) => {
    const sequence = numberOr(cell(row, columns, "stop_sequence"), file, line, "stop_sequence", problems);
    if (sequence === null) return;
    let arrivalSec: number;
    let departureSec: number;
    try {
      arrivalSec = parseGtfsTime(cell(row, columns, "arrival_time"), file, line);
      departureSec = parseGtfsTime(cell(row, columns, "departure_time"), file, line);
    } catch (error) {
      problems.push({ file, row: line, message: (error as Error).message });
      return;
    }
    stopTimes.push({
      tripId: intern(ids, cell(row, columns, "trip_id")),
      stopId: intern(ids, cell(row, columns, "stop_id")),
      arrivalSec,
      departureSec,
      sequence,
    });
  });
  return { stopTimes, problems };
}

const DAY_COLUMNS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export function loadCalendar(text: string): {
  calendar: GtfsCalendar[];
  problems: Problem[];
} {
  const file = "calendar.txt";
  const calendar: GtfsCalendar[] = [];
  const problems: Problem[] = [];
  eachDataRow(file, text, ["service_id", ...DAY_COLUMNS, "start_date", "end_date"], (row, columns, line) => {
    const days = DAY_COLUMNS.map((day) => {
      const raw = cell(row, columns, day);
      if (raw !== "0" && raw !== "1") {
        problems.push({ file, row: line, message: `bad ${day} "${raw}"` });
        return -1;
      }
      return Number(raw);
    });
    if (days.includes(-1)) return;
    calendar.push({
      serviceId: cell(row, columns, "service_id"),
      days: days as [number, number, number, number, number, number, number],
      startDate: cell(row, columns, "start_date"),
      endDate: cell(row, columns, "end_date"),
    });
  });
  return { calendar, problems };
}

export function loadCalendarDates(text: string): {
  dates: GtfsCalendarDate[];
  problems: Problem[];
} {
  const file = "calendar_dates.txt";
  const dates: GtfsCalendarDate[] = [];
  const problems: Problem[] = [];
  eachDataRow(file, text, ["service_id", "date", "exception_type"], (row, columns, line) => {
    const exceptionType = numberOr(cell(row, columns, "exception_type"), file, line, "exception_type", problems);
    if (exceptionType === null) return;
    dates.push({
      serviceId: cell(row, columns, "service_id"),
      date: cell(row, columns, "date"),
      exceptionType,
    });
  });
  return { dates, problems };
}

export function loadShapes(text: string): {
  shapes: Map<string, GtfsShapePoint[]>;
  problems: Problem[];
} {
  const file = "shapes.txt";
  const shapes = new Map<string, GtfsShapePoint[]>();
  const problems: Problem[] = [];
  const ids = new Map<string, string>();
  eachDataRow(file, text, ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], (row, columns, line) => {
    const lat = numberOr(cell(row, columns, "shape_pt_lat"), file, line, "shape_pt_lat", problems);
    const lon = numberOr(cell(row, columns, "shape_pt_lon"), file, line, "shape_pt_lon", problems);
    const sequence = numberOr(cell(row, columns, "shape_pt_sequence"), file, line, "shape_pt_sequence", problems);
    if (lat === null || lon === null || sequence === null) return;
    const id = intern(ids, cell(row, columns, "shape_id"));
    const list = shapes.get(id) ?? [];
    list.push({ lat, lon, sequence });
    shapes.set(id, list);
  });
  for (const list of shapes.values()) list.sort((a, b) => a.sequence - b.sequence);
  return { shapes, problems };
}

export function loadTransfers(text: string): {
  transfers: GtfsTransfer[];
  problems: Problem[];
} {
  const file = "transfers.txt";
  const transfers: GtfsTransfer[] = [];
  const problems: Problem[] = [];
  eachDataRow(file, text, ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"], (row, columns, line) => {
    const transferType = numberOr(cell(row, columns, "transfer_type"), file, line, "transfer_type", problems);
    if (transferType === null) return;
    transfers.push({
      fromStopId: cell(row, columns, "from_stop_id"),
      toStopId: cell(row, columns, "to_stop_id"),
      transferType,
      minTransferSec: Number(cell(row, columns, "min_transfer_time") || "0"),
    });
  });
  return { transfers, problems };
}

export function loadFeedInfo(text: string): GtfsFeedInfo {
  let info: GtfsFeedInfo | null = null;
  eachDataRow(
    "feed_info.txt",
    text,
    ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version", "feed_contact_url"],
    (row, columns) => {
      if (!info) {
        info = {
          version: cell(row, columns, "feed_version"),
          startDate: cell(row, columns, "feed_start_date"),
          endDate: cell(row, columns, "feed_end_date"),
        };
      }
    },
  );
  if (!info) throw new Error("feed_info.txt has no data row");
  return info;
}

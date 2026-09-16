/**
 * Typical-week headway tables from stop_times + calendar.
 *
 * Day types come from the calendar day COLUMNS (never service_id names —
 * bus feeds use depot-prefixed ids like CA_D6-Weekday-SDon). Holiday
 * calendar_dates exceptions are NOT modeled; the manifest records that.
 */

import type { GtfsCalendar, GtfsCalendarDate, GtfsStopTime, GtfsTrip } from "./gtfs";
import type { DayType, HeadwayRow } from "./model";
import { median } from "./util";

export function classifyDayType(days: [number, number, number, number, number, number, number]): DayType | null {
  const [mo, tu, we, th, fr, sa, su] = days;
  if (mo === 1 && tu === 1 && we === 1 && th === 1 && fr === 1 && sa === 0 && su === 0) {
    return "weekday";
  }
  if (mo === 0 && tu === 0 && we === 0 && th === 0 && fr === 0 && sa === 1 && su === 0) {
    return "saturday";
  }
  if (mo === 0 && tu === 0 && we === 0 && th === 0 && fr === 0 && sa === 0 && su === 1) {
    return "sunday";
  }
  return null;
}

export interface HeadwayInput {
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  calendar: GtfsCalendar[];
  /**
   * calendar_dates rows. Services defined ONLY here (MTA school-holiday
   * variants like GH_D6-Weekday) get their day type inferred from the
   * weekday of their active dates; mixed-date services stay unclassified.
   */
  dates?: GtfsCalendarDate[];
  /** Maps a trip to its headway route key (route_id, or display short name). */
  routeKey: (trip: GtfsTrip) => string;
  /** Minimum first-stop departures per hour bucket; sparser buckets → null. */
  minDepartures?: number;
}

/** Day type of a YYYYMMDD date (UTC, to avoid host-timezone shifts). */
export function dayTypeOfDate(date: string): DayType {
  const day = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
  ).getUTCDay();
  if (day === 0) return "sunday";
  if (day === 6) return "saturday";
  return "weekday";
}

/** Infer day types for dates-only services from their active dates. */
export function inferDatesOnlyServices(
  calendar: GtfsCalendar[],
  dates: GtfsCalendarDate[],
): Map<string, DayType | null> {
  const inCalendar = new Set(calendar.map((service) => service.serviceId));
  const activeDates = new Map<string, Set<string>>();
  for (const entry of dates) {
    if (inCalendar.has(entry.serviceId)) continue;
    // exception_type 2 (removed) carries no service on that date.
    if (entry.exceptionType !== 1) continue;
    const set = activeDates.get(entry.serviceId) ?? new Set<string>();
    set.add(entry.date);
    activeDates.set(entry.serviceId, set);
  }
  const inferred = new Map<string, DayType | null>();
  for (const [serviceId, days] of activeDates) {
    const types = new Set([...days].map(dayTypeOfDate));
    inferred.set(serviceId, types.size === 1 ? ([...types][0] as DayType) : null);
  }
  return inferred;
}

export function computeHeadways(input: HeadwayInput): {
  headways: HeadwayRow[];
  unclassifiedServices: string[];
  sparseBuckets: number;
} {
  const minDepartures = input.minDepartures ?? 4;
  const serviceDay = new Map<string, DayType>();
  const unclassifiedServices: string[] = [];
  for (const service of input.calendar) {
    const dayType = classifyDayType(service.days);
    if (dayType) serviceDay.set(service.serviceId, dayType);
    else unclassifiedServices.push(service.serviceId);
  }
  for (const [serviceId, dayType] of inferDatesOnlyServices(input.calendar, input.dates ?? [])) {
    if (dayType) serviceDay.set(serviceId, dayType);
    else unclassifiedServices.push(serviceId);
  }
  const firstDeparture = new Map<string, number>();
  for (const entry of input.stopTimes) {
    // Trips are grouped below; keep the earliest departure per trip, which is
    // the first stop because validate enforces increasing stop_sequence and
    // non-decreasing times.
    const known = firstDeparture.get(entry.tripId);
    if (known === undefined || entry.departureSec < known) {
      firstDeparture.set(entry.tripId, entry.departureSec);
    }
  }
  // bucket key: route\tdirection\tdayType\thour → departures + services.
  const buckets = new Map<string, { departures: number[]; services: Set<string> }>();
  for (const trip of input.trips) {
    const dayType = serviceDay.get(trip.serviceId);
    if (!dayType) continue;
    const departure = firstDeparture.get(trip.tripId);
    if (departure === undefined) continue;
    const key = `${input.routeKey(trip)}\t${trip.direction}\t${dayType}\t${Math.floor(departure / 3600)}`;
    const bucket = buckets.get(key) ?? { departures: [], services: new Set<string>() };
    bucket.departures.push(departure);
    bucket.services.add(trip.serviceId);
    buckets.set(key, bucket);
  }
  const headways: HeadwayRow[] = [];
  let sparseBuckets = 0;
  for (const [key, bucket] of buckets) {
    // Dedupe exact same-second departures: overlapping calendar variants can
    // double-publish a schedule, and a 0-second gap would collapse the median.
    const unique = [...new Set(bucket.departures)].sort((a, b) => a - b);
    if (unique.length < minDepartures) {
      sparseBuckets += 1;
      continue;
    }
    const gaps: number[] = [];
    for (let i = 1; i < unique.length; i += 1) {
      gaps.push((unique[i] as number) - (unique[i - 1] as number));
    }
    const [route, directionRaw, dayTypeRaw, hourRaw] = key.split("\t") as [string, string, DayType, string];
    headways.push({
      route,
      direction: Number(directionRaw),
      dayType: dayTypeRaw,
      hour: Number(hourRaw),
      medianSec: median(gaps),
      trips: unique.length,
      services: bucket.services.size,
    });
  }
  headways.sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : a.hour - b.hour,
  );
  return { headways, unclassifiedServices, sparseBuckets };
}

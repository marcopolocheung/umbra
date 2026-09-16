/**
 * Typical-week headway tables from stop_times + calendar.
 *
 * Each day type is the schedule of ONE representative date, chosen by
 * `pickRepresentativeDates`. It is not the union of every service whose day
 * columns match: those services are frequently alternatives for the same
 * weekday — a base pick, the next pick, school-day variants — made exclusive by
 * `calendar_dates.txt` removals. Unioning them counted two or three timetables
 * as one day's service and roughly halved the headway (measured over 1,651
 * Brooklyn weekday buckets: a median 0.57x the true single-day figure, with 42%
 * at or below half). The representative date is recorded so the transit card can
 * say which day it is describing.
 */

import type { GtfsStopTime, GtfsTrip } from "./gtfs";
import type { GtfsCalendar, GtfsCalendarDate } from "./gtfs";
import type { DayType, HeadwayRow } from "./model";
import {
  buildServiceCalendar,
  pickRepresentativeDates,
  type RepresentativeDates,
} from "./serviceCalendar";
import { median } from "./util";

export interface HeadwayInput {
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  calendar: GtfsCalendar[];
  /** calendar_dates rows. Exceptions decide which pick runs on which date. */
  dates?: GtfsCalendarDate[];
  /**
   * Where the search for representative dates starts, YYYYMMDD — normally the
   * build date, so the tables describe the service period ahead. Explicit rather
   * than defaulted to the clock, so a build is reproducible from its manifest.
   */
  referenceDate: string;
  /** Maps a trip to its headway route key (route_id, or display short name). */
  routeKey: (trip: GtfsTrip) => string;
  /** Minimum first-stop departures per hour bucket; sparser buckets are dropped. */
  minDepartures?: number;
}

export interface HeadwayResult {
  headways: HeadwayRow[];
  /** The date each day type's table describes, plus how typical it is. */
  representativeDates: RepresentativeDates;
  /** Services that have trips but run on none of the representative dates. */
  unrepresentedServices: string[];
  sparseBuckets: number;
}

export function computeHeadways(input: HeadwayInput): HeadwayResult {
  const minDepartures = input.minDepartures ?? 4;
  const calendar = buildServiceCalendar(input.calendar, input.dates ?? []);
  const representativeDates = pickRepresentativeDates(calendar, input.referenceDate);

  // serviceId -> the day types whose representative date it runs on. A service
  // can appear in more than one (a Saturday+Sunday service, say).
  const dayTypesOf = new Map<string, DayType[]>();
  for (const [dayType, chosen] of Object.entries(representativeDates)) {
    if (!chosen) continue;
    for (const serviceId of chosen.services) {
      const known = dayTypesOf.get(serviceId) ?? [];
      known.push(dayType as DayType);
      dayTypesOf.set(serviceId, known);
    }
  }

  const firstDeparture = new Map<string, number>();
  for (const entry of input.stopTimes) {
    // The earliest departure of a trip is its first stop: validate enforces
    // increasing stop_sequence and non-decreasing times.
    const known = firstDeparture.get(entry.tripId);
    if (known === undefined || entry.departureSec < known) {
      firstDeparture.set(entry.tripId, entry.departureSec);
    }
  }

  // bucket key: route \t direction \t dayType \t hour
  const buckets = new Map<string, { departures: number[]; services: Set<string> }>();
  const unrepresented = new Set<string>();
  for (const trip of input.trips) {
    const dayTypes = dayTypesOf.get(trip.serviceId);
    if (!dayTypes) {
      unrepresented.add(trip.serviceId);
      continue;
    }
    const departure = firstDeparture.get(trip.tripId);
    if (departure === undefined) continue;
    for (const dayType of dayTypes) {
      const key = `${input.routeKey(trip)}\t${trip.direction}\t${dayType}\t${Math.floor(departure / 3600)}`;
      const bucket = buckets.get(key) ?? { departures: [], services: new Set<string>() };
      bucket.departures.push(departure);
      bucket.services.add(trip.serviceId);
      buckets.set(key, bucket);
    }
  }

  const headways: HeadwayRow[] = [];
  let sparseBuckets = 0;
  for (const [key, bucket] of buckets) {
    // Two trips of one route leaving at the same second on the same date is a
    // data artifact; a 0-second gap would drag the median down.
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
    a.route < b.route
      ? -1
      : a.route > b.route
        ? 1
        : a.dayType < b.dayType
          ? -1
          : a.dayType > b.dayType
            ? 1
            : a.direction - b.direction || a.hour - b.hour,
  );
  return {
    headways,
    representativeDates,
    unrepresentedServices: [...unrepresented].sort(),
    sparseBuckets,
  };
}

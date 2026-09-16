/**
 * GTFS service activity: which service_ids actually run on a given date, and
 * which single date best represents each day type.
 *
 * This exists because day columns alone do not answer the question. The MTA bus
 * feeds carry several Mon–Fri services at once — a base pick, the next pick, and
 * school-day variants — and make them mutually exclusive through
 * `calendar_dates.txt` removals, not through their day columns. Brooklyn's
 * calendar_dates is 728 rows, 700 of them type 2. Reading the columns alone and
 * unioning the matches counts two or three timetables as one day's service.
 */

import type { GtfsCalendar, GtfsCalendarDate } from "./gtfs";
import type { DayType } from "./model";

/** Day type of a YYYYMMDD date (UTC, so the host timezone cannot shift it). */
export function dayTypeOfDate(date: string): DayType {
  const day = utcDate(date).getUTCDay();
  if (day === 0) return "sunday";
  if (day === 6) return "saturday";
  return "weekday";
}

/** calendar.txt day columns run Monday-first; getUTCDay() puts Sunday at 0. */
const DAY_COLUMN: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };

function utcDate(date: string): Date {
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
  );
}

function addDays(date: string, delta: number): string {
  const at = utcDate(date);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface ServiceCalendar {
  /** Every service_id the feed defines, in calendar.txt or calendar_dates.txt. */
  serviceIds: string[];
  /** Earliest and latest date any row mentions. */
  window: { start: string; end: string };
  /** GTFS activity: day column and date range, then calendar_dates exceptions. */
  isActiveOn(serviceId: string, date: string): boolean;
  /** Every service active on a date, sorted. */
  activeOn(date: string): string[];
}

export function buildServiceCalendar(
  calendar: GtfsCalendar[],
  dates: GtfsCalendarDate[],
): ServiceCalendar {
  const byService = new Map<string, GtfsCalendar>();
  for (const service of calendar) byService.set(service.serviceId, service);
  // date -> serviceId -> exception type. A later row wins, as in GTFS.
  const exceptions = new Map<string, Map<string, number>>();
  for (const entry of dates) {
    const forDate = exceptions.get(entry.date) ?? new Map<string, number>();
    forDate.set(entry.serviceId, entry.exceptionType);
    exceptions.set(entry.date, forDate);
  }
  const serviceIds = [...new Set([...byService.keys(), ...dates.map((d) => d.serviceId)])].sort();

  const bounds = [
    ...calendar.flatMap((service) => [service.startDate, service.endDate]),
    ...dates.map((entry) => entry.date),
  ].filter((value) => /^\d{8}$/.test(value));
  const window = {
    start: bounds.reduce((a, b) => (a < b ? a : b), bounds[0] ?? ""),
    end: bounds.reduce((a, b) => (a > b ? a : b), bounds[0] ?? ""),
  };

  const isActiveOn = (serviceId: string, date: string): boolean => {
    const service = byService.get(serviceId);
    let active = false;
    if (service) {
      const column = DAY_COLUMN[utcDate(date).getUTCDay()] as number;
      active = service.days[column] === 1 && service.startDate <= date && date <= service.endDate;
    }
    const exception = exceptions.get(date)?.get(serviceId);
    if (exception === 1) active = true;
    if (exception === 2) active = false;
    return active;
  };

  return {
    serviceIds,
    window,
    isActiveOn,
    activeOn: (date) => serviceIds.filter((id) => isActiveOn(id, date)),
  };
}

export interface RepresentativeDate {
  /** The chosen date, YYYYMMDD. */
  date: string;
  /**
   * The day after `date`, which is where this table's hours 24-27 land. A
   * weekday table is usually followed by another weekday, but a Friday
   * representative spills into a Saturday, and the service there is different.
   */
  nextDate: string;
  nextDayType: DayType;
  /** Services running that day. */
  services: string[];
  /** Candidate dates whose active set is identical to this one. */
  matchingDates: number;
  /** Candidate dates of this day type that were considered. */
  candidateDates: number;
}

export type RepresentativeDates = Record<DayType, RepresentativeDate | null>;

const DAY_TYPES: DayType[] = ["weekday", "saturday", "sunday"];

/**
 * One representative date per day type: the *modal* active-service set among
 * candidate dates, which is what "a typical weekday" means once picks and
 * school variants rotate. Ties break to the earliest date.
 *
 * Candidates start at `referenceDate` so the tables describe the service period
 * ahead rather than one that has already ended — the subway feed spans two
 * Saturday picks and the earlier one covers more dates, so scanning the whole
 * window would publish the expired pick. When no candidate remains on or after
 * the reference date (a feed gone stale), the whole window is used instead.
 */
export function pickRepresentativeDates(
  calendar: ServiceCalendar,
  referenceDate: string,
): RepresentativeDates {
  const { start, end } = calendar.window;
  const picked: RepresentativeDates = { weekday: null, saturday: null, sunday: null };
  if (!start || !end) return picked;

  const from = referenceDate > start && referenceDate <= end ? referenceDate : start;
  for (const dayType of DAY_TYPES) {
    let candidates = datesOfType(from, end, dayType);
    if (candidates.length === 0) candidates = datesOfType(start, end, dayType);
    // Group candidates by their exact active-service set; the biggest group is
    // the typical day, and a holiday or a pick boundary falls out as a small one.
    const groups = new Map<string, { services: string[]; dates: string[] }>();
    for (const date of candidates) {
      const services = calendar.activeOn(date);
      if (services.length === 0) continue;
      const key = services.join("\t");
      const group = groups.get(key) ?? { services, dates: [] };
      group.dates.push(date);
      groups.set(key, group);
    }
    let best: { services: string[]; dates: string[] } | null = null;
    for (const group of groups.values()) {
      const better =
        !best ||
        group.dates.length > best.dates.length ||
        (group.dates.length === best.dates.length &&
          (group.dates[0] as string) < (best.dates[0] as string));
      if (better) best = group;
    }
    const chosen = best ? (best.dates[0] as string) : null;
    picked[dayType] = best && chosen
      ? {
          date: chosen,
          nextDate: addDays(chosen, 1),
          nextDayType: dayTypeOfDate(addDays(chosen, 1)),
          services: best.services,
          matchingDates: best.dates.length,
          candidateDates: candidates.length,
        }
      : null;
  }
  return picked;
}

function datesOfType(from: string, to: string, dayType: DayType): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (dayTypeOfDate(date) === dayType) dates.push(date);
  }
  return dates;
}

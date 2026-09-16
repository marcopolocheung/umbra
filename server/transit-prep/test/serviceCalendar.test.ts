import assert from "node:assert/strict";
import test from "node:test";
import type { GtfsCalendar } from "../src/gtfs";
import {
  buildServiceCalendar,
  dayTypeOfDate,
  pickRepresentativeDates,
} from "../src/serviceCalendar";

const WEEKDAY: GtfsCalendar = {
  serviceId: "WD",
  days: [1, 1, 1, 1, 1, 0, 0],
  startDate: "20261001",
  endDate: "20261031",
};

test("day type comes from the date, in UTC", () => {
  // 2026-11-26 is a Thursday, 2026-11-28 a Saturday, 2026-11-29 a Sunday.
  assert.equal(dayTypeOfDate("20261126"), "weekday");
  assert.equal(dayTypeOfDate("20261128"), "saturday");
  assert.equal(dayTypeOfDate("20261129"), "sunday");
});

test("activity needs the day column, the date range and the exceptions", () => {
  const calendar = buildServiceCalendar(
    [WEEKDAY],
    [
      { serviceId: "WD", date: "20261007", exceptionType: 2 },
      { serviceId: "WD", date: "20261010", exceptionType: 1 },
    ],
  );
  // 2026-10-06 Tue in range, 10-07 Wed removed, 10-10 Sat added, 10-03 Sat not,
  // 11-03 Tue past the end date.
  assert.equal(calendar.isActiveOn("WD", "20261006"), true);
  assert.equal(calendar.isActiveOn("WD", "20261007"), false);
  assert.equal(calendar.isActiveOn("WD", "20261010"), true);
  assert.equal(calendar.isActiveOn("WD", "20261003"), false);
  assert.equal(calendar.isActiveOn("WD", "20261103"), false);
});

test("a service defined only in calendar_dates still runs on its dates", () => {
  const calendar = buildServiceCalendar(
    [],
    [{ serviceId: "SCHOOL_OUT", date: "20261223", exceptionType: 1 }],
  );
  assert.deepEqual(calendar.serviceIds, ["SCHOOL_OUT"]);
  assert.equal(calendar.isActiveOn("SCHOOL_OUT", "20261223"), true);
  assert.equal(calendar.isActiveOn("SCHOOL_OUT", "20261222"), false);
});

test("the representative date is the most common service pattern", () => {
  // BASE runs all October weekdays; SPECIAL joins on exactly two of them.
  const calendar = buildServiceCalendar(
    [{ ...WEEKDAY, serviceId: "BASE" }],
    [
      { serviceId: "SPECIAL", date: "20261005", exceptionType: 1 },
      { serviceId: "SPECIAL", date: "20261006", exceptionType: 1 },
    ],
  );
  const picked = pickRepresentativeDates(calendar, "20261001");
  assert.deepEqual(picked.weekday?.services, ["BASE"]);
  assert.equal(picked.weekday?.matchingDates, 20);
  assert.equal(picked.weekday?.candidateDates, 22);
});

test("candidates start at the reference date, so an expired pick is not chosen", () => {
  // Two picks split the window: the earlier covers more dates, the later is the
  // one still running. This is the subway feed's two Saturday picks in little.
  const calendar = buildServiceCalendar(
    [
      { serviceId: "OLD", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20261001", endDate: "20261023" },
      { serviceId: "NEW", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20261026", endDate: "20261031" },
    ],
    [],
  );
  assert.deepEqual(pickRepresentativeDates(calendar, "20261001").weekday?.services, ["OLD"]);
  assert.deepEqual(pickRepresentativeDates(calendar, "20261026").weekday?.services, ["NEW"]);
});

test("a reference date past the window falls back to the whole window", () => {
  const calendar = buildServiceCalendar([WEEKDAY], []);
  const picked = pickRepresentativeDates(calendar, "20271231");
  assert.deepEqual(picked.weekday?.services, ["WD"]);
  assert.equal(picked.saturday, null);
});

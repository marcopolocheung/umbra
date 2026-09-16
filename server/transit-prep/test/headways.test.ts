import assert from "node:assert/strict";
import test from "node:test";
import type { GtfsCalendar, GtfsCalendarDate, GtfsStopTime, GtfsTrip } from "../src/gtfs";
import { computeHeadways } from "../src/headways";

/** Inside every fixture calendar window below. */
const REFERENCE_DATE = "20260101";

function trip(id: string, service: string, direction: number): GtfsTrip {
  return { routeId: "R", tripId: id, serviceId: service, headsign: "", direction, shapeId: "S" };
}

function at(id: string, departure: number): GtfsStopTime {
  return { tripId: id, stopId: "S", arrivalSec: departure, departureSec: departure, sequence: 1 };
}

const WEEKDAY: GtfsCalendar = {
  serviceId: "WD",
  days: [1, 1, 1, 1, 1, 0, 0],
  startDate: "20260101",
  endDate: "20261231",
};

test("computes median headway per hour bucket", () => {
  const departures = [8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200, 8 * 3600 + 1800];
  const ids = ["a", "b", "c", "d"];
  const { headways, sparseBuckets } = computeHeadways({
    trips: ids.map((id) => trip(id, "WD", 0)),
    stopTimes: ids.map((id, i) => at(id, departures[i] as number)),
    calendar: [WEEKDAY],
    referenceDate: REFERENCE_DATE,
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways.length, 1);
  assert.equal(headways[0]?.medianSec, 600);
  assert.equal(headways[0]?.hour, 8);
  assert.equal(headways[0]?.trips, 4);
  assert.equal(sparseBuckets, 0);
});

test("sparse buckets are dropped and services off the representative date are reported", () => {
  const { headways, unrepresentedServices, sparseBuckets } = computeHeadways({
    trips: [trip("a", "WD", 0), trip("b", "ODD", 0)],
    stopTimes: [at("a", 100), at("b", 200)],
    calendar: [
      WEEKDAY,
      // Mondays only: Tue-Fri outnumber Mondays, so {WD} is the modal weekday
      // pattern and ODD lands on no representative date at all.
      { serviceId: "ODD", days: [1, 0, 0, 0, 0, 0, 0], startDate: "20260101", endDate: "20261231" },
    ],
    referenceDate: REFERENCE_DATE,
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways.length, 0);
  assert.equal(sparseBuckets, 1);
  assert.deepEqual(unrepresentedServices, ["ODD"]);
});

test("same-second duplicate departures do not collapse the median", () => {
  const ids = ["a", "b", "c", "d", "a2", "b2"];
  const departures = [0, 600, 1200, 1800, 0, 600];
  const { headways } = computeHeadways({
    trips: ids.map((id) => trip(id, "WD", 0)),
    stopTimes: ids.map((id, i) => at(id, departures[i] as number)),
    calendar: [WEEKDAY],
    referenceDate: REFERENCE_DATE,
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways[0]?.medianSec, 600);
});

/** Every weekday in October 2026, for exclusive-pick fixtures. */
const WEEKDAYS_OCT = Array.from({ length: 31 }, (_, i) => i + 1)
  .filter((day) => {
    const dow = new Date(Date.UTC(2026, 9, day)).getUTCDay();
    return dow !== 0 && dow !== 6;
  })
  .map((day) => `202610${String(day).padStart(2, "0")}`);

test("mutually exclusive weekday picks do not inflate frequency", () => {
  // The B1 pathology, reduced: two Mon-Fri services covering the same window,
  // made exclusive by calendar_dates removals rather than by their day columns.
  // Each runs every 10 minutes; their times interleave at 5-minute offsets, so
  // unioning them halves the apparent headway.
  const base = 13 * 3600;
  const trips: GtfsTrip[] = [];
  const stopTimes: GtfsStopTime[] = [];
  const add = (id: string, service: string, departure: number): void => {
    trips.push(trip(id, service, 0));
    stopTimes.push(at(id, departure));
  };
  for (let i = 0; i < 6; i += 1) {
    add(`pick-a-${i}`, "PICK_A", base + i * 600);
    add(`pick-b-${i}`, "PICK_B", base + i * 600 + 300);
  }
  const calendar: GtfsCalendar[] = [
    { serviceId: "PICK_A", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20261001", endDate: "20261031" },
    { serviceId: "PICK_B", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20261001", endDate: "20261031" },
  ];
  // Weekdays alternate between the two picks; each is removed on the days the
  // other runs, exactly as the MTA bus feeds do it.
  const dates: GtfsCalendarDate[] = WEEKDAYS_OCT.map((date, index) => ({
    serviceId: index % 2 === 0 ? "PICK_B" : "PICK_A",
    date,
    exceptionType: 2,
  }));
  const { headways, representativeDates } = computeHeadways({
    trips,
    stopTimes,
    calendar,
    dates,
    referenceDate: "20261001",
    routeKey: (t) => t.routeId,
  });
  const row = headways.find((r) => r.dayType === "weekday" && r.hour === 13);
  // One pick runs on any given weekday: 10-minute service, not 5-minute.
  assert.equal(row?.medianSec, 600);
  assert.equal(row?.services, 1);
  assert.equal(representativeDates.weekday?.services.length, 1);
});

test("a holiday timetable does not become the typical weekday", () => {
  // Thanksgiving 2026-11-26 runs a thin Sunday-ish schedule on a Thursday. It is
  // one date against dozens, so the modal pattern must ignore it.
  const ids = ["r1", "r2", "r3", "r4", "h1", "h2", "h3", "h4"];
  const trips = [
    ...ids.slice(0, 4).map((id) => trip(id, "WD", 0)),
    ...ids.slice(4).map((id) => trip(id, "HOLIDAY", 0)),
  ];
  const stopTimes = [
    ...ids.slice(0, 4).map((id, i) => at(id, 9 * 3600 + i * 600)),
    ...ids.slice(4).map((id, i) => at(id, 9 * 3600 + i * 3600)),
  ];
  const { headways, unrepresentedServices, representativeDates } = computeHeadways({
    trips,
    stopTimes,
    calendar: [WEEKDAY],
    dates: [
      { serviceId: "HOLIDAY", date: "20261126", exceptionType: 1 },
      { serviceId: "WD", date: "20261126", exceptionType: 2 },
    ],
    referenceDate: REFERENCE_DATE,
    routeKey: (t) => t.routeId,
  });
  assert.equal(representativeDates.weekday?.services.join(), "WD");
  assert.equal(headways.find((r) => r.hour === 9)?.medianSec, 600);
  assert.deepEqual(unrepresentedServices, ["HOLIDAY"]);
});

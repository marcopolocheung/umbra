import assert from "node:assert/strict";
import test from "node:test";
import { classifyDayType, computeHeadways, dayTypeOfDate, inferDatesOnlyServices } from "../src/headways";
import type { GtfsCalendar, GtfsStopTime, GtfsTrip } from "../src/gtfs";

test("classifies day types from columns, never names", () => {
  assert.equal(classifyDayType([1, 1, 1, 1, 1, 0, 0]), "weekday");
  assert.equal(classifyDayType([0, 0, 0, 0, 0, 1, 0]), "saturday");
  assert.equal(classifyDayType([0, 0, 0, 0, 0, 0, 1]), "sunday");
  assert.equal(classifyDayType([1, 1, 1, 1, 1, 1, 0]), null);
});

function trip(id: string, service: string, direction: number): GtfsTrip {
  return { routeId: "R", tripId: id, serviceId: service, headsign: "", direction, shapeId: "S" };
}

test("computes median headway per hour bucket", () => {
  const departures = [8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200, 8 * 3600 + 1800];
  const stopTimes: GtfsStopTime[] = ["a", "b", "c", "d"].map((id, i) => ({
    tripId: id,
    stopId: "S",
    arrivalSec: departures[i] as number,
    departureSec: departures[i] as number,
    sequence: 1,
  }));
  const calendar: GtfsCalendar[] = [
    { serviceId: "WD", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20260101", endDate: "20261231" },
  ];
  const { headways, sparseBuckets } = computeHeadways({
    trips: ["a", "b", "c", "d"].map((id) => trip(id, "WD", 0)),
    stopTimes,
    calendar,
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways.length, 1);
  assert.equal(headways[0]?.medianSec, 600);
  assert.equal(headways[0]?.hour, 8);
  assert.equal(headways[0]?.trips, 4);
  assert.equal(sparseBuckets, 0);
});

test("sparse buckets become null and unclassified services are reported", () => {
  const { headways, unclassifiedServices, sparseBuckets } = computeHeadways({
    trips: [trip("a", "WD", 0), trip("b", "ODD", 0)],
    stopTimes: [
      { tripId: "a", stopId: "S", arrivalSec: 100, departureSec: 100, sequence: 1 },
      { tripId: "b", stopId: "S", arrivalSec: 200, departureSec: 200, sequence: 1 },
    ],
    calendar: [
      { serviceId: "WD", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20260101", endDate: "20261231" },
      { serviceId: "ODD", days: [1, 0, 0, 0, 0, 0, 1], startDate: "20260101", endDate: "20261231" },
    ],
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways.length, 0);
  assert.equal(sparseBuckets, 1);
  assert.deepEqual(unclassifiedServices, ["ODD"]);
});

test("same-second duplicate departures do not collapse the median", () => {  const ids = ["a", "b", "c", "d", "a2", "b2"];
  const departures = [0, 600, 1200, 1800, 0, 600];
  const { headways } = computeHeadways({
    trips: ids.map((id) => trip(id, "WD", 0)),
    stopTimes: ids.map((id, i) => ({
      tripId: id,
      stopId: "S",
      arrivalSec: departures[i] as number,
      departureSec: departures[i] as number,
      sequence: 1,
    })),
    calendar: [
      { serviceId: "WD", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20260101", endDate: "20261231" },
    ],
    routeKey: (t) => t.routeId,
  });
  assert.equal(headways[0]?.medianSec, 600);
});

test("infers dates-only services from their active dates", () => {
  // 2026-11-26 is a Thursday; 2026-11-29 is a Sunday.
  assert.equal(dayTypeOfDate("20261126"), "weekday");
  assert.equal(dayTypeOfDate("20261129"), "sunday");
  const inferred = inferDatesOnlyServices([], [
    { serviceId: "HOL-WD", date: "20261126", exceptionType: 1 },
    { serviceId: "HOL-MIX", date: "20261126", exceptionType: 1 },
    { serviceId: "HOL-MIX", date: "20261129", exceptionType: 1 },
    { serviceId: "CAL", date: "20261126", exceptionType: 1 },
  ]);
  // CAL is skipped here (no calendar passed means nothing is "in calendar",
  // so CAL infers as weekday too) — the calendar-membership filter is
  // covered by passing a calendar below.
  assert.equal(inferred.get("HOL-WD"), "weekday");
  assert.equal(inferred.get("HOL-MIX"), null);
  const withCalendar = inferDatesOnlyServices(
    [{ serviceId: "CAL", days: [1, 1, 1, 1, 1, 0, 0], startDate: "20260101", endDate: "20261231" }],
    [{ serviceId: "CAL", date: "20261126", exceptionType: 1 }],
  );
  assert.equal(withCalendar.has("CAL"), false);
});

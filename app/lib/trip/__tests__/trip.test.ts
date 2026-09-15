import { describe, expect, it } from "vitest";
import {
  addStop,
  buildTrip,
  legDepartureTimes,
  makeStop,
  moveStop,
  normalizeDwellMinutes,
  removeStop,
  replaceStops,
  setLegMode,
  setStopDwell,
  swapStops,
  tripToRoutePlan,
  tripTotals,
  withDefaultMode,
} from "../trip";
import type { Trip } from "../types";

const DEPART = { instant: "2026-09-15T12:00:00.000Z", zone: "Europe/Madrid" };

function fourStopTrip(): Trip {
  return buildTrip({
    departAt: DEPART,
    defaultMode: "walk",
    stops: [
      { coord: [-3.7, 40.41], label: "A" },
      { coord: [-3.69, 40.415], label: "B", dwellMinutes: 30 },
      { coord: [-3.68, 40.42], label: "C" },
      { coord: [-3.67, 40.425], label: "D" },
    ],
  });
}

describe("buildTrip", () => {
  it("orders stops A, via, B with positional legs in the default mode", () => {
    const trip = fourStopTrip();
    expect(trip.stops.map((s) => s.label)).toEqual(["A", "B", "C", "D"]);
    expect(trip.legs).toEqual([
      { from: 0, to: 1, mode: "walk" },
      { from: 1, to: 2, mode: "walk" },
      { from: 2, to: 3, mode: "walk" },
    ]);
    expect(trip.departAt).toEqual(DEPART);
    expect(trip.defaultMode).toBe("walk");
  });

  it("gives every stop a unique id", () => {
    const trip = fourStopTrip();
    const ids = new Set(trip.stops.map((s) => s.id));
    expect(ids.size).toBe(4);
  });
});

describe("stop edits keep identity", () => {
  it("moveStop carries ids with the stops, not the positions", () => {
    const trip = fourStopTrip();
    const moved = moveStop(trip, 0, 3);
    expect(moved.stops.map((s) => s.label)).toEqual(["B", "C", "D", "A"]);
    // The stop now last is still the stop that was first.
    expect(moved.stops[3].id).toBe(trip.stops[0].id);
    // And its dwell travelled with it.
    expect(moved.stops[0].dwellMinutes).toBe(30);
  });

  it("swapStops exchanges stops with their ids", () => {
    const trip = fourStopTrip();
    const swapped = swapStops(trip, 0, 1);
    expect(swapped.stops.map((s) => s.label)).toEqual(["B", "A", "C", "D"]);
    expect(swapped.stops[0].id).toBe(trip.stops[1].id);
    expect(swapped.stops[1].id).toBe(trip.stops[0].id);
  });

  it("removeStop drops the stop and re-derives positional legs", () => {
    const trip = fourStopTrip();
    const next = removeStop(trip, 1);
    expect(next.stops.map((s) => s.label)).toEqual(["A", "C", "D"]);
    expect(next.legs).toEqual([
      { from: 0, to: 1, mode: "walk" },
      { from: 1, to: 2, mode: "walk" },
    ]);
  });

  it("addStop inserts at the given position with a fresh id", () => {
    const trip = fourStopTrip();
    const extra = makeStop([-3.685, 40.417], "X");
    const next = addStop(trip, extra, 1);
    expect(next.stops.map((s) => s.label)).toEqual(["A", "X", "B", "C", "D"]);
    expect(next.stops[1].id).toBe(extra.id);
    expect(next.legs).toHaveLength(4);
  });

  it("never mutates the input trip", () => {
    const trip = fourStopTrip();
    const before = JSON.stringify(trip);
    moveStop(trip, 0, 2);
    removeStop(trip, 0);
    setStopDwell(trip, 0, 99);
    expect(JSON.stringify(trip)).toBe(before);
  });
});

describe("dwell and leg modes", () => {
  it("setStopDwell stores whole non-negative minutes, clearing on zero", () => {
    const trip = fourStopTrip();
    expect(setStopDwell(trip, 2, 45).stops[2].dwellMinutes).toBe(45);
    expect(setStopDwell(trip, 2, -5).stops[2].dwellMinutes).toBeUndefined();
    expect(setStopDwell(trip, 1, 0).stops[1].dwellMinutes).toBeUndefined();
  });

  it("normalizeDwellMinutes coerces garbage to zero", () => {
    expect(normalizeDwellMinutes(30.9)).toBe(30);
    expect(normalizeDwellMinutes(-3)).toBe(0);
    expect(normalizeDwellMinutes(Number.NaN)).toBe(0);
    expect(normalizeDwellMinutes("30")).toBe(0);
    expect(normalizeDwellMinutes(undefined)).toBe(0);
  });

  it("setLegMode sticks to the stop pair across a reorder", () => {
    const trip = setLegMode(fourStopTrip(), 0, "bike");
    // Moving A to the end breaks the A→B pair, so the bike mode goes with it.
    const moved = moveStop(trip, 0, 3);
    expect(moved.legs.map((l) => l.mode)).toEqual(["walk", "walk", "walk"]);
    // But a reorder that keeps A→B adjacent keeps its mode.
    const swapped = swapStops(trip, 2, 3);
    expect(swapped.legs[0].mode).toBe("bike");
  });
});

describe("replaceStops", () => {
  it("keeps the identity of stops whose coordinates did not move", () => {
    const trip = fourStopTrip();
    // An agent revision re-issues the same plan with a new destination: the
    // unaffected stops must keep their ids (C11's acceptance kernel).
    const next = replaceStops(trip, [
      { coord: [-3.7, 40.41] },
      { coord: [-3.69, 40.415] },
      { coord: [-3.68, 40.42] },
      { coord: [-3.0, 41.0] },
    ]);
    expect(next.stops.slice(0, 3).map((s) => s.id)).toEqual(trip.stops.slice(0, 3).map((s) => s.id));
    expect(next.stops[3].id).not.toBe(trip.stops[3].id);
    // Dwell and labels travel with the preserved stops.
    expect(next.stops[1].dwellMinutes).toBe(30);
    expect(next.stops[1].label).toBe("B");
  });

  it("applies explicit label and dwell overrides to preserved stops", () => {
    const trip = fourStopTrip();
    const next = replaceStops(trip, [
      { coord: [-3.7, 40.41], label: "Home" },
      { coord: [-3.69, 40.415], dwellMinutes: 0 },
      { coord: [-3.68, 40.42] },
      { coord: [-3.67, 40.425] },
    ]);
    expect(next.stops[0].id).toBe(trip.stops[0].id);
    expect(next.stops[0].label).toBe("Home");
    expect(next.stops[1].id).toBe(trip.stops[1].id);
    expect(next.stops[1].dwellMinutes).toBeUndefined();
  });
});

describe("withDefaultMode", () => {
  it("moves every leg to the new default mode", () => {
    const trip = withDefaultMode(fourStopTrip(), "bike");
    expect(trip.defaultMode).toBe("bike");
    expect(trip.legs.map((l) => l.mode)).toEqual(["bike", "bike", "bike"]);
  });

  it("returns the same trip when nothing changes", () => {
    const trip = fourStopTrip();
    expect(withDefaultMode(trip, "walk")).toBe(trip);
  });
});

describe("tripToRoutePlan", () => {
  it("adapts to C4's RoutePlan shape with via stops and labels", () => {
    expect(tripToRoutePlan(fourStopTrip())).toEqual({
      from: [-3.7, 40.41],
      to: [-3.67, 40.425],
      via: [
        [-3.69, 40.415],
        [-3.68, 40.42],
      ],
      fromLabel: "A",
      toLabel: "D",
    });
  });

  it("falls back to Start/Destination for missing labels", () => {
    const trip = buildTrip({
      departAt: DEPART,
      defaultMode: "walk",
      stops: [{ coord: [0, 0] }, { coord: [1, 1] }],
    });
    const plan = tripToRoutePlan(trip);
    expect(plan.fromLabel).toBe("Start");
    expect(plan.toLabel).toBe("Destination");
    expect(plan.via).toEqual([]);
  });

  it("refuses a plan with fewer than two stops", () => {
    const trip = buildTrip({ departAt: DEPART, defaultMode: "walk", stops: [{ coord: [0, 0] }] });
    expect(() => tripToRoutePlan(trip)).toThrow();
  });

  it("a no-dwell trip adapts to the hand-built plan byte-identically", () => {
    const trip = buildTrip({
      departAt: DEPART,
      defaultMode: "bike",
      stops: [
        { coord: [-3.7, 40.41], label: "A" },
        { coord: [-3.69, 40.415] },
        { coord: [-3.67, 40.425], label: "D" },
      ],
    });
    expect(tripToRoutePlan(trip)).toEqual({
      from: [-3.7, 40.41],
      to: [-3.67, 40.425],
      via: [[-3.69, 40.415]],
      fromLabel: "A",
      toLabel: "D",
    });
  });
});

describe("legDepartureTimes", () => {
  it("dwells shift each later leg's departure", () => {
    const departures = legDepartureTimes(fourStopTrip(), [600, 600, 600]);
    expect(departures[0].toISOString()).toBe("2026-09-15T12:00:00.000Z");
    // Leg 1 departs after leg 0's travel plus the 30 min dwell at B, where
    // leg 0 arrives — dwell at the arrival stop delays the next departure.
    expect(departures[1].toISOString()).toBe("2026-09-15T12:40:00.000Z");
    // Leg 2 departs after leg 1's travel; C has no dwell.
    expect(departures[2].toISOString()).toBe("2026-09-15T12:50:00.000Z");
  });

  it("rejects a travel-time array that does not match the legs", () => {
    expect(() => legDepartureTimes(fourStopTrip(), [600])).toThrow();
  });
});

describe("tripTotals", () => {
  it("sums legs and adds dwell to time", () => {
    const totals = tripTotals(fourStopTrip(), [
      { distanceM: 1000, timeSec: 700, shadowCoverage: 0.8 },
      { distanceM: 1000, timeSec: 700, shadowCoverage: 0.4 },
      { distanceM: 2000, timeSec: 1400, shadowCoverage: 0.4 },
    ]);
    expect(totals.distanceM).toBe(4000);
    // 2800 s travel + 30 min dwell at B.
    expect(totals.timeSec).toBe(4600);
    // Distance-weighted: (800 + 400 + 800) / 4000.
    expect(totals.shadowCoverage).toBeCloseTo(0.5, 10);
  });

  it("counts only intermediate dwell, agreeing with legDepartureTimes", () => {
    // Dwell on the origin (before departAt) and on the destination (after
    // arrival) delays no leg, so it must not inflate the journey either.
    const trip = buildTrip({
      departAt: DEPART,
      defaultMode: "walk",
      stops: [
        { coord: [-3.7, 40.41], dwellMinutes: 15 },
        { coord: [-3.69, 40.415], dwellMinutes: 30 },
        { coord: [-3.68, 40.42], dwellMinutes: 45 },
      ],
    });
    const stats = [
      { distanceM: 500, timeSec: 600, shadowCoverage: null },
      { distanceM: 500, timeSec: 600, shadowCoverage: null },
    ];
    // 1200 s travel + the 30 min at the middle stop only.
    expect(tripTotals(trip, stats).timeSec).toBe(1200 + 1800);
    // And that is exactly the span legDepartureTimes covers: last departure
    // plus the last leg's travel, measured from the anchor.
    const departures = legDepartureTimes(trip, [600, 600]);
    const arrival = departures[1].getTime() + 600_000;
    expect(arrival - new Date(DEPART.instant).getTime()).toBe((1200 + 1800) * 1000);
  });

  it("reports null shadow while no leg has a route", () => {
    const trip = fourStopTrip();
    const unrouted = trip.legs.map(() => ({
      distanceM: 500,
      timeSec: 600,
      shadowCoverage: null,
    }));
    const totals = tripTotals(trip, unrouted);
    expect(totals.shadowCoverage).toBeNull();
    expect(totals.distanceM).toBeGreaterThan(0);
  });

  it("rejects stats that do not match the legs", () => {
    expect(() => tripTotals(fourStopTrip(), [])).toThrow();
  });
});

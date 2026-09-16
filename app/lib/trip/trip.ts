import type { RoutePlan } from "../routePlanJob";
import type { TravelModeId } from "../travelMode";
import type { Stop, Trip, TripDepartAt, TripLeg, TripTotals } from "./types";
import type { StopEntry } from "./types";

export type { Stop, Trip, TripDepartAt, TripLeg, TripTotals, StopEntry };

/** Dwell values arrive from share URLs and stored records — coerce the
 * garbage to zero rather than carrying NaN through departure math. */
export function normalizeDwellMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function newStopId(): string {
  return crypto.randomUUID();
}

export function makeStop(
  coord: [number, number],
  label: string | null = null,
  opts: { id?: string; dwellMinutes?: number; placeId?: string } = {},
): Stop {
  const stop: Stop = { id: opts.id ?? newStopId(), coord, label };
  const dwell = normalizeDwellMinutes(opts.dwellMinutes);
  if (dwell > 0) stop.dwellMinutes = dwell;
  if (opts.placeId) stop.placeId = opts.placeId;
  return stop;
}

/** Rebuild positional legs, preserving a per-leg mode wherever the same
 * stop pair survives the edit (a reorder keeps its modes, a fresh pair
 * takes the default). Modes key on stop ids, never on positions. */
function rebuildLegs(
  stops: Stop[],
  modesByPair: Map<string, TravelModeId>,
  defaultMode: TravelModeId,
): TripLeg[] {
  const legs: TripLeg[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const pair = `${stops[i].id}>${stops[i + 1].id}`;
    legs.push({ from: i, to: i + 1, mode: modesByPair.get(pair) ?? defaultMode });
  }
  return legs;
}

function modesByPair(trip: Trip): Map<string, TravelModeId> {
  const modes = new Map<string, TravelModeId>();
  for (const leg of trip.legs) {
    const from = trip.stops[leg.from];
    const to = trip.stops[leg.to];
    if (from && to) modes.set(`${from.id}>${to.id}`, leg.mode);
  }
  return modes;
}

function withStops(trip: Trip, stops: Stop[]): Trip {
  return { ...trip, stops, legs: rebuildLegs(stops, modesByPair(trip), trip.defaultMode) };
}

export interface BuildTripInput {
  /** `id` is for callers that need reproducible identity (the saved-record
   * migration re-derives the same trip on every read); omitted means minted. */
  stops: {
    coord: [number, number];
    label?: string | null;
    dwellMinutes?: number;
    placeId?: string;
    id?: string;
  }[];
  departAt: TripDepartAt;
  defaultMode: TravelModeId;
  id?: string;
}

/** Build a trip from today's legacy state: waypointA/B, labels,
 * additionalWaypoints (in order between A and B), and the map date. */
export function buildTrip(input: BuildTripInput): Trip {
  const stops = input.stops.map((s) =>
    makeStop(s.coord, s.label ?? null, {
      id: s.id,
      dwellMinutes: s.dwellMinutes,
      placeId: s.placeId,
    }),
  );
  return {
    id: input.id ?? crypto.randomUUID(),
    stops,
    legs: rebuildLegs(stops, new Map(), input.defaultMode),
    defaultMode: input.defaultMode,
    departAt: { ...input.departAt },
  };
}

export function addStop(trip: Trip, stop: Stop, index: number = trip.stops.length): Trip {
  const at = Math.max(0, Math.min(index, trip.stops.length));
  return withStops(trip, [...trip.stops.slice(0, at), stop, ...trip.stops.slice(at)]);
}

export function removeStop(trip: Trip, index: number): Trip {
  if (index < 0 || index >= trip.stops.length) return trip;
  return withStops(trip, trip.stops.filter((_, i) => i !== index));
}

export function moveStop(trip: Trip, fromIndex: number, toIndex: number): Trip {
  if (fromIndex < 0 || fromIndex >= trip.stops.length) return trip;
  const at = Math.max(0, Math.min(toIndex, trip.stops.length - 1));
  if (at === fromIndex) return trip;
  const stops = [...trip.stops];
  const [moved] = stops.splice(fromIndex, 1);
  stops.splice(at, 0, moved);
  return withStops(trip, stops);
}

export function swapStops(trip: Trip, a: number, b: number): Trip {
  if (a < 0 || b < 0 || a >= trip.stops.length || b >= trip.stops.length || a === b) return trip;
  const stops = [...trip.stops];
  [stops[a], stops[b]] = [stops[b], stops[a]];
  return withStops(trip, stops);
}

export function setStopDwell(trip: Trip, index: number, dwellMinutes: number): Trip {
  const stop = trip.stops[index];
  if (!stop) return trip;
  const dwell = normalizeDwellMinutes(dwellMinutes);
  const next: Stop = { ...stop };
  if (dwell > 0) next.dwellMinutes = dwell;
  else delete next.dwellMinutes;
  return { ...trip, stops: trip.stops.map((s, i) => (i === index ? next : s)) };
}

export function setLegMode(trip: Trip, legIndex: number, mode: TravelModeId): Trip {
  if (legIndex < 0 || legIndex >= trip.legs.length) return trip;
  return { ...trip, legs: trip.legs.map((l, i) => (i === legIndex ? { ...l, mode } : l)) };
}

/**
 * Adopt a new default mode. Every leg follows it: E5 state keeps legs
 * uniform (per-leg overrides have no producer yet — B8/C11 will add one),
 * so there is nothing to preserve here. The core `setLegMode` stays the
 * override API for that later slice.
 */
export function withDefaultMode(trip: Trip, mode: TravelModeId): Trip {
  if (trip.defaultMode === mode && trip.legs.every((l) => l.mode === mode)) return trip;
  return {
    ...trip,
    defaultMode: mode,
    legs: trip.legs.map((l) => ({ ...l, mode })),
  };
}

function coordsEqual(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Replace the whole stop list, keeping the identity (and the dwell, label,
 * place) of every stop whose coordinates did not move. This is what makes an
 * agent plan revision — or any legacy setter sequence — preserve unaffected
 * stops: same coordinates, same stop.
 *
 * Matching is by coordinate, not by position. Index-wise matching looks right
 * until a stop is INSERTED, which shifts every later stop by one and re-mints
 * the id and drops the dwell of all of them — exactly the "coffee then dinner"
 * case this model exists for. The same-index stop is still preferred so that
 * moving one stop onto another's old coordinates cannot steal its identity.
 */
export function replaceStops(trip: Trip, entries: StopEntry[]): Trip {
  const key = (c: [number, number]) => `${c[0]},${c[1]}`;
  const byCoord = new Map<string, Stop[]>();
  for (const stop of trip.stops) {
    const k = key(stop.coord);
    const bucket = byCoord.get(k);
    if (bucket) bucket.push(stop);
    else byCoord.set(k, [stop]);
  }
  const claimed = new Set<Stop>();

  const carryOver = (entry: StopEntry, existing: Stop): Stop => {
    const next: Stop = { ...existing };
    if (entry.label !== undefined) next.label = entry.label;
    if (entry.dwellMinutes !== undefined) {
      const dwell = normalizeDwellMinutes(entry.dwellMinutes);
      if (dwell > 0) next.dwellMinutes = dwell;
      else delete next.dwellMinutes;
    }
    if (entry.placeId !== undefined) {
      if (entry.placeId) next.placeId = entry.placeId;
      else delete next.placeId;
    }
    return next;
  };

  const stops = entries.map((entry, i) => {
    const sameIndex = trip.stops[i];
    if (sameIndex && !claimed.has(sameIndex) && coordsEqual(sameIndex.coord, entry.coord)) {
      claimed.add(sameIndex);
      return carryOver(entry, sameIndex);
    }
    const moved = byCoord.get(key(entry.coord))?.find((s) => !claimed.has(s));
    if (moved) {
      claimed.add(moved);
      return carryOver(entry, moved);
    }
    return makeStop(entry.coord, entry.label ?? null, {
      dwellMinutes: entry.dwellMinutes,
      placeId: entry.placeId,
    });
  });
  return withStops(trip, stops);
}

/**
 * Adapt a trip to C4's `RoutePlan` shape. The terminal contract and every C1
 * scenario stay unchanged: ids, dwell, modes and the time anchor are the
 * journey's business, the plan job only needs ordered stops and labels.
 */
export function tripToRoutePlan(trip: Trip): RoutePlan {
  if (trip.stops.length < 2) throw new Error("tripToRoutePlan needs at least two stops");
  const from = trip.stops[0];
  const to = trip.stops[trip.stops.length - 1];
  return {
    from: [...from.coord] as [number, number],
    to: [...to.coord] as [number, number],
    via: trip.stops.slice(1, -1).map((s) => [...s.coord] as [number, number]),
    fromLabel: from.label ?? "Start",
    toLabel: to.label ?? "Destination",
  };
}

/**
 * Each leg's departure: the previous departure plus that leg's travel plus
 * the dwell AT the stop it arrives at.
 *
 * This is the schedule, NOT what the router used. Every leg is still costed
 * against the shadow at the current map time; routing each leg at its own
 * departure is #365. A caller that shows these times must not imply the route
 * was chosen for them.
 */
export function legDepartureTimes(trip: Trip, legTravelSecs: number[]): Date[] {
  if (legTravelSecs.length !== trip.legs.length) {
    throw new Error(
      `legDepartureTimes needs one travel time per leg (${trip.legs.length}), got ${legTravelSecs.length}`,
    );
  }
  const departures: Date[] = [];
  let at = new Date(trip.departAt.instant).getTime();
  for (let i = 0; i < trip.legs.length; i++) {
    departures.push(new Date(at));
    const travel = Number.isFinite(legTravelSecs[i]) ? Math.max(0, legTravelSecs[i]) : 0;
    const dwell = normalizeDwellMinutes(trip.stops[i + 1]?.dwellMinutes) * 60000;
    at += travel * 1000 + dwell;
  }
  return departures;
}

export interface LegStats {
  distanceM: number;
  timeSec: number;
  shadowCoverage: number | null;
}

/**
 * Distance-weighted totals over per-leg stats, plus the dwell the journey
 * actually spends waiting: the *intermediate* stops only. Dwell at the origin
 * sits before `departAt` and dwell at the destination sits after arrival, so
 * neither delays a departure — counting them here would inflate the journey by
 * time `legDepartureTimes` does not spend. The two functions agree by
 * construction.
 */
export function tripTotals(trip: Trip, legs: LegStats[]): TripTotals {
  if (legs.length !== trip.legs.length) {
    throw new Error(
      `tripTotals needs one stat per leg (${trip.legs.length}), got ${legs.length}`,
    );
  }
  let distanceM = 0;
  let timeSec = 0;
  let shadowedM = 0;
  let shadowedDenomM = 0;
  for (const leg of legs) {
    distanceM += leg.distanceM;
    timeSec += leg.timeSec;
    if (leg.shadowCoverage != null) {
      shadowedM += leg.distanceM * leg.shadowCoverage;
      shadowedDenomM += leg.distanceM;
    }
  }
  for (const stop of trip.stops.slice(1, -1)) {
    timeSec += normalizeDwellMinutes(stop.dwellMinutes) * 60;
  }
  return {
    distanceM,
    timeSec,
    shadowCoverage: shadowedDenomM > 0 ? shadowedM / shadowedDenomM : null,
  };
}

import type { PartialRouteInfo } from "../partialRoute";
import type { RouteOption } from "../routing";
import type { TravelModeId } from "../travelMode";

/**
 * Track E's published contract: one first-class object for a multi-stop
 * journey. Track C's planner (C4/C11) and Track B's leg browser (B8) consume
 * this instead of the parallel waypoint arrays it replaces.
 *
 * Deliberately NOT here (C11's, when it lands): arrival windows,
 * uncertainties, expiration, version history. Extend these interfaces then —
 * they are plain data, nothing more.
 */
export interface Stop {
  /** Stable identity: survives add/remove/move/swap so a revision can show
   * which stops were unaffected. Positional indices cannot show that. */
  id: string;
  coord: [number, number];
  label: string | null;
  /** Minutes spent AT this stop before departing the next leg. Shifts every
   * later leg's departure, as `legDepartureTimes` computes it.
   *
   * NOTE: routing does NOT yet honour that shift — every leg is still costed
   * against the shadow at the current map time (see #365). Do not present a
   * leg as routed for its own departure hour until that lands. */
  dwellMinutes?: number;
  /** Foursquare id, when the stop came from a place. */
  placeId?: string;
}

export interface TripLeg {
  /** Indices into `stops`. Invariant: `legs[i]` is `{ from: i, to: i + 1 }` —
   * legs are positional, derived from stop order, never independently ordered. */
  from: number;
  to: number;
  mode: TravelModeId;
  route?: RouteOption;
  partial?: PartialRouteInfo;
}

/** One stop's worth of input for whole-list replacement. Every field except
 * `coord` is optional: an omitted field keeps the existing stop's value on an
 * exact-coordinate match, an explicit one overwrites it. */
export interface StopEntry {
  coord: [number, number];
  label?: string | null;
  dwellMinutes?: number;
  placeId?: string;
}

/** When the journey starts, anchored to a real zone (D0), not an offset. */
export interface TripDepartAt {
  /** Instant the first leg departs, ISO string. */
  instant: string;
  /** IANA zone the wall-clock reading belongs to (e.g. "Asia/Kolkata"). */
  zone: string;
}

export interface Trip {
  id: string;
  stops: Stop[];
  legs: TripLeg[];
  defaultMode: TravelModeId;
  departAt: TripDepartAt;
}

/**
 * Journey totals. Always DERIVED by `tripTotals`, never stored — a stored
 * copy goes stale on the next dwell edit and nothing would notice.
 */
export interface TripTotals {
  distanceM: number;
  /** Travel + dwell. Dwell is time spent standing still, and it counts. */
  timeSec: number;
  /** Distance-weighted mean over legs that have a route, or null while no
   * leg has been routed yet — unknown, not zero. */
  shadowCoverage: number | null;
}

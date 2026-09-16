/** Normalized output model: what build/ assembles into R2 shards. */

export interface StopNode {
  /** Namespaced id: "subway:101" or "bus:200001" (both feeds use bare numerics). */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Bus only: which borough feeds listed this stop. */
  feeds?: string[];
}

export interface RouteEdge {
  from: string;
  to: string;
  /** Subway: route_id (A, 1). Bus: display route (route_short_name, e.g. B1). */
  route: string;
  direction: number;
  medianSec: number;
  trips: number;
  distM: number;
}

export interface RouteInfo {
  id: string;
  shortName: string;
  longName: string;
  type: number;
  color: string;
  textColor: string;
  /** Bus only: how many route_id variants collapsed into this display route. */
  variants?: number;
}

export interface HeadwayRow {
  route: string;
  direction: number;
  dayType: DayType;
  /**
   * Hour of the service day, 0-27 — NOT a wall-clock hour of `dayType`. GTFS
   * puts a departure after midnight on the previous service day at 24:xx-27:xx,
   * so hours 24+ are the early morning of `representativeDates[dayType].nextDate`.
   *
   * Hours 0-3 and 24-27 are both "around midnight" and must not be merged: they
   * are different calendar days with different service. The 7 train weekday
   * direction 0 ships hour 1 at 1200 s and hour 24 at 570 s.
   */
  hour: number;
  medianSec: number;
  trips: number;
  /** How many distinct service_ids fed this bucket (variant overlap signal). */
  services: number;
}

export type DayType = "weekday" | "saturday" | "sunday";

/** Representative simplified shape per "route:direction", points as [lon, lat]. */
export type ShapeMap = Record<string, [number, number][]>;

export interface TransferEdge {
  from: string;
  to: string;
  minSec: number;
  /** "gtfs" (transfers.txt) or "spatial" (nearest-stop stub). */
  kind: "gtfs" | "spatial";
}

export interface FeedVersion {
  id: string;
  version: string;
  startDate: string;
  endDate: string;
  sha256: string;
}

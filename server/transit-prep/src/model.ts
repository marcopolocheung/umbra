/** Normalized output model: what build/ assembles into R2 shards. */

export interface StopNode {
  /** Namespaced id: "subway:101" or "bus:200001" (both feeds use bare numerics). */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Bus only: which borough feeds listed this stop. */
  feeds?: string[];
  /**
   * Subway only: seconds to change between lines *inside* this station, from
   * its `transfers.txt` self-transfer row, taken verbatim.
   *
   * Collapsing directional children into one parent node makes the change
   * invisible in the graph, and the self-transfer row is the only thing that
   * prices it. The values are graded and meaningful: 0 at cross-platform
   * interchanges (72 St, Times Sq and 14 St on the 1/2/3; Grand Central and
   * Union Sq on the 4/5/6), 180 for a typical in-station change, 300 at the
   * big complexes (Penn Station, Atlantic Av-Barclays, Rockefeller Ctr). 0 is
   * data, not a missing value, so it is never replaced by a fallback.
   *
   * Absent when the feed states nothing — 11 stations, all same-platform pairs
   * such as 135 St [2,3] and 72 St [N,Q]. Left unstated rather than defaulted,
   * so no number appears that the agency did not give.
   */
  changeSec?: number;
}

export interface RouteEdge {
  from: string;
  to: string;
  /** Subway: route_id (A, 1). Bus: display route (route_short_name, e.g. B1). */
  route: string;
  direction: number;
  medianSec: number;
  trips: number;
  /**
   * Distance between the two stops: along the track when `geom` was sliced,
   * the straight-line haversine between the node coordinates otherwise.
   */
  distM: number;
  /**
   * The track between the two stops, as a Google encoded polyline (precision 5)
   * of the GTFS shape points strictly *between* them — the endpoints are the
   * stops, which the shard already carries.
   *
   * Absent means one of two things, and neither is a licence to guess: the
   * shape doubled back between the stops so no sub-path between them exists
   * (32 of 24,354 NYC edges), or both stops landed on one shape segment so
   * there is nothing between them. A client draws the straight chord either
   * way. See `docs/notes/transit-edge-geometry.md`.
   */
  geom?: string;
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

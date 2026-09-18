/**
 * Joins each subway station to the doors OSM says are its own.
 *
 * GTFS publishes no entrances for NYC, and the client used to recover them at
 * run time: every `railway=subway_entrance` within 400 m, given to a station by
 * name or else to the nearest GTFS point. That knows nothing about which line a
 * door serves. At Grand Central it handed two Metro-North terminal doors to the
 * 7, because they sat nearest the 7's point.
 *
 * OSM already records the attribution. A `public_transport=stop_area` relation
 * groups one station's platforms and doors, and Grand Central has one each for
 * the 7, the 4/5/6, the S and the terminal. So the join runs station → a
 * platform of a line that stops there → the stop area holding that platform →
 * its doors. Measured against the 2026-09-18 generation it resolves 476 of 496
 * stations; the rest are Staten Island Railway stations, where OSM maps no
 * entrance nodes, plus Newkirk Plaza and Canarsie–Rockaway Pkwy.
 */

import type { StopNode } from "./model";
import { EXCLUDED_OPERATOR, type OsmRelation, type OsmWay, osmRefFor } from "./structure";
import { type LatLon, projectOnSegment } from "./util";

export interface OsmNode {
  type?: string;
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface StationEntrance {
  lat: number;
  lon: number;
  /** `entrance=exit`: a way out that is no way in. */
  exitOnly?: true;
}

export interface EntranceStats {
  stations: number;
  /** Stations given at least one door. */
  resolved: number;
  /** Of those, how many were matched by the platform's own `gtfs:stop_id`. */
  byTag: number;
  doors: number;
  /** Station ids that end up with an empty list, for the build log. */
  unresolved: string[];
}

/**
 * How far a station's GTFS point may sit from a platform of one of its lines.
 * The point is one coordinate for a platform that can run 200 m; beyond this a
 * nearest platform is more likely the next station's than this one's.
 */
const MAX_PLATFORM_M = 250;

/**
 * A door OSM says a rider cannot use: `access=no|private`, or an emergency
 * exit. The client drops the same set when it fetches doors itself (#428).
 *
 * **Not `open=no`.** All 31 NYC entrances carrying it also carry `door=hinged`
 * or `door=swinging`: it describes a door that is kept shut, not a way that is
 * closed. It is the only door at Neck Rd, Ocean Pkwy, Avenue X and 86 St (N),
 * and reading it as closed left those stations with none.
 */
function isUnusable(tags: Record<string, string> = {}): boolean {
  return tags.access === "no" || tags.access === "private" || tags.entrance === "emergency";
}

/** Metres to a platform's outline, or 0 from inside a closed one. */
function distanceToPlatform(p: LatLon, geometry: LatLon[]): number {
  const first = geometry[0] as LatLon;
  const last = geometry[geometry.length - 1] as LatLon;
  if (geometry.length > 3 && first.lat === last.lat && first.lon === last.lon) {
    let inside = false;
    for (let i = 1; i < geometry.length; i += 1) {
      const a = geometry[i - 1] as LatLon;
      const b = geometry[i] as LatLon;
      if (a.lat > p.lat !== b.lat > p.lat) {
        const lonAt = a.lon + ((p.lat - a.lat) / (b.lat - a.lat)) * (b.lon - a.lon);
        if (p.lon < lonAt) inside = !inside;
      }
    }
    if (inside) return 0;
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < geometry.length; i += 1) {
    const { distM } = projectOnSegment(p, geometry[i - 1] as LatLon, geometry[i] as LatLon);
    if (distM < best) best = distM;
  }
  return best;
}

/** `R16N` and `R16S` are the two directions of station `R16`. */
function gtfsStationIds(tag: string): string[] {
  return tag
    .split(";")
    .map((id) => id.trim())
    .map((id) => (id.length > 3 && /[NS]$/.test(id) ? id.slice(0, -1) : id));
}

/**
 * Attaches `entrances` to every subway stop. An empty list is a finding — OSM
 * maps no door there — and is published as such, so a client can tell it from
 * a generation built without this join, which carries no field at all.
 */
export function attachEntrances(
  stops: StopNode[],
  routesByStop: Map<string, Set<string>>,
  osm: { relations: OsmRelation[]; ways: OsmWay[]; stopAreas: OsmRelation[]; entrances: OsmNode[] },
): { stops: StopNode[]; stats: EntranceStats } {
  const refsByPlatform = new Map<number, Set<string>>();
  for (const relation of osm.relations) {
    if (EXCLUDED_OPERATOR.test(relation.tags?.operator ?? "")) continue;
    const ref = relation.tags?.ref;
    if (!ref) continue;
    for (const member of relation.members ?? []) {
      if (member.type !== "way" || !member.role.startsWith("platform")) continue;
      let refs = refsByPlatform.get(member.ref);
      if (!refs) {
        refs = new Set();
        refsByPlatform.set(member.ref, refs);
      }
      refs.add(ref);
    }
  }
  const platforms = osm.ways.filter(
    (way) => refsByPlatform.has(way.id) && way.geometry && way.geometry.length >= 2,
  );

  const stopAreasByPlatform = new Map<number, OsmRelation[]>();
  for (const area of osm.stopAreas) {
    for (const member of area.members ?? []) {
      if (member.type !== "way") continue;
      const list = stopAreasByPlatform.get(member.ref) ?? [];
      list.push(area);
      stopAreasByPlatform.set(member.ref, list);
    }
  }
  const doorById = new Map(osm.entrances.map((node) => [node.id, node]));

  const stats: EntranceStats = { stations: 0, resolved: 0, byTag: 0, doors: 0, unresolved: [] };
  const out = stops.map((stop) => {
    if (!stop.id.startsWith("subway:")) return stop;
    stats.stations += 1;
    const refs = new Set([...(routesByStop.get(stop.id) ?? [])].map(osmRefFor));
    const serving = platforms.filter((way) =>
      [...(refsByPlatform.get(way.id) as Set<string>)].some((ref) => refs.has(ref)),
    );

    // One platform, so one station: taking the nearest platform *per line*
    // merged neighbours at Nostrand Av and Lex/63 St, where a line's OSM route
    // skips the station and its nearest platform is the next one's.
    const gtfsId = stop.id.slice("subway:".length);
    let platform = serving.find((way) =>
      gtfsStationIds(way.tags?.["gtfs:stop_id"] ?? "").includes(gtfsId),
    );
    if (platform) stats.byTag += 1;
    else {
      let bestM = MAX_PLATFORM_M;
      for (const way of serving) {
        const d = distanceToPlatform(stop, way.geometry as LatLon[]);
        if (d < bestM) {
          bestM = d;
          platform = way;
        }
      }
    }

    const entrances: StationEntrance[] = [];
    const seen = new Set<number>();
    for (const area of platform ? (stopAreasByPlatform.get(platform.id) ?? []) : []) {
      for (const member of area.members ?? []) {
        const door = member.type === "node" ? doorById.get(member.ref) : undefined;
        if (!door || seen.has(door.id) || isUnusable(door.tags)) continue;
        seen.add(door.id);
        entrances.push({
          lat: door.lat,
          lon: door.lon,
          ...(door.tags?.entrance === "exit" ? { exitOnly: true as const } : {}),
        });
      }
    }
    if (entrances.length > 0) stats.resolved += 1;
    else stats.unresolved.push(stop.id);
    stats.doors += entrances.length;
    return { ...stop, entrances };
  });
  return { stops: out, stats };
}

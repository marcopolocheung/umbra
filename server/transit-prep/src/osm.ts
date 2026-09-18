/**
 * Acquires the OSM subway geometry the structure join needs, and the station
 * groupings the entrance join needs, and caches both.
 *
 * Two Overpass queries, about 5 MB together: the subway route relations (which
 * service runs over which way) and the geometry and tags of the ways those
 * relations contain. Restricting ways to relation members is both smaller and
 * more correct than a bbox sweep — it excludes the 43% of `railway=subway` ways
 * that are yards, sidings and crossovers and carry no riders.
 *
 * **A build must never depend on Overpass being up.** The result is cached
 * under `raw/osm/` with a receipt, exactly as the GTFS zips are, and `build`
 * reads only the cache. Refreshing is an explicit step. This is not a
 * hypothetical: over the 2026-09-17 session `overpass-api.de` and
 * `overpass.kumi.systems` both returned 504 on queries of a few hundred KB.
 *
 * A Geofabrik extract was the other candidate and is the wrong tool here: it
 * would mean a 400 MB state-wide download and a `.osm.pbf` parser dependency to
 * recover the ~3,700 ways we actually want, where Overpass answers exactly that
 * question natively. Caching, not a different source, is what removes the
 * build-time dependency.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OsmNode } from "./entrances";
import type { OsmRelation, OsmWay } from "./structure";
import { json, requireRoot, sha256, writeJson } from "./util";

/** The five boroughs plus enough margin for the Rockaways and Staten Island. */
export const NYC_BBOX = { south: 40.4, west: -74.3, north: 40.95, east: -73.6 };

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** OSM policy requires a real, identifying User-Agent. A server can send one. */
const USER_AGENT = "Umbra/1.0 (+https://shademapnav.vercel.app)";
const ATTEMPT_TIMEOUT_MS = 240_000;

const bbox = () => `${NYC_BBOX.south},${NYC_BBOX.west},${NYC_BBOX.north},${NYC_BBOX.east}`;

const RELATIONS_QL = () =>
  `[out:json][timeout:240];rel["type"="route"]["route"="subway"](${bbox()});out body;`;
const WAYS_QL = () =>
  `[out:json][timeout:240];rel["type"="route"]["route"="subway"](${bbox()});way(r);out tags geom;`;
/**
 * Every stop area and the subway doors it lists, in one answer: the relations
 * say which platforms and doors form a station, the nodes say where each door
 * is and whether it is usable.
 */
const STOP_AREAS_QL = () =>
  `[out:json][timeout:240];rel["public_transport"="stop_area"](${bbox()})->.s;.s out body;node(r.s)["railway"="subway_entrance"];out body;`;

export interface OsmReceipt {
  fetchedAt: string;
  endpoint: string;
  bbox: typeof NYC_BBOX;
  relations: { count: number; bytes: number; sha256: string };
  ways: { count: number; bytes: number; sha256: string };
  /** Absent from a cache acquired before the entrance join existed. */
  stopAreas?: { count: number; entrances: number; bytes: number; sha256: string };
}

export interface OsmCache {
  relations: OsmRelation[];
  ways: OsmWay[];
  /**
   * `public_transport=stop_area` relations and the `railway=subway_entrance`
   * nodes they list. Both absent from an older cache, which still serves the
   * structure join; the build then publishes no entrances at all.
   */
  stopAreas?: OsmRelation[];
  entrances?: OsmNode[];
  receipt: OsmReceipt;
}

const osmDir = () => join(requireRoot(), "raw", "osm");

/**
 * Posts one query, trying each endpoint in turn.
 *
 * Failing over rather than pinning one mirror: the public instances are
 * individually unreliable, and this runs rarely enough that politeness is
 * satisfied by not retrying a mirror that already answered.
 */
async function overpass(query: string, label: string): Promise<{ body: string; endpoint: string }> {
  const failures: string[] = [];
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) {
        failures.push(`${endpoint} HTTP ${response.status}`);
        continue;
      }
      const body = await response.text();
      if (body.trimStart().startsWith("<")) {
        failures.push(`${endpoint} returned XML (an Overpass error page)`);
        continue;
      }
      return { body, endpoint };
    } catch (error) {
      failures.push(`${endpoint} ${(error as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`OSM ${label} query failed on every endpoint: ${failures.join(" | ")}`);
}

/**
 * Fetches both queries and writes them to the cache. Network step; run it
 * deliberately, not as part of a build.
 */
export async function acquireOsm(): Promise<OsmReceipt> {
  const directory = osmDir();
  await mkdir(directory, { recursive: true });

  const relationsResponse = await overpass(RELATIONS_QL(), "relations");
  const waysResponse = await overpass(WAYS_QL(), "ways");
  const stopAreasResponse = await overpass(STOP_AREAS_QL(), "stop areas");

  const relations = (JSON.parse(relationsResponse.body).elements ?? []).filter(
    (element: { type: string }) => element.type === "relation",
  ) as OsmRelation[];
  const ways = (JSON.parse(waysResponse.body).elements ?? []).filter(
    (element: { type: string }) => element.type === "way",
  ) as OsmWay[];

  const stopAreaElements = JSON.parse(stopAreasResponse.body).elements ?? [];
  const stopAreas = stopAreaElements.filter(
    (element: { type: string }) => element.type === "relation",
  ) as OsmRelation[];
  const entrances = stopAreaElements.filter(
    (element: { type: string }) => element.type === "node",
  ) as OsmNode[];

  if (relations.length === 0) throw new Error("OSM returned no subway route relations");
  if (ways.length === 0) throw new Error("OSM returned no subway ways");
  if (stopAreas.length === 0) throw new Error("OSM returned no stop areas");
  if (entrances.length === 0) throw new Error("OSM returned no subway entrances");

  const encoder = new TextEncoder();
  const receipt: OsmReceipt = {
    fetchedAt: new Date().toISOString(),
    endpoint: waysResponse.endpoint,
    bbox: NYC_BBOX,
    relations: {
      count: relations.length,
      bytes: relationsResponse.body.length,
      sha256: sha256(encoder.encode(relationsResponse.body)),
    },
    ways: {
      count: ways.length,
      bytes: waysResponse.body.length,
      sha256: sha256(encoder.encode(waysResponse.body)),
    },
    stopAreas: {
      count: stopAreas.length,
      entrances: entrances.length,
      bytes: stopAreasResponse.body.length,
      sha256: sha256(encoder.encode(stopAreasResponse.body)),
    },
  };

  await writeJson(join(directory, "relations.json"), relations);
  await writeJson(join(directory, "ways.json"), ways);
  await writeJson(join(directory, "stop_areas.json"), stopAreas);
  await writeJson(join(directory, "entrances.json"), entrances);
  await writeJson(join(directory, "receipt.json"), receipt);
  return receipt;
}

/**
 * Reads the cached OSM data, or `null` when it has never been acquired.
 *
 * `null` rather than a throw: the structure join is additive, and a generation
 * built without it is still a valid generation. `build` says so out loud rather
 * than failing, so the pipeline keeps working on a machine that has not fetched
 * OSM yet.
 */
export async function readOsm(): Promise<OsmCache | null> {
  const directory = osmDir();
  try {
    const [relations, ways, receipt] = await Promise.all([
      json<OsmRelation[]>(join(directory, "relations.json")),
      json<OsmWay[]>(join(directory, "ways.json")),
      json<OsmReceipt>(join(directory, "receipt.json")),
    ]);
    const cache: OsmCache = { relations, ways, receipt };
    // Optional on its own: a cache from before the entrance join is still a
    // cache, and the structure join must not lose it.
    try {
      const [stopAreas, entrances] = await Promise.all([
        json<OsmRelation[]>(join(directory, "stop_areas.json")),
        json<OsmNode[]>(join(directory, "entrances.json")),
      ]);
      cache.stopAreas = stopAreas;
      cache.entrances = entrances;
    } catch {
      // Acquired before stop areas were; build publishes no entrances.
    }
    return cache;
  } catch {
    return null;
  }
}

/** Test seam: the fixtures write a cache directly rather than hitting Overpass. */
export async function writeOsmCache(cache: OsmCache): Promise<void> {
  const directory = osmDir();
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "relations.json"), cache.relations);
  await writeJson(join(directory, "ways.json"), cache.ways);
  if (cache.stopAreas && cache.entrances) {
    await writeJson(join(directory, "stop_areas.json"), cache.stopAreas);
    await writeJson(join(directory, "entrances.json"), cache.entrances);
  }
  await writeJson(join(directory, "receipt.json"), cache.receipt);
}

/**
 * Acquires the OSM subway geometry the structure join needs, and the station
 * groupings the entrance join needs, and caches both.
 *
 * Subway route relations (which service runs over which way) and the geometry
 * and tags of the ways those relations contain, about 5 MB together, plus the
 * pedestrian ways around every subway station that `walkability.ts` routes a
 * subway↔bus change over. Restricting ways to relation members is both smaller and
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OsmNode } from "./entrances";
import { loadStops } from "./gtfs";
import { FEED_SOURCES } from "./sources";
import type { OsmRelation, OsmWay } from "./structure";
import { json, requireRoot, sha256, writeJson } from "./util";
import type { FootwayWay } from "./walkability";

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

/**
 * Pedestrian ways within this distance of a station point. A stub reaches 200 m
 * from the station and the farthest doors stand ~400 m out at the big
 * complexes, so a path that leaves this circle is a false refusal, never a
 * false promotion — the check can only fail safe on what it was not given.
 */
export const FOOTWAY_RADIUS_M = 350;
/**
 * Stations per Overpass request. The whole city in one union is ~60 MB and the
 * public instances refuse it as "too busy" far more often than they answer;
 * fifty stations is ~8 MB and usually goes through on the first or second try.
 */
const FOOTWAY_BATCH = 50;
const FOOTWAY_ROUNDS = 6;
const FOOTWAY_PAUSE_MS = 20_000;
/**
 * What a pedestrian may walk on. Everything tagged `highway` except roads
 * pedestrians are barred from (motorways, and anything `foot=no`, `private` or
 * `use_sidepath` — the last meaning the pavement is mapped as its own way) and
 * things that are not a way at all yet (`construction`, `proposed`). Kept in the
 * receipt, since it is part of what "walkable" means.
 */
export const FOOTWAY_FILTER =
  '["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|abandoned|platform|raceway|bus_guideway|busway)$"]["foot"!~"^(no|private|use_sidepath)$"]["access"!~"^(no|private)$"]';

const FOOTWAYS_QL = (anchors: { lat: number; lon: number }[]) =>
  `[out:json][timeout:180];(${anchors
    .map((a) => `way${FOOTWAY_FILTER}(around:${FOOTWAY_RADIUS_M},${a.lat.toFixed(6)},${a.lon.toFixed(6)});`)
    .join("")});out skel geom qt;`;

export interface OsmReceipt {
  fetchedAt: string;
  endpoint: string;
  bbox: typeof NYC_BBOX;
  relations: { count: number; bytes: number; sha256: string };
  ways: { count: number; bytes: number; sha256: string };
  /** Absent from a cache acquired before the entrance join existed. */
  stopAreas?: { count: number; entrances: number; bytes: number; sha256: string };
  /** Absent from a cache acquired before the walkability check existed. */
  footways?: {
    count: number;
    anchors: number;
    radiusM: number;
    filter: string;
    bytes: number;
    /** Of `footways.json` as written, which is what `build` and `verify` read. */
    sha256: string;
  };
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
  /**
   * The pedestrian ways around every subway station, and the SHA-256 of the
   * file they were read from — computed on read, not copied from the receipt,
   * so a manifest records the bytes its transfers were actually routed on.
   * Absent from an older cache; the build then promotes no stub.
   */
  footways?: FootwayWay[];
  footwaysSha256?: string;
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
 * `overpass`, retried in rounds: the footway batches are the heaviest thing
 * this pipeline asks for, and "too busy" is an answer that changes minutes
 * later, not a verdict.
 */
async function overpassPatiently(query: string, label: string): Promise<{ body: string; endpoint: string }> {
  for (let round = 1; ; round += 1) {
    try {
      return await overpass(query, label);
    } catch (error) {
      if (round >= FOOTWAY_ROUNDS) throw error;
      await new Promise((resolve) => setTimeout(resolve, FOOTWAY_PAUSE_MS));
    }
  }
}

/**
 * The pedestrian ways within `FOOTWAY_RADIUS_M` of every subway parent station
 * in the local GTFS, deduplicated by way id and sorted, so the same OSM state
 * writes the same bytes.
 */
async function acquireFootways(): Promise<{ ways: FootwayWay[]; anchors: number }> {
  const source = FEED_SOURCES.find((item) => item.id === "subway");
  if (!source) throw new Error("subway source missing");
  const { stops } = loadStops(await readFile(join(requireRoot(), source.workDir, "stops.txt"), "utf8"));
  const anchors = stops.filter((stop) => stop.locationType === 1);
  if (anchors.length === 0) throw new Error("no subway parent stations to fetch footways around (run acquire first)");
  const byId = new Map<number, FootwayWay>();
  for (let i = 0; i < anchors.length; i += FOOTWAY_BATCH) {
    const batch = anchors.slice(i, i + FOOTWAY_BATCH);
    const { body } = await overpassPatiently(FOOTWAYS_QL(batch), `footways ${i / FOOTWAY_BATCH + 1}`);
    for (const element of JSON.parse(body).elements ?? []) {
      if (element.type !== "way" || byId.has(element.id)) continue;
      const nodes = element.nodes as number[];
      const geometry = element.geometry as { lat: number; lon: number }[];
      if (!Array.isArray(nodes) || !Array.isArray(geometry) || nodes.length !== geometry.length) continue;
      byId.set(element.id, {
        id: element.id,
        nodes,
        coords: geometry.flatMap((point) => [point.lat, point.lon]),
      });
    }
  }
  return { ways: [...byId.values()].sort((a, b) => a.id - b.id), anchors: anchors.length };
}

/**
 * Fetches every query and writes them to the cache. Network step; run it
 * deliberately, not as part of a build.
 */
export async function acquireOsm(): Promise<OsmReceipt> {
  const directory = osmDir();
  await mkdir(directory, { recursive: true });

  const relationsResponse = await overpass(RELATIONS_QL(), "relations");
  const waysResponse = await overpass(WAYS_QL(), "ways");
  const stopAreasResponse = await overpass(STOP_AREAS_QL(), "stop areas");
  const footways = await acquireFootways();

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
  if (footways.ways.length === 0) throw new Error("OSM returned no pedestrian ways");
  // Compact, not pretty-printed: ~120k ways, and the hash is of these bytes.
  const footwayBytes = JSON.stringify(footways.ways);

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
    footways: {
      count: footways.ways.length,
      anchors: footways.anchors,
      radiusM: FOOTWAY_RADIUS_M,
      filter: FOOTWAY_FILTER,
      bytes: footwayBytes.length,
      sha256: sha256(encoder.encode(footwayBytes)),
    },
  };

  await writeJson(join(directory, "relations.json"), relations);
  await writeJson(join(directory, "ways.json"), ways);
  await writeJson(join(directory, "stop_areas.json"), stopAreas);
  await writeJson(join(directory, "entrances.json"), entrances);
  await writeFile(join(directory, "footways.json"), footwayBytes);
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
    try {
      const bytes = await readFile(join(directory, "footways.json"));
      cache.footways = JSON.parse(bytes.toString("utf8")) as FootwayWay[];
      cache.footwaysSha256 = sha256(new Uint8Array(bytes));
    } catch {
      // Acquired before the walkability check; build promotes no stub.
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
  if (cache.footways) await writeFile(join(directory, "footways.json"), JSON.stringify(cache.footways));
  await writeJson(join(directory, "receipt.json"), cache.receipt);
}

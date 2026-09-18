/**
 * Step 5: assemble the 8 R2 shard objects + manifest.json under
 * normalized/<gen>/, enforcing the size budget and count baselines.
 * Shards are sharded per borough so the client lazy-loads only the
 * boroughs intersecting its bbox; bus edges reference the shared global
 * stop registry, which ships inside every bus shard that needs it.
 */

import { normalizeBus, type BusNormalized } from "./normalizeBus";
import { normalizeSubway, type SubwayNormalized } from "./normalizeSubway";
import { FEED_SOURCES } from "./sources";
import { buildSpatialStubs, SPATIAL_TRANSFER_CAP_PER_STATION, SPATIAL_TRANSFER_RADIUS_M, SPATIAL_WALK_MPS } from "./transfers";
import type {
  DayType,
  FeedVersion,
  HeadwayRow,
  RouteEdge,
  RouteInfo,
  StopNode,
  TransferEdge,
} from "./model";
import type { RepresentativeDates } from "./serviceCalendar";
import { readReceipts } from "./receipts";
import { readOsm } from "./osm";
import { attachStructure, buildStructureIndex, type StructureStats } from "./structure";
import { requireRoot, sha256, writeJson } from "./util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SHARD_BUDGET_BYTES = 3_000_000;
export const TOTAL_BUDGET_BYTES = 15_000_000;

export type RepresentativeSummary = Record<
  DayType,
  {
    date: string;
    /** Where this table's hours 24-27 land; see HeadwayRow.hour. */
    nextDate: string;
    nextDayType: DayType;
    matchingDates: number;
    candidateDates: number;
  } | null
>;

export interface ShardBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ShardRecord {
  key: string;
  bytes: number;
  sha256: string;
  stops: number;
  edges: number;
  routes: number;
  /**
   * The extent of the stops this shard ships, so a client can tell whether it
   * covers a bbox without downloading it (#388). Computed, never the borough
   * the shard is named after: shards are self-contained, so the S53 over the
   * Verrazzano puts Staten Island stops in `bus-b`.
   */
  bounds: ShardBounds;
}

export interface GenerationManifest {
  generation: string;
  createdAt: string;
  /** Honesty label for the transit card (Step 6 reads this). */
  schedulesAsOf: Record<string, { version: string; startDate: string; endDate: string }>;
  /**
   * Which single date each headway table describes, per dataset, and how many
   * candidate dates of that day type share its service pattern. The transit
   * card needs this to say "typical weekday" honestly.
   */
  headwayDates: {
    referenceDate: string;
    subway?: RepresentativeSummary;
    bus?: RepresentativeSummary;
  };
  feeds: FeedVersion[];
  shards: ShardRecord[];
  budgets: { shardBytes: number; totalBytes: number };
  constants: {
    spatialTransferRadiusM: number;
    spatialTransferCapPerStation: number;
    spatialWalkMps: number;
    subwayMaxKmh: number;
    busMaxKmh: number;
  };
  notes: string[];
}

/**
 * The bounding box of a shard's own stops.
 *
 * An empty shard throws rather than publishing an infinite or null extent: the
 * client refuses a malformed `bounds` outright, so it would take the whole
 * manifest down — and every dataset the pipeline builds has stops.
 */
function stopBounds(key: string, stops: StopNode[]): ShardBounds {
  if (stops.length === 0) throw new Error(`${key}: no stops to compute bounds from`);
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const stop of stops) {
    if (stop.lat < south) south = stop.lat;
    if (stop.lat > north) north = stop.lat;
    if (stop.lon < west) west = stop.lon;
    if (stop.lon > east) east = stop.lon;
  }
  return { south, west, north, east };
}

export interface NormalizeOptions {
  only?: "subway" | "bus";
  updateBaseline?: boolean;
  /**
   * Where the search for each day type's representative date starts, YYYYMMDD.
   * Defaults to the build date; the manifest records what was used, so a
   * generation can be rebuilt exactly.
   */
  referenceDate?: string;
}

export interface BaselineCounts {
  subwayParents: number;
  busUniqueStops: number;
}

export const CURRENT_BASELINE: BaselineCounts = {
  subwayParents: 496,
  busUniqueStops: 13461,
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Content-addressed generation id: `nyc-<date>-<hash12>`. The date orders the
 * directories for a human; the hash is what discriminates.
 *
 * It replaces a 24-character slice of the seven feed_version strings joined
 * together, which discriminated almost nothing. The subway version alone
 * ("20260826-X-long-term-supplement-trip-ids") is 40 characters once
 * punctuation is stripped, so the slice dropped all six bus picks and cut the
 * subway string mid-word: a quarterly bus pick rebuilt the same day reused the
 * id, and reusing an id overwrites shards already served
 * `Cache-Control: immutable`. Hashing the shard bytes as well as the feed
 * identities means a pipeline change earns a new id too, which a hash over the
 * upstream inputs alone would not.
 */
export function generationId(
  feeds: FeedVersion[],
  shards: { key: string; sha256: string }[],
  at: Date,
): string {
  // Sorted so neither receipt order nor shard order can move the hash.
  const identity = [
    ...feeds.map((feed) => `feed\t${feed.id}\t${feed.version}\t${feed.sha256}`),
    ...shards.map((shard) => `shard\t${shard.key}\t${shard.sha256}`),
  ].sort();
  const digest = sha256(new TextEncoder().encode(identity.join("\n")));
  return `nyc-${at.toISOString().slice(0, 10)}-${digest.slice(0, 12)}`;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export interface BusShard {
  kind: "bus-shard";
  feed: string;
  feeds: FeedVersion[];
  stops: StopNode[];
  edges: RouteEdge[];
  routes: RouteInfo[];
  headways: HeadwayRow[];
  stats: BusNormalized["stats"];
}

/**
 * One borough's shard. An edge belongs to it when either endpoint stop was
 * listed by that borough's feed (a boundary stop appears in both), and
 * everything else — routes, shapes, headways — is scoped to the routes those
 * edges actually use.
 *
 * Scoping the routes is the point: shipping the city-wide table in all six
 * shards was byte-identical duplication inside a 15 MB budget.
 */
export function busShard(bus: BusNormalized, feedId: string): BusShard {
  const stopById = new Map(bus.stops.map((stop) => [stop.id, stop]));
  const listedBy = (stopId: string): boolean =>
    (stopById.get(stopId)?.feeds ?? []).includes(feedId);
  const stops = new Map<string, StopNode>();
  const edges: RouteEdge[] = [];
  const used = new Set<string>();
  for (const edge of bus.edges) {
    if (!listedBy(edge.from) && !listedBy(edge.to)) continue;
    edges.push(edge);
    used.add(edge.route);
    const from = stopById.get(edge.from);
    const to = stopById.get(edge.to);
    if (from) stops.set(from.id, from);
    if (to) stops.set(to.id, to);
  }
  return {
    kind: "bus-shard",
    feed: feedId,
    feeds: bus.feeds,
    stops: [...stops.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges,
    routes: bus.routes.filter((route) => used.has(route.id)),
    headways: bus.headways.filter((row) => used.has(row.route)),
    stats: bus.stats,
  };
}

export async function normalizeAll(options?: NormalizeOptions): Promise<{
  subway: SubwayNormalized | null;
  bus: BusNormalized | null;
  stubs: TransferEdge[];
  referenceDate: string;
}> {
  const root = requireRoot();
  const { receipts } = await readReceipts();
  const versionOf = (id: string): FeedVersion => {
    const receipt = receipts.find((item) => item.id === id);
    if (!receipt) throw new Error(`no receipt for ${id} (run receipts first)`);
    return {
      id,
      version: receipt.feedVersion,
      startDate: receipt.feedStartDate,
      endDate: receipt.feedEndDate,
      sha256: receipt.sha256,
    };
  };
  const subwaySource = FEED_SOURCES.find((item) => item.id === "subway");
  if (!subwaySource) throw new Error("subway source missing");
  const busSources = FEED_SOURCES.filter((item) => item.kind === "bus");

  const referenceDate = options?.referenceDate ?? todayUtc();
  const subway =
    !options?.only || options.only === "subway"
      ? await normalizeSubway(root, subwaySource.workDir, versionOf("subway"), referenceDate)
      : null;
  const bus =
    !options?.only || options.only === "bus"
      ? await normalizeBus(
          root,
          busSources.map((source) => ({ feedId: source.id, dir: source.workDir })),
          busSources.map((source) => versionOf(source.id)),
          referenceDate,
        )
      : null;

  // Baselines pin the validated real-world counts; a new pick that genuinely
  // changes them must pass --update-baseline consciously.
  if (subway && subway.stops.length !== CURRENT_BASELINE.subwayParents && !options?.updateBaseline) {
    throw new Error(`subway parent count ${subway.stops.length} != baseline ${CURRENT_BASELINE.subwayParents} (new pick? re-run with --update-baseline)`);
  }
  if (bus && bus.stops.length !== CURRENT_BASELINE.busUniqueStops && !options?.updateBaseline) {
    throw new Error(`bus stop count ${bus.stops.length} != baseline ${CURRENT_BASELINE.busUniqueStops} (new pick? re-run with --update-baseline)`);
  }

  const stubs =
    subway && bus ? buildSpatialStubs(subway.stops, bus.stops) : [];
  return { subway, bus, stubs, referenceDate };
}

export async function buildGeneration(options?: NormalizeOptions): Promise<{
  generation: string;
  manifest: GenerationManifest;
  directory: string;
  /** Absent when OSM has not been acquired; the shard then ships no structure. */
  structure?: StructureStats;
}> {
  const root = requireRoot();
  const { subway, bus, stubs, referenceDate } = await normalizeAll(options);
  const { receipts } = await readReceipts();

  const objects: { key: string; value: unknown }[] = [];
  let structureStats: StructureStats | undefined;
  if (subway) {
    // All spatial stubs touch a subway node by construction; they ship with
    // the subway shard, along with the bus stops they reference, so the
    // shard stays self-contained (and strictly verifiable) on its own.
    const subwayStops = new Map(subway.stops.map((stop) => [stop.id, stop]));
    if (bus) {
      const referenced = new Set<string>();
      for (const stub of stubs) {
        referenced.add(stub.from);
        referenced.add(stub.to);
      }
      for (const stop of bus.stops) {
        if (!subwayStops.has(stop.id) && referenced.has(stop.id)) {
          subwayStops.set(stop.id, stop);
        }
      }
    }
    const allSubwayStops = [...subwayStops.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

    // Per-segment structure, where OSM has been acquired. Additive and
    // optional: without the cache the shard is the same shard it was, minus
    // one field, and the client already treats its absence as "unknown".
    const osm = await readOsm();
    let edges = subway.edges;
    if (osm) {
      const attached = attachStructure(
        subway.edges,
        allSubwayStops,
        buildStructureIndex(osm.relations, osm.ways),
      );
      edges = attached.edges;
      structureStats = attached.stats;
    }

    objects.push({
      key: "subway.json",
      value: {
        ...subway,
        stops: allSubwayStops,
        edges,
        transfers: [...subway.transfers, ...stubs],
      },
    });
  }
  if (bus) {
    for (const source of FEED_SOURCES.filter((item) => item.kind === "bus")) {
      objects.push({ key: source.shard, value: busShard(bus, source.id) });
    }
  }

  // Encode and budget-check every shard before anything is written: the
  // generation id hashes the shard bytes, so the directory it names is not
  // known until they all exist.
  const shards: ShardRecord[] = [];
  const encoded: { key: string; bytes: Uint8Array }[] = [];
  let totalBytes = 0;
  for (const { key, value } of objects) {
    const bytes = encode(value);
    if (bytes.length > SHARD_BUDGET_BYTES) {
      throw new Error(`${key}: ${bytes.length} bytes exceeds ${SHARD_BUDGET_BYTES} budget`);
    }
    totalBytes += bytes.length;
    encoded.push({ key, bytes });
    const recordValue = value as { stops: StopNode[]; edges: unknown[]; routes: unknown[] };
    shards.push({
      key,
      bytes: bytes.length,
      sha256: sha256(bytes),
      stops: recordValue.stops.length,
      edges: recordValue.edges.length,
      routes: recordValue.routes.length,
      bounds: stopBounds(key, recordValue.stops),
    });
  }
  if (totalBytes > TOTAL_BUDGET_BYTES) {
    throw new Error(`total ${totalBytes} bytes exceeds ${TOTAL_BUDGET_BYTES} budget`);
  }

  const feeds: FeedVersion[] = receipts.map((receipt) => ({
    id: receipt.id,
    version: receipt.feedVersion,
    startDate: receipt.feedStartDate,
    endDate: receipt.feedEndDate,
    sha256: receipt.sha256,
  }));
  const generation = generationId(feeds, shards, new Date());
  const directory = join(root, "normalized", generation);
  await mkdir(directory, { recursive: true });
  for (const { key, bytes } of encoded) await writeFile(join(directory, key), bytes);

  const summarize = (dates: RepresentativeDates): RepresentativeSummary => ({
    weekday: summarizeDay(dates.weekday),
    saturday: summarizeDay(dates.saturday),
    sunday: summarizeDay(dates.sunday),
  });

  const schedulesAsOf: GenerationManifest["schedulesAsOf"] = {};
  for (const receipt of receipts) {
    schedulesAsOf[receipt.id] = {
      version: receipt.feedVersion,
      startDate: receipt.feedStartDate,
      endDate: receipt.feedEndDate,
    };
  }
  const manifest: GenerationManifest = {
    generation,
    createdAt: new Date().toISOString(),
    schedulesAsOf,
    headwayDates: {
      referenceDate,
      ...(subway ? { subway: summarize(subway.stats.representativeDates) } : {}),
      ...(bus ? { bus: summarize(bus.stats.representativeDates) } : {}),
    },
    feeds,
    shards,
    budgets: { shardBytes: SHARD_BUDGET_BYTES, totalBytes: TOTAL_BUDGET_BYTES },
    constants: {
      spatialTransferRadiusM: SPATIAL_TRANSFER_RADIUS_M,
      spatialTransferCapPerStation: SPATIAL_TRANSFER_CAP_PER_STATION,
      spatialWalkMps: SPATIAL_WALK_MPS,
      subwayMaxKmh: 80,
      busMaxKmh: 60,
    },
    notes: [
      `Each headway table is one representative date's schedule, chosen as the most common service pattern on or after ${referenceDate} (see headwayDates); calendar_dates exceptions are applied, so holidays, school-holiday variants and pick boundaries run a different timetable than the table shows.`,
      "Bus travel times are scheduled, not traffic-aware; no realtime data is used.",
      "Route geometry ships per edge, where the edge could be sliced: `geom` is a Google encoded polyline (precision 5) of the GTFS shape points strictly between the two stops, taken from the shape the trips serving that edge run on. One polyline per route cannot describe a branched route, but between two adjacent stops every pattern runs the same track, so an edge slice is well defined where a route's was not. An edge carrying no `geom` either has a shape that doubles back between its stops or has both stops on one shape segment; a client draws the straight chord there. `distM` is the along-track length of the slice where one exists, and the straight-line haversine between the two stops where none does.",
      "Subway stops carry changeSec, the feed's own cost for changing lines inside that station (0 at cross-platform interchanges). Stations the feed prices no change for leave it unset rather than defaulted; changing lines there is unpriced.",
      "Bus stop wait exposure assumes unsheltered stops (GTFS carries no shelter geometry).",
      "Headway hours are service-day hours 0-27, not wall-clock hours: hours 24-27 are the early morning of headwayDates[dataset][dayType].nextDate, whose day type is given as nextDayType. Hours 0-3 and 24-27 are different calendar days and must not be merged.",
      ...(structureStats
        ? [
            "Subway edge structure is joined from OpenStreetMap, not from GTFS, which carries none. Shares are sampled along the straight line between the two stops and sum to at most 1; the shortfall is the part no OSM way matched. An edge carrying no structure field at all is unknown, which is not the same as at_grade: at_grade means a matched OSM way that is tagged neither tunnel nor bridge nor cutting nor embankment.",
          ]
        : []),
    ],
  };
  await writeJson(join(directory, "manifest.json"), manifest);
  return { generation, manifest, directory, structure: structureStats };
}

function summarizeDay(chosen: RepresentativeDates[DayType]): RepresentativeSummary[DayType] {
  return chosen
    ? {
        date: chosen.date,
        nextDate: chosen.nextDate,
        nextDayType: chosen.nextDayType,
        matchingDates: chosen.matchingDates,
        candidateDates: chosen.candidateDates,
      }
    : null;
}

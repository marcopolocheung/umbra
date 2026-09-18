/**
 * The published NYC transit contract, and the parsers that refuse anything else.
 *
 * Three hops — pointer → manifest → shard — each bound to the next by a SHA-256
 * digest, exactly as `shadowField/remoteCatalog.ts` binds the shadow generation.
 * The parsers here are the only place shard JSON becomes typed: everything
 * downstream may assume the shapes below and nothing else.
 *
 * Produced by `server/transit-prep`. If the pipeline's output and these types
 * disagree, the published data wins and these move.
 */

// ─── Pointer ────────────────────────────────────────────────────────────────

/** The small, mutable entry point to an otherwise immutable generation. */
export interface TransitPointer {
  version: 1;
  dataset: "nyc-transit";
  generation: string;
  manifestPath: string;
  manifestSha256: string;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

export interface TransitFeedRef {
  id: string;
  version: string;
  /** GTFS `YYYYMMDD`, not ISO — the feed's own service window. */
  startDate: string;
  endDate: string;
  sha256: string;
}

/** A plain lat/lon rectangle. Never crosses the antimeridian — see `parseBounds`. */
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface TransitShardRef {
  key: string;
  bytes: number;
  sha256: string;
  stops: number;
  edges: number;
  routes: number;
  /**
   * The computed extent of the stops this shard ships — not a borough outline.
   * A shard is self-contained, so the S53 over the Verrazzano puts Staten
   * Island stops in `bus-b`.
   *
   * **Optional forever.** The field is additive and the manifest deployed in
   * production predates it; a ref without it selects by kind, as before.
   */
  bounds?: GeoBounds;
}

/**
 * Which single service date each headway table describes. Not "every weekday":
 * unioning service patterns halved the headway (#376), so one representative
 * date is chosen per day type and named here.
 */
export interface HeadwayDateInfo {
  date: string;
  nextDate: string;
  nextDayType: DayType;
  matchingDates: number;
  candidateDates: number;
}

export type HeadwayDates = {
  referenceDate: string;
} & Record<string, Record<string, HeadwayDateInfo> | string>;

export interface TransitManifest {
  generation: string;
  createdAt: string;
  schedulesAsOf: Record<string, Omit<TransitFeedRef, "id" | "sha256">>;
  headwayDates: HeadwayDates;
  feeds: TransitFeedRef[];
  shards: TransitShardRef[];
  budgets: { shardBytes: number; totalBytes: number };
  constants: Record<string, number>;
  /** The honesty statements the transit card has to surface. Never drop these. */
  notes: string[];
}

// ─── Shards ─────────────────────────────────────────────────────────────────

export type DayType = "weekday" | "saturday" | "sunday";

export interface TransitStop {
  /** Namespaced: `subway:127`, `bus:100587`. Never an OSM node id. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /**
   * The feed's own cost of changing lines inside this station, in seconds.
   * **0 is a real value** — 57 cross-platform interchanges price a change at
   * zero. Absent means the agency priced no change; it is not a zero. (#384)
   */
  changeSec?: number;
  feeds?: string[];
  /**
   * Subway only: the doors OSM groups with this station in its
   * `public_transport=stop_area`, joined by `server/transit-prep` (#430).
   * **Empty is a finding** — OSM maps no door here, so the station point is
   * used. Absent is unknown: a generation built before the join, which the
   * client answers by fetching and matching doors itself.
   */
  entrances?: TransitEntrance[];
}

export interface TransitEntrance {
  lat: number;
  lon: number;
  /** `entrance=exit`: a way out that is no way in. */
  exitOnly?: true;
}

/**
 * Where a segment runs, joined from OSM by `server/transit-prep` because GTFS
 * carries no such thing.
 *
 * `at_grade` is a matched OSM way tagged neither tunnel nor bridge nor cutting
 * nor embankment — which under OSM's closed-world convention means at grade.
 * It is not the same as the whole field being absent, which means unknown.
 */
export type EdgeStructure = Partial<
  Record<"underground" | "elevated" | "open_cut" | "embankment" | "at_grade", number>
>;

export interface TransitEdge {
  from: string;
  to: string;
  route: string;
  direction: number;
  /** Scheduled median run time between the two stops. */
  medianSec: number;
  trips: number;
  /**
   * Along the track where the producer could slice the edge out of its GTFS
   * shape, and the straight-line haversine between the two stops where it
   * could not — which is ~5-7% under true path length.
   */
  distM: number;
  /**
   * Share of the segment running in each structure. Sums to **at most** 1 — the
   * shortfall is the part no OSM way matched, so the field carries its own
   * uncertainty.
   *
   * **Optional forever.** Absent means unknown: a generation built before the
   * join existed, or one built without the OSM cache. Nothing may read absence
   * as "underground" — that is the claim #393 was opened for.
   */
  structure?: EdgeStructure;
  /**
   * The track between the two stops, as a Google encoded polyline (precision 5)
   * of the GTFS shape points strictly *between* them — the endpoints are the
   * stops, which the shard already carries.
   *
   * **Optional forever.** Absent means the edge was not sliceable (its shape
   * doubled back between the stops, or both stops landed on one shape
   * segment) or the generation predates per-edge geometry; a client draws the
   * straight chord either way.
   */
  geom?: string;
}

export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  /** GTFS route_type: 1 subway, 3 bus. */
  type: number;
  /** Bare RRGGBB, no leading `#`. */
  color: string;
  textColor: string;
}

export interface TransitHeadway {
  route: string;
  direction: number;
  dayType: DayType;
  /**
   * A **service-day** hour, 0-27 — not a wall-clock hour. Hours 24+ are the
   * early morning of the *next* date, whose day type the manifest gives as
   * `nextDayType`; Saturday's hour 24 is Sunday service. Hours 0-3 and 24-27
   * are different calendar days and must not be merged. (#383)
   */
  hour: number;
  medianSec: number;
  trips: number;
  services: number;
}

export interface TransitTransfer {
  from: string;
  to: string;
  minSec: number;
  /** `gtfs` is the agency's own transfer; `spatial` is an unvalidated stub. */
  kind: "gtfs" | "spatial";
}

export interface TransitShard {
  /** `subway` or `bus-shard`. */
  kind: string;
  stops: TransitStop[];
  edges: TransitEdge[];
  routes: TransitRoute[];
  headways: TransitHeadway[];
  /** Subway shards only; bus shards ship none. */
  transfers: TransitTransfer[];
}

// ─── Budgets ────────────────────────────────────────────────────────────────

/** The manifest is metadata; a megabyte of it means something is wrong. */
export const MAX_MANIFEST_BYTES = 256_000;
/** The pipeline's own per-shard budget, enforced again on the way in. */
export const MAX_SHARD_BYTES = 3_000_000;

const generationPattern = /^nyc-\d{4}-\d{2}-\d{2}-[a-f0-9]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const shardKeyPattern = /^[a-z0-9-]{1,32}\.json$/;
/** The producer's own cap per station; the most any NYC station has is 24. */
const MAX_STATION_ENTRANCES = 64;
const dayTypes = new Set<string>(["weekday", "saturday", "sunday"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ─── Pointer parsing ────────────────────────────────────────────────────────

/**
 * Reject malformed pointers before their paths are used in browser requests.
 * `manifestPath` is bound to the generation rather than trusted, so a pointer
 * cannot steer a fetch at an arbitrary key.
 */
export function parseTransitPointer(value: unknown): TransitPointer {
  if (!isRecord(value)) throw new Error("invalid NYC transit pointer");
  const generation = value.generation;
  if (
    value.version !== 1 ||
    value.dataset !== "nyc-transit" ||
    typeof generation !== "string" ||
    !generationPattern.test(generation) ||
    value.manifestPath !== `transit/nyc/${generation}/manifest.json` ||
    typeof value.manifestSha256 !== "string" ||
    !sha256Pattern.test(value.manifestSha256)
  )
    throw new Error("invalid NYC transit pointer");
  return {
    version: 1,
    dataset: "nyc-transit",
    generation,
    manifestPath: value.manifestPath,
    manifestSha256: value.manifestSha256,
  };
}

// ─── Manifest parsing ───────────────────────────────────────────────────────

function parseFeedRef(value: unknown): TransitFeedRef {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.startDate !== "string" ||
    typeof value.endDate !== "string" ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256)
  )
    throw new Error("invalid NYC transit manifest feed");
  return {
    id: value.id,
    version: value.version,
    startDate: value.startDate,
    endDate: value.endDate,
    sha256: value.sha256,
  };
}

/**
 * A shard's extent, or `undefined` when the manifest publishes none.
 *
 * An inverted or out-of-range rectangle throws rather than being ignored: the
 * client skips a download on the strength of this, so a wrong extent would drop
 * transit for real New York routes and look like the feature being off.
 * `west > east` is rejected on the same grounds — the dataset is NYC-only, so
 * an antimeridian-crossing shard means the pipeline is publishing something
 * this contract does not describe.
 *
 * `null` counts as absent, not as malformed: it is what a serializer emits for
 * an optional it has no value for, and it parses today by being ignored.
 * Throwing on it would take a whole manifest down over a field nothing needs.
 */
function parseBounds(value: unknown): GeoBounds | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.south) ||
    !isFiniteNumber(value.west) ||
    !isFiniteNumber(value.north) ||
    !isFiniteNumber(value.east) ||
    value.south < -90 ||
    value.north > 90 ||
    value.west < -180 ||
    value.east > 180 ||
    value.south > value.north ||
    value.west > value.east
  )
    throw new Error("invalid NYC transit manifest shard");
  return { south: value.south, west: value.west, north: value.north, east: value.east };
}

function parseShardRef(value: unknown): TransitShardRef {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !shardKeyPattern.test(value.key) ||
    !isNonNegativeInt(value.bytes) ||
    value.bytes > MAX_SHARD_BYTES ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256) ||
    !isNonNegativeInt(value.stops) ||
    !isNonNegativeInt(value.edges) ||
    !isNonNegativeInt(value.routes)
  )
    throw new Error("invalid NYC transit manifest shard");
  const ref: TransitShardRef = {
    key: value.key,
    bytes: value.bytes,
    sha256: value.sha256,
    stops: value.stops,
    edges: value.edges,
    routes: value.routes,
  };
  // Absent stays absent: the key must not appear on a ref the pipeline
  // published without one, or `selectShardRefs` cannot tell the two apart.
  const bounds = parseBounds(value.bounds);
  if (bounds) ref.bounds = bounds;
  return ref;
}

/** Parses the manifest and checks it describes the generation we asked for. */
export function parseTransitManifest(value: unknown, generation: string): TransitManifest {
  if (!isRecord(value)) throw new Error("invalid NYC transit manifest");
  if (value.generation !== generation) throw new Error("NYC transit generation mismatch");
  if (
    typeof value.createdAt !== "string" ||
    !isRecord(value.schedulesAsOf) ||
    !isRecord(value.headwayDates) ||
    !Array.isArray(value.feeds) ||
    !Array.isArray(value.shards) ||
    value.shards.length === 0 ||
    !isRecord(value.budgets) ||
    !isRecord(value.constants) ||
    !Array.isArray(value.notes)
  )
    throw new Error("invalid NYC transit manifest");

  const budgets = value.budgets;
  if (!isNonNegativeInt(budgets.shardBytes) || !isNonNegativeInt(budgets.totalBytes))
    throw new Error("invalid NYC transit manifest");

  const notes: string[] = [];
  for (const note of value.notes) {
    if (typeof note !== "string") throw new Error("invalid NYC transit manifest");
    notes.push(note);
  }

  const constants: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value.constants)) {
    if (!isFiniteNumber(entry)) throw new Error("invalid NYC transit manifest");
    constants[key] = entry;
  }

  const shards = value.shards.map(parseShardRef);
  const keys = new Set(shards.map((shard) => shard.key));
  if (keys.size !== shards.length) throw new Error("duplicate NYC transit shard key");

  const schedulesAsOf: TransitManifest["schedulesAsOf"] = {};
  for (const [id, entry] of Object.entries(value.schedulesAsOf)) {
    if (
      !isRecord(entry) ||
      typeof entry.version !== "string" ||
      typeof entry.startDate !== "string" ||
      typeof entry.endDate !== "string"
    )
      throw new Error("invalid NYC transit manifest");
    schedulesAsOf[id] = {
      version: entry.version,
      startDate: entry.startDate,
      endDate: entry.endDate,
    };
  }

  return {
    generation,
    createdAt: value.createdAt,
    schedulesAsOf,
    headwayDates: value.headwayDates as HeadwayDates,
    feeds: value.feeds.map(parseFeedRef),
    shards,
    budgets: { shardBytes: budgets.shardBytes, totalBytes: budgets.totalBytes },
    constants,
    notes,
  };
}

// ─── Shard parsing ──────────────────────────────────────────────────────────

function parseStop(value: unknown): TransitStop {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isFiniteNumber(value.lat) ||
    !isFiniteNumber(value.lon)
  )
    throw new Error("invalid NYC transit stop");
  const stop: TransitStop = {
    id: value.id,
    name: value.name,
    lat: value.lat,
    lon: value.lon,
  };
  // Absent stays absent: a defaulted changeSec would invent a number the
  // agency never published for the 33 stations that price no change.
  if (value.changeSec !== undefined) {
    if (!isNonNegativeInt(value.changeSec)) throw new Error("invalid NYC transit stop");
    stop.changeSec = value.changeSec;
  }
  if (Array.isArray(value.feeds)) stop.feeds = value.feeds.filter((f) => typeof f === "string");
  // `[]` is kept: "OSM maps no door" is not "unknown", and only the second
  // sends the client back to Overpass.
  const entrances = parseEntrances(value.entrances);
  if (entrances) stop.entrances = entrances;
  return stop;
}

/**
 * A station's published doors, or `undefined` when it publishes none. `null`
 * counts as absent, as it does for `structure`.
 */
function parseEntrances(value: unknown): TransitEntrance[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_STATION_ENTRANCES)
    throw new Error("invalid NYC transit stop");
  return value.map((door) => {
    if (
      !isRecord(door) ||
      !isFiniteNumber(door.lat) ||
      !isFiniteNumber(door.lon) ||
      (door.exitOnly !== undefined && door.exitOnly !== true)
    )
      throw new Error("invalid NYC transit stop");
    return { lat: door.lat, lon: door.lon, ...(door.exitOnly ? { exitOnly: true as const } : {}) };
  });
}

const STRUCTURES = new Set(["underground", "elevated", "open_cut", "embankment", "at_grade"]);

/**
 * A segment's structure shares, or `undefined` when the edge publishes none.
 *
 * `null` counts as absent for the same reason `bounds` does. Shares must be
 * fractions and must not sum past 1: they are shares *of the segment*, and a
 * sum above 1 means the producer is describing something this contract does
 * not. A small epsilon absorbs the pipeline's two-decimal rounding.
 */
function parseStructure(value: unknown): EdgeStructure | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("invalid NYC transit edge");
  const structure: EdgeStructure = {};
  let sum = 0;
  for (const [key, share] of Object.entries(value)) {
    if (!STRUCTURES.has(key)) throw new Error("invalid NYC transit edge");
    if (!isFiniteNumber(share) || share <= 0 || share > 1)
      throw new Error("invalid NYC transit edge");
    sum += share;
    structure[key as keyof EdgeStructure] = share;
  }
  if (sum > 1.01) throw new Error("invalid NYC transit edge");
  return Object.keys(structure).length > 0 ? structure : undefined;
}

/**
 * An edge's sliced track geometry, or `undefined` when the edge publishes none.
 *
 * Validation is shape + length, not a full decode: decoding all ~29,000
 * strings at load would allocate ~330,000 point objects for the ten hops a
 * route actually draws, so the decode happens lazily per drawn hop. The
 * encoder emits only chars 63–126 (`?`–`~`); 8192 chars is ~4× the observed
 * worst case (median 31, p99 517, max 1,983 across the real build's seven
 * shards). `null` and the empty string count as absent, like `structure`.
 */
function parseGeom(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[?-~]{1,8192}$/.test(value))
    throw new Error("invalid NYC transit edge");
  return value;
}

function parseEdge(value: unknown): TransitEdge {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.route !== "string" ||
    !isNonNegativeInt(value.direction) ||
    !isNonNegativeInt(value.medianSec) ||
    !isNonNegativeInt(value.trips) ||
    !isFiniteNumber(value.distM) ||
    value.distM < 0
  )
    throw new Error("invalid NYC transit edge");
  const edge: TransitEdge = {
    from: value.from,
    to: value.to,
    route: value.route,
    direction: value.direction,
    medianSec: value.medianSec,
    trips: value.trips,
    distM: value.distM,
  };
  // Absent stays absent, so a consumer can tell "unknown" from "at grade".
  const structure = parseStructure(value.structure);
  if (structure) edge.structure = structure;
  // Absent stays absent, so a consumer draws the straight chord there.
  const geom = parseGeom(value.geom);
  if (geom) edge.geom = geom;
  return edge;
}

function parseRoute(value: unknown): TransitRoute {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.shortName !== "string" ||
    typeof value.longName !== "string" ||
    !isNonNegativeInt(value.type) ||
    typeof value.color !== "string" ||
    typeof value.textColor !== "string"
  )
    throw new Error("invalid NYC transit route");
  return {
    id: value.id,
    shortName: value.shortName,
    longName: value.longName,
    type: value.type,
    color: value.color,
    textColor: value.textColor,
  };
}

function parseHeadway(value: unknown): TransitHeadway {
  if (
    !isRecord(value) ||
    typeof value.route !== "string" ||
    !isNonNegativeInt(value.direction) ||
    typeof value.dayType !== "string" ||
    !dayTypes.has(value.dayType) ||
    !isNonNegativeInt(value.hour) ||
    value.hour > 27 ||
    !isNonNegativeInt(value.medianSec) ||
    !isNonNegativeInt(value.trips) ||
    !isNonNegativeInt(value.services)
  )
    throw new Error("invalid NYC transit headway");
  return {
    route: value.route,
    direction: value.direction,
    dayType: value.dayType as DayType,
    hour: value.hour,
    medianSec: value.medianSec,
    trips: value.trips,
    services: value.services,
  };
}

function parseTransfer(value: unknown): TransitTransfer {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !isNonNegativeInt(value.minSec) ||
    (value.kind !== "gtfs" && value.kind !== "spatial")
  )
    throw new Error("invalid NYC transit transfer");
  return { from: value.from, to: value.to, minSec: value.minSec, kind: value.kind };
}

/**
 * Parses one shard and checks it against the counts the manifest promised.
 * The digest already proves the bytes are the ones the pipeline published; the
 * count check is what catches the pipeline publishing a different contract.
 */
export function parseTransitShard(value: unknown, ref: TransitShardRef): TransitShard {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new Error(`invalid NYC transit shard (${ref.key})`);
  if (
    !Array.isArray(value.stops) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.headways)
  )
    throw new Error(`invalid NYC transit shard (${ref.key})`);
  if (value.transfers !== undefined && !Array.isArray(value.transfers))
    throw new Error(`invalid NYC transit shard (${ref.key})`);

  if (
    value.stops.length !== ref.stops ||
    value.edges.length !== ref.edges ||
    value.routes.length !== ref.routes
  )
    throw new Error(`NYC transit shard count mismatch (${ref.key})`);

  return {
    kind: value.kind,
    stops: value.stops.map(parseStop),
    edges: value.edges.map(parseEdge),
    routes: value.routes.map(parseRoute),
    headways: value.headways.map(parseHeadway),
    transfers: (value.transfers ?? []).map(parseTransfer),
  };
}

/**
 * The v1 contract for the static NYC navigation dataset.
 *
 * This module is the only place where navigation pointer, manifest, street-shard,
 * building-shard, and notices JSON become typed browser values. The producer uses
 * the same shapes through type-only imports; every runtime parser is deliberately
 * strict because a malformed shard must never become a plausible route or a false
 * "no buildings" answer.
 */

// ─── Shared records ──────────────────────────────────────────────────────────

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface NavigationPointer {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  manifestPath: string;
  manifestSha256: string;
}

export interface NavigationSourceReceipt {
  id: string;
  /**
   * Human-readable upstream release identity (extract date, feed window,
   * catalog update stamp, …).
   */
  release: string;
  /** HTTPS download/query URL the bytes came from. */
  url: string;
  /** Exact downstream byte count of the pinned artifact. */
  bytes: number;
  /** Upstream-provided timestamp (ISO 8601, or the source's HTTP date). */
  timestamp: string;
  sha256: string;
}

export interface NavigationStreetShardRef {
  key: string;
  bytes: number;
  sha256: string;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  nodes: number;
  edges: number;
}

export interface NavigationBuildingShardRef {
  key: string;
  bytes: number;
  sha256: string;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  buildings: number;
  rings: number;
  missingHeights: number;
  maxHeightM: number;
}

export interface NavigationManifest {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  createdAt: string;
  supportBounds: GeoBounds;
  recipe: string;
  sources: NavigationSourceReceipt[];
  noticesPath: string;
  noticesSha256: string;
  streetShards: NavigationStreetShardRef[];
  buildingShards: NavigationBuildingShardRef[];
  budgets: {
    streetShardBytes: number;
    buildingShardBytes: number;
    totalBytes: number;
  };
}

export interface NavigationStreetNode {
  id: number;
  lat: number;
  lon: number;
  isIntersection: boolean;
}

export interface NavigationStreetTags {
  highway?: string;
  surface?: string;
  smoothness?: string;
  cycleway?: string;
  bicycle?: string;
  foot?: string;
  access?: string;
}

/** A directed edge. A bidirectional OSM way is represented by two records. */
export interface NavigationStreetEdge {
  id: string;
  from: number;
  to: number;
  distanceM: number;
  tags: NavigationStreetTags;
}

export interface NavigationStreetShard {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  kind: "streets";
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  nodes: NavigationStreetNode[];
  edges: NavigationStreetEdge[];
}

export type NavigationBuildingStatus = "active" | "under-construction" | "other";
export type NavigationHeightSource = "source" | "fallback" | "unknown";

export interface NavigationBuilding {
  id: string;
  rings: Array<Array<[number, number]>>;
  /** null is explicit unknown; zero is not a valid published height. */
  heightM: number | null;
  heightSource: NavigationHeightSource;
  featureCode: number;
  status: NavigationBuildingStatus;
}

export interface NavigationBuildingShard {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  kind: "buildings";
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  buildings: NavigationBuilding[];
}

export interface NavigationNotices {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  attribution: string[];
  licenses: string[];
  sourceNotes: string[];
}

// ─── Budgets and patterns ───────────────────────────────────────────────────

/** Metadata should remain small enough to fetch before any spatial shard. */
export const MAX_MANIFEST_BYTES = 512_000;
export const MAX_NOTICES_BYTES = 128_000;
/**
 * z14-shaped envelopes, measured on the first citywide generation
 * (2026-09-18 snapshot): largest street shard 4.75 MB, largest building
 * shard 3.54 MB, citywide total 855.4 MB. The 5 MB per-shard caps are the
 * measured decision from the z13/z14 comparison in
 * docs/notes/nyc-navigation-data-city.md; the total leaves ~2.3× headroom
 * for source growth before the next measured adjustment.
 */
export const MAX_STREET_SHARD_BYTES = 5_000_000;
export const MAX_BUILDING_SHARD_BYTES = 5_000_000;
export const MAX_TOTAL_BYTES = 2_000_000_000;

const generationPattern = /^nyc-\d{4}-\d{2}-\d{2}-[a-f0-9]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const streetShardKeyPattern = /^streets\/[a-z0-9-]{1,64}\.json$/;
const buildingShardKeyPattern = /^buildings\/[a-z0-9-]{1,64}\.json$/;
const noticesPathPattern = /^navigation\/nyc\/nyc-\d{4}-\d{2}-\d{2}-[a-f0-9]{12}\/notices\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return isNonNegativeInt(value) && value > 0;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(message);
  }
}

function parseString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function parseSha256(value: unknown, message: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(message);
  return value;
}

function parseGeneration(value: unknown, message: string): string {
  if (typeof value !== "string" || !generationPattern.test(value)) throw new Error(message);
  return value;
}

/** Parses a non-antimeridian latitude/longitude rectangle. */
export function parseGeoBounds(
  value: unknown,
  message = "invalid NYC navigation bounds",
): GeoBounds {
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
    throw new Error(message);
  assertKeys(value, ["south", "west", "north", "east"], message);
  return { south: value.south, west: value.west, north: value.north, east: value.east };
}

function boundsContain(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  );
}

// ─── Pointer ────────────────────────────────────────────────────────────────

export function parseNavigationPointer(value: unknown): NavigationPointer {
  if (!isRecord(value)) throw new Error("invalid NYC navigation pointer");
  assertKeys(
    value,
    ["version", "dataset", "generation", "manifestPath", "manifestSha256"],
    "invalid NYC navigation pointer",
  );
  const generation = parseGeneration(value.generation, "invalid NYC navigation pointer");
  if (
    value.version !== 1 ||
    value.dataset !== "nyc-navigation" ||
    value.manifestPath !== `navigation/nyc/${generation}/manifest.json`
  )
    throw new Error("invalid NYC navigation pointer");
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    manifestPath: value.manifestPath,
    manifestSha256: parseSha256(value.manifestSha256, "invalid NYC navigation pointer"),
  };
}

// ─── Manifest ───────────────────────────────────────────────────────────────

function parseSourceReceipt(value: unknown): NavigationSourceReceipt {
  if (!isRecord(value)) throw new Error("invalid NYC navigation source receipt");
  assertKeys(
    value,
    ["id", "release", "url", "bytes", "timestamp", "sha256"],
    "invalid NYC navigation source receipt",
  );
  const url = parseString(value.url, "invalid NYC navigation source receipt");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("invalid NYC navigation source receipt");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
    throw new Error("invalid NYC navigation source receipt");
  if (
    !isPositiveInt(value.bytes) ||
    typeof value.timestamp !== "string" ||
    value.timestamp.length === 0
  )
    throw new Error("invalid NYC navigation source receipt");
  return {
    id: parseString(value.id, "invalid NYC navigation source receipt"),
    release: parseString(value.release, "invalid NYC navigation source receipt"),
    url,
    bytes: value.bytes,
    timestamp: value.timestamp,
    sha256: parseSha256(value.sha256, "invalid NYC navigation source receipt"),
  };
}

function parseStreetShardRef(value: unknown): NavigationStreetShardRef {
  if (!isRecord(value)) throw new Error("invalid NYC navigation street shard ref");
  assertKeys(
    value,
    ["key", "bytes", "sha256", "geometryBounds", "supportBounds", "nodes", "edges"],
    "invalid NYC navigation street shard ref",
  );
  if (
    typeof value.key !== "string" ||
    !streetShardKeyPattern.test(value.key) ||
    !isPositiveInt(value.bytes) ||
    value.bytes > MAX_STREET_SHARD_BYTES ||
    !isNonNegativeInt(value.nodes) ||
    !isNonNegativeInt(value.edges)
  )
    throw new Error("invalid NYC navigation street shard ref");
  const geometryBounds = parseGeoBounds(
    value.geometryBounds,
    "invalid NYC navigation street shard ref",
  );
  const supportBounds = parseGeoBounds(
    value.supportBounds,
    "invalid NYC navigation street shard ref",
  );
  if (!boundsContain(supportBounds, geometryBounds))
    throw new Error("invalid NYC navigation street shard ref");
  return {
    key: value.key,
    bytes: value.bytes,
    sha256: parseSha256(value.sha256, "invalid NYC navigation street shard ref"),
    geometryBounds,
    supportBounds,
    nodes: value.nodes,
    edges: value.edges,
  };
}

function parseBuildingShardRef(value: unknown): NavigationBuildingShardRef {
  if (!isRecord(value)) throw new Error("invalid NYC navigation building shard ref");
  assertKeys(
    value,
    [
      "key",
      "bytes",
      "sha256",
      "geometryBounds",
      "supportBounds",
      "buildings",
      "rings",
      "missingHeights",
      "maxHeightM",
    ],
    "invalid NYC navigation building shard ref",
  );
  if (
    typeof value.key !== "string" ||
    !buildingShardKeyPattern.test(value.key) ||
    !isPositiveInt(value.bytes) ||
    value.bytes > MAX_BUILDING_SHARD_BYTES ||
    !isNonNegativeInt(value.buildings) ||
    !isNonNegativeInt(value.rings) ||
    !isNonNegativeInt(value.missingHeights) ||
    !isFiniteNumber(value.maxHeightM) ||
    value.maxHeightM < 0
  )
    throw new Error("invalid NYC navigation building shard ref");
  const geometryBounds = parseGeoBounds(
    value.geometryBounds,
    "invalid NYC navigation building shard ref",
  );
  const supportBounds = parseGeoBounds(
    value.supportBounds,
    "invalid NYC navigation building shard ref",
  );
  if (!boundsContain(supportBounds, geometryBounds))
    throw new Error("invalid NYC navigation building shard ref");
  if (value.missingHeights > value.buildings)
    throw new Error("invalid NYC navigation building shard ref");
  return {
    key: value.key,
    bytes: value.bytes,
    sha256: parseSha256(value.sha256, "invalid NYC navigation building shard ref"),
    geometryBounds,
    supportBounds,
    buildings: value.buildings,
    rings: value.rings,
    missingHeights: value.missingHeights,
    maxHeightM: value.maxHeightM,
  };
}

export function parseNavigationManifest(value: unknown, generation: string): NavigationManifest {
  if (!isRecord(value)) throw new Error("invalid NYC navigation manifest");
  assertKeys(
    value,
    [
      "version",
      "dataset",
      "generation",
      "createdAt",
      "supportBounds",
      "recipe",
      "sources",
      "noticesPath",
      "noticesSha256",
      "streetShards",
      "buildingShards",
      "budgets",
    ],
    "invalid NYC navigation manifest",
  );
  if (
    value.version !== 1 ||
    value.dataset !== "nyc-navigation" ||
    value.generation !== generation ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    !Array.isArray(value.streetShards) ||
    value.streetShards.length === 0 ||
    !Array.isArray(value.buildingShards) ||
    value.buildingShards.length === 0 ||
    typeof value.recipe !== "string" ||
    value.recipe.length === 0 ||
    typeof value.noticesPath !== "string" ||
    !noticesPathPattern.test(value.noticesPath)
  )
    throw new Error("invalid NYC navigation manifest");

  const supportBounds = parseGeoBounds(
    value.supportBounds,
    "invalid NYC navigation manifest bounds",
  );
  const noticesPath = value.noticesPath;
  if (noticesPath !== `navigation/nyc/${generation}/notices.json`)
    throw new Error("invalid NYC navigation manifest");
  const budgets = value.budgets;
  if (
    !isRecord(budgets) ||
    Object.keys(budgets).some(
      (key) => !["streetShardBytes", "buildingShardBytes", "totalBytes"].includes(key),
    ) ||
    !isNonNegativeInt(budgets.streetShardBytes) ||
    !isNonNegativeInt(budgets.buildingShardBytes) ||
    !isNonNegativeInt(budgets.totalBytes) ||
    budgets.streetShardBytes + budgets.buildingShardBytes > MAX_TOTAL_BYTES ||
    budgets.totalBytes > MAX_TOTAL_BYTES
  )
    throw new Error("invalid NYC navigation manifest");

  const streetShards = value.streetShards.map(parseStreetShardRef);
  const buildingShards = value.buildingShards.map(parseBuildingShardRef);
  const streetKeys = new Set(streetShards.map((ref) => ref.key));
  const buildingKeys = new Set(buildingShards.map((ref) => ref.key));
  if (streetKeys.size !== streetShards.length || buildingKeys.size !== buildingShards.length)
    throw new Error("duplicate NYC navigation shard key");
  if (streetShards.some((ref) => !boundsContain(supportBounds, ref.supportBounds)))
    throw new Error("NYC navigation street shard outside dataset support");
  if (buildingShards.some((ref) => !boundsContain(supportBounds, ref.supportBounds)))
    throw new Error("NYC navigation building shard outside dataset support");

  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: value.createdAt,
    supportBounds,
    recipe: value.recipe,
    sources: value.sources.map(parseSourceReceipt),
    noticesPath,
    noticesSha256: parseSha256(value.noticesSha256, "invalid NYC navigation manifest"),
    streetShards,
    buildingShards,
    budgets: {
      streetShardBytes: budgets.streetShardBytes,
      buildingShardBytes: budgets.buildingShardBytes,
      totalBytes: budgets.totalBytes,
    },
  };
}

// ─── Street shard ───────────────────────────────────────────────────────────

function parseStreetNode(value: unknown): NavigationStreetNode {
  if (!isRecord(value)) throw new Error("invalid NYC navigation street node");
  assertKeys(value, ["id", "lat", "lon", "isIntersection"], "invalid NYC navigation street node");
  if (
    !isPositiveInt(value.id) ||
    !isFiniteNumber(value.lat) ||
    !isFiniteNumber(value.lon) ||
    value.lat < -90 ||
    value.lat > 90 ||
    value.lon < -180 ||
    value.lon > 180 ||
    typeof value.isIntersection !== "boolean"
  )
    throw new Error("invalid NYC navigation street node");
  return { id: value.id, lat: value.lat, lon: value.lon, isIntersection: value.isIntersection };
}

function parseTags(value: unknown): NavigationStreetTags {
  if (!isRecord(value)) throw new Error("invalid NYC navigation street edge");
  const allowed = [
    "highway",
    "surface",
    "smoothness",
    "cycleway",
    "bicycle",
    "foot",
    "access",
  ] as const;
  assertKeys(value, allowed, "invalid NYC navigation street edge");
  const tags: NavigationStreetTags = {};
  for (const key of allowed) {
    const tag = value[key];
    if (tag !== undefined) {
      if (typeof tag !== "string" || tag.length === 0)
        throw new Error("invalid NYC navigation street edge");
      tags[key] = tag;
    }
  }
  return tags;
}

function parseStreetEdge(value: unknown): NavigationStreetEdge {
  if (!isRecord(value)) throw new Error("invalid NYC navigation street edge");
  assertKeys(
    value,
    ["id", "from", "to", "distanceM", "tags"],
    "invalid NYC navigation street edge",
  );
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isPositiveInt(value.from) ||
    !isPositiveInt(value.to) ||
    value.from === value.to ||
    !isFiniteNumber(value.distanceM) ||
    value.distanceM <= 0
  )
    throw new Error("invalid NYC navigation street edge");
  return {
    id: value.id,
    from: value.from,
    to: value.to,
    distanceM: value.distanceM,
    tags: parseTags(value.tags),
  };
}

export function parseNavigationStreetShard(
  value: unknown,
  ref: NavigationStreetShardRef,
  expectedGeneration?: string,
): NavigationStreetShard {
  if (!isRecord(value)) throw new Error(`invalid NYC navigation street shard (${ref.key})`);
  assertKeys(
    value,
    [
      "version",
      "dataset",
      "generation",
      "kind",
      "geometryBounds",
      "supportBounds",
      "nodes",
      "edges",
    ],
    `invalid NYC navigation street shard (${ref.key})`,
  );
  if (
    value.version !== 1 ||
    value.dataset !== "nyc-navigation" ||
    typeof value.generation !== "string" ||
    value.kind !== "streets" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length !== ref.nodes ||
    value.edges.length !== ref.edges ||
    (expectedGeneration !== undefined && value.generation !== expectedGeneration)
  )
    throw new Error(`invalid NYC navigation street shard (${ref.key})`);
  const geometryBounds = parseGeoBounds(
    value.geometryBounds,
    `invalid NYC navigation street shard (${ref.key})`,
  );
  const supportBounds = parseGeoBounds(
    value.supportBounds,
    `invalid NYC navigation street shard (${ref.key})`,
  );
  if (!boundsContain(supportBounds, geometryBounds))
    throw new Error(`invalid NYC navigation street shard (${ref.key})`);

  const nodes = value.nodes.map(parseStreetNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length)
    throw new Error(`duplicate NYC navigation street node (${ref.key})`);
  const edges = value.edges.map(parseStreetEdge);
  const edgeIds = new Set(edges.map((edge) => edge.id));
  if (edgeIds.size !== edges.length)
    throw new Error(`duplicate NYC navigation street edge (${ref.key})`);
  if (edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to)))
    throw new Error(`dangling NYC navigation street edge (${ref.key})`);

  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: parseGeneration(
      value.generation,
      `invalid NYC navigation street shard (${ref.key})`,
    ),
    kind: "streets",
    geometryBounds,
    supportBounds,
    nodes,
    edges,
  };
}

// ─── Building shard ──────────────────────────────────────────────────────────

function parseRing(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value) || value.length < 4)
    throw new Error("invalid NYC navigation building ring");
  const ring = value.map((point) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isFiniteNumber(point[0]) ||
      !isFiniteNumber(point[1]) ||
      point[0] < -180 ||
      point[0] > 180 ||
      point[1] < -90 ||
      point[1] > 90
    )
      throw new Error("invalid NYC navigation building ring");
    return [point[0], point[1]] as [number, number];
  });
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1])
    throw new Error("invalid NYC navigation building ring");
  return ring;
}

function parseBuilding(value: unknown): NavigationBuilding {
  if (!isRecord(value)) throw new Error("invalid NYC navigation building");
  assertKeys(
    value,
    ["id", "rings", "heightM", "heightSource", "featureCode", "status"],
    "invalid NYC navigation building",
  );
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !Array.isArray(value.rings) ||
    value.rings.length === 0 ||
    !isNonNegativeInt(value.featureCode) ||
    (value.status !== "active" &&
      value.status !== "under-construction" &&
      value.status !== "other") ||
    (value.heightSource !== "source" &&
      value.heightSource !== "fallback" &&
      value.heightSource !== "unknown")
  )
    throw new Error("invalid NYC navigation building");
  const heightM = value.heightM;
  if (heightM !== null && (!isFiniteNumber(heightM) || heightM <= 0))
    throw new Error("invalid NYC navigation building");
  if ((value.heightSource === "unknown") !== (heightM === null))
    throw new Error("invalid NYC navigation building height state");
  if (heightM === null && value.status === "under-construction")
    throw new Error("invalid NYC navigation building height state");
  return {
    id: value.id,
    rings: value.rings.map(parseRing),
    heightM,
    heightSource: value.heightSource,
    featureCode: value.featureCode,
    status: value.status,
  };
}

export function parseNavigationBuildingShard(
  value: unknown,
  ref: NavigationBuildingShardRef,
  expectedGeneration?: string,
): NavigationBuildingShard {
  if (!isRecord(value)) throw new Error(`invalid NYC navigation building shard (${ref.key})`);
  assertKeys(
    value,
    ["version", "dataset", "generation", "kind", "geometryBounds", "supportBounds", "buildings"],
    `invalid NYC navigation building shard (${ref.key})`,
  );
  if (
    value.version !== 1 ||
    value.dataset !== "nyc-navigation" ||
    typeof value.generation !== "string" ||
    (expectedGeneration !== undefined && value.generation !== expectedGeneration) ||
    value.kind !== "buildings" ||
    !Array.isArray(value.buildings) ||
    value.buildings.length !== ref.buildings
  )
    throw new Error(`invalid NYC navigation building shard (${ref.key})`);
  const generation = parseGeneration(
    value.generation,
    `invalid NYC navigation building shard (${ref.key})`,
  );
  const geometryBounds = parseGeoBounds(
    value.geometryBounds,
    `invalid NYC navigation building shard (${ref.key})`,
  );
  const supportBounds = parseGeoBounds(
    value.supportBounds,
    `invalid NYC navigation building shard (${ref.key})`,
  );
  if (!boundsContain(supportBounds, geometryBounds))
    throw new Error(`invalid NYC navigation building shard (${ref.key})`);
  const buildings = value.buildings.map(parseBuilding);
  const ids = new Set(buildings.map((building) => building.id));
  if (ids.size !== buildings.length)
    throw new Error(`duplicate NYC navigation building (${ref.key})`);
  const rings = buildings.reduce((sum, building) => sum + building.rings.length, 0);
  const missingHeights = buildings.filter((building) => building.heightM === null).length;
  const maxHeightM = buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0);
  if (rings !== ref.rings || missingHeights !== ref.missingHeights || maxHeightM !== ref.maxHeightM)
    throw new Error(`NYC navigation building shard count mismatch (${ref.key})`);
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "buildings",
    geometryBounds,
    supportBounds,
    buildings,
  };
}

// ─── Notices ─────────────────────────────────────────────────────────────────

export function parseNavigationNotices(value: unknown, generation: string): NavigationNotices {
  if (!isRecord(value)) throw new Error("invalid NYC navigation notices");
  assertKeys(
    value,
    ["version", "dataset", "generation", "attribution", "licenses", "sourceNotes"],
    "invalid NYC navigation notices",
  );
  const parseList = (entry: unknown): string[] => {
    if (
      !Array.isArray(entry) ||
      entry.some((item) => typeof item !== "string" || item.length === 0)
    )
      throw new Error("invalid NYC navigation notices");
    return [...entry];
  };
  if (value.version !== 1 || value.dataset !== "nyc-navigation" || value.generation !== generation)
    throw new Error("invalid NYC navigation notices");
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    attribution: parseList(value.attribution),
    licenses: parseList(value.licenses),
    sourceNotes: parseList(value.sourceNotes),
  };
}

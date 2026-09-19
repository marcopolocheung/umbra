import {
  MAX_BUILDING_SHARD_BYTES,
  MAX_STREET_SHARD_BYTES,
  MAX_TOTAL_BYTES,
  type GeoBounds,
  type NavigationBuilding,
  type NavigationBuildingShard,
  type NavigationBuildingShardRef,
  type NavigationManifest,
  type NavigationNotices,
  type NavigationPointer,
  type NavigationStreetEdge,
  type NavigationStreetNode,
  type NavigationStreetShard,
  type NavigationStreetShardRef,
} from "../../../app/lib/navigationData/shardContract";
import { canonicalJson, jsonBytes, sha256Hex } from "./canonical";

const SUPPORT_BOUNDS: GeoBounds = {
  south: 40.754,
  west: -73.989,
  north: 40.757,
  east: -73.985,
};

const WEST_GEOMETRY_BOUNDS: GeoBounds = {
  south: 40.7545,
  west: -73.989,
  north: 40.7565,
  east: -73.987,
};

const EAST_GEOMETRY_BOUNDS: GeoBounds = {
  south: 40.7545,
  west: -73.987,
  north: 40.7565,
  east: -73.985,
};

const WEST_SUPPORT_BOUNDS: GeoBounds = {
  south: 40.754,
  west: -73.989,
  north: 40.757,
  east: -73.9868,
};

const EAST_SUPPORT_BOUNDS: GeoBounds = {
  south: 40.754,
  west: -73.9872,
  north: 40.757,
  east: -73.985,
};

const WEST_NODES: NavigationStreetNode[] = [
  { id: 1001, lat: 40.755, lon: -73.9885, isIntersection: true },
  { id: 1002, lat: 40.7555, lon: -73.987, isIntersection: true },
  // This endpoint belongs to the east geometry cell but is a ghost node here.
  { id: 1003, lat: 40.756, lon: -73.9862, isIntersection: true },
  { id: 1004, lat: 40.7558, lon: -73.988, isIntersection: false },
];

const EAST_NODES: NavigationStreetNode[] = [
  // This endpoint belongs to the west geometry cell but is a ghost node here.
  { id: 1002, lat: 40.7555, lon: -73.987, isIntersection: true },
  { id: 1003, lat: 40.756, lon: -73.9862, isIntersection: true },
  { id: 1005, lat: 40.7562, lon: -73.9857, isIntersection: false },
];

function edge(
  id: string,
  from: number,
  to: number,
  distanceM: number,
  tags: NavigationStreetEdge["tags"],
): NavigationStreetEdge {
  return { id, from, to, distanceM, tags };
}

const WEST_EDGES: NavigationStreetEdge[] = [
  edge("way-2001-a", 1001, 1002, 142, { highway: "residential", surface: "asphalt" }),
  edge("way-2001-b", 1002, 1001, 142, { highway: "residential", surface: "asphalt" }),
  // The owner is west; node 1003 is intentionally a ghost in this shard.
  edge("way-2002-a", 1002, 1003, 75, { highway: "pedestrian", foot: "yes" }),
  edge("way-2002-b", 1003, 1002, 75, { highway: "pedestrian", foot: "yes" }),
  edge("way-2003-a", 1002, 1004, 48, { highway: "steps", surface: "concrete", access: "yes" }),
  edge("way-2003-b", 1004, 1002, 48, { highway: "steps", surface: "concrete", access: "yes" }),
];

const EAST_EDGES: NavigationStreetEdge[] = [
  edge("way-2004-a", 1003, 1005, 52, {
    highway: "footway",
    surface: "concrete",
    foot: "designated",
  }),
  edge("way-2004-b", 1005, 1003, 52, {
    highway: "footway",
    surface: "concrete",
    foot: "designated",
  }),
];

const WEST_BUILDINGS: NavigationBuilding[] = [
  {
    id: "doitt-fixture-1",
    rings: [
      [
        [-73.98735, 40.75515],
        [-73.9869, 40.75515],
        [-73.9869, 40.75565],
        [-73.98735, 40.75565],
        [-73.98735, 40.75515],
      ],
    ],
    heightM: 38.1,
    heightSource: "source",
    featureCode: 2100,
    status: "active",
  },
];

const EAST_BUILDINGS: NavigationBuilding[] = [
  {
    id: "doitt-fixture-2",
    rings: [
      [
        [-73.98665, 40.7558],
        [-73.9862, 40.7558],
        [-73.9862, 40.7562],
        [-73.98665, 40.7562],
        [-73.98665, 40.7558],
      ],
    ],
    heightM: null,
    heightSource: "unknown",
    featureCode: 2100,
    status: "active",
  },
];

/** Source-only records used to demonstrate the policy that rejects placeholders. */
export const REJECTED_FIXTURE_BUILDINGS = [
  {
    id: "doitt-fixture-placeholder",
    featureCode: 1003,
    reason: "placeholder triangles are not ground-shadow casters",
  },
] as const;

function streetShard(
  generation: string,
  geometryBounds: GeoBounds,
  supportBounds: GeoBounds,
  nodes: NavigationStreetNode[],
  edges: NavigationStreetEdge[],
): NavigationStreetShard {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds,
    supportBounds,
    nodes,
    edges,
  };
}

function buildingShard(
  generation: string,
  geometryBounds: GeoBounds,
  supportBounds: GeoBounds,
  buildings: NavigationBuilding[],
): NavigationBuildingShard {
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

function streetRef(
  key: string,
  value: NavigationStreetShard,
  bytes: Uint8Array,
): NavigationStreetShardRef {
  return {
    key,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    geometryBounds: value.geometryBounds,
    supportBounds: value.supportBounds,
    nodes: value.nodes.length,
    edges: value.edges.length,
  };
}

function buildingRef(
  key: string,
  value: NavigationBuildingShard,
  bytes: Uint8Array,
): NavigationBuildingShardRef {
  const buildings = value.buildings;
  return {
    key,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    geometryBounds: value.geometryBounds,
    supportBounds: value.supportBounds,
    buildings: buildings.length,
    rings: buildings.reduce((sum, building) => sum + building.rings.length, 0),
    missingHeights: buildings.filter((building) => building.heightM === null).length,
    maxHeightM: buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0),
  };
}

export interface FixtureGeneration {
  generation: string;
  pointer: NavigationPointer;
  manifest: NavigationManifest;
  notices: NavigationNotices;
  streetShards: Map<string, NavigationStreetShard>;
  buildingShards: Map<string, NavigationBuildingShard>;
  bytes: Map<string, Uint8Array>;
}

/** Builds the complete fixture from stable literals and no network or clock. */
export function buildFixtureGeneration(): FixtureGeneration {
  const seed = {
    supportBounds: SUPPORT_BOUNDS,
    streets: {
      west: { nodes: WEST_NODES, edges: WEST_EDGES },
      east: { nodes: EAST_NODES, edges: EAST_EDGES },
    },
    buildings: { west: WEST_BUILDINGS, east: EAST_BUILDINGS },
    rejectedBuildings: REJECTED_FIXTURE_BUILDINGS,
  };
  const generation = `nyc-2026-09-18-${sha256Hex(canonicalJson(seed)).slice(0, 12)}`;
  const streets = new Map<string, NavigationStreetShard>([
    [
      "streets/z14-west.json",
      streetShard(generation, WEST_GEOMETRY_BOUNDS, WEST_SUPPORT_BOUNDS, WEST_NODES, WEST_EDGES),
    ],
    [
      "streets/z14-east.json",
      streetShard(generation, EAST_GEOMETRY_BOUNDS, EAST_SUPPORT_BOUNDS, EAST_NODES, EAST_EDGES),
    ],
  ]);
  const buildings = new Map<string, NavigationBuildingShard>([
    [
      "buildings/z14-west.json",
      buildingShard(generation, WEST_GEOMETRY_BOUNDS, WEST_SUPPORT_BOUNDS, WEST_BUILDINGS),
    ],
    [
      "buildings/z14-east.json",
      buildingShard(generation, EAST_GEOMETRY_BOUNDS, EAST_SUPPORT_BOUNDS, EAST_BUILDINGS),
    ],
  ]);
  const bytes = new Map<string, Uint8Array>();
  const streetRefs = [...streets.entries()].map(([key, value]) => {
    const body = jsonBytes(value);
    bytes.set(key, body);
    return streetRef(key, value, body);
  });
  const buildingRefs = [...buildings.entries()].map(([key, value]) => {
    const body = jsonBytes(value);
    bytes.set(key, body);
    return buildingRef(key, value, body);
  });

  const notices: NavigationNotices = {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    attribution: ["© OpenStreetMap contributors", "NYC Office of Technology and Innovation"],
    licenses: [
      "OpenStreetMap data: Open Database License (ODbL)",
      "NYC Building Footprints: NYC Open Data terms of use",
    ],
    sourceNotes: [
      "Session-1 fixture only; no citywide source was downloaded.",
      "Placeholder building features are rejected before publication.",
    ],
  };
  const noticesPath = `navigation/nyc/${generation}/notices.json`;
  const noticesBytes = jsonBytes(notices);
  bytes.set(noticesPath, noticesBytes);

  const manifest: NavigationManifest = {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: "2026-09-18T00:00:00.000Z",
    supportBounds: SUPPORT_BOUNDS,
    recipe: "navigation-fixture-v1",
    sources: [
      {
        id: "osm-fixture",
        release: "session-1",
        url: "https://example.invalid/nyc-navigation-fixture/osm.pbf",
        bytes: 1000,
        timestamp: "2026-09-18T00:00:00Z",
        sha256: "1".repeat(64),
      },
      {
        id: "nyc-building-footprints-fixture",
        release: "session-1",
        url: "https://example.invalid/nyc-navigation-fixture/buildings.geojson",
        bytes: 2000,
        timestamp: "2026-09-18T00:00:00Z",
        sha256: "2".repeat(64),
      },
    ],
    noticesPath,
    noticesSha256: sha256Hex(noticesBytes),
    streetShards: streetRefs,
    buildingShards: buildingRefs,
    budgets: {
      streetShardBytes: streetRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      buildingShardBytes: buildingRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      totalBytes:
        streetRefs.reduce((sum, ref) => sum + ref.bytes, 0) +
        buildingRefs.reduce((sum, ref) => sum + ref.bytes, 0) +
        noticesBytes.byteLength,
    },
  };
  const manifestPath = `navigation/nyc/${generation}/manifest.json`;
  const manifestBytes = jsonBytes(manifest);
  bytes.set(manifestPath, manifestBytes);
  const pointer: NavigationPointer = {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    manifestPath,
    manifestSha256: sha256Hex(manifestBytes),
  };

  if (
    streetRefs.some((ref) => ref.bytes > MAX_STREET_SHARD_BYTES) ||
    buildingRefs.some((ref) => ref.bytes > MAX_BUILDING_SHARD_BYTES) ||
    manifest.budgets.totalBytes > MAX_TOTAL_BYTES
  )
    throw new Error("fixture exceeds navigation contract budgets");

  return {
    generation,
    pointer,
    manifest,
    notices,
    streetShards: streets,
    buildingShards: buildings,
    bytes,
  };
}

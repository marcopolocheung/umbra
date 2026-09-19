import { describe, expect, it } from "vitest";
import {
  parseNavigationBuildingShard,
  parseNavigationManifest,
  parseNavigationNotices,
  parseNavigationPointer,
  parseNavigationStreetShard,
  type NavigationBuildingShardRef,
  type NavigationManifest,
  type NavigationStreetShardRef,
} from "../shardContract";

const generation = "nyc-2026-09-18-0123456789ab";
const bounds = { south: 40.7, west: -74.1, north: 40.8, east: -73.9 };
const streetRef: NavigationStreetShardRef = {
  key: "streets/z14-test.json",
  bytes: 200,
  sha256: "a".repeat(64),
  geometryBounds: bounds,
  supportBounds: bounds,
  nodes: 2,
  edges: 2,
};
const buildingRef: NavigationBuildingShardRef = {
  key: "buildings/z14-test.json",
  bytes: 300,
  sha256: "b".repeat(64),
  geometryBounds: bounds,
  supportBounds: bounds,
  buildings: 1,
  rings: 1,
  missingHeights: 0,
  maxHeightM: 20,
};

function manifest(overrides: Partial<NavigationManifest> = {}): NavigationManifest {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: "2026-09-18T00:00:00.000Z",
    supportBounds: bounds,
    recipe: "test",
    sources: [
      { id: "osm", release: "test", url: "https://example.test/osm.pbf", bytes: 1000, timestamp: "2026-09-18T00:00:00Z", sha256: "c".repeat(64) },
    ],
    noticesPath: `navigation/nyc/${generation}/notices.json`,
    noticesSha256: "d".repeat(64),
    streetShards: [streetRef],
    buildingShards: [buildingRef],
    budgets: { streetShardBytes: 200, buildingShardBytes: 300, totalBytes: 500 },
    ...overrides,
  };
}

function streetShard() {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds: bounds,
    supportBounds: bounds,
    nodes: [
      { id: 1, lat: 40.75, lon: -74, isIntersection: true },
      { id: 2, lat: 40.751, lon: -73.999, isIntersection: false },
    ],
    edges: [
      {
        id: "e1",
        from: 1,
        to: 2,
        distanceM: 120,
        tags: { highway: "footway", surface: "concrete" },
      },
      {
        id: "e1-reverse",
        from: 2,
        to: 1,
        distanceM: 120,
        tags: { highway: "footway", surface: "concrete" },
      },
    ],
  };
}

function buildingShard() {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "buildings",
    geometryBounds: bounds,
    supportBounds: bounds,
    buildings: [
      {
        id: "b1",
        rings: [
          [
            [-74, 40.75],
            [-73.999, 40.75],
            [-73.999, 40.751],
            [-74, 40.751],
            [-74, 40.75],
          ],
        ],
        heightM: 20,
        heightSource: "source",
        featureCode: 2100,
        status: "active",
      },
    ],
  };
}

describe("navigation pointer", () => {
  it("accepts a generation-bound manifest path", () => {
    expect(
      parseNavigationPointer({
        version: 1,
        dataset: "nyc-navigation",
        generation,
        manifestPath: `navigation/nyc/${generation}/manifest.json`,
        manifestSha256: "a".repeat(64),
      }).generation,
    ).toBe(generation);
  });

  it.each([
    { generation: "../../secret", manifestPath: "navigation/nyc/../../secret/manifest.json" },
    { generation, manifestPath: "navigation/nyc/other/manifest.json" },
  ])("rejects unsafe pointer paths: $manifestPath", (bad) => {
    expect(() =>
      parseNavigationPointer({
        version: 1,
        dataset: "nyc-navigation",
        generation: bad.generation,
        manifestPath: bad.manifestPath,
        manifestSha256: "a".repeat(64),
      }),
    ).toThrow(/pointer/);
  });
});

describe("navigation manifest", () => {
  it("rejects a generation mismatch, duplicate keys, and an inverted support box", () => {
    expect(() => parseNavigationManifest(manifest(), "nyc-2026-09-19-0123456789ab")).toThrow(
      /manifest/,
    );
    expect(() =>
      parseNavigationManifest(manifest({ streetShards: [streetRef, streetRef] }), generation),
    ).toThrow(/duplicate/);
    expect(() =>
      parseNavigationManifest(
        manifest({ supportBounds: { south: 41, west: -74, north: 40, east: -73 } }),
        generation,
      ),
    ).toThrow(/bounds/);
  });

  it("rejects a shard outside the dataset support", () => {
    expect(() =>
      parseNavigationManifest(
        manifest({
          streetShards: [
            { ...streetRef, supportBounds: { south: 39, west: -74.2, north: 40.9, east: -73.8 } },
          ],
        }),
        generation,
      ),
    ).toThrow(/outside/);
  });
});

describe("navigation street shard", () => {
  it("accepts a bidirectional fixture", () => {
    expect(parseNavigationStreetShard(streetShard(), streetRef, generation).edges).toHaveLength(2);
  });

  it("rejects dangling edges, duplicate nodes, and count mismatches", () => {
    expect(() =>
      parseNavigationStreetShard(
        {
          ...streetShard(),
          edges: [{ ...streetShard().edges[0], to: 99 }, streetShard().edges[1]],
        },
        streetRef,
        generation,
      ),
    ).toThrow(/dangling/);
    expect(() =>
      parseNavigationStreetShard(
        { ...streetShard(), nodes: [streetShard().nodes[0], streetShard().nodes[0]] },
        { ...streetRef, nodes: 2 },
        generation,
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      parseNavigationStreetShard(streetShard(), { ...streetRef, edges: 3 }, generation),
    ).toThrow(/invalid/);
  });
});

describe("navigation building shard", () => {
  it("accepts a positive source height", () => {
    expect(
      parseNavigationBuildingShard(buildingShard(), buildingRef, generation).buildings[0].heightM,
    ).toBe(20);
  });

  it("keeps unknown height distinct from zero and rejects inconsistent states", () => {
    const unknown = {
      ...buildingShard(),
      buildings: [{ ...buildingShard().buildings[0], heightM: null, heightSource: "unknown" }],
    };
    expect(
      parseNavigationBuildingShard(
        unknown,
        { ...buildingRef, missingHeights: 1, maxHeightM: 0 },
        generation,
      ).buildings[0].heightM,
    ).toBeNull();
    expect(() =>
      parseNavigationBuildingShard(
        {
          ...buildingShard(),
          buildings: [{ ...buildingShard().buildings[0], heightM: 0, heightSource: "source" }],
        },
        buildingRef,
        generation,
      ),
    ).toThrow(/building/);
  });
});

describe("navigation notices", () => {
  it("pins notices to the generation", () => {
    expect(
      parseNavigationNotices(
        {
          version: 1,
          dataset: "nyc-navigation",
          generation,
          attribution: ["© OpenStreetMap contributors"],
          licenses: ["ODbL"],
          sourceNotes: ["fixture"],
        },
        generation,
      ).generation,
    ).toBe(generation);
  });
});

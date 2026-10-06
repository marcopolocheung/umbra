import { describe, expect, it } from "vitest";
import {
  parseNavigationManifest,
  parseNavigationShadeShard,
  type NavigationManifest,
  type NavigationShadeShardRef,
} from "../shardContract";

const generation = "nyc-2026-09-18-abcdef012345";
const bounds = { south: 40.75, west: -74.0, north: 40.76, east: -73.99 };
const generationSha = "a".repeat(64);

const streetRef = {
  key: "streets/z14-1-2.json",
  bytes: 100,
  sha256: generationSha,
  geometryBounds: bounds,
  supportBounds: bounds,
  nodes: 2,
  edges: 2,
};
const buildingRef = {
  key: "buildings/z14-1-2.json",
  bytes: 100,
  sha256: generationSha,
  geometryBounds: bounds,
  supportBounds: bounds,
  buildings: 1,
  rings: 1,
  missingHeights: 0,
  maxHeightM: 20,
};

function shadeRef(overrides: Partial<NavigationShadeShardRef> = {}): NavigationShadeShardRef {
  return {
    key: "shades/z14-1-2.json",
    bytes: 200,
    sha256: generationSha,
    geometryBounds: bounds,
    supportBounds: bounds,
    segments: 2,
    slots: 768,
    payloadKey: "shades/z14-1-2.bin",
    payloadBytes: 2 * 768 * 2,
    payloadSha256: "b".repeat(64),
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: "2026-09-18T00:00:00.000Z",
    supportBounds: bounds,
    recipe: "test",
    sources: [
      {
        id: "osm",
        release: "test",
        url: "https://example.test/osm.pbf",
        bytes: 1000,
        timestamp: "2026-09-18T00:00:00Z",
        sha256: generationSha,
      },
    ],
    noticesPath: `navigation/nyc/${generation}/notices.json`,
    noticesSha256: generationSha,
    streetShards: [streetRef],
    buildingShards: [buildingRef],
    budgets: {
      streetShardBytes: 100,
      buildingShardBytes: 100,
      shadeShardBytes: 0,
      totalBytes: 200,
    },
    ...overrides,
  };
}

describe("navigation shade shard contract", () => {
  it("accepts a manifest without a shade table (older generations)", () => {
    const parsed: NavigationManifest = parseNavigationManifest(manifest(), generation);
    expect(parsed.shadeShards).toBeUndefined();
    expect(parsed.budgets.shadeShardBytes).toBe(0);
  });

  it("parses a manifest carrying a shade table", () => {
    const parsed = parseNavigationManifest(
      manifest({
        shadeShards: [shadeRef()],
        budgets: {
          streetShardBytes: 100,
          buildingShardBytes: 100,
          shadeShardBytes: 3072,
          totalBytes: 3272,
        },
      }),
      generation,
    );
    expect(parsed.shadeShards).toHaveLength(1);
    expect(parsed.shadeShards?.[0].segments).toBe(2);
    expect(parsed.budgets.shadeShardBytes).toBe(3072);
  });

  it("rejects a shade ref whose payload size disagrees with its columns", () => {
    const shard = {
      version: 1,
      dataset: "nyc-navigation",
      generation,
      kind: "shade",
      geometryBounds: bounds,
      supportBounds: bounds,
      slots: 768,
      segments: [
        [1, 2],
        [3, 4],
      ],
      payload: { key: "shades/z14-1-2.bin", bytes: 999, sha256: "b".repeat(64) },
    };
    expect(() => parseNavigationShadeShard(shard, shadeRef())).toThrow();
  });

  it("parses a well-formed shade index", () => {
    const shard = {
      version: 1,
      dataset: "nyc-navigation",
      generation,
      kind: "shade",
      geometryBounds: bounds,
      supportBounds: bounds,
      slots: 768,
      segments: [
        [1, 2],
        [3, 4],
      ],
      payload: {
        key: "shades/z14-1-2.bin",
        bytes: 2 * 768 * 2,
        sha256: "b".repeat(64),
      },
    };
    const parsed = parseNavigationShadeShard(shard, shadeRef(), generation);
    expect(parsed.segments).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parsed.payload.key).toBe("shades/z14-1-2.bin");
  });

  it("rejects unordered or non-canonical segments", () => {
    const base = {
      version: 1,
      dataset: "nyc-navigation",
      generation,
      kind: "shade",
      geometryBounds: bounds,
      supportBounds: bounds,
      slots: 768,
      payload: { key: "shades/z14-1-2.bin", bytes: 2 * 768 * 2, sha256: "b".repeat(64) },
    };
    expect(() =>
      parseNavigationShadeShard({ ...base, segments: [[4, 3], [1, 2]] }, shadeRef()),
    ).toThrow();
    expect(() =>
      parseNavigationShadeShard({ ...base, segments: [[1, 2], [1, 2]] }, shadeRef()),
    ).toThrow();
  });
});

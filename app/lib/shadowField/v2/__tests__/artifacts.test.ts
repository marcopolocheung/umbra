import { describe, expect, it } from "vitest";
import {
  artifactBytes,
  assembleTileBounds,
  assertArtifactBudget,
  buildCoverageIndex,
  buildGenerationRoot,
  buildNotices,
  canonicalLicenceBinding,
  classifyTileSupport,
  coverageSetHas,
  coverageSetIsSubset,
  coverageSetToTiles,
  licenceRecordsFor,
  MAX_BOUNDS_BYTES,
  MAX_COVERAGE_BYTES,
  parseGenerationRoot,
  parseZ18Tile,
  reduceBoundsLevel,
  reduceComposedTile,
  reduceConservativeBounds,
  ROOF_BELOW_TERRAIN_ANOMALY,
  sortTilesYX,
  tileBoundsLonLat,
  tileCellLonLatZ18,
  tileIntersectsCoverage,
  tilesToCoverageSet,
  type CoverageGeometry,
  type LeafBoundsArrays,
  type RegionLicenceInput,
} from "../artifacts";
import { COMPONENT_FLAGS, type ComponentKind } from "../types";
import { composeTile } from "../compose";
import type { ComposedTile } from "../compose";

const world: CoverageGeometry = {
  type: "Polygon",
  coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
};

const regionInput: RegionLicenceInput = {  boundaryLicence: "NYC Open Data Terms of Use",
  boundaryUrl: "https://example.com/boundary",
  boundaryRelease: "26b",
  sources: [
    { id: "fabdem-v1.2", kind: "terrain", licence: "CC BY-NC-SA 4.0", url: "https://example.com/fabdem" },
    { id: "overture-buildings", kind: "buildings", licence: "ODbL 1.0", url: "https://example.com/overture" },
    { id: "chmv2-native", kind: "canopy", licence: "CC BY 4.0", url: "https://example.com/chm" },
    { id: "osm-tree-fallback", kind: "canopy-fallback", licence: "ODbL 1.0", url: "https://example.com/osm" },
  ],
  regionFileSha256: "a".repeat(64),
};

function v2TestIdentity(kind: ComponentKind) {
  return {
    generation: "test-gen",
    tile: "18/1/1",
    sourceHash: `source-${kind}`,
    recipeHash: "recipe",
    datumHash: "datum",
    hierarchyHash: "hierarchy",
    licenceHash: `licence-${kind}`,
  };
}

function composedFixture(ground: number, building: number, crown: number, unknown: boolean): ComposedTile {
  const cells = 258 * 258;
  const flags = new Uint32Array(cells);
  if (building > 0) flags.fill(COMPONENT_FLAGS.buildingPresent);
  if (crown > 0) flags.fill(flags[0] | COMPONENT_FLAGS.canopyPresent);
  if (unknown) flags[0] |= COMPONENT_FLAGS.buildingUnknown;
  const groundQ = new Int32Array(cells).fill(ground);
  const buildingTopQ = new Int32Array(cells).fill(building);
  const crownTopQ = new Int32Array(cells).fill(crown);
  return {
    groundQ,
    buildingTopQ,
    crownBaseQ: new Int32Array(cells),
    crownTopQ,
    flagsAndMaterial: flags,
    provenanceIndex: new Uint32Array(cells),
    evidence: { terrain: "present", buildings: "present", canopy: "present", complete: !unknown },
    accounting: { outputBytes: cells * 24, reservedBytes: cells * 24 },
  };
}

describe("coverage sets", () => {
  it("round-trips tiles through row runs", () => {
    const tiles = ["18/2/10", "18/1/10", "18/1/11", "18/5/10", "18/3/10"];
    const set = tilesToCoverageSet(tiles);
    expect(set.count).toBe(5);
    expect(set.rows).toHaveLength(2);
    expect(coverageSetToTiles(set).sort()).toEqual([...tiles].sort());
    expect(coverageSetHas(set, 1, 10)).toBe(true);
    expect(coverageSetHas(set, 4, 10)).toBe(false);
  });

  it("rejects duplicates and malformed tiles", () => {
    expect(() => tilesToCoverageSet(["18/1/1", "18/1/1"])).toThrow(/duplicate/);
    expect(() => tilesToCoverageSet(["17/1/1"])).toThrow(/invalid z18/);
    expect(() => parseZ18Tile("18/1")).toThrow(/invalid z18/);
  });

  it("enforces activation as a subset of availability", () => {
    const available = ["18/1/1", "18/2/1"];
    const good = buildCoverageIndex({
      generation: "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2",
      availableTiles: available,
      activationTiles: ["18/1/1"],
      activationRule: "test",
      activationBoundary: null,
    });
    expect(good.activationTileCount).toBe(1);
    expect(good.availableTileCount).toBe(2);
    expect(() =>
      buildCoverageIndex({
        generation: "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2",
        availableTiles: available,
        activationTiles: ["18/9/9"],
        activationRule: "test",
        activationBoundary: null,
      }),
    ).toThrow(/subset/);
    expect(coverageSetIsSubset(tilesToCoverageSet(["18/1/1"]), tilesToCoverageSet(available))).toBe(true);
  });

  it("sorts tiles in row-major order", () => {
    expect(sortTilesYX(["18/2/10", "18/1/11", "18/1/10"])).toEqual(["18/1/10", "18/2/10", "18/1/11"]);
  });
});

describe("coverage geometry", () => {
  it("classifies interior tiles as fully known and exterior tiles as fully unknown", () => {
    const inside = classifyTileSupport(world, 77123, 98543);
    expect(inside.every((value) => value === 1)).toBe(true);
    const far: CoverageGeometry = {
      type: "Polygon",
      coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
    };
    const outside = classifyTileSupport(far, 77123, 98543);
    expect(outside.every((value) => value === 2)).toBe(true);
  });

  it("marks boundary tiles mixed without blanket values", () => {
    const bounds = tileBoundsLonLat(77123, 98543, 1);
    const westHalf: CoverageGeometry = {
      type: "Polygon",
      coordinates: [[
        [bounds.west, bounds.south],
        [(bounds.west + bounds.east) / 2, bounds.south],
        [(bounds.west + bounds.east) / 2, bounds.north],
        [bounds.west, bounds.north],
        [bounds.west, bounds.south],
      ]],
    };
    const mixed = classifyTileSupport(westHalf, 77123, 98543);
    expect(mixed.some((value) => value === 1)).toBe(true);
    expect(mixed.some((value) => value === 2)).toBe(true);
  });

  it("tests tile-area intersection for the activation clip", () => {
    expect(tileIntersectsCoverage(world, 77123, 98543)).toBe(true);
    const [lon, lat] = tileCellLonLatZ18(77123, 98543, 129, 129);
    const d = 0.0005;
    const around: CoverageGeometry = {
      type: "Polygon",
      coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
    };
    expect(tileIntersectsCoverage(around, 77123, 98543)).toBe(true);
    const far: CoverageGeometry = {
      type: "Polygon",
      coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
    };
    expect(tileIntersectsCoverage(far, 77123, 98543)).toBe(false);
    expect(tileIntersectsCoverage(far, 77123, 98544)).toBe(false);
  });
});

describe("bounds reduction", () => {
  it("reduces a composed tile to per-component bounds", () => {
    const reduced = reduceComposedTile(composedFixture(64, 832, 764, false));
    expect(reduced).toMatchObject({ minG: 64, maxG: 64, maxTopQ: 832, maxCrownQ: 764, coverage: 0 });
    const unknown = reduceComposedTile(composedFixture(64, 0, 0, true));
    expect(unknown.coverage).toBe(1);
  });

  it("matches the conservative fallback on anomaly-free tiles", () => {
    const cells = 258 * 258;
    const ground = new Uint32Array(cells).fill(64);
    const foundation = new Uint32Array(cells).fill(32);
    const present = new Uint32Array(cells).fill(1);
    const agl = new Uint32Array(cells);
    agl[9] = 640;
    const mask = new Uint32Array(cells);
    mask[9] = 1;
    const known = new Uint32Array(cells).fill(1);
    const zeros = new Uint32Array(cells);
    const terrain = {
      kind: "terrain" as const,
      identity: v2TestIdentity("terrain"),
      evidence: {},
      planes: [
        { name: "groundQ" as const, type: "i32" as const, words: ground },
        { name: "foundationQ" as const, type: "i32" as const, words: foundation },
        { name: "foundationPresent" as const, type: "u32" as const, words: present },
      ],
    };
    const buildings = {
      kind: "buildings" as const,
      identity: v2TestIdentity("buildings"),
      support: "present" as const,
      evidence: {},
      planes: [
        { name: "buildingAglQ" as const, type: "i32" as const, words: agl },
        { name: "buildingMask" as const, type: "u32" as const, words: mask },
        { name: "buildingSupport" as const, type: "u32" as const, words: known },
      ],
    };
    const canopy = {
      kind: "canopy" as const,
      identity: v2TestIdentity("canopy"),
      support: "known-empty" as const,
      evidence: {},
      planes: [
        { name: "canopyHeightAglQ" as const, type: "i32" as const, words: zeros },
        { name: "canopyMask" as const, type: "u32" as const, words: zeros.slice() },
        { name: "canopySupport" as const, type: "u32" as const, words: known.slice() },
      ],
    };
    const composed = composeTile([terrain, buildings, canopy], { reserve: () => true });
    expect(reduceConservativeBounds(terrain, buildings, canopy)).toEqual(reduceComposedTile(composed));
  });

  it("bounds buried roofs conservatively instead of throwing", () => {
    const cells = 258 * 258;
    // Whole-feature foundation below a steep upslope ground cell: the stored
    // roof sits under local ground, exactly like staged tile 18/77196/98517.
    const ground = new Uint32Array(cells).fill(5000);
    const foundation = new Uint32Array(cells).fill(3800);
    const present = new Uint32Array(cells).fill(1);
    const agl = new Uint32Array(cells).fill(1000);
    const mask = new Uint32Array(cells).fill(1);
    const known = new Uint32Array(cells).fill(1);
    const terrain = {
      kind: "terrain" as const,
      identity: v2TestIdentity("terrain"),
      evidence: {},
      planes: [
        { name: "groundQ" as const, type: "i32" as const, words: ground },
        { name: "foundationQ" as const, type: "i32" as const, words: foundation },
        { name: "foundationPresent" as const, type: "u32" as const, words: present },
      ],
    };
    const buildings = {
      kind: "buildings" as const,
      identity: v2TestIdentity("buildings"),
      support: "present" as const,
      evidence: {},
      planes: [
        { name: "buildingAglQ" as const, type: "i32" as const, words: agl },
        { name: "buildingMask" as const, type: "u32" as const, words: mask },
        { name: "buildingSupport" as const, type: "u32" as const, words: known },
      ],
    };
    expect(() => composeTile([terrain, buildings], { reserve: () => true })).toThrow(
      /roof below terrain/,
    );
    const reduced = reduceConservativeBounds(terrain, buildings, undefined);
    // The raw stored roof still bounds the stored geometry from above.
    expect(reduced.maxTopQ).toBe(3800 + 1000);
    expect(reduced.minG).toBe(5000);
    expect(ROOF_BELOW_TERRAIN_ANOMALY).toBe("roof-below-terrain");
  });

  it("encloses every leaf in every hierarchy ancestor", () => {
    const leafByTile = new Map([
      ["18/100/200", { minG: 10, maxG: 15, maxTopQ: 100, maxCrownQ: 0, coverage: 0 as const }],
      ["18/101/200", { minG: 20, maxG: 25, maxTopQ: 0, maxCrownQ: 60, coverage: 1 as const }],
      ["18/100/201", { minG: 30, maxG: 35, maxTopQ: 50, maxCrownQ: 0, coverage: 0 as const }],
      ["18/101/201", { minG: 40, maxG: 45, maxTopQ: 0, maxCrownQ: 0, coverage: 2 as const }],
    ]);
    const artifact = assembleTileBounds("nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2", leafByTile);
    expect(artifact.tileCount).toBe(4);
    expect(artifact.tileOrder).toBe("y-x");
    const z17 = artifact.levels[0];
    expect(z17.z).toBe(17);
    expect(z17.x).toEqual([50]);
    expect(z17.y).toEqual([100]);
    expect(z17.minG[0]).toBe(10);
    expect(z17.maxG[0]).toBe(45);
    expect(z17.maxTopQ[0]).toBe(100);
    expect(z17.maxCrownQ[0]).toBe(60);
    expect(z17.coverage[0]).toBe(2);
    // Every level down to z10 exists and stays conservative.
    expect(artifact.levels.at(-1)?.z).toBe(10);
    for (const level of artifact.levels) {
      for (let i = 0; i < level.x.length; i++) {
        expect(level.minG[i]).toBeLessThanOrEqual(level.maxG[i]);
      }
    }
  });

  it("assembles identically regardless of input order and rejects duplicates", () => {
    const entries = [
      ["18/101/201", { minG: 40, maxG: 45, maxTopQ: 0, maxCrownQ: 0, coverage: 2 as const }],
      ["18/100/200", { minG: 10, maxG: 15, maxTopQ: 100, maxCrownQ: 0, coverage: 0 as const }],
      ["18/101/200", { minG: 20, maxG: 25, maxTopQ: 0, maxCrownQ: 60, coverage: 1 as const }],
      ["18/100/201", { minG: 30, maxG: 35, maxTopQ: 50, maxCrownQ: 0, coverage: 0 as const }],
    ] as const;
    const scrambled = new Map([...entries].reverse().map(([tile, bounds]) => [tile, { ...bounds }]));
    const ordered = new Map([...entries].map(([tile, bounds]) => [tile, { ...bounds }]));
    const fromScrambled = assembleTileBounds("nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2", scrambled);
    const fromOrdered = assembleTileBounds("nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2", ordered);
    expect(fromScrambled).toEqual(fromOrdered);
    // Leaf arrays follow canonical (y, x) order however the map was filled.
    expect(fromScrambled.leaf.minG).toEqual([10, 20, 30, 40]);
  });

  it("marks parents with missing children unknown", () => {
    const level = reduceBoundsLevel(
      17,
      new Map([["100/200", { x: 100, y: 200, minG: 1, maxG: 2, maxTopQ: 0, maxCrownQ: 0, coverage: 0 }]]),
      [{ x: 50, y: 100 }],
    );
    expect(level.coverage[0]).toBe(2);
    expect(level.minG[0]).toBe(1);
    expect(level.maxG[0]).toBe(2);
  });
});

describe("licences and notices", () => {
  it("binds one canonical record set per kind", () => {
    expect(licenceRecordsFor("terrain", regionInput).map((entry) => entry.id)).toEqual(["fabdem-v1.2"]);
    expect(licenceRecordsFor("buildings", regionInput).map((entry) => entry.id)).toEqual(["overture-buildings"]);
    expect(licenceRecordsFor("canopy", regionInput).map((entry) => entry.id)).toEqual([
      "chmv2-native",
      "osm-tree-fallback",
    ]);
    expect(canonicalLicenceBinding("terrain", regionInput)).toBe(
      canonicalLicenceBinding("terrain", regionInput),
    );
    expect(() =>
      licenceRecordsFor("terrain", { ...regionInput, sources: [] }),
    ).toThrow(/lacks source/);
  });

  it("builds a generation-bound notices document", () => {
    const notices = buildNotices({
      generation: "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2",
      input: regionInput,
      licenceHashes: { terrain: "b".repeat(64), buildings: "c".repeat(64), canopy: "d".repeat(64) },
    });
    expect(notices.projectUse).toMatch(/non-commercial/);
    expect(notices.licences.length).toBeGreaterThanOrEqual(4);
    expect(notices.licenceBindings.terrain).toContain("fabdem-v1.2");
  });
});

describe("generation root", () => {
  const ref = (filename: string) => ({
    path: `/_shadow/generations/nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2/${filename}`,
    sha256: "e".repeat(64),
    bytes: 100,
  });

  function validRoot() {
    return buildGenerationRoot({
      generation: "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2",
      identity: {
        recipeHash: "f".repeat(64),
        datumHash: "f".repeat(64),
        hierarchyHash: "f".repeat(64),
        normalizerHash: "f".repeat(64),
        compositorHash: "f".repeat(64),
        treeModelHash: "f".repeat(64),
        receiverHash: "f".repeat(64),
      },
      manifest: { ...ref("manifest.json"), bytes: 1000 },
      coverage: ref("coverage.json"),
      bounds: ref("bounds.json"),
      notices: ref("notices.json"),
      tileCount: 10,
      availableTileCount: 10,
      activationTileCount: 9,
    });
  }

  it("round-trips through the strict parser", () => {
    const root = validRoot();
    expect(parseGenerationRoot(JSON.parse(JSON.stringify(root))).generation).toContain("nyc-");
  });

  it("fails closed on corrupt references", () => {
    const root = validRoot() as unknown as Record<string, unknown>;
    expect(() =>
      parseGenerationRoot({ ...root, artifacts: { ...(root.artifacts as object), coverage: { ...ref("coverage.json"), sha256: "zz" } } }),
    ).toThrow(/coverage/);
    expect(() => parseGenerationRoot({ ...root, generation: "nope" })).toThrow(/generation root/);
    expect(() => parseGenerationRoot({ ...root, tileCount: 0 })).toThrow(/tileCount/);
  });
});

describe("artifact budgets", () => {
  it("projects full-scale coverage and bounds under budget", () => {
    // A dense 80x50 block stands in for the five-borough footprint; sizes
    // scale linearly in tile count, so project to 61,442 before freezing.
    const tiles: string[] = [];
    for (let y = 98400; y < 98450; y++) for (let x = 77100; x < 77180; x++) tiles.push(`18/${x}/${y}`);
    const coverage = buildCoverageIndex({
      generation: "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2",
      availableTiles: tiles,
      activationTiles: tiles.slice(0, 3000),
      activationRule: "test-projection",
      activationBoundary: null,
    });
    const coverageBytes = artifactBytes(coverage).byteLength;
    expect((coverageBytes * 61442) / tiles.length).toBeLessThan(MAX_COVERAGE_BYTES);
    const leafByTile = new Map(
      tiles.map((tile, i) => [
        tile,
        { minG: i, maxG: i + 10, maxTopQ: i * 2, maxCrownQ: 0, coverage: 0 as const },
      ]),
    );
    const bounds = assembleTileBounds("nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-v2", leafByTile);
    const boundsBytes = artifactBytes(bounds).byteLength;
    expect((boundsBytes * 61442) / tiles.length).toBeLessThan(MAX_BOUNDS_BYTES);
    assertArtifactBudget("coverage.json", coverageBytes, MAX_COVERAGE_BYTES);
    assertArtifactBudget("bounds.json", boundsBytes, MAX_BOUNDS_BYTES);
  });
});

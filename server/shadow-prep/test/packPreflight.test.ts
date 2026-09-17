import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tileBoundsLonLat, type CoverageGeometry } from "../../../app/lib/shadowField/v2/artifacts";
import { candidateTileIndex, NYC_FIVE_BOROUGH_TILE_COUNT } from "../src/pack";
import { loadV2AggregationInputs, v2InputValidationReport } from "../src/pack-full-cli";
import { supportTiles } from "../src/tiles";
import { sha256 } from "../src/util";

const normalizationId = "70e3507f16d472adf5475b614a60cb16";
const indexKey = `browser-pack/nyc-${normalizationId}-five-borough-v1/candidate-index.json`;

function exactRectangle(width: number, height: number): CoverageGeometry {
  const x = 100_000;
  const y = 100_000;
  const first = tileBoundsLonLat(x, y);
  const last = tileBoundsLonLat(x + width - 1, y + height - 1);
  const epsilon = 1e-9;
  return {
    type: "Polygon",
    coordinates: [[
      [first.west + epsilon, first.north - epsilon],
      [last.east - epsilon, first.north - epsilon],
      [last.east - epsilon, last.south + epsilon],
      [first.west + epsilon, last.south + epsilon],
      [first.west + epsilon, first.north - epsilon],
    ]],
  };
}

function fiveFeatureBoundary(candidate: CoverageGeometry) {
  const exterior = (candidate.coordinates as number[][][])[0];
  const west = exterior[0][0];
  const east = exterior[1][0];
  const north = exterior[0][1];
  const south = exterior[2][1];
  return {
    type: "FeatureCollection",
    features: Array.from({ length: 5 }, (_, index) => {
      const left = west + ((east - west) * index) / 5;
      const right = west + ((east - west) * (index + 1)) / 5;
      return {
        type: "Feature",
        properties: { borough: index },
        geometry: { type: "MultiPolygon", coordinates: [[[[left, south], [right, south], [right, north], [left, north], [left, south]]]] },
      };
    }),
  };
}

const requiredReceipts = [
  ["fabdem-v1.2", "terrain"],
  ["overture-buildings", "buildings"],
  ["overture-building-parts", "building-parts"],
  ["chmv2-height", "canopy-height"],
  ["chmv2-validity-mask", "canopy-mask"],
  ["osm-tree-fallback", "canopy-fallback"],
  ["usgs-3dep-controls", "control"],
] as const;

test("v2 preflight uses aggregation inputs, validates the exact index, and has no publication store", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-v2-preflight-"));
  const originalArgv = process.argv;
  try {
    const candidate = exactRectangle(62, 991);
    const tiles = supportTiles(candidate).map((tile) => tile.key);
    assert.equal(tiles.length, NYC_FIVE_BOROUGH_TILE_COUNT);
    const index = candidateTileIndex(normalizationId, tiles);
    const support: CoverageGeometry = {
      type: "Polygon",
      coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
    };
    const boundary = fiveFeatureBoundary(candidate);
    const admission = {
      blockers: [],
      receipts: requiredReceipts.map(([id, role]) => ({
        id,
        role,
        licence: "test licence",
        rights: `https://example.invalid/${id}/rights`,
        assets: [{ filename: `${id}.bin`, sha256: "a".repeat(64), publisherUrl: `https://example.invalid/${id}`, release: "test" }],
      })),
      datum: {
        grids: ["us_nga_egm08_25.tif", "us_nga_egm96_15.tif"],
        gridHashes: { "us_nga_egm08_25.tif": "b".repeat(64), "us_nga_egm96_15.tif": "c".repeat(64) },
      },
    };
    const supportBytes = new TextEncoder().encode(JSON.stringify(support));
    const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate));
    const boundaryBytes = new TextEncoder().encode(JSON.stringify(boundary));
    const admissionBytes = new TextEncoder().encode(JSON.stringify(admission));
    const supportPath = join(directory, "support.json");
    const candidatePath = join(directory, "candidate.json");
    const boundaryPath = join(directory, "boundary.json");
    const admissionPath = join(directory, "admission.json");
    const regionPath = join(directory, "region.json");
    await Promise.all([
      writeFile(supportPath, supportBytes),
      writeFile(candidatePath, candidateBytes),
      writeFile(boundaryPath, boundaryBytes),
      writeFile(admissionPath, admissionBytes),
      writeFile(regionPath, JSON.stringify({
        boundary: {
          sha256: sha256(boundaryBytes),
          localName: "nyc-borough-boundaries-26b.geojson",
          licence: "NYC Open Data Terms of Use",
          url: "https://example.invalid/boundary",
          release: "26b",
        },
        sources: [],
      })),
    ]);

    process.argv = [
      "node", "pack-full-cli.ts", "--validate-v2-inputs",
      "--support-geometry", supportPath, "--support-sha256", sha256(supportBytes),
      "--candidate-tile-geometry", candidatePath, "--candidate-tile-sha256", sha256(candidateBytes),
      "--borough-boundary", boundaryPath, "--admission-manifest", admissionPath,
      "--region-file", regionPath,
    ];
    let reads = 0;
    const indexBytes = new TextEncoder().encode(JSON.stringify(index));
    const readOnlyIndexStore = {
      read: async (key: string) => {
        reads++;
        assert.equal(key, indexKey);
        return indexBytes;
      },
    };
    const inputs = await loadV2AggregationInputs(readOnlyIndexStore);
    const report = v2InputValidationReport(inputs);
    assert.equal(reads, 1);
    assert.equal(inputs.index.tiles.length, NYC_FIVE_BOROUGH_TILE_COUNT);
    assert.equal(report.action, "validate-v2-inputs");
    assert.equal(report.index.tileCount, NYC_FIVE_BOROUGH_TILE_COUNT);
    assert.equal(report.boundary.featureCount, 5);
    assert.equal(report.boundary.polygonCount, 5);
    assert.equal(report.boundary.ringCount, 5);
    assert.ok(report.activationTileCount > 0);
    assert.equal(report.hashes.supportGeometrySha256, sha256(supportBytes));
    assert.equal(report.hashes.candidateTileGeometrySha256, sha256(candidateBytes));
    assert.equal(report.hashes.boroughBoundarySha256, sha256(boundaryBytes));
    assert.equal(report.hashes.admissionManifestSha256, sha256(admissionBytes));
    assert.match(report.hashes.licence.terrain, /^[a-f0-9]{64}$/);
  } finally {
    process.argv = originalArgv;
    await rm(directory, { recursive: true, force: true });
  }
});

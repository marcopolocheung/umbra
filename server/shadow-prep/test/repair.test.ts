import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTileSupport,
  tileBoundsLonLat,
  tileCellLonLatZ18,
  type CoverageGeometry,
} from "../../../app/lib/shadowField/v2/artifacts";
import { tileBounds, tileCellLonLat } from "../src/tiles";
import {
  boundSourceHash,
  repairBuildingSupport,
  repairPolicyHash,
  REPAIR_POLICY_VERSION,
  supportPlaneHash,
  verifySupportGeometryTiles,
  type RepairReceipt,
} from "../src/repair";
import { STORED_SIZE } from "../../../app/lib/shadowField/v2/types";

const cells = STORED_SIZE * STORED_SIZE;
const world: CoverageGeometry = {
  type: "Polygon",
  coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
};

test("projection helpers match the canonical tile lattice", () => {
  for (const [x, y] of [[77123, 98543], [77336, 98545], [77076, 98687]] as const) {
    const tile = { z: 18 as const, x, y, key: `18/${x}/${y}` };
    const canonical = tileBounds(tile, 1);
    const mirrored = tileBoundsLonLat(x, y, 1);
    for (const [a, b] of [[canonical.west, mirrored.west], [canonical.east, mirrored.east], [canonical.north, mirrored.north], [canonical.south, mirrored.south]] as const) {
      assert.ok(Math.abs(a - b) < 1e-9, `bounds diverge for ${tile.key}`);
    }
    for (const [sx, sy] of [[0, 0], [129, 129], [257, 257]] as const) {
      const [lon, lat] = tileCellLonLat(tile, sx, sy);
      const [mlon, mlat] = tileCellLonLatZ18(x, y, sx, sy);
      assert.ok(Math.abs(lon - mlon) < 1e-9 && Math.abs(lat - mlat) < 1e-9, `cell ${sx},${sy} diverges`);
    }
  }
});

test("repair fills covered tiles as known and exterior tiles as unknown", () => {
  const zeros = new Uint32Array(cells);
  const inside = repairBuildingSupport({
    tile: "18/77123/98543",
    mask: zeros,
    originalSupport: zeros,
    geometry: world,
    geometryHash: "a".repeat(64),
    originalDescriptorHash: "b".repeat(64),
  });
  assert.ok(inside.support.every((value) => value === 1));
  assert.equal(inside.receipt.policy, REPAIR_POLICY_VERSION);
  assert.equal(inside.receipt.policyHash, repairPolicyHash());
  assert.equal(inside.receipt.supportGeometryHash, "a".repeat(64));
  assert.equal(inside.receipt.originalDescriptorHash, "b".repeat(64));
  assert.equal(inside.receipt.originalSupportPlaneHash, supportPlaneHash(zeros));
  assert.notEqual(inside.receipt.correctedSupportPlaneHash, inside.receipt.originalSupportPlaneHash);

  const far: CoverageGeometry = {
    type: "Polygon",
    coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
  };
  const outside = repairBuildingSupport({
    tile: "18/77123/98543",
    mask: zeros,
    originalSupport: zeros,
    geometry: far,
    geometryHash: "c".repeat(64),
    originalDescriptorHash: "b".repeat(64),
  });
  assert.ok(outside.support.every((value) => value === 2));
});

test("repair refuses an occupied cell outside admitted coverage", () => {
  const mask = new Uint32Array(cells);
  mask[100] = 1;
  const far: CoverageGeometry = {
    type: "Polygon",
    coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
  };
  assert.throws(
    () =>
      repairBuildingSupport({
        tile: "18/77123/98543",
        mask,
        originalSupport: new Uint32Array(cells),
        geometry: far,
        geometryHash: "c".repeat(64),
        originalDescriptorHash: "b".repeat(64),
      }),
    /outside admitted coverage/,
  );
});

test("repair derives mixed support on boundary tiles", () => {
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
  const classified = classifyTileSupport(westHalf, 77123, 98543);
  assert.ok(classified.some((value) => value === 1));
  assert.ok(classified.some((value) => value === 2));
});

test("support geometry must reproduce the frozen tile set", async () => {
  const { supportTiles } = await import("../src/tiles.js");
  const square: CoverageGeometry = {
    type: "Polygon",
    coordinates: [[[10, 10], [10.01, 10], [10.01, 10.01], [10, 10.01], [10, 10]]],
  };
  const derived = supportTiles(square).map((tile) => tile.key);
  assert.ok(derived.length > 0 && derived.length < 1000);
  // The comparator accepts the exact derived set and refuses anything else.
  verifySupportGeometryTiles(square, derived);
  assert.throws(() => verifySupportGeometryTiles(square, derived.slice(1)), /refusing repair/);
  assert.throws(() => verifySupportGeometryTiles(square, ["18/10/10"]), /refusing repair/);
});

test("source binding is deterministic and sensitive to every input", () => {
  const receipt: RepairReceipt = {
    version: 1 as const,
    tile: "18/1/1",
    policy: REPAIR_POLICY_VERSION,
    policyHash: repairPolicyHash(),
    supportGeometryHash: "a".repeat(64),
    originalDescriptorHash: "b".repeat(64),
    originalSupportPlaneHash: "c".repeat(64),
    correctedSupportPlaneHash: "d".repeat(64),
  };
  const first = boundSourceHash("e".repeat(64), receipt);
  assert.equal(first, boundSourceHash("e".repeat(64), receipt));
  assert.notEqual(first, boundSourceHash("f".repeat(64), receipt));
  const altered: RepairReceipt = { ...receipt, correctedSupportPlaneHash: "0".repeat(64) };
  assert.notEqual(first, boundSourceHash("e".repeat(64), altered));
  assert.throws(() => boundSourceHash("not-a-hash", receipt), /sha256/);
});

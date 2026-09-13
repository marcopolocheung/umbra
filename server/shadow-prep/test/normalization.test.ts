import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { composeTile } from "../../../app/lib/shadowField/v2/compose";
import { decodeComponent, encodeComponent } from "../../../app/lib/shadowField/v2/format";
import { STORED_SIZE, type Component } from "../../../app/lib/shadowField/v2/types";
import { normalizeFixture } from "../src/normalize";

const gzip = async (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes));
test("fixture raw normalization preserves whole-feature holes/parts and native zero/nodata precedence through components", async () => {
  const count = STORED_SIZE * STORED_SIZE;
  const canopy = Array.from({ length: count }, (_, index) => index === 0 ? { heightQ: 0, valid: true, nodata: false, osmFallbackQ: 900 } : index === 1 ? { heightQ: 0, valid: false, nodata: true, osmFallbackQ: 700 } : { heightQ: 0, valid: false, nodata: true });
  const tile = normalizeFixture("18/1/1", 64, [{ id: "building-a", outer: { coordinates: [[0, 0], [2, 0], [2, 2], [0, 0]] }, holes: [{ coordinates: [[.5, .5], [1, .5], [.5, .5]] }], height: 10, minHeight: 2, parts: [{ id: "part-a", height: 12, minHeight: 2 }] }], canopy);
  assert.equal(tile.evidence.wholeFeatureCount, "1"); assert.equal(tile.canopy.find((p) => p.name === "crownTopAglQ")?.words[0], 0); assert.equal(tile.canopy.find((p) => p.name === "crownTopAglQ")?.words[1], 700);
  const make = (kind: Component["kind"], planes: Component["planes"]): Component => ({ kind, identity: { generation: "g", tile: tile.tile, sourceHash: kind, recipeHash: "r", datumHash: "d", hierarchyHash: "h", licenceHash: "l" }, evidence: tile.evidence, planes });
  const decoded = await Promise.all([make("terrain", tile.terrain), make("buildings", tile.buildings), make("canopy", tile.canopy)].map(async (component) => decodeComponent((await encodeComponent(component, gzip)).bytes)));
  const composed = composeTile(decoded, { reserve: () => true }); assert.equal(composed.groundQ[0], 64); assert.equal(composed.buildingTopQ[0], 832); assert.equal(composed.crownTopQ[1], 764);
});

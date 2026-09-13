import { describe, expect, it } from "vitest";
import { composeTile } from "../compose";
import { STORED_SIZE, type Component } from "../types";

const count = STORED_SIZE * STORED_SIZE;
function part(kind: Component["kind"], planes: Component["planes"]): Component { return { kind, identity: { generation: "g", tile: "18/1/1", sourceHash: kind, recipeHash: "r", datumHash: "d", hierarchyHash: "h", licenceHash: "l" }, evidence: {}, planes }; }
it("composes terrain-derived foundation with independent AGL values", () => {
  const ground = new Uint32Array(count); ground.fill(64);
  const foundation = new Uint32Array(count); foundation[5] = 128;
  const building = new Uint32Array(count); building[5] = 192;
  const result = composeTile([part("terrain", [{ name: "groundQ", type: "i32", words: ground }, { name: "foundationQ", type: "i32", words: foundation }]), part("buildings", [{ name: "buildingAglQ", type: "i32", words: building }])], { reserve: (bytes) => bytes === count * 24 });
  expect(result.buildingTopQ[5]).toBe(320);
  expect(result.groundQ[5]).toBe(64);
});

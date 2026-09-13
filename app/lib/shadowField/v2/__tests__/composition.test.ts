import { expect, it } from "vitest";
import { chooseBuildingCandidate, composeTile } from "../compose";
import { COMPONENT_FLAGS, STORED_SIZE, type Component } from "../types";
import { syntheticComponents, syntheticManifest } from "./formatFixtures";

const count = STORED_SIZE * STORED_SIZE;
function part(kind: Component["kind"], planes: Component["planes"]): Component {
  return {
    kind,
    identity: {
      generation: "g",
      tile: "18/1/1",
      sourceHash: kind,
      recipeHash: "r",
      datumHash: "d",
      hierarchyHash: "h",
      licenceHash: "l",
    },
    evidence: {},
    planes,
  };
}
it("composes terrain-derived foundation with independent AGL values", () => {
  const ground = new Uint32Array(count);
  ground.fill(64);
  const foundation = new Uint32Array(count);
  foundation[5] = 128;
  const building = new Uint32Array(count);
  building[5] = 192;
  const result = composeTile(
    [
      part("terrain", [
        { name: "groundQ", type: "i32", words: ground },
        { name: "foundationQ", type: "i32", words: foundation },
      ]),
      part("buildings", [{ name: "buildingAglQ", type: "i32", words: building }]),
    ],
    { reserve: (bytes) => bytes === count * 24 },
  );
  expect(result.buildingTopQ[5]).toBe(320);
  expect(result.groundQ[5]).toBe(64);
});

it("keeps sloped and negative terrain, whole-feature foundations, and courtyard cells exact", () => {
  const components = syntheticComponents();
  const terrain = components[0].planes.find((entry) => entry.name === "groundQ")?.words;
  const building = components[1].planes.find((entry) => entry.name === "buildingAglQ")?.words;
  if (!terrain || !building) throw new Error("fixture planes missing");
  const roof = composeTile(components, syntheticManifest(components), { reserve: () => true });
  const occupied = STORED_SIZE + 2;
  expect(roof.groundQ[occupied]).toBe(-15);
  expect(roof.buildingTopQ[occupied]).toBe(608); // complete feature foundation -32 + 10 m roof
  expect(roof.buildingTopQ[occupied + 1]).toBe(0); // courtyard stays a hole
  expect(roof.flagsAndMaterial[occupied] & COMPONENT_FLAGS.buildingPresent).toBeTruthy();
});

it("uses native masks at their distinct source pixels, preserves valid-zero absence, clips roofs, and fails closed", () => {
  const components = syntheticComponents();
  const canopy = components[2];
  const mask = canopy.planes.find((entry) => entry.name === "canopyMask")?.words;
  const height = canopy.planes.find((entry) => entry.name === "canopyHeightAglQ")?.words;
  const support = canopy.planes.find((entry) => entry.name === "canopySupport")?.words;
  if (!mask || !height || !support) throw new Error("fixture planes missing");
  const first = STORED_SIZE * 2 + 3;
  const second = first + 2;
  mask[second] = 1;
  height[second] = 320; // a second source pixel, not a filled rectangle
  mask[first + 1] = 0;
  height[first + 1] = 960; // valid zero mask remains absent
  const result = composeTile(components, syntheticManifest(components), { reserve: () => true });
  expect(result.crownTopQ[first]).toBe(result.groundQ[first] + 960);
  expect(result.crownTopQ[first + 1]).toBe(0);
  expect(result.crownTopQ[second]).toBe(result.groundQ[second] + 320);
  expect(result.crownBaseQ[first]).toBe(result.groundQ[first] + 336);
  expect(() =>
    composeTile(components, syntheticManifest(components), { reserve: () => false }),
  ).toThrow(/reservation/);
  canopy.support = "unknown";
  expect(() =>
    composeTile(components, syntheticManifest(components), { reserve: () => true }),
  ).toThrow(/unresolved/);
  support[first] = 0;
});

it("rejects dependency mismatch before it can create a page", () => {
  const components = syntheticComponents();
  components[1].identity.recipeHash = "other";
  let reserved = false;
  expect(() =>
    composeTile(components, syntheticManifest(), {
      reserve: () => {
        reserved = true;
        return true;
      },
    }),
  ).toThrow(/mixed/);
  expect(reserved).toBe(false);
});

it("resolves whole features before clipping with roof then stable ID precedence", () => {
  expect(
    chooseBuildingCandidate([
      { featureId: 9, priority: 1, foundationQ: -64, heightAglQ: 640 },
      { featureId: 4, priority: 1, foundationQ: 0, heightAglQ: 576 },
    ]),
  ).toMatchObject({ featureId: 4 });
  expect(
    chooseBuildingCandidate([
      { featureId: 9, priority: 1, foundationQ: 0, heightAglQ: 640 },
      { featureId: 4, priority: 2, foundationQ: 0, heightAglQ: 640 },
    ]),
  ).toMatchObject({ featureId: 4 });
});

it("uses fallback crowns only where native support is unavailable and clips roof overlap", () => {
  const components = syntheticComponents();
  const canopy = components[2];
  const index = STORED_SIZE + 2;
  const support = canopy.planes.find((entry) => entry.name === "canopySupport")?.words;
  if (!support) throw new Error("fixture support missing");
  const fallbackMask = new Uint32Array(count);
  fallbackMask[index] = 1;
  const fallbackTop = new Uint32Array(count);
  fallbackTop[index] = 700;
  const fallbackBase = new Uint32Array(count);
  fallbackBase[index] = 100;
  canopy.planes.push(
    { name: "fallbackCanopyMask", type: "u32", words: fallbackMask },
    { name: "fallbackCrownTopAglQ", type: "i32", words: fallbackTop },
    { name: "fallbackCrownBaseAglQ", type: "i32", words: fallbackBase },
  );
  let result = composeTile(components, syntheticManifest(components), { reserve: () => true });
  expect(result.crownTopQ[index]).toBe(0); // native support is valid, so fallback cannot fill it
  support[index] = 0;
  result = composeTile(components, syntheticManifest(components), { reserve: () => true });
  expect(result.crownBaseQ[index]).toBe(result.buildingTopQ[index]);
  expect(result.crownTopQ[index]).toBe(result.groundQ[index] + 700);
});

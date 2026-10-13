import assert from "node:assert/strict";
import test from "node:test";
import { compareToNearest, seeded } from "../tools/benchmark_shade_baseline";

test("compares the tool's top side with the nearest side", () => {
  const result = compareToNearest([
    { candidateId: "b", meanShade: 0.9, distanceM: 300 },
    { candidateId: "a", meanShade: 0.2, distanceM: 100 },
  ]);
  assert.deepEqual(result, {
    toolIsNearest: false,
    shadeGain: 0.9 - 0.2,
    extraM: 200,
    gainPer100m: (100 * (0.9 - 0.2)) / 200,
    topShade: 0.9,
    nearestShade: 0.2,
  });
});

test("a top side that is also the nearest gains nothing and costs nothing", () => {
  const result = compareToNearest([
    { candidateId: "a", meanShade: 0.9, distanceM: 50 },
    { candidateId: "b", meanShade: 0.1, distanceM: 50 },
  ])!;
  assert.equal(result.toolIsNearest, true);
  assert.equal(result.shadeGain, 0);
  assert.equal(result.gainPer100m, null);
  assert.equal(compareToNearest([]), null);
});

test("the query set is reproducible from its seed", () => {
  const a = seeded(7),
    b = seeded(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

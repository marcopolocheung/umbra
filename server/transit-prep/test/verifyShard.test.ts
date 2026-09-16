import assert from "node:assert/strict";
import test from "node:test";
import { checkShard } from "../src/verify";

/** Minimal shard that passes every structural check. */
function shard(overrides: Record<string, unknown> = {}): Parameters<typeof checkShard>[1] {
  return {
    kind: "bus-shard",
    stops: [
      { id: "bus:a" },
      { id: "bus:b" },
    ],
    edges: [{ from: "bus:a", to: "bus:b", route: "R1", medianSec: 300 }],
    routes: [{ id: "R1" }],
    headways: [{ route: "R1", hour: 9 }],
    shapes: { "R1:0": [[-73.9, 40.7], [-73.89, 40.71]] },
    ...overrides,
  } as Parameters<typeof checkShard>[1];
}

test("a well-formed shard passes", () => {
  assert.doesNotThrow(() => checkShard("bus-x.json", shard()));
});

test("headway hours outside 0-27 are rejected", () => {
  // 24-27 are legal: a departure after midnight keeps the previous service
  // day's hour. 28 is not, and nor is a fractional or negative hour.
  assert.doesNotThrow(() => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 27 }] })));
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 28 }] })),
    /hour 28/,
  );
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: -1 }] })),
    /hour -1/,
  );
  assert.throws(
    () => checkShard("bus-x.json", shard({ headways: [{ route: "R1", hour: 9.5 }] })),
    /hour 9.5/,
  );
});

test("a bus shard may not carry a route none of its edges use", () => {
  assert.throws(
    () => checkShard("bus-x.json", shard({ routes: [{ id: "R1" }, { id: "R2" }] })),
    /route R2 has no edge/,
  );
});

test("a bus shard may not carry a shape for a route it does not serve", () => {
  assert.throws(
    () =>
      checkShard("bus-x.json", shard({ shapes: { "R2:0": [[-73.9, 40.7], [-73.89, 40.71]] } })),
    /shape R2:0/,
  );
});

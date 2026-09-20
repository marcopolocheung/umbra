import assert from "node:assert/strict";
import test from "node:test";
import { buildSpatialStubs } from "../src/transfers";
import type { StopNode } from "../src/model";

const station: StopNode = { id: "subway:P1", name: "Alpha", lat: 40.75, lon: -73.99 };
const near: StopNode = { id: "bus:S1", name: "Near", lat: 40.751, lon: -73.989 };
const far: StopNode = { id: "bus:F1", name: "Far", lat: 40.8, lon: -73.9 };

test("links stops within radius in both directions with walk time", () => {
  const stubs = buildSpatialStubs([station], [near, far]);
  const pairs = stubs.map((s) => `${s.from}→${s.to}`);
  assert.ok(pairs.includes("subway:P1→bus:S1"));
  assert.ok(pairs.includes("bus:S1→subway:P1"));
  assert.ok(!pairs.some((p) => p.includes("F1")));
  for (const stub of stubs) {
    assert.equal(stub.kind, "spatial");
    assert.ok(stub.minSec >= 30);
  }
});

test("keeps every stop within the radius, nearest first, uncapped", () => {
  // The old cap of 10 decided which stops connect by rank alone; the radius
  // is the only bound now, and walkability.ts decides which ones are real.
  const crowd: StopNode[] = Array.from({ length: 20 }, (_, i) => ({
    id: `bus:C${i}`,
    name: `Crowd ${i}`,
    lat: 40.75 + (i + 1) * 0.0001,
    lon: -73.99,
  }));
  const stubs = buildSpatialStubs([station], crowd, { radiusM: 5000 });
  assert.equal(stubs.length, 40);
  assert.equal(stubs[0]?.to, "bus:C0");
  assert.equal(stubs[38]?.to, "bus:C19");
});

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

test("caps stubs per station by distance", () => {
  const crowd: StopNode[] = Array.from({ length: 20 }, (_, i) => ({
    id: `bus:C${i}`,
    name: `Crowd ${i}`,
    lat: 40.75 + (i + 1) * 0.0001,
    lon: -73.99,
  }));
  const stubs = buildSpatialStubs([station], crowd, { radiusM: 5000, cap: 5 });
  // 5 nearest × 2 directions.
  assert.equal(stubs.length, 10);
  const ids = new Set(stubs.map((s) => (s.from === station.id ? s.to : s.from)));
  assert.ok(ids.has("bus:C0"));
  assert.ok(!ids.has("bus:C19"));
});

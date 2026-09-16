import assert from "node:assert/strict";
import test from "node:test";
import { simplifyCapped, simplifyPath } from "../src/simplify";

const line = [
  { lat: 40.0, lon: -74.0 },
  { lat: 40.001, lon: -74.0 },
  { lat: 40.002, lon: -74.0 },
  { lat: 40.003, lon: -74.0 },
];

test("collapses a straight line to endpoints", () => {
  const simple = simplifyPath(line, 15);
  assert.equal(simple.length, 2);
  assert.deepEqual(simple[0], line[0]);
  assert.deepEqual(simple[simple.length - 1], line[3]);
});

test("keeps a real corner", () => {
  const bent = [...line, { lat: 40.003, lon: -73.99 }];
  const simple = simplifyPath(bent, 15);
  assert.ok(simple.length >= 3);
  assert.deepEqual(simple[simple.length - 1], bent[bent.length - 1]);
});

test("caps point counts with endpoints preserved", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ lat: 40 + i * 0.0001, lon: -74 + (i % 2) * 0.0001 }));
  const capped = simplifyCapped(many, 1, 10);
  assert.equal(capped.length, 10);
  assert.deepEqual(capped[0], many[0]);
  assert.deepEqual(capped[9], many[99]);
});

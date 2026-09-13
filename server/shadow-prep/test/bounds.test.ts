import assert from "node:assert/strict";
import test from "node:test";
import { canCertifyClear, parentEncloses } from "../src/bounds";

test("parent bounds enclose every exact child and unknown remains non-clear", () => {
  assert.equal(parentEncloses({ min: -4, max: 10, coverage: "complete" }, { min: -3, max: 9, coverage: "complete" }), true);
  assert.equal(parentEncloses({ min: 0, max: 8, coverage: "complete" }, { min: -1, max: 8, coverage: "complete" }), false);
  assert.equal(canCertifyClear({ min: 0, max: 0, coverage: "unknown" }), false);
});

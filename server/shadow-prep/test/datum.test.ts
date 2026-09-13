import assert from "node:assert/strict";
import test from "node:test";
import { transformHeight } from "../src/admission";

test("EGM2008 to EGM96 control shift applies to absolute elevations only", () => {
  assert.equal(transformHeight(12, 0.41, false), 12.41);
  assert.equal(transformHeight(12, 0.41, true), 12);
});

import assert from "node:assert/strict";
import test from "node:test";
import { assertExactHeader, cell, eachCsvRow, headerBody, parseCsv, requireColumns } from "../src/csv";

test("parses simple rows and headers", () => {
  const rows = parseCsv("a,b,c\n1,2,3\n");
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "2", "3"]]);
});

test("handles quotes, escaped quotes and commas inside quotes", () => {
  const rows = parseCsv('id,name\n1,"GOETHALS, RD ""NORTH"""\n');
  assert.deepEqual(rows, [["id", "name"], ["1", 'GOETHALS, RD "NORTH"']]);
});

test("handles CRLF and missing trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("keeps empty fields and empty lines inside quotes", () => {
  const rows = parseCsv("a,b,c\n,,\n");
  assert.deepEqual(rows, [["a", "b", "c"], ["", "", ""]]);
});

test("throws when a quoted field never closes", () => {
  assert.throws(() => parseCsv('a\n"oops\n'), /inside a quoted field/);
});

test("requireColumns maps indexes regardless of order", () => {
  const map = requireColumns(["b", "a"], ["a", "b"]);
  assert.equal(map.get("a"), 1);
  assert.equal(map.get("b"), 0);
  assert.equal(cell(["x", "y"], map, "b"), "x");
});

test("requireColumns fails on missing columns", () => {
  assert.throws(() => requireColumns(["a"], ["a", "b"]), /missing columns: b/);
});

test("assertExactHeader pins order and extras", () => {
  assertExactHeader("f", ["a", "b"], ["a", "b"]);
  assert.throws(() => assertExactHeader("f", ["b", "a"], ["a", "b"]), /header drift/);
  assert.throws(() => assertExactHeader("f", ["a", "b", "c"], ["a", "b"]), /header drift/);
});

test("headerBody fails on empty files", () => {
  assert.throws(() => headerBody([]), /no header/);
});

test("eachCsvRow streams rows with line numbers and no retention", () => {
  const seen: [string[], number][] = [];
  eachCsvRow("a,b\n1,2\n3,4\n", (row, line) => {
    seen.push([row, line]);
  });
  assert.deepEqual(seen, [[["a", "b"], 1], [["1", "2"], 2], [["3", "4"], 3]]);
});

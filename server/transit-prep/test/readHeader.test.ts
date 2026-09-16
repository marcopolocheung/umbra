import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HEADER_WINDOW_BYTES, readHeader } from "../src/validate";

async function feed(body: string): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "tp-header-"));
  await writeFile(join(root, "stops.txt"), body);
  return { root, dir: "." };
}

test("reads the header without reading the rest of the file", async () => {
  // The body is deliberately larger than the read window: a header read must
  // not depend on how big the file is. Brooklyn's stop_times.txt is 155 MB.
  const big = `a,b,c\n${"1,2,3\n".repeat(40_000)}`;
  assert.ok(big.length > HEADER_WINDOW_BYTES);
  const { root, dir } = await feed(big);
  assert.deepEqual(await readHeader(root, dir, "stops.txt"), ["a", "b", "c"]);
});

test("handles CRLF line endings", async () => {
  const { root, dir } = await feed("a,b,c\r\n1,2,3\r\n");
  assert.deepEqual(await readHeader(root, dir, "stops.txt"), ["a", "b", "c"]);
});

test("handles a quoted header field", async () => {
  const { root, dir } = await feed('a,"b,still b",c\n1,2,3\n');
  assert.deepEqual(await readHeader(root, dir, "stops.txt"), ["a", "b,still b", "c"]);
});

test("a file with no newline at all is still a header", async () => {
  const { root, dir } = await feed("a,b,c");
  assert.deepEqual(await readHeader(root, dir, "stops.txt"), ["a", "b", "c"]);
});

test("a header longer than the window fails loudly rather than truncating", async () => {
  const { root, dir } = await feed(`${"x".repeat(HEADER_WINDOW_BYTES + 10)}\na,b\n`);
  await assert.rejects(() => readHeader(root, dir, "stops.txt"), /no header line/);
});

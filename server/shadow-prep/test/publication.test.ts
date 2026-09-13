import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "../src/util";
import { deterministicGenerationId } from "../src/build";
import type { Admission } from "../src/admission";

test("atomic pointer replacement leaves a complete JSON pointer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-prep-")); const pointer = join(directory, "current.json");
  await atomicJson(pointer, { generation: "one" }); await writeFile(`${pointer}.interrupted`, "{incomplete");
  assert.deepEqual(JSON.parse(await readFile(pointer, "utf8")), { generation: "one" });
  await atomicJson(pointer, { generation: "two" });
  assert.deepEqual(JSON.parse(await readFile(pointer, "utf8")), { generation: "two" });
});

test("identical admitted inputs retain a byte-stable generation identity", () => {
  const admission = { boundary: { sha256: "boundary" }, receipts: [{ sha256: "b" }, { sha256: "a" }] } as unknown as Admission;
  const input = [{ tile: "18/1/1", terrain: [], buildings: [], canopy: [], evidence: {} }] as never;
  assert.equal(deterministicGenerationId(input, admission), deterministicGenerationId(structuredClone(input), admission));
});

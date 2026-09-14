import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import { completedCandidate, writeCandidate } from "../src/candidates";
import { FilesystemStore, type ObjectStore } from "../src/storage";
import { deterministicShard } from "../src/normalize";

const words = new Uint32Array(STORED_SIZE * STORED_SIZE);
const component = (name: ComponentPlane["name"]): ComponentPlane => ({ name, type: "u32", words });
const descriptor = { schemaVersion: 1 as const, normalizationId: "n", tile: "18/1/2", gutter: 1 as const, byteOrder: "little-endian-u32" as const, support: { terrain: { known: words.length, empty: 0, unknown: 0 }, buildings: { known: 0, empty: words.length, unknown: 0 }, canopy: { known: 0, empty: 0, unknown: words.length } } };

test("candidate planes are visible before descriptor and verified retries skip only complete tiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-store-"));
  try {
    const store = new FilesystemStore(directory); const result = await writeCandidate(store, descriptor, { terrain: [component("groundQ")], buildings: [component("buildingMask")], canopy: [component("canopyMask")] });
    assert.ok(await completedCandidate(store, "n", "18/1/2"));
    assert.equal((await writeCandidate(store, descriptor, { terrain: [component("groundQ")], buildings: [component("buildingMask")], canopy: [component("canopyMask")] })).components.terrain[0].sha256, result.components.terrain[0].sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("corrupted plane makes descriptor incomplete and deterministic shards are disjoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-store-"));
  try {
    const store = new FilesystemStore(directory); const result = await writeCandidate(store, descriptor, { terrain: [component("groundQ")], buildings: [component("buildingMask")], canopy: [component("canopyMask")] });
    await store.write(result.components.terrain[0].path, new Uint8Array([1])); assert.equal(await completedCandidate(store, "n", "18/1/2"), undefined);
    const tiles = [{ key: "18/3/1" }, { key: "18/1/1" }, { key: "18/2/1" }, { key: "18/4/1" }]; const left = deterministicShard(tiles, { index: 0, count: 2 }).map((tile) => tile.key), right = deterministicShard(tiles, { index: 1, count: 2 }).map((tile) => tile.key);
    assert.deepEqual([...left, ...right].sort(), tiles.map((tile) => tile.key).sort()); assert.equal(left.filter((tile) => right.includes(tile)).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

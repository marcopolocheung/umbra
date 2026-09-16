import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeBrowserTileBundle } from "../../../app/lib/shadowField/v2/bundle";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import { writeCandidate } from "../src/candidates";
import { benchmarkCandidatePack, browserPackIdentity, candidateTileIndex, contiguousShard, packCandidateDescriptor, reconcileBrowserPack } from "../src/pack";
import { FilesystemStore } from "../src/storage";

const cells = STORED_SIZE * STORED_SIZE;
const words = (value: number) => { const result = new Uint32Array(cells); result.fill(value >>> 0); return result; };
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], value: number): ComponentPlane => ({ name, type, words: words(value) });

test("candidate browser pack validates planes and round-trips all three components in one object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-pack-"));
  try {
    const store = new FilesystemStore(directory);
    const descriptor = await writeCandidate(store, {
      schemaVersion: 1, normalizationId: "0123456789abcdef0123456789abcdef", tile: "18/77123/98543", gutter: 1, byteOrder: "little-endian-u32",
      support: { terrain: { known: cells, empty: 0, unknown: 0 }, buildings: { known: 0, empty: cells, unknown: 0 }, canopy: { known: cells, empty: 0, unknown: 0 } },
    }, {
      terrain: [plane("groundQ", "i32", 64), plane("foundationQ", "i32", 64), plane("foundationPresent", "u32", 1)],
      buildings: [plane("buildingAglQ", "i32", 0), plane("buildingMask", "u32", 0), plane("buildingSupport", "u32", 0), plane("buildingFeatureId", "u32", 0), plane("buildingPriority", "u32", 0)],
      canopy: [plane("canopyHeightAglQ", "i32", 128), plane("canopyBaseAglQ", "i32", 64), plane("canopyMask", "u32", 1), plane("canopySupport", "u32", 1), plane("fallbackCrownTopAglQ", "i32", 0), plane("fallbackCrownBaseAglQ", "i32", 0), plane("fallbackCanopyMask", "u32", 0), plane("fallbackFeatureId", "u32", 0), plane("flagsAndMaterial", "u32", 0)],
    });
    const packed = await packCandidateDescriptor(store, descriptor, browserPackIdentity(descriptor.normalizationId));
    assert.match(packed.packed.key, /generations\/nyc-0123456789abcdef0123456789abcdef\/tiles\/18-77123-98543\.smb$/);
    const components = await decodeBrowserTileBundle(packed.bytes);
    assert.deepEqual(components.map((item) => item.kind).sort(), ["buildings", "canopy", "terrain"]);
    assert.equal(components.find((item) => item.kind === "terrain")?.planes[0].words[0], 64);
    const entries: Awaited<ReturnType<typeof packCandidateDescriptor>>["packed"][] = [];
    const benchmark = await benchmarkCandidatePack(store, [descriptor], store, 1, (entry) => entries.push(entry));
    assert.equal(benchmark.packedTiles, 1);
    assert.ok(benchmark.packedBytes > 0);
    assert.ok(benchmark.compressionRatio > 0);
    const reconciliation = await reconcileBrowserPack(store, entries, browserPackIdentity(descriptor.normalizationId));
    assert.equal(reconciliation.verifiedTiles, 1);
    assert.equal((await store.head(reconciliation.manifestKey))?.sha256, reconciliation.manifestSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full-pack tile index is frozen, numeric, and partitions contiguous work without overlap", () => {
  const tiles = ["18/2/10", "18/1/99", "18/1/2", "18/3/1"];
  const index = candidateTileIndex("0123456789abcdef0123456789abcdef", tiles, 4);
  assert.deepEqual(index.tiles, ["18/1/2", "18/1/99", "18/2/10", "18/3/1"]);
  assert.equal(candidateTileIndex(index.normalizationId, [...tiles].reverse(), 4).sha256, index.sha256);
  assert.deepEqual([0, 1, 2].flatMap((shard) => contiguousShard(index.tiles, shard, 3)), index.tiles);
  assert.throws(() => candidateTileIndex(index.normalizationId, [...tiles, tiles[0]], 5), /duplicate/);
});

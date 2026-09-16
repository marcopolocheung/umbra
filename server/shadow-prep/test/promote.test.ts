import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoverageGeometry, RegionLicenceInput } from "../../../app/lib/shadowField/v2/artifacts";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import { writeCandidate } from "../src/candidates";
import {
  aggregateBrowserPack,
  browserPackIdentityV2,
  candidateTileIndex,
  componentLicenceHashes,
  packCandidateDescriptor,
  reconcileBrowserPackShard,
  type PackedBrowserTile,
  type RepairContext,
} from "../src/pack";
import { promoteGeneration } from "../src/pack-full-cli";
import { repairPolicyHash, REPAIR_POLICY_VERSION } from "../src/repair";
import { FilesystemStore, type ConditionalWriteOptions, type ObjectHead, type ObjectStore } from "../src/storage";
import { sha256 } from "../src/util";

const cells = STORED_SIZE * STORED_SIZE;
const world: CoverageGeometry = {
  type: "Polygon",
  coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
};
const regionInput: RegionLicenceInput = {
  boundaryLicence: "NYC Open Data Terms of Use",
  boundaryUrl: "https://example.com/boundary",
  boundaryRelease: "26b",
  sources: [
    { id: "fabdem-v1.2", kind: "terrain", licence: "CC BY-NC-SA 4.0", url: "https://example.com/fabdem" },
    { id: "overture-buildings", kind: "buildings", licence: "ODbL 1.0", url: "https://example.com/overture" },
    { id: "chmv2-native", kind: "canopy", licence: "CC BY 4.0", url: "https://example.com/chm" },
    { id: "osm-tree-fallback", kind: "canopy-fallback", licence: "ODbL 1.0", url: "https://example.com/osm" },
  ],
  regionFileSha256: "a".repeat(64),
  receiptManifestSha256: "b".repeat(64),
};

const words = (value: number) => {
  const result = new Uint32Array(cells);
  result.fill(value >>> 0);
  return result;
};
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], value: number): ComponentPlane => ({ name, type, words: words(value) });

async function buildGeneration(directory: string) {
  const store = new FilesystemStore(directory);
  const output = new FilesystemStore(join(directory, "r2"));
  const tiles = ["18/77123/98543", "18/77124/98543"];
  const descriptors = [];
  const hashes = new Map<string, string>();
  for (const tile of tiles) {
    const descriptor = await writeCandidate(
      store,
      {
        schemaVersion: 1,
        normalizationId: "0123456789abcdef0123456789abcdef",
        tile,
        gutter: 1,
        byteOrder: "little-endian-u32",
        support: {
          terrain: { known: cells, empty: 0, unknown: 0 },
          buildings: { known: 0, empty: cells, unknown: 0 },
          canopy: { known: cells, empty: 0, unknown: 0 },
        },
      },
      {
        terrain: [plane("groundQ", "i32", 64), plane("foundationQ", "i32", 64), plane("foundationPresent", "u32", 1)],
        buildings: [
          plane("buildingAglQ", "i32", 0),
          plane("buildingMask", "u32", 0),
          plane("buildingSupport", "u32", 0),
          plane("buildingFeatureId", "u32", 0),
          plane("buildingPriority", "u32", 0),
        ],
        canopy: [
          plane("canopyHeightAglQ", "i32", 128),
          plane("canopyBaseAglQ", "i32", 64),
          plane("canopyMask", "u32", 0),
          plane("canopySupport", "u32", 1),
          plane("fallbackCrownTopAglQ", "i32", 0),
          plane("fallbackCrownBaseAglQ", "i32", 0),
          plane("fallbackCanopyMask", "u32", 0),
          plane("fallbackFeatureId", "u32", 0),
          plane("flagsAndMaterial", "u32", 0),
        ],
      },
    );
    hashes.set(tile, sha256(new TextEncoder().encode(`${JSON.stringify(descriptor)}\n`)));
    descriptors.push(descriptor);
  }
  const identity = browserPackIdentityV2(descriptors[0].normalizationId, "promote-v2");
  const index = candidateTileIndex(descriptors[0].normalizationId, tiles, 2);
  const repairFor = (descriptor: { tile: string }): RepairContext => ({
    geometry: world,
    geometryHash: "b".repeat(64),
    descriptorHash: hashes.get(descriptor.tile)!,
    regionInput,
  });
  const entries: PackedBrowserTile[] = [];
  for (const descriptor of descriptors) {
    const { bytes, packed } = await packCandidateDescriptor(store, descriptor, identity, { recipe: 2, repairFor });
    await output.write(packed.key, bytes);
    entries.push(packed);
  }
  const repair = { policy: REPAIR_POLICY_VERSION, policyHash: repairPolicyHash(), supportGeometryHash: "b".repeat(64), regionFileSha256: regionInput.regionFileSha256, receiptManifestSha256: regionInput.receiptManifestSha256!, licenceHashes: componentLicenceHashes(regionInput) } as const;
  await reconcileBrowserPackShard(output, entries, identity, 0, 1, repair);
  const reconciliation = await aggregateBrowserPack(output, index, identity, 1, {
    borough: world,
    boroughFile: { filename: "test-borough.geojson", sha256: "c".repeat(64) },
    regionInput,
  });
  assert.ok(reconciliation.generationSha256);
  return { output, identity, reconciliation };
}

test("promotion verifies everything, moves the pointer last, and refuses races", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-promote-"));
  try {
    const { output, identity, reconciliation } = await buildGeneration(directory);
    const reports: unknown[] = [];
    // Verify-only touches nothing.
    await promoteGeneration(output, identity, { verifyOnly: true }, (value) => { reports.push(value); });
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as { action: string }).action, "promote-verify");
    assert.equal(await output.head("current.json"), undefined);
    // Interrupted upload cannot change current.json: publishing nothing new
    // must still refuse a stale compare-and-swap value.
    await assert.rejects(
      promoteGeneration(output, identity, { verifyOnly: false, expectedPreviousSha256: "0".repeat(64) }, () => {}),
      /refused/,
    );
    assert.equal(await output.head("current.json"), undefined);
    // Real promotion writes a v2 pointer bound to the published root.
    await promoteGeneration(output, identity, { verifyOnly: false, expectedPreviousSha256: "absent" }, (value) => { reports.push(value); });
    const pointerRaw = await output.read("current.json");
    const pointer = JSON.parse(new TextDecoder().decode(pointerRaw)) as Record<string, unknown>;
    assert.equal(pointer.version, 2);
    assert.equal(pointer.dataset, "nyc-shadow");
    assert.equal(pointer.generation, identity.generation);
    assert.equal(pointer.generationPath, `/_shadow/generations/${identity.generation}/generation.json`);
    assert.equal(pointer.generationSha256, reconciliation.generationSha256);
    assert.equal(pointer.tileCount, 2);
    // A concurrent promotion invalidates the recorded previous hash.
    await assert.rejects(
      promoteGeneration(output, identity, { verifyOnly: false, expectedPreviousSha256: "absent" }, () => {}),
      /refused/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotion fails closed on a corrupted tile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-promote-corrupt-"));
  try {
    const { output, identity } = await buildGeneration(directory);
    const rootRaw = await output.read(`generations/${identity.generation}/generation.json`);
    const root = JSON.parse(new TextDecoder().decode(rootRaw)) as { artifacts: { manifest: { path: string } } };
    const manifestRaw = await output.read(root.artifacts.manifest.path.replace(/^\/_shadow\//, ""));
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as { tiles: Array<{ key: string }> };
    // Flip one byte of the first tile object behind the metadata's back.
    const tilePath = join(directory, "r2", manifest.tiles[0].key);
    await writeFile(tilePath, new Uint8Array([0]));
    await assert.rejects(promoteGeneration(output, identity, { verifyOnly: true }, () => {}), /mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Delegating store that lets a concurrent winner slip a `current.json` write
 * in between the loser's head and writeConditional — the exact interleave a
 * client-side read-compare-write would miss and server-side CAS must refuse. */
class InterleavedWinnerStore implements ObjectStore {
  readonly kind = "filesystem" as const;
  private injected = false;
  constructor(
    readonly delegate: FilesystemStore,
    readonly winnerBytes: Uint8Array,
  ) {}
  read(key: string): Promise<Uint8Array> {
    return this.delegate.read(key);
  }
  copyToFile(key: string, destination: string): Promise<void> {
    return this.delegate.copyToFile(key, destination);
  }
  write(key: string, value: Uint8Array, contentType?: string): Promise<void> {
    return this.delegate.write(key, value, contentType);
  }
  head(key: string): Promise<ObjectHead | undefined> {
    return this.delegate.head(key);
  }
  async writeConditional(
    key: string,
    value: Uint8Array,
    contentType?: string,
    opts: ConditionalWriteOptions = {},
  ): Promise<void> {
    if (key === "current.json" && !this.injected) {
      this.injected = true;
      await this.delegate.writeConditional(key, this.winnerBytes, "application/json", { ifNoneMatch: "*" });
    }
    return this.delegate.writeConditional(key, value, contentType, opts);
  }
}

test("promotion refuses an interleaved concurrent promotion (loser loses, winner survives)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-promote-race-"));
  try {
    const { output, identity } = await buildGeneration(directory);
    const winnerBytes = new TextEncoder().encode('{"winner":"interleaved"}\n');
    const racing = new InterleavedWinnerStore(output, winnerBytes);
    await assert.rejects(
      promoteGeneration(racing, identity, { verifyOnly: false, expectedPreviousSha256: "absent" }, () => {}),
      /promotion refused: concurrent promotion/,
    );
    const survivor = await output.read("current.json");
    assert.equal(sha256(survivor), sha256(winnerBytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotion full sweep catches a corrupted non-sampled tile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-promote-sweep-"));
  try {
    const { output, identity } = await buildGeneration(directory);
    const rootRaw = await output.read(`generations/${identity.generation}/generation.json`);
    const root = JSON.parse(new TextDecoder().decode(rootRaw)) as { artifacts: { manifest: { path: string } } };
    const manifestRaw = await output.read(root.artifacts.manifest.path.replace(/^\/_shadow\//, ""));
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as { tiles: Array<{ tile: string; key: string }> };
    // Two tiles: the deterministic sample (pos0 + %1024) covers only the
    // first, so corrupting the second proves the full HEAD sweep runs.
    assert.ok(manifest.tiles.length >= 2);
    const tilePath = join(directory, "r2", manifest.tiles[1].key);
    await writeFile(tilePath, new Uint8Array([0]));
    await assert.rejects(
      promoteGeneration(output, identity, { verifyOnly: true }, () => {}),
      /promotion tile metadata mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

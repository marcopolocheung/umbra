import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeBrowserTileBundle } from "../../../app/lib/shadowField/v2/bundle";
import {
  parseGenerationRoot,
  type CoverageGeometry,
  type RegionLicenceInput,
} from "../../../app/lib/shadowField/v2/artifacts";
import { composeTile } from "../../../app/lib/shadowField/v2/compose";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import { writeCandidate } from "../src/candidates";
import {
  aggregateBrowserPack,
  browserPackIdentityV2,
  browserPackManifestV2,
  browserPackShardReceipt,
  candidateTileIndex,
  packCandidateDescriptor,
  reconcileBrowserPackShard,
  type PackedBrowserTile,
  type RepairContext,
} from "../src/pack";
import { repairPolicyHash, REPAIR_POLICY_VERSION } from "../src/repair";
import { FilesystemStore } from "../src/storage";
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
};

const words = (value: number) => {
  const result = new Uint32Array(cells);
  result.fill(value >>> 0);
  return result;
};
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], value: number): ComponentPlane => ({ name, type, words: words(value) });

/** v1-style candidate planes: the building support plane is all zeros (the defect). */
async function writeV1StyleCandidate(store: FilesystemStore, tile: string, occupied: boolean) {
  const mask = words(0);
  if (occupied) {
    mask[0] = 1;
    mask[1000] = 1;
  }
  const agl = words(0);
  if (occupied) {
    agl[0] = 640;
    agl[1000] = 320;
  }
  return writeCandidate(
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
        { name: "buildingAglQ", type: "i32", words: agl },
        { name: "buildingMask", type: "u32", words: mask },
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
}

function repairFor(descriptorHashes: Map<string, string>) {
  return (descriptor: { tile: string }): RepairContext => {
    const descriptorHash = descriptorHashes.get(descriptor.tile);
    if (!descriptorHash) throw new Error(`missing descriptor hash for ${descriptor.tile}`);
    return { geometry: world, geometryHash: "b".repeat(64), descriptorHash, regionInput };
  };
}

function descriptorHashOf(descriptor: unknown): string {
  return sha256(new TextEncoder().encode(`${JSON.stringify(descriptor)}\n`));
}

test("v2 repair corrects Times-Square-like support without touching masks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-"));
  try {
    const store = new FilesystemStore(directory);
    const descriptor = await writeV1StyleCandidate(store, "18/77123/98543", true);
    const identity = browserPackIdentityV2(descriptor.normalizationId, "times-square-v2");
    assert.ok(identity.model);
    const { bytes, packed } = await packCandidateDescriptor(store, descriptor, identity, {
      recipe: 2,
      repairFor: repairFor(new Map([[descriptor.tile, descriptorHashOf(descriptor)]])),
    });
    assert.ok(packed.bounds);
    const components = await decodeBrowserTileBundle(bytes);
    const buildings = components.find((item) => item.kind === "buildings")!;
    // The defect is gone: full coverage, present state, mask preserved.
    assert.equal(buildings.support, "present");
    assert.ok(buildings.planes.find((item) => item.name === "buildingSupport")!.words.every((value) => value === 1));
    assert.equal(buildings.planes.find((item) => item.name === "buildingMask")!.words[1000], 1);
    // Repair evidence binds the substitution instead of implying original bytes.
    assert.equal(buildings.evidence.repairPolicy, REPAIR_POLICY_VERSION);
    assert.equal(buildings.evidence.supportGeometryHash, "b".repeat(64));
    assert.ok(buildings.identity.normalizerHash && buildings.identity.compositorHash);
    assert.ok(buildings.identity.treeModelHash && buildings.identity.receiverHash);
    const canopy = components.find((item) => item.kind === "canopy")!;
    assert.equal(canopy.support, "known-empty");
    // The repaired tile composes with complete evidence.
    const composed = composeTile(components, { reserve: () => true });
    assert.equal(composed.evidence!.complete, true);
    assert.ok(composed.buildingTopQ[0] > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("known source coverage with zero occupancy stays valid known absence", async () => {  const directory = await mkdtemp(join(tmpdir(), "pack-v2-empty-"));
  try {
    const store = new FilesystemStore(directory);
    const descriptor = await writeV1StyleCandidate(store, "18/77123/98543", false);
    const identity = browserPackIdentityV2(descriptor.normalizationId, "empty-v2");
    const { bytes } = await packCandidateDescriptor(store, descriptor, identity, {
      recipe: 2,
      repairFor: repairFor(new Map([[descriptor.tile, descriptorHashOf(descriptor)]])),
    });
    const components = await decodeBrowserTileBundle(bytes);
    assert.equal(components.find((item) => item.kind === "buildings")!.support, "known-empty");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-running identical repair inputs produces identical generation objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-determinism-"));
  try {
    const store = new FilesystemStore(directory);
    const descriptor = await writeV1StyleCandidate(store, "18/77123/98543", true);
    const identity = browserPackIdentityV2(descriptor.normalizationId, "deterministic-v2");
    const options = {
      recipe: 2 as const,
      repairFor: repairFor(new Map([[descriptor.tile, descriptorHashOf(descriptor)]])),
    };
    const first = await packCandidateDescriptor(store, descriptor, identity, options);
    const second = await packCandidateDescriptor(store, descriptor, identity, options);
    assert.equal(first.packed.sha256, second.packed.sha256);
    assert.deepEqual(first.bytes, second.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 shard receipts, manifest, and generation root assemble on a small set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-aggregate-"));
  try {
    const store = new FilesystemStore(directory);
    const tiles = ["18/77123/98543", "18/77124/98543"];
    const descriptors = [];
    const hashes = new Map<string, string>();
    for (const tile of tiles) {
      const descriptor = await writeV1StyleCandidate(store, tile, true);
      hashes.set(tile, descriptorHashOf(descriptor));
      descriptors.push(descriptor);
    }
    const identity = browserPackIdentityV2(descriptors[0].normalizationId, "aggregate-v2");
    const index = candidateTileIndex(descriptors[0].normalizationId, tiles, 2);
    const output = new FilesystemStore(join(directory, "r2"));
    const entries: PackedBrowserTile[] = [];
    for (const descriptor of descriptors) {
      const { bytes, packed } = await packCandidateDescriptor(store, descriptor, identity, {
        recipe: 2,
        repairFor: repairFor(hashes),
      });
      const prior = await output.head(packed.key);
      if (!prior) await output.write(packed.key, bytes);
      entries.push(packed);
    }
    const repair = { policy: REPAIR_POLICY_VERSION, policyHash: repairPolicyHash(), supportGeometryHash: "b".repeat(64), regionFileSha256: regionInput.regionFileSha256 } as const;
    const receipt = browserPackShardReceipt(entries, identity, 0, 1, repair);
    assert.ok(receipt.bounds && receipt.repair);
    assert.equal(receipt.bounds.minG.length, 2);
    const reconciliation = await reconcileBrowserPackShard(output, entries, identity, 0, 1, repair);
    assert.equal(reconciliation.verifiedTiles, 2);
    const full = await aggregateBrowserPack(output, index, identity, 1, {
      borough: world,
      boroughFile: { filename: "test-borough.geojson", sha256: "c".repeat(64) },
      regionInput,
    });
    assert.ok(full.generationKey && full.generationSha256);
    assert.ok(full.coverageKey && full.boundsKey && full.noticesKey);
    // The manifest binds tiles and compact artifacts; the root binds everything.
    const manifestBytes = await output.read(full.manifestKey);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { version: number; artifacts: Record<string, string> };
    assert.equal(manifest.version, 2);
    assert.ok(manifest.artifacts.coverageSha256 && manifest.artifacts.boundsSha256 && manifest.artifacts.noticesSha256);
    const rootBytes = await output.read(full.generationKey!);
    const root = parseGenerationRoot(JSON.parse(new TextDecoder().decode(rootBytes)));
    assert.equal(root.generation, identity.generation);
    assert.equal(root.availableTileCount, 2);
    assert.equal(root.activationTileCount, 2);
    assert.equal(root.artifacts.manifest.sha256, full.manifestSha256);
    // v2 manifest helper stands alone too.
    const standalone = browserPackManifestV2(entries, identity, {
      coverageSha256: "d".repeat(64),
      boundsSha256: "d".repeat(64),
      noticesSha256: "d".repeat(64),
    });
    assert.equal(standalone.version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buried roofs fall back to conservative bounds with a recorded anomaly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pack-v2-anomaly-"));
  try {
    const store = new FilesystemStore(directory);
    // Whole-feature foundation below upslope ground: the stored roof sits
    // under the local ground cell, like staged tile 18/77196/98517.
    const ground = words(5000);
    const buried = await writeCandidate(
      store,
      {
        schemaVersion: 1,
        normalizationId: "0123456789abcdef0123456789abcdef",
        tile: "18/77123/98543",
        gutter: 1,
        byteOrder: "little-endian-u32",
        support: {
          terrain: { known: cells, empty: 0, unknown: 0 },
          buildings: { known: 0, empty: cells, unknown: 0 },
          canopy: { known: cells, empty: 0, unknown: 0 },
        },
      },
      {
        terrain: [
          { name: "groundQ", type: "i32", words: ground },
          { name: "foundationQ", type: "i32", words: words(3800) },
          { name: "foundationPresent", type: "u32", words: words(1) },
        ],
        buildings: [
          { name: "buildingAglQ", type: "i32", words: words(1000) },
          { name: "buildingMask", type: "u32", words: words(1) },
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
    const identity = browserPackIdentityV2(buried.normalizationId, "anomaly-v2");
    const { packed } = await packCandidateDescriptor(store, buried, identity, {
      recipe: 2,
      repairFor: repairFor(new Map([[buried.tile, descriptorHashOf(buried)]])),
    });
    // The tile packs: raw stored roofs still bound the stored geometry, and
    // the anomaly travels with the entry instead of failing the shard.
    assert.ok(packed.bounds);
    assert.equal(packed.bounds.maxTopQ, 3800 + 1000);
    assert.equal(packed.boundsAnomaly, "roof-below-terrain");
    const receipt = browserPackShardReceipt([packed], identity, 0, 1, {
      policy: REPAIR_POLICY_VERSION,
      policyHash: repairPolicyHash(),
      supportGeometryHash: "b".repeat(64),
      regionFileSha256: regionInput.regionFileSha256,
    });
    assert.deepEqual(receipt.anomalies, [{ tile: buried.tile, reason: "roof-below-terrain" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

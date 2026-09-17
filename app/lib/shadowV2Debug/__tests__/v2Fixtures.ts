import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { artifactBytes, buildCoverageIndex, buildGenerationRoot } from "../../shadowField/v2/artifacts";
import { encodeBrowserTileBundle } from "../../shadowField/v2/bundle";
import { encodeComponent } from "../../shadowField/v2/format";
import { STORED_SIZE, type Component, type ComponentKind } from "../../shadowField/v2/types";
import { SUPPORT_UNKNOWN } from "../../shadowField/v2/support";

export const FIXTURE_GENERATION = "nyc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-debug";
export const FIXTURE_TILE = "18/77123/98543";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain));
const identity = {
  recipeHash: "1".repeat(64), datumHash: "2".repeat(64), hierarchyHash: "3".repeat(64),
  normalizerHash: "4".repeat(64), compositorHash: "5".repeat(64), treeModelHash: "6".repeat(64), receiverHash: "7".repeat(64),
};

function components(tile: string, unknown = false): Component[] {
  const words = STORED_SIZE * STORED_SIZE;
  const zeros = () => new Uint32Array(words);
  const known = () => new Uint32Array(words).fill(1);
  const buildingMask = zeros(); buildingMask[STORED_SIZE + 1] = 1;
  const buildingAgl = zeros(); buildingAgl[STORED_SIZE + 1] = 640;
  const buildingSupport = known(); if (unknown) buildingSupport[STORED_SIZE * 2 + 2] = SUPPORT_UNKNOWN;
  const base = (kind: ComponentKind, support: Component["support"], planes: Component["planes"]): Component => ({
    kind, support, evidence: { fixture: "shadow-v2-debug" },
    identity: { generation: FIXTURE_GENERATION, tile, sourceHash: `${kind}-source`, licenceHash: `${kind}-licence`, ...identity },
    tables: { licences: [{ id: `${kind}-licence`, notice: "fixture" }], provenance: [{ id: kind, source: "fixture", support: support ?? "present" }], evidence: [{ id: kind, subject: kind, hash: "8".repeat(64) }] },
    planes,
  });
  return [
    base("terrain", "present", [{ name: "groundQ", type: "i32", words: zeros() }, { name: "foundationQ", type: "i32", words: zeros() }, { name: "foundationPresent", type: "u32", words: zeros() }]),
    base("buildings", unknown ? "partial" : "present", [{ name: "buildingAglQ", type: "i32", words: buildingAgl }, { name: "buildingMask", type: "u32", words: buildingMask }, { name: "buildingSupport", type: "u32", words: buildingSupport }, { name: "buildingFeatureId", type: "u32", words: zeros() }]),
    base("canopy", "known-empty", [{ name: "canopyHeightAglQ", type: "i32", words: zeros() }, { name: "canopyBaseAglQ", type: "i32", words: zeros() }, { name: "canopyMask", type: "u32", words: zeros() }, { name: "canopySupport", type: "u32", words: known() }]),
  ];
}

export interface DebugV2Fixtures {
  pointer: Uint8Array;
  root: Uint8Array;
  coverage: Uint8Array;
  bundle: Uint8Array;
  truncatedBundle: Uint8Array;
  corruptBundle: Uint8Array;
  mixedGenerationBundle: Uint8Array;
  rootIdentityMismatchBundle: Uint8Array;
  unknownSupportBundle: Uint8Array;
  urls: { current: string; root: string; coverage: string; tile: string };
}

/** A complete pinned v2 transport corpus for worker tests; it never contacts Cloudflare. */
export async function makeDebugV2Fixtures(base = "https://shadow.fixture.test"): Promise<DebugV2Fixtures> {
  const coverageValue = buildCoverageIndex({ generation: FIXTURE_GENERATION, availableTiles: [FIXTURE_TILE], activationTiles: [FIXTURE_TILE], activationRule: "fixture", activationBoundary: null });
  const coverage = artifactBytes(coverageValue);
  const ref = (path: string, bytes: Uint8Array) => ({ path, bytes: bytes.byteLength, sha256: hash(bytes) });
  const rootValue = buildGenerationRoot({
    generation: FIXTURE_GENERATION, identity,
    manifest: { path: `/_shadow/generations/${FIXTURE_GENERATION}/manifest.json`, bytes: 1, sha256: "a".repeat(64) },
    coverage: ref(`/_shadow/generations/${FIXTURE_GENERATION}/coverage.json`, coverage),
    bounds: { path: `/_shadow/generations/${FIXTURE_GENERATION}/bounds.json`, bytes: 1, sha256: "b".repeat(64) },
    notices: { path: `/_shadow/generations/${FIXTURE_GENERATION}/notices.json`, bytes: 1, sha256: "c".repeat(64) },
    tileCount: 1, availableTileCount: 1, activationTileCount: 1,
  });
  const root = artifactBytes(rootValue);
  const pointer = new TextEncoder().encode(`${JSON.stringify({ version: 2, dataset: "nyc-shadow", generation: FIXTURE_GENERATION, generationPath: `/_shadow/generations/${FIXTURE_GENERATION}/generation.json`, generationSha256: hash(root), tilePathTemplate: rootValue.tilePathTemplate, tileCount: 1 })}\n`);
  const bundleFor = async (parts: Component[]) => {
    const encoded = await Promise.all(parts.map((part) => encodeComponent(part, gzip)));
    return encodeBrowserTileBundle(FIXTURE_TILE, parts.map((part, index) => ({ component: part, encoded: encoded[index] }))).bytes;
  };
  const manuallyFramedBundle = async (parts: Component[]) => {
    const encoded = await Promise.all(parts.map((part) => encodeComponent(part, gzip)));
    let offset = 0;
    const directory = {
      version: 1, recipe: 2, tile: FIXTURE_TILE,
      components: parts.map((part, index) => {
        const entry = { kind: part.kind, offset, length: encoded[index].bytes.byteLength, transportHash: encoded[index].transportHash, physicsHash: encoded[index].physicsHash };
        offset += entry.length;
        return entry;
      }),
    };
    const directoryBytes = new TextEncoder().encode(JSON.stringify(directory));
    const bytes = new Uint8Array(12 + directoryBytes.byteLength + offset);
    bytes.set(new TextEncoder().encode("SMB1"));
    const view = new DataView(bytes.buffer); view.setUint16(4, 1, true); view.setUint16(6, 3, true); view.setUint32(8, directoryBytes.byteLength, true);
    bytes.set(directoryBytes, 12);
    let bodyAt = 12 + directoryBytes.byteLength;
    for (const item of encoded) { bytes.set(item.bytes, bodyAt); bodyAt += item.bytes.byteLength; }
    return bytes;
  };
  const bundle = await bundleFor(components(FIXTURE_TILE));
  const unknownSupportBundle = await bundleFor(components(FIXTURE_TILE, true));
  const mismatch = components(FIXTURE_TILE); for (const part of mismatch) part.identity.compositorHash = "9".repeat(64);
  const rootIdentityMismatchBundle = await bundleFor(mismatch);
  // A validly framed bundle whose component identity is from a different root.
  const mixed = components(FIXTURE_TILE); mixed[1].identity.generation = "nyc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-debug";
  const mixedGenerationBundle = await manuallyFramedBundle(mixed);
  const corruptBundle = bundle.slice(); corruptBundle[corruptBundle.length - 1] ^= 0xff;
  const prefix = base.replace(/\/$/, "");
  return {
    pointer, root, coverage, bundle, truncatedBundle: bundle.subarray(0, bundle.length - 9), corruptBundle, mixedGenerationBundle, rootIdentityMismatchBundle, unknownSupportBundle,
    urls: { current: `${prefix}/_shadow/current.json`, root: `${prefix}/_shadow/generations/${FIXTURE_GENERATION}/generation.json`, coverage: `${prefix}/_shadow/generations/${FIXTURE_GENERATION}/coverage.json`, tile: `${prefix}/_shadow/generations/${FIXTURE_GENERATION}/tiles/18-77123-98543.smb` },
  };
}

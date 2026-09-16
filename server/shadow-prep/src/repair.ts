import { STORED_SIZE } from "../../../app/lib/shadowField/v2/types";
import { SUPPORT_KNOWN } from "../../../app/lib/shadowField/v2/support";
import {
  classifyTileSupport,
  parseZ18Tile,
  type CoverageGeometry,
} from "../../../app/lib/shadowField/v2/artifacts";
import type { PolygonalCoverage } from "./admission";
import { supportTiles } from "./tiles";
import { sha256 } from "./util";

/**
 * Pack-time repair for the v1 building-support defect (PR2). The v1 producer
 * allocated `buildingSupport` as zeros and never filled it, so sampled
 * bundles declare `known-empty` over tens of thousands of occupied cells.
 * The repair derives per-cell support from the hash-pinned frozen-support
 * geometry — evidence input, not a raw vector/raster rerun — and binds every
 * substitution cryptographically (see RepairReceipt). Old candidate objects
 * and the old generation are never mutated.
 */
export const REPAIR_POLICY_VERSION = "nyc-building-support-repair-v1";

const REPAIR_POLICY_TEXT = [
  "policy=nyc-building-support-repair-v1",
  "rule=buildingSupport[i] is 1 where the stored-cell center is covered by the admitted source geometry, else 2",
  "mask-invariant=buildingMask[i] != 0 requires buildingSupport[i] == 1",
  "legacy=the value 0 is never emitted; the v1 all-zero plane is replaced, not reinterpreted",
].join("\n");

export function repairPolicyHash(): string {
  return sha256(new TextEncoder().encode(REPAIR_POLICY_TEXT));
}

export interface RepairReceipt {
  version: 1;
  tile: string;
  policy: typeof REPAIR_POLICY_VERSION;
  policyHash: string;
  supportGeometryHash: string;
  originalDescriptorHash: string;
  originalSupportPlaneHash: string;
  correctedSupportPlaneHash: string;
}

function planeBytes(words: Uint32Array): Uint8Array {
  const output = new Uint8Array(words.byteLength);
  const view = new DataView(output.buffer);
  for (let index = 0; index < words.length; index++) view.setUint32(index * 4, words[index], true);
  return output;
}

export function supportPlaneHash(words: Uint32Array): string {
  if (words.length !== STORED_SIZE * STORED_SIZE) throw new Error("support plane has invalid stored dimensions");
  return sha256(planeBytes(words));
}

/**
 * Fail closed unless the supplied support geometry reproduces the frozen
 * candidate tile set exactly. A wrong or drifted geometry file cannot repair
 * tiles it does not explain. Run once per worker before packing a shard.
 */
export function verifySupportGeometryTiles(
  geometry: CoverageGeometry,
  tiles: readonly string[],
): void {
  const derived = supportTiles(geometry as PolygonalCoverage)
    .map((tile) => tile.key)
    .sort();
  const expected = [...tiles].sort();
  if (derived.length !== expected.length || derived.some((tile, index) => tile !== expected[index]))
    throw new Error(
      `support geometry explains ${derived.length} tiles, expected ${expected.length}: refusing repair`,
    );
}

/**
 * Derive corrected building support for one tile. Throws when the observed
 * building mask disagrees with admitted coverage — an occupied cell outside
 * coverage is evidence of drift, never silently published as unknown.
 */
export function repairBuildingSupport(args: {
  tile: string;
  mask: Uint32Array;
  originalSupport: Uint32Array;
  geometry: CoverageGeometry;
  geometryHash: string;
  originalDescriptorHash: string;
}): { support: Uint32Array; receipt: RepairReceipt } {
  const { x, y } = parseZ18Tile(args.tile);
  if (args.mask.length !== STORED_SIZE * STORED_SIZE || args.originalSupport.length !== STORED_SIZE * STORED_SIZE)
    throw new Error(`repair input planes have invalid stored dimensions for ${args.tile}`);
  const classified = classifyTileSupport(args.geometry, x, y);
  const support = new Uint32Array(classified.length);
  for (let index = 0; index < classified.length; index++) {
    support[index] = classified[index];
    if (args.mask[index] !== 0 && support[index] !== SUPPORT_KNOWN)
      throw new Error(`repair refuses ${args.tile}: occupied cell ${index} lies outside admitted coverage`);
  }
  const receipt: RepairReceipt = {
    version: 1,
    tile: args.tile,
    policy: REPAIR_POLICY_VERSION,
    policyHash: repairPolicyHash(),
    supportGeometryHash: args.geometryHash,
    originalDescriptorHash: args.originalDescriptorHash,
    originalSupportPlaneHash: supportPlaneHash(args.originalSupport),
    correctedSupportPlaneHash: supportPlaneHash(support),
  };
  return { support, receipt };
}

/**
 * The v2 sourceHash binds the original candidate identity plus the
 * deterministic repair evidence, so the corrected bytes never imply they
 * contain the original support plane.
 */
export function boundSourceHash(originalSourceHash: string, receipt: RepairReceipt): string {
  if (!/^[a-f0-9]{64}$/.test(originalSourceHash)) throw new Error("original source hash is not a sha256 hex digest");
  if (!/^[a-f0-9]{64}$/.test(receipt.originalDescriptorHash)) throw new Error("original descriptor hash is not a sha256 hex digest");
  return sha256(
    new TextEncoder().encode(
      `${originalSourceHash}\n${receipt.originalDescriptorHash}\n${receipt.policyHash}\n${receipt.supportGeometryHash}\n${receipt.originalSupportPlaneHash}\n${receipt.correctedSupportPlaneHash}`,
    ),
  );
}

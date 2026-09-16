import { componentPhysicsHash, decodeComponent } from "./format";
import type { GenerationIdentity } from "./artifacts";
import { assertV2SupportStrict } from "./support";
import type { Component, ComponentIdentity, EncodedComponent } from "./types";

/**
 * A browser tile is one request containing the three independently encoded v2
 * components.  Components remain independently verifiable; the bundle only
 * removes two network round trips from the critical path.
 */
const MAGIC = "SMB1";
const HEADER_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BrowserTileBundleEntry {
  kind: Component["kind"];
  offset: number;
  length: number;
  transportHash: string;
  physicsHash: string;
}

export interface BrowserTileBundleDirectory {
  version: 1;
  /** Explicit recipe gate; do not infer v2 semantics from optional identity fields. */
  recipe: 1 | 2;
  tile: string;
  components: BrowserTileBundleEntry[];
}

export interface EncodedBrowserTileBundle {
  bytes: Uint8Array;
  directory: BrowserTileBundleDirectory;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Create a compact, deterministic one-request container for exactly one tile. */
export function encodeBrowserTileBundle(
  tile: string,
  components: Array<{ component: Component; encoded: EncodedComponent }>,
): EncodedBrowserTileBundle {
  if (!/^18\/\d+\/\d+$/.test(tile) || components.length !== 3)
    throw new Error("a browser tile bundle requires exactly three z18 components");
  const kinds = components.map(({ component }) => component.kind);
  if (new Set(kinds).size !== 3 || !["terrain", "buildings", "canopy"].every((kind) => kinds.includes(kind as Component["kind"])))
    throw new Error("a browser tile bundle requires terrain, buildings, and canopy");
  if (components.some(({ component }) => component.identity.tile !== tile))
    throw new Error("bundle component tile mismatch");
  assertSharedIdentity(components.map(({ component }) => component.identity));

  let offset = 0;
  const entries = components.map(({ component, encoded }) => {
    const entry: BrowserTileBundleEntry = {
      kind: component.kind,
      offset,
      length: encoded.bytes.byteLength,
      transportHash: encoded.transportHash,
      physicsHash: encoded.physicsHash,
    };
    offset += encoded.bytes.byteLength;
    return entry;
  });
  const directory: BrowserTileBundleDirectory = {
    version: 1,
    // Published v2 bundles carry this immutable recipe marker. Legacy bundles
    // omit it on disk and are accepted only as recipe 1 below.
    recipe: components.every(({ component }) => hasFullModelBlock(component.identity)) ? 2 : 1,
    tile,
    components: entries,
  };
  const directoryBytes = encoder.encode(JSON.stringify(directory));
  const header = new Uint8Array(HEADER_BYTES);
  header.set(encoder.encode(MAGIC));
  const view = new DataView(header.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, components.length, true);
  view.setUint32(8, directoryBytes.byteLength, true);
  return { bytes: concat([header, directoryBytes, ...components.map(({ encoded }) => encoded.bytes)]), directory };
}

/** Parse and independently verify every embedded component before composition.
 *
 * Without `opts.rootIdentity`, the bundle must at minimum carry the full v2
 * model block (all four model fields, unanimous across all three components)
 * to take the strict support path; a truly model-free bundle is the v1 legacy
 * path. With `opts.rootIdentity`, every component's recipe/datum/hierarchy
 * plus full model block must additionally match the generation root.
 */
export async function decodeBrowserTileBundle(
  bytes: Uint8Array,
  opts?: { rootIdentity?: GenerationIdentity },
): Promise<Component[]> {
  if (bytes.byteLength < HEADER_BYTES || decoder.decode(bytes.subarray(0, 4)) !== MAGIC)
    throw new Error("unknown browser tile bundle format");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 3)
    throw new Error("unsupported browser tile bundle version");
  const length = view.getUint32(8, true);
  if (length === 0 || HEADER_BYTES + length > bytes.byteLength)
    throw new Error("truncated browser tile bundle directory");
  let directory: BrowserTileBundleDirectory;
  try {
    directory = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))) as BrowserTileBundleDirectory;
  } catch {
    throw new Error("invalid browser tile bundle directory");
  }
  // Pre-marker SMB1 bundles are the explicitly grandfathered v1 format.  A
  // marker, once present, controls strictness even if identity fields are
  // stripped from the component payload.
  const recipe = directory.recipe === undefined ? 1 : directory.recipe;
  if (directory.version !== 1 || (recipe !== 1 && recipe !== 2) || !/^18\/\d+\/\d+$/.test(directory.tile) || !Array.isArray(directory.components) || directory.components.length !== 3)
    throw new Error("invalid browser tile bundle directory");
  const bodyLength = bytes.byteLength - HEADER_BYTES - length;
  const seen = new Set<Component["kind"]>();
  const hashPattern = /^[a-f0-9]{64}$/;
  for (const entry of directory.components) {
    const end = entry.offset + entry.length;
    if (!(["terrain", "buildings", "canopy"] as const).includes(entry.kind) || seen.has(entry.kind) || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) || !Number.isSafeInteger(end) || entry.offset < 0 || entry.length <= 0 || end > bodyLength)
      throw new Error("invalid browser tile bundle entry");
    if (typeof entry.transportHash !== "string" || !hashPattern.test(entry.transportHash) || typeof entry.physicsHash !== "string" || !hashPattern.test(entry.physicsHash))
      throw new Error("invalid browser tile bundle entry");
    seen.add(entry.kind);
  }
  // Entries must exactly cover the body: no overlaps, gaps, or trailing bytes.
  const ordered = [...directory.components].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const entry of ordered) {
    if (entry.offset !== cursor) throw new Error("invalid browser tile bundle entry");
    cursor += entry.length;
  }
  if (cursor !== bodyLength) throw new Error("invalid browser tile bundle entry");
  const components: Component[] = [];
  for (const entry of directory.components) {
    const start = HEADER_BYTES + length + entry.offset;
    const component = await decodeComponent(bytes.subarray(start, start + entry.length));
    if (component.kind !== entry.kind || component.identity.tile !== directory.tile || component.transportHash !== entry.transportHash)
      throw new Error("browser tile bundle component mismatch");
    // The outer transport/physics records are verified, not documentation:
    // a mismatched physics hash means the directory does not describe its body.
    if ((await componentPhysicsHash(component.planes)) !== entry.physicsHash)
      throw new Error("browser tile bundle physics mismatch");
    components.push(component);
  }
  // All three embedded components must name one generation, tile, recipe,
  // datum, and hierarchy before composition. sourceHash/licenceHash
  // legitimately differ per kind and are excluded here.
  assertSharedIdentity(components.map((component) => component.identity));
  assertSharedModelIdentity(components.map((component) => component.identity));
  if (opts?.rootIdentity) {
    assertBundleRootIdentity(components, opts.rootIdentity);
    if (recipe !== 2) throw new Error("generation-root v2 bundle lacks its recipe marker");
  }
  assertV2Support(components, recipe === 2);
  return components;
}

/**
 * Shared generation/recipe/datum/hierarchy agreement across one tile's three
 * components. Enforced universally — the active v1 generation satisfies it.
 */
export function assertSharedIdentity(identities: ComponentIdentity[]): void {
  if (identities.length !== 3) throw new Error("bundle component identity mismatch");
  const [first, ...rest] = identities;
  for (const identity of rest) {
    if (
      identity.generation !== first.generation ||
      identity.tile !== first.tile ||
      identity.recipeHash !== first.recipeHash ||
      identity.datumHash !== first.datumHash ||
      identity.hierarchyHash !== first.hierarchyHash
    )
      throw new Error("bundle component identity mismatch");
  }
  assertSharedModelIdentity(identities);
}

/** Every model field the v2 recipe pins on each component identity. */
const MODEL_FIELDS = ["normalizerHash", "compositorHash", "treeModelHash", "receiverHash"] as const;

function hasAnyModelField(identity: ComponentIdentity): boolean {
  return MODEL_FIELDS.some((field) => identity[field] !== undefined);
}

/**
 * v2 model-identity agreement. The v2 recipe pins normalizer, compositor,
 * tree-model, and receiver identities on every component, and strictness is
 * selected by the FULL model block — never by `compositorHash` alone. A bundle
 * with no model field on any component is true v1 and stays grandfathered for
 * support semantics only. Anything else must be complete and unanimous: a
 * single stripped field (a compositor-only downgrade) or a 1–2/3 component
 * mix throws instead of silently falling back to the legacy path.
 */
export function assertSharedModelIdentity(identities: ComponentIdentity[]): void {
  if (identities.length !== 3) throw new Error("bundle component identity mismatch");
  if (identities.every((identity) => !hasAnyModelField(identity))) return;
  for (const identity of identities) {
    for (const field of MODEL_FIELDS) {
      if (identity[field] === undefined)
        throw new Error("bundle mixes v1 and v2 component identities");
    }
  }
  const [first, ...rest] = identities;
  for (const field of MODEL_FIELDS) {
    if (!first[field]) throw new Error(`bundle v2 component identity lacks ${field}`);
    for (const identity of rest) {
      if (identity[field] !== first[field]) throw new Error(`bundle v2 ${field} mismatch`);
    }
  }
}

/**
 * Bind a decoded bundle to its generation root: recipe, datum, hierarchy, and
 * the full model block must match on every component. A stripped or rotated
 * field fails here even if the bundle is internally unanimous.
 */
export function assertBundleRootIdentity(
  components: Component[],
  root: GenerationIdentity,
): void {
  for (const component of components) {
    const identity = component.identity;
    if (
      identity.recipeHash !== root.recipeHash ||
      identity.datumHash !== root.datumHash ||
      identity.hierarchyHash !== root.hierarchyHash ||
      identity.normalizerHash !== root.normalizerHash ||
      identity.compositorHash !== root.compositorHash ||
      identity.treeModelHash !== root.treeModelHash ||
      identity.receiverHash !== root.receiverHash
    )
      throw new Error(`bundle ${component.kind} identity mismatch with generation root`);
  }
}

const SUPPORT_PLANE: Record<"buildings" | "canopy", "buildingSupport" | "canopySupport"> = {
  buildings: "buildingSupport",
  canopy: "canopySupport",
};
const MASK_PLANE: Record<"buildings" | "canopy", "buildingMask" | "canopyMask"> = {
  buildings: "buildingMask",
  canopy: "canopyMask",
};

/**
 * v2 support strictness via {@link assertV2SupportStrict}: exact {1,2} cell
 * values, both planes present, and the coarse state exactly derived — never
 * inferred. True-v1 bundles (no model field on any component) skip this;
 * their zeros are the known PR2 defect, preserved decodable for rollback.
 * Anything with even one model field anywhere takes the strict path, so a
 * stripped-model downgrade fails instead of grandfathering.
 */
export function assertV2Support(components: Component[], strictRecipe = false): void {
  if (!strictRecipe && components.every((component) => !hasAnyModelField(component.identity))) return;
  for (const kind of ["buildings", "canopy"] as const) {
    const component = components.find((item) => item.kind === kind);
    if (!component) throw new Error(`bundle lacks a v2 ${kind} component`);
    if (!hasFullModelBlock(component.identity))
      throw new Error("bundle mixes v1 and v2 component identities");
    const support = component.planes.find((item) => item.name === SUPPORT_PLANE[kind])?.words;
    const mask = component.planes.find((item) => item.name === MASK_PLANE[kind])?.words;
    assertV2SupportStrict(kind, support, mask, component.support);
  }
}

function hasFullModelBlock(identity: ComponentIdentity): boolean {
  return MODEL_FIELDS.every((field) => identity[field] !== undefined);
}

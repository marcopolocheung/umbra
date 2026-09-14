import {
  FORMAT_VERSION,
  GUTTER_CELLS,
  LOGICAL_SIZE,
  MAX_DECODED_BYTES,
  MAX_HEIGHT_METRES,
  QUANTIZATION,
  STORED_SIZE,
  type Component,
  type ComponentPlane,
  type Compressor,
  type EncodedComponent,
  type GenerationManifest,
  type PlaneType,
  type Predictor,
} from "./types";

const MAGIC = "SMV2";
export const HEADER_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PLANE_NAMES = new Set<ComponentPlane["name"]>([
  "groundQ",
  "foundationQ",
  "foundationPresent",
  "buildingAglQ",
  "buildingMask",
  "buildingSupport",
  "buildingFeatureId",
  "buildingPriority",
  "canopyHeightAglQ",
  "canopyBaseAglQ",
  "canopyMask",
  "canopySupport",
  "fallbackCrownTopAglQ",
  "fallbackCrownBaseAglQ",
  "fallbackCanopyMask",
  "fallbackFeatureId",
  "crownBaseAglQ",
  "crownTopAglQ",
  "flagsAndMaterial",
  "provenanceIndex",
]);

interface DirectoryPlane {
  name: ComponentPlane["name"];
  type: PlaneType;
  predictor: Predictor;
  decodedOffset: number;
  decodedLength: number;
  checksum: string;
  provenanceTableIndex?: number;
  materialTableIndex?: number;
}
interface Directory {
  version: number;
  kind: Component["kind"];
  identity: Component["identity"];
  evidence: Record<string, string>;
  logicalSize: number;
  storedSize: number;
  gutter: number;
  quantization: number;
  byteOrder: "little-endian-u32";
  zoom: 18;
  terrainDiagonal: "nw-se";
  headerFlags: number;
  codec: "gzip";
  payloadOffset: number;
  payloadLength: number;
  planes: DirectoryPlane[];
  tables?: Component["tables"];
  support?: Component["support"];
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy to a plain ArrayBuffer-backed view: WebCrypto/Blob intentionally reject
  // potentially shared backing stores.
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))));
}

function bytesFor(words: Uint32Array): Uint8Array {
  return new Uint8Array(words.buffer, words.byteOffset, words.byteLength).slice();
}

/** Quantize a source Float64 exactly once before it enters a canonical i32 plane. */
export function quantizeHeight(metres: number): number {
  if (!Number.isFinite(metres) || metres < -MAX_HEIGHT_METRES || metres > MAX_HEIGHT_METRES)
    throw new Error("height is nonfinite or out of range");
  return Math.round(metres * QUANTIZATION);
}

function transform(words: Uint32Array, predictor: Predictor): Uint8Array {
  const result = new Uint32Array(words.length);
  if (predictor === "none") result.set(words);
  else {
    for (let row = 0; row < STORED_SIZE; row++) {
      const start = row * STORED_SIZE;
      result[start] = words[start];
      for (let x = 1; x < STORED_SIZE; x++)
        result[start + x] = words[start + x] - words[start + x - 1];
    }
  }
  return bytesFor(result);
}

function restore(bytes: Uint8Array, predictor: Predictor): Uint32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error("plane is not aligned to u32 words");
  const values = new Uint32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  if (predictor === "horizontal-delta-u32") {
    for (let row = 0; row < STORED_SIZE; row++) {
      const start = row * STORED_SIZE;
      for (let x = 1; x < STORED_SIZE; x++) values[start + x] += values[start + x - 1];
    }
  }
  return values;
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

function assertPlane(plane: ComponentPlane): void {
  if (!PLANE_NAMES.has(plane.name)) throw new Error("unknown component plane");
  if (plane.words.length !== STORED_SIZE * STORED_SIZE)
    throw new Error(`${plane.name} has invalid stored dimensions`);
  if (plane.type === "i32") {
    for (const word of plane.words) {
      const value = word | 0;
      if (
        !Number.isFinite(value) ||
        value < -MAX_HEIGHT_METRES * QUANTIZATION ||
        value > MAX_HEIGHT_METRES * QUANTIZATION
      ) {
        throw new Error(`${plane.name} contains an out-of-range height`);
      }
    }
  }
}

function validTableIndex(index: number | undefined, length: number): boolean {
  return index === undefined || (Number.isInteger(index) && index >= 0 && index < length);
}

function assertComponent(component: Component): void {
  if (!(["terrain", "buildings", "canopy"] as const).includes(component.kind))
    throw new Error("unknown component kind");
  for (const value of [
    component.identity.generation,
    component.identity.tile,
    component.identity.sourceHash,
    component.identity.recipeHash,
    component.identity.datumHash,
    component.identity.hierarchyHash,
    component.identity.licenceHash,
  ]) {
    if (!value) throw new Error("incomplete component identity");
  }
  if (
    component.support &&
    !["present", "known-empty", "nodata", "unknown"].includes(component.support)
  )
    throw new Error("unknown component support");
  const tables = component.tables;
  if (!tables) return;
  for (const table of [tables.licences, tables.provenance, tables.evidence]) {
    if (
      !Array.isArray(table) ||
      new Set(table.map((entry) => entry.id)).size !== table.length ||
      table.some((entry) => !entry.id)
    )
      throw new Error("invalid component table");
  }
  if (
    tables.provenance.some(
      (entry) => !["present", "known-empty", "nodata", "unknown"].includes(entry.support),
    )
  )
    throw new Error("invalid provenance support");
}

/** Encodes one independent component. The compressor is injected so browser code has no Node imports. */
export async function encodeComponent(
  component: Component,
  gzip: Compressor,
): Promise<EncodedComponent> {
  if (!component.planes.length) throw new Error("component has no planes");
  assertComponent(component);
  const names = new Set<string>();
  const plain: Uint8Array[] = [];
  const planes: DirectoryPlane[] = [];
  let offset = 0;
  for (const plane of component.planes) {
    assertPlane(plane);
    if (names.has(plane.name)) throw new Error(`duplicate plane ${plane.name}`);
    names.add(plane.name);
    const predictor = plane.predictor ?? "horizontal-delta-u32";
    const transformed = transform(plane.words, predictor);
    plain.push(transformed);
    if (
      !validTableIndex(plane.provenanceTableIndex, component.tables?.provenance.length ?? 0) ||
      !validTableIndex(plane.materialTableIndex, component.tables?.licences.length ?? 0)
    )
      throw new Error("invalid plane table index");
    planes.push({
      name: plane.name,
      type: plane.type,
      predictor,
      decodedOffset: offset,
      decodedLength: transformed.byteLength,
      checksum: await sha256(bytesFor(plane.words)),
      provenanceTableIndex: plane.provenanceTableIndex,
      materialTableIndex: plane.materialTableIndex,
    });
    offset += transformed.byteLength;
  }
  if (offset > MAX_DECODED_BYTES) throw new Error("component decoded payload exceeds limit");
  const compressed = await gzip(concat(plain));
  const directory: Directory = {
    version: FORMAT_VERSION,
    kind: component.kind,
    identity: component.identity,
    evidence: component.evidence,
    logicalSize: LOGICAL_SIZE,
    storedSize: STORED_SIZE,
    gutter: GUTTER_CELLS,
    quantization: QUANTIZATION,
    byteOrder: "little-endian-u32",
    zoom: 18,
    terrainDiagonal: "nw-se",
    headerFlags: 0,
    codec: "gzip",
    payloadOffset: 0,
    payloadLength: compressed.byteLength,
    planes,
    tables: component.tables,
    support: component.support,
  };
  // The directory length changes when payloadOffset gains digits; converge before serializing.
  let directoryBytes = encoder.encode(JSON.stringify(directory));
  directory.payloadOffset = HEADER_BYTES + directoryBytes.byteLength;
  directoryBytes = encoder.encode(JSON.stringify(directory));
  directory.payloadOffset = HEADER_BYTES + directoryBytes.byteLength;
  directoryBytes = encoder.encode(JSON.stringify(directory));
  const header = new Uint8Array(HEADER_BYTES);
  header.set(encoder.encode(MAGIC));
  new DataView(header.buffer).setUint16(4, FORMAT_VERSION, true);
  new DataView(header.buffer).setUint16(6, 0, true);
  new DataView(header.buffer).setUint32(8, directoryBytes.byteLength, true);
  const bytes = concat([header, directoryBytes, compressed]);
  return {
    bytes,
    transportHash: await sha256(bytes),
    physicsHash: await sha256(concat(component.planes.map((plane) => bytesFor(plane.words)))),
  };
}

async function ungzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("gzip decoder unavailable");
  const stream = new Blob([Uint8Array.from(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_DECODED_BYTES) throw new Error("decoded payload exceeds limit");
    chunks.push(next.value);
  }
  return concat(chunks);
}

function parseDirectory(bytes: Uint8Array): Directory {
  if (bytes.byteLength < HEADER_BYTES || decoder.decode(bytes.subarray(0, 4)) !== MAGIC)
    throw new Error("unknown component format");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== FORMAT_VERSION)
    throw new Error("unsupported component format version");
  if (view.getUint16(6, true) !== 0) throw new Error("unknown component header flags");
  const length = view.getUint32(8, true);
  if (length === 0 || HEADER_BYTES + length > bytes.byteLength)
    throw new Error("truncated component directory");
  let directory: Directory;
  try {
    directory = JSON.parse(
      decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length)),
    ) as Directory;
  } catch {
    throw new Error("invalid component directory");
  }
  if (
    directory.version !== FORMAT_VERSION ||
    directory.logicalSize !== LOGICAL_SIZE ||
    directory.storedSize !== STORED_SIZE ||
    directory.gutter !== GUTTER_CELLS ||
    directory.quantization !== QUANTIZATION ||
    directory.codec !== "gzip" ||
    directory.byteOrder !== "little-endian-u32" ||
    directory.zoom !== 18 ||
    directory.terrainDiagonal !== "nw-se" ||
    directory.headerFlags !== 0
  )
    throw new Error("unsupported component layout");
  if (
    directory.payloadOffset !== HEADER_BYTES + length ||
    directory.payloadLength !== bytes.byteLength - directory.payloadOffset
  )
    throw new Error("invalid component payload range");
  if (
    !Array.isArray(directory.planes) ||
    !Number.isSafeInteger(directory.payloadOffset) ||
    !Number.isSafeInteger(directory.payloadLength)
  )
    throw new Error("invalid component directory");
  assertComponent({
    kind: directory.kind,
    identity: directory.identity,
    evidence: directory.evidence,
    planes: [],
    support: directory.support,
    tables: directory.tables,
  });
  return directory;
}

export async function decodeComponent(bytes: Uint8Array): Promise<Component> {
  const directory = parseDirectory(bytes);
  const plain = await ungzip(bytes.subarray(directory.payloadOffset));
  const planes: ComponentPlane[] = [];
  const ranges: Array<[number, number]> = [];
  for (const entry of directory.planes) {
    if (
      (entry.type !== "i32" && entry.type !== "u32") ||
      (entry.predictor !== "none" && entry.predictor !== "horizontal-delta-u32") ||
      !PLANE_NAMES.has(entry.name)
    )
      throw new Error("unknown plane encoding");
    if (
      !validTableIndex(entry.provenanceTableIndex, directory.tables?.provenance.length ?? 0) ||
      !validTableIndex(entry.materialTableIndex, directory.tables?.licences.length ?? 0)
    )
      throw new Error("invalid plane table index");
    const end = entry.decodedOffset + entry.decodedLength;
    if (
      !Number.isSafeInteger(entry.decodedOffset) ||
      !Number.isSafeInteger(entry.decodedLength) ||
      entry.decodedOffset < 0 ||
      end > plain.byteLength ||
      entry.decodedLength !== STORED_SIZE * STORED_SIZE * 4 ||
      ranges.some(([start, finish]) => entry.decodedOffset < finish && end > start)
    )
      throw new Error("invalid plane range");
    ranges.push([entry.decodedOffset, end]);
    const words = restore(plain.subarray(entry.decodedOffset, end), entry.predictor);
    if ((await sha256(bytesFor(words))) !== entry.checksum)
      throw new Error(`checksum mismatch for ${entry.name}`);
    planes.push({
      name: entry.name,
      type: entry.type,
      predictor: entry.predictor,
      words,
      provenanceTableIndex: entry.provenanceTableIndex,
      materialTableIndex: entry.materialTableIndex,
    });
  }
  return {
    kind: directory.kind,
    identity: directory.identity,
    evidence: directory.evidence,
    planes,
    support: directory.support,
    tables: directory.tables,
    transportHash: await sha256(bytes),
  };
}

/** Rejects mixed generation, datum, recipe, hierarchy and unlisted component identities. */
export function validateManifestDependencies(
  manifest: GenerationManifest,
  components: Component[],
): void {
  if (
    !manifest.generation ||
    !manifest.recipeHash ||
    !manifest.datumHash ||
    !manifest.hierarchyHash
  )
    throw new Error("incomplete generation manifest");
  if (components.length !== manifest.components.length)
    throw new Error("component count does not match manifest");
  const seen = new Set<string>();
  for (const component of components) {
    const listed = manifest.components.find(
      (entry) => entry.kind === component.kind && entry.tile === component.identity.tile,
    );
    const key = `${component.kind}/${component.identity.tile}`;
    if (
      seen.has(key) ||
      !listed ||
      component.identity.generation !== manifest.generation ||
      component.identity.recipeHash !== manifest.recipeHash ||
      component.identity.datumHash !== manifest.datumHash ||
      component.identity.hierarchyHash !== manifest.hierarchyHash ||
      listed.sourceHash !== component.identity.sourceHash ||
      listed.licenceHash !== component.identity.licenceHash ||
      (component.transportHash !== undefined && listed.objectHash !== component.transportHash)
    )
      throw new Error("mixed or unlisted component dependency");
    seen.add(key);
  }
}

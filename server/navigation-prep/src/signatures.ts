/**
 * Shade signatures (#321): every sidewalk side's year of shade, compressed to
 * 16 numbers and a coarse type.
 *
 * The shade table already holds the exact physics: 768 slots per side. A
 * signature is a lossy summary of it for similarity and map colouring. Routing
 * never reads one; the table stays the source of truth.
 *
 * Nothing is fitted here. The model is frozen in `models/<version>.json`: the
 * per-slot mean, 16 PCA components, the int8 scales, the K = 8 centroids and
 * each type's hour summary. It was written once by `tools/fit_signatures.py`,
 * and a refit is a deliberate version bump. This stage only **projects**:
 * centre a side's daylight slots, multiply by the components, take the
 * nearest centroid. So type ids mean the same thing in every generation.
 *
 * Per z14 cell the payload is row-major in the shade index's segment order,
 * `[left, right]` per segment, 17 bytes per side: 16 int8 components (each
 * `round(z / scale)`), then the type byte.
 *
 * Projection is float64 over values parsed from JSON, with no reduction
 * across threads, so the bytes are a function of the shade bytes and the
 * model alone.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SHADE_BYTES_PER_SEGMENT,
  SHADE_SLOT_COUNT,
} from "../../../app/lib/navigationData/shadeSlots";
import { canonicalJson, sha256Hex } from "./canonical";
import { loadBuiltShadeShards, type BuiltShadeShard } from "./shade";
import { rootPath } from "./util";

/** The frozen model version this build projects with. */
export const SIGNATURE_MODEL_VERSION = "signatures-v1";

export const SIGNATURE_COMPONENTS = 16;

/** Bytes per sidewalk side: 16 int8 components, then one type byte. */
export const SIGNATURE_BYTES_PER_SIDE = SIGNATURE_COMPONENTS + 1;

/** Sides per segment, `[left, right]`, matching the shade table. */
const SIDES = SHADE_BYTES_PER_SEGMENT;

export interface SignatureType {
  id: number;
  /** Generated from the type's mean profile; numbers only. */
  name: string;
  shaded: number;
  summerShaded: number;
  winterShaded: number;
  /** Summer clock windows (America/New_York), `[start, end)`. */
  summerShade: Array<[string, string]>;
  summerSun: Array<[string, string]>;
}

export interface SignatureModel {
  version: string;
  fit: {
    generation: string;
    seed: number;
    sample: number;
    libraries: Record<string, string>;
    varianceExplained: number;
  };
  /** Shade-table slot indices the model reads, ascending. */
  daySlots: number[];
  mean: number[];
  /** SIGNATURE_COMPONENTS rows × daySlots.length. */
  components: number[][];
  /** Per component: z = q × scale. */
  scales: number[];
  /** K rows × SIGNATURE_COMPONENTS. */
  centers: number[][];
  types: SignatureType[];
}

export function modelPath(version = SIGNATURE_MODEL_VERSION): string {
  return join(import.meta.dirname, "..", "models", `${version}.json`);
}

export async function loadSignatureModel(version = SIGNATURE_MODEL_VERSION): Promise<{
  model: SignatureModel;
  sha256: string;
}> {
  const bytes = await readFile(modelPath(version));
  const model = JSON.parse(bytes.toString("utf8")) as SignatureModel;
  const days = model.daySlots.length;
  if (
    model.version !== version ||
    days === 0 ||
    model.daySlots.some(
      (slot, index) =>
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= SHADE_SLOT_COUNT ||
        (index > 0 && slot <= model.daySlots[index - 1]),
    ) ||
    model.mean.length !== days ||
    model.components.length !== SIGNATURE_COMPONENTS ||
    model.components.some((row) => row.length !== days) ||
    model.scales.length !== SIGNATURE_COMPONENTS ||
    model.scales.some((scale) => !(scale > 0)) ||
    model.centers.length === 0 ||
    model.centers.length > 255 ||
    model.centers.some((row) => row.length !== SIGNATURE_COMPONENTS) ||
    model.types.length !== model.centers.length ||
    model.types.some((type, index) => type.id !== index)
  )
    throw new Error(`signature model ${version} is malformed`);
  return { model, sha256: sha256Hex(bytes) };
}

/**
 * Projects one cell's slot-major shade payload to its signature payload. Rows
 * follow the shade columns: segment 0 left, segment 0 right, segment 1 left, …
 */
export function projectSignatures(
  model: SignatureModel,
  shadeBytes: Uint8Array,
  segments: number,
): Uint8Array {
  const stride = segments * SIDES;
  if (shadeBytes.byteLength !== SHADE_SLOT_COUNT * stride)
    throw new Error(`shade payload is ${shadeBytes.byteLength} bytes, not ${SHADE_SLOT_COUNT} × ${stride}`);
  const { daySlots, mean, components, scales, centers } = model;
  const days = daySlots.length;
  const out = new Uint8Array(stride * SIGNATURE_BYTES_PER_SIDE);
  const x = new Float64Array(days);
  const z = new Float64Array(SIGNATURE_COMPONENTS);
  for (let row = 0; row < stride; row++) {
    for (let d = 0; d < days; d++) x[d] = shadeBytes[daySlots[d] * stride + row] / 255 - mean[d];
    for (let c = 0; c < SIGNATURE_COMPONENTS; c++) {
      const component = components[c];
      let sum = 0;
      for (let d = 0; d < days; d++) sum += x[d] * component[d];
      z[c] = sum;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let k = 0; k < centers.length; k++) {
      const center = centers[k];
      let distance = 0;
      for (let c = 0; c < SIGNATURE_COMPONENTS; c++) distance += (z[c] - center[c]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    const offset = row * SIGNATURE_BYTES_PER_SIDE;
    for (let c = 0; c < SIGNATURE_COMPONENTS; c++) {
      const q = Math.max(-127, Math.min(127, Math.floor(z[c] / scales[c] + 0.5)));
      out[offset + c] = q & 0xff;
    }
    out[offset + SIGNATURE_COMPONENTS] = best;
  }
  return out;
}

// ─── The stage: work/signatures/<cell>.{bin,json} ───────────────────────────

/** What one built cell was projected from, so `build` can refuse a stale one. */
export interface SignatureCellDescriptor {
  key: string;
  model: string;
  modelSha256: string;
  shadeSha256: string;
  segments: number;
  bytes: number;
  sha256: string;
}

export function signatureOutputDirectory(): string {
  return rootPath("work", "signatures");
}

export interface SignatureProgress {
  model: string;
  modelSha256: string;
  cells: number;
  segments: number;
  bytes: number;
  types: number[];
  elapsedMs: number;
}

/**
 * Projects every built shade cell. Single process, ~1 minute for the city:
 * the work is a 581 × 16 multiply per side, and the shade payloads are
 * already on local disk.
 */
export async function signaturesExecute(): Promise<SignatureProgress> {
  const started = Date.now();
  const { model, sha256: modelSha256 } = await loadSignatureModel();
  const shades = await loadBuiltShadeShards();
  if (shades.length === 0) throw new Error("no built shade cells; run shade --execute first");
  // Every run reprojects every cell, so start clean: a cell the shade table
  // no longer has must not linger and block the next build.
  const directory = signatureOutputDirectory();
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const types = new Array<number>(model.centers.length).fill(0);
  let segments = 0;
  let bytes = 0;
  for (const shade of shades) {
    const payload = projectSignatures(model, shade.payloadBytes, shade.ref.segments);
    for (let i = SIGNATURE_COMPONENTS; i < payload.byteLength; i += SIGNATURE_BYTES_PER_SIDE)
      types[payload[i]] += 1;
    const descriptor: SignatureCellDescriptor = {
      key: shade.cellKey,
      model: model.version,
      modelSha256,
      shadeSha256: shade.ref.payloadSha256,
      segments: shade.ref.segments,
      bytes: payload.byteLength,
      sha256: sha256Hex(payload),
    };
    await writeFile(join(directory, `${shade.cellKey}.bin`), payload);
    await writeFile(join(directory, `${shade.cellKey}.json`), `${canonicalJson(descriptor)}\n`);
    segments += shade.ref.segments;
    bytes += payload.byteLength;
  }
  return {
    model: model.version,
    modelSha256,
    cells: shades.length,
    segments,
    bytes,
    types,
    elapsedMs: Date.now() - started,
  };
}

// ─── Folding into a generation ──────────────────────────────────────────────

/** The generation's `signatures/index.json`, `generation` empty until labelled. */
export interface SignatureIndex {
  version: 1;
  dataset: "nyc-navigation";
  generation: string;
  kind: "signatures";
  model: SignatureModel;
  bytesPerSide: number;
  /** Per cell, in key order; rows follow `shades/<cell>.json` `segments`. */
  cells: Array<{
    key: string;
    shadeKey: string;
    segments: number;
    payloadKey: string;
    bytes: number;
    sha256: string;
  }>;
}

export interface BuiltSignatures {
  indexKey: string;
  index: SignatureIndex;
  payloads: Map<string, Uint8Array>;
}

/**
 * Reads the signature stage's output for `build`. Absent is a valid
 * generation, like the shade table. Present, it must cover every shade cell
 * and match the shade bytes and the model it was projected from: a stale
 * signature is an error, never silently published.
 */
export async function loadBuiltSignatures(
  shades: BuiltShadeShard[],
): Promise<BuiltSignatures | null> {
  const directory = signatureOutputDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  const descriptors = entries.filter((name) => name.endsWith(".json")).sort();
  if (descriptors.length === 0) return null;
  const { model, sha256: modelSha256 } = await loadSignatureModel();
  const byKey = new Map(shades.map((shade) => [shade.cellKey, shade]));
  if (descriptors.length !== shades.length)
    throw new Error(
      `signatures cover ${descriptors.length} cells but the shade table has ${shades.length}; rerun signatures`,
    );
  const index: SignatureIndex = {
    version: 1,
    dataset: "nyc-navigation",
    generation: "",
    kind: "signatures",
    model,
    bytesPerSide: SIGNATURE_BYTES_PER_SIDE,
    cells: [],
  };
  const payloads = new Map<string, Uint8Array>();
  for (const entry of descriptors) {
    const descriptor = JSON.parse(
      await readFile(join(directory, entry), "utf8"),
    ) as SignatureCellDescriptor;
    const shade = byKey.get(descriptor.key);
    if (!shade) throw new Error(`signature cell ${descriptor.key} has no shade cell`);
    if (
      descriptor.model !== model.version ||
      descriptor.modelSha256 !== modelSha256 ||
      descriptor.shadeSha256 !== shade.ref.payloadSha256 ||
      descriptor.segments !== shade.ref.segments
    )
      throw new Error(`signature cell ${descriptor.key} is stale; rerun signatures`);
    const payload = new Uint8Array(await readFile(join(directory, `${descriptor.key}.bin`)));
    if (
      payload.byteLength !== descriptor.segments * SIDES * SIGNATURE_BYTES_PER_SIDE ||
      payload.byteLength !== descriptor.bytes ||
      sha256Hex(payload) !== descriptor.sha256
    )
      throw new Error(`signature payload ${descriptor.key} disagrees with its descriptor`);
    const payloadKey = `signatures/${descriptor.key}.bin`;
    payloads.set(payloadKey, payload);
    index.cells.push({
      key: descriptor.key,
      shadeKey: shade.indexKey,
      segments: descriptor.segments,
      payloadKey,
      bytes: payload.byteLength,
      sha256: descriptor.sha256,
    });
  }
  return { indexKey: "signatures/index.json", index, payloads };
}

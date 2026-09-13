import { statfs } from "node:fs/promises";
import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import { sha256 } from "./util";
import type { ObjectStore } from "./storage";

export interface CandidateDescriptor { schemaVersion: 1; normalizationId: string; tile: string; gutter: 1; byteOrder: "little-endian-u32"; components: Record<"terrain" | "buildings" | "canopy", Array<{ name: string; type: string; path: string; sha256: string; bytes: number }>>; support: Record<"terrain" | "buildings" | "canopy", { known: number; empty: number; unknown: number }>; }
const expected = STORED_SIZE * STORED_SIZE;
function bytes(words: Uint32Array): Uint8Array { const output = new Uint8Array(words.byteLength); const view = new DataView(output.buffer); for (let i=0;i<words.length;i++) view.setUint32(i*4, words[i], true); return output; }
export function candidateBytesPerTile(planeCount = 10): number { return expected * 4 * planeCount + 8192; }
export async function requireCandidateSpace(root: string, requiredBytes: number): Promise<void> { const status = await statfs(root); const free = Number(status.bavail) * Number(status.bsize); const minimum = Math.ceil(requiredBytes * 1.25); if (!Number.isSafeInteger(minimum) || free < minimum) throw new Error(`candidate preflight needs ${minimum} bytes free (25% margin), found ${free}`); }
/** A descriptor appears only after every immutable plane is in place. Interrupted
 * work therefore has orphan planes but never a half-candidate. */
export function candidatePrefix(normalizationId: string, tile: string): string { return `normalized/${normalizationId}/tiles/${tile.replaceAll("/", "-")}`; }
export function candidateDescriptorKey(normalizationId: string, tile: string): string { return `${candidatePrefix(normalizationId, tile)}/descriptor.json`; }

/** Validate an existing completed tile before skipping it.  Descriptor hashes are
 * checked against each object, so an interrupted/partially overwritten retry is
 * never mistaken for success. */
export async function completedCandidate(store: ObjectStore, normalizationId: string, tile: string): Promise<CandidateDescriptor | undefined> {
  const key = candidateDescriptorKey(normalizationId, tile); const metadata = await store.head(key); if (!metadata) return undefined;
  let descriptor: CandidateDescriptor;
  try { const bytes = await store.read(key); if (metadata.sha256 !== sha256(bytes)) return undefined; descriptor = JSON.parse(new TextDecoder().decode(bytes)) as CandidateDescriptor; } catch { return undefined; }
  if (descriptor.schemaVersion !== 1 || descriptor.normalizationId !== normalizationId || descriptor.tile !== tile || descriptor.gutter !== 1 || descriptor.byteOrder !== "little-endian-u32") return undefined;
  for (const component of ["terrain", "buildings", "canopy"] as const) for (const item of descriptor.components?.[component] ?? []) {
    const object = await store.head(item.path); if (!object || object.bytes !== item.bytes || object.sha256 !== item.sha256) return undefined;
  }
  return descriptor;
}

/** Planes are immutable objects.  The descriptor is the completion marker and
 * is written only after every plane has a hash-checked object in the store. */
export async function writeCandidate(store: ObjectStore, descriptor: Omit<CandidateDescriptor, "components">, components: Record<"terrain" | "buildings" | "canopy", ComponentPlane[]>): Promise<CandidateDescriptor> {
  const existing = await completedCandidate(store, descriptor.normalizationId, descriptor.tile); if (existing) return existing;
  const prefix = candidatePrefix(descriptor.normalizationId, descriptor.tile); const output = { ...descriptor, components: { terrain: [], buildings: [], canopy: [] } } as CandidateDescriptor;
  for (const kind of ["terrain", "buildings", "canopy"] as const) for (const plane of components[kind]) {
    if (plane.words.length !== expected) throw new Error(`candidate ${kind}/${plane.name} lacks true one-cell gutter`);
    const filename = `${kind}-${plane.name}.le32`; const path = `${prefix}/${filename}`; const value=bytes(plane.words); const hash = sha256(value);
    const prior = await store.head(path); if (!prior) await store.write(path, value); else if (prior.bytes !== value.byteLength || prior.sha256 !== hash) throw new Error(`immutable candidate plane collision: ${path}`);
    const written = await store.head(path); if (!written || written.bytes !== value.byteLength || written.sha256 !== hash) throw new Error(`candidate plane readback failed: ${path}`);
    output.components[kind].push({ name: plane.name, type: plane.type, path, sha256: hash, bytes: value.byteLength });
  }
  await store.write(candidateDescriptorKey(descriptor.normalizationId, descriptor.tile), new TextEncoder().encode(`${JSON.stringify(output)}\n`), "application/json");
  if (!(await completedCandidate(store, descriptor.normalizationId, descriptor.tile))) throw new Error(`candidate descriptor readback failed for ${descriptor.tile}`);
  return output;
}

import { gzipSync } from "node:zlib";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeComponent, encodeComponent, validateManifestDependencies } from "../../../app/lib/shadowField/v2/format";
import { composeTile } from "../../../app/lib/shadowField/v2/compose";
import { STORED_SIZE, type Component, type ComponentKind, type ComponentPlane, type GenerationManifest } from "../../../app/lib/shadowField/v2/types";
import { admit, type Admission } from "./admission";
import { atomicJson, json, requireRoot, sha256, writeJson } from "./util";
import { normalizeProduction, type NormalizedTile } from "./normalize";
import { receiptsForComponent } from "./sources";

interface Bound { min: number; max: number; coverage: "complete" | "unknown"; children?: string[]; }
interface Published { manifest: GenerationManifest & { objects: Array<{ path: string; sha256: string; physicsHash: string }> }; hierarchy: Record<string, Bound>; generationPath: string; }

const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));
function component(kind: ComponentKind, tile: NormalizedTile, planes: ComponentPlane[], admission: Admission): Component {
  if (!planes.length) throw new Error(`${tile.tile} has no ${kind} planes`);
  const sourceReceipts = admission.receipts.filter((item) => receiptsForComponent(kind).includes(item.id));
  const hashes = sourceReceipts.map((item) => item.sha256).sort();
  const sourceHash = sha256(Buffer.from(hashes.join("\n")));
  return { kind, identity: { generation: "", tile: tile.tile, sourceHash, recipeHash: sha256(Buffer.from("nyc-v1-source-separated-recipe")), datumHash: sha256(Buffer.from(`${admission.datum.inputVertical}->${admission.datum.outputVertical}:${admission.datum.gridPaths.join(",")}`)), hierarchyHash: "", licenceHash: sha256(Buffer.from(sourceReceipts.map((item) => `${item.id}:${item.licence}`).sort().join("\n"))) }, evidence: tile.evidence, planes: planes.map((plane) => ({ ...plane, words: Uint32Array.from(plane.words) })) };
}
export function deterministicGenerationId(inputs: NormalizedTile[], admission: Admission): string { return sha256(Buffer.from(JSON.stringify({ inputs, boundary: admission.boundary.sha256, sourceHashes: admission.receipts.map((source) => source.sha256) }))).slice(0, 24); }
function terrainBounds(component: Component): Bound {
  const ground = component.planes.find((plane) => plane.name === "groundQ")?.words;
  if (!ground || ground.length !== STORED_SIZE * STORED_SIZE) throw new Error(`terrain ${component.identity.tile} lacks complete ground`);
  const values = Array.from(ground, (word) => word | 0);
  return { min: Math.min(...values), max: Math.max(...values), coverage: "complete" };
}
function hierarchy(leaves: Map<string, Bound>): Record<string, Bound> {
  const result: Record<string, Bound> = Object.fromEntries(leaves);
  let current = [...leaves.entries()];
  while (current.length) {
    const parents = new Map<string, Array<[string, Bound]>>();
    for (const [key, value] of current) {
      const [z, x, y] = key.split("/").map(Number); if (z <= 0) continue;
      const parent = `${z - 1}/${Math.floor(x / 2)}/${Math.floor(y / 2)}`;
      parents.set(parent, [...(parents.get(parent) ?? []), [key, value]]);
    }
    const next: Array<[string, Bound]> = [];
    for (const [key, children] of parents) {
      if (result[key]) continue;
      const coverage: Bound["coverage"] = children.length === 4 && children.every(([, child]) => child.coverage === "complete") ? "complete" : "unknown";
      const bound = { min: Math.min(...children.map(([, child]) => child.min)), max: Math.max(...children.map(([, child]) => child.max)), coverage, children: children.map(([child]) => child).sort() };
      result[key] = bound; next.push([key, bound]);
    }
    current = next;
  }
  return result;
}

export async function build(): Promise<Published> {
  const root = requireRoot(); const admission = await admit();
  const inputs = await normalizeProduction(admission);
  if (inputs.some((tile) => !tile.tile.startsWith("18/"))) throw new Error("only exact z18 terrain leaves may enter a NYC generation");
  const generation = deterministicGenerationId(inputs, admission); const staging = join(root, "staging", generation); const finalPath = join(root, "generations", generation);
  await rm(staging, { recursive: true, force: true }); await mkdir(join(staging, "objects"), { recursive: true });
  const allComponents: Component[] = []; const objects: Published["manifest"]["objects"] = []; const leaves = new Map<string, Bound>();
  const recipeHash = sha256(Buffer.from("nyc-v1-source-separated-recipe"));
  const datumHash = sha256(Buffer.from(`${admission.datum.inputVertical}->${admission.datum.outputVertical}:${admission.datum.gridPaths.join(",")}`));
  for (const input of inputs) {
    const provisional = [component("terrain", input, input.terrain, admission), component("buildings", input, input.buildings, admission), component("canopy", input, input.canopy, admission)];
    leaves.set(input.tile, terrainBounds(provisional[0])); allComponents.push(...provisional);
  }
  const tree = hierarchy(leaves); const hierarchyHash = sha256(Buffer.from(JSON.stringify(tree)));
  for (const item of allComponents) { item.identity.generation = generation; item.identity.recipeHash = recipeHash; item.identity.datumHash = datumHash; item.identity.hierarchyHash = hierarchyHash; }
  for (const item of allComponents) {
    const encoded = await encodeComponent(item, gzip); const name = `${item.kind}-${item.identity.tile.replaceAll("/", "-")}.smv2`; const path = join(staging, "objects", name);
    await writeFile(path, encoded.bytes); objects.push({ path: `objects/${name}`, sha256: encoded.transportHash, physicsHash: encoded.physicsHash });
  }
  const manifest: Published["manifest"] = { generation, recipeHash, datumHash, hierarchyHash, components: allComponents.map((item, index) => ({ kind: item.kind, tile: item.identity.tile, sourceHash: item.identity.sourceHash, recipeHash, datumHash, hierarchyHash, licenceHash: item.identity.licenceHash, objectHash: objects[index].sha256 })), objects };
  await writeJson(join(staging, "hierarchy.json"), tree); await writeJson(join(staging, "manifest.json"), manifest); await writeJson(join(staging, "ATTRIBUTION.json"), { boundary: admission.boundary, sources: admission.receipts.map(({ id, licence, url, release, role }) => ({ id, licence, url, release, role })), notice: "terrain-derived values remain only in terrain objects; final field is composed only in memory" });
  await verifyGeneration(staging);
  await mkdir(join(root, "generations"), { recursive: true });
  try { await rename(staging, finalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await rm(staging, { recursive: true, force: true }); }
  await atomicJson(join(root, "current.json"), { generation, manifest: `generations/${generation}/manifest.json`, sha256: await sha256File(join(finalPath, "manifest.json")) });
  return { manifest, hierarchy: tree, generationPath: finalPath };
}
async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }

export async function verifyGeneration(path: string): Promise<void> {
  const manifest = await json<Published["manifest"]>(join(path, "manifest.json")); const tree = await json<Record<string, Bound>>(join(path, "hierarchy.json"));
  const components: Component[] = [];
  for (const object of manifest.objects) {
    const bytes = await readFile(join(path, object.path));
    if (sha256(bytes) !== object.sha256) throw new Error(`object hash mismatch: ${object.path}`);
    components.push(await decodeComponent(bytes));
  }
  validateManifestDependencies(manifest, components);
  for (const leaf of Object.keys(tree).filter((key) => key.startsWith("18/"))) {
    let child = tree[leaf]; let key = leaf;
    while (key.split("/")[0] !== "0") { const [z, x, y] = key.split("/").map(Number); key = `${z - 1}/${Math.floor(x / 2)}/${Math.floor(y / 2)}`; const parent = tree[key]; if (!parent) throw new Error(`missing parent bound for ${leaf}`); if (parent.min > child.min || parent.max < child.max) throw new Error(`parent does not enclose ${leaf}`); child = parent; }
  }
  // A decoder/recomposer check prevents a valid binary container from hiding an unusable join.
  for (const tile of new Set(components.map((component) => component.identity.tile))) composeTile(components.filter((component) => component.identity.tile === tile), { reserve: () => true });
}

export async function current(): Promise<string> { const root = requireRoot(); const pointer = await json<{ manifest: string }>(join(root, "current.json")); return join(root, pointer.manifest.replace(/\/manifest\.json$/, "")); }

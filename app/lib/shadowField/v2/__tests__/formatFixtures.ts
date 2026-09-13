import { gzipSync } from "node:zlib";
import { encodeComponent } from "../format";
import { STORED_SIZE, type Component, type ComponentKind, type GenerationManifest } from "../types";

const words = STORED_SIZE * STORED_SIZE;
export const gzipLevel6 = async (plain: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(plain, { level: 6 }));

function identity(kind: ComponentKind) {
  return {
    generation: "synthetic-v2-1",
    tile: "18/77123/98543",
    sourceHash: `synthetic-${kind}-source`,
    recipeHash: "synthetic-recipe-v1",
    datumHash: "synthetic-egm96",
    hierarchyHash: "synthetic-hierarchy-v1",
    licenceHash: `synthetic-${kind}-licence`,
    normalizerHash: "synthetic-normalizer-v1",
    compositorHash: "shadow-v2-compositor",
    treeModelHash: "tree-model-v2",
    receiverHash: "receiver-v2",
  };
}

function tables(kind: ComponentKind): NonNullable<Component["tables"]> {
  return {
    licences: [
      { id: `${kind}-licence`, notice: "Synthetic deterministic fixture; no geographic source." },
    ],
    provenance: [
      { id: `${kind}-provenance`, source: "synthetic fixture producer", support: "present" },
    ],
    evidence: [{ id: `${kind}-evidence`, subject: kind, hash: `synthetic-${kind}-evidence-v1` }],
  };
}

function component(kind: ComponentKind, planes: Component["planes"]): Component {
  return {
    kind,
    identity: identity(kind),
    support: "present",
    evidence: { fixture: "synthetic-deterministic-v1" },
    tables: tables(kind),
    planes,
  };
}

/** Independent components deliberately share no source array or encoded payload. */
export function syntheticComponents(terrainBumpQ = 0): Component[] {
  const groundQ = new Uint32Array(words);
  for (let y = 0; y < STORED_SIZE; y++)
    for (let x = 0; x < STORED_SIZE; x++)
      groundQ[y * STORED_SIZE + x] = (x - y - 16 + terrainBumpQ) >>> 0;
  const foundationQ = new Uint32Array(words);
  foundationQ[STORED_SIZE + 2] = -32 >>> 0;
  const foundationPresent = new Uint32Array(words);
  foundationPresent[STORED_SIZE + 2] = 1;
  const buildingAglQ = new Uint32Array(words);
  buildingAglQ[STORED_SIZE + 2] = 640;
  const buildingMask = new Uint32Array(words);
  buildingMask[STORED_SIZE + 2] = 1;
  const buildingFeatureId = new Uint32Array(words);
  buildingFeatureId[STORED_SIZE + 2] = 7;
  const canopyHeightAglQ = new Uint32Array(words);
  canopyHeightAglQ[STORED_SIZE * 2 + 3] = 960;
  const canopyMask = new Uint32Array(words);
  canopyMask[STORED_SIZE * 2 + 3] = 1;
  const canopySupport = new Uint32Array(words);
  canopySupport.fill(1);
  return [
    component("terrain", [
      {
        name: "groundQ",
        type: "i32",
        words: groundQ,
        predictor: "horizontal-delta-u32",
        provenanceTableIndex: 0,
      },
      {
        name: "foundationQ",
        type: "i32",
        words: foundationQ,
        predictor: "none",
        provenanceTableIndex: 0,
      },
      {
        name: "foundationPresent",
        type: "u32",
        words: foundationPresent,
        predictor: "none",
        provenanceTableIndex: 0,
      },
    ]),
    component("buildings", [
      {
        name: "buildingAglQ",
        type: "i32",
        words: buildingAglQ,
        predictor: "horizontal-delta-u32",
        provenanceTableIndex: 0,
      },
      {
        name: "buildingMask",
        type: "u32",
        words: buildingMask,
        predictor: "none",
        provenanceTableIndex: 0,
      },
      {
        name: "buildingFeatureId",
        type: "u32",
        words: buildingFeatureId,
        predictor: "none",
        provenanceTableIndex: 0,
      },
    ]),
    component("canopy", [
      {
        name: "canopyHeightAglQ",
        type: "i32",
        words: canopyHeightAglQ,
        predictor: "horizontal-delta-u32",
        provenanceTableIndex: 0,
        materialTableIndex: 0,
      },
      {
        name: "canopyMask",
        type: "u32",
        words: canopyMask,
        predictor: "none",
        provenanceTableIndex: 0,
      },
      {
        name: "canopySupport",
        type: "u32",
        words: canopySupport,
        predictor: "none",
        provenanceTableIndex: 0,
      },
    ]),
  ];
}

export function syntheticManifest(components = syntheticComponents()): GenerationManifest {
  return {
    generation: "synthetic-v2-1",
    recipeHash: "synthetic-recipe-v1",
    datumHash: "synthetic-egm96",
    hierarchyHash: "synthetic-hierarchy-v1",
    components: components.map((part) => ({
      kind: part.kind,
      tile: part.identity.tile,
      sourceHash: part.identity.sourceHash,
      recipeHash: part.identity.recipeHash,
      datumHash: part.identity.datumHash,
      hierarchyHash: part.identity.hierarchyHash,
      licenceHash: part.identity.licenceHash,
      objectHash: "fixture-object-hash-supplied-after-encoding",
    })),
  };
}

export async function encodeSyntheticFixture(terrainBumpQ = 0) {
  const components = syntheticComponents(terrainBumpQ);
  const encoded = await Promise.all(components.map((part) => encodeComponent(part, gzipLevel6)));
  return { components, manifest: syntheticManifest(components), encoded };
}

/** The immutable, source-separated v2 tile contract. */
export const FORMAT_VERSION = 1;
export const LOGICAL_SIZE = 256;
export const STORED_SIZE = 258;
export const QUANTIZATION = 64;

export type ComponentKind = "terrain" | "buildings" | "canopy";
export type PlaneName = "groundQ" | "buildingAglQ" | "foundationQ" | "crownBaseAglQ" | "crownTopAglQ" | "flagsAndMaterial" | "provenanceIndex";
export type PlaneType = "i32" | "u32";
export type Predictor = "none" | "horizontal-delta-u32";

export interface ComponentPlane {
  name: PlaneName;
  type: PlaneType;
  /** Canonical words: signed values use their two's-complement Uint32 representation. */
  words: Uint32Array;
  predictor?: Predictor;
}

export interface ComponentIdentity {
  generation: string;
  tile: string;
  sourceHash: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  licenceHash: string;
}

export interface Component {
  kind: ComponentKind;
  identity: ComponentIdentity;
  planes: ComponentPlane[];
  /** References are deliberately metadata, not a fused value table. */
  evidence: Record<string, string>;
}

export interface EncodedComponent {
  bytes: Uint8Array;
  transportHash: string;
  physicsHash: string;
}

export interface GenerationManifest {
  generation: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  components: Array<Pick<ComponentIdentity, "tile" | "sourceHash" | "recipeHash" | "datumHash" | "hierarchyHash" | "licenceHash"> & { kind: ComponentKind; objectHash: string }>;
}

export interface Compressor {
  (plain: Uint8Array): Promise<Uint8Array>;
}

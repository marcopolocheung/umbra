/** Public, immutable contract for one source-separated z18 v2 component. */
export const FORMAT_VERSION = 1;
export const LOGICAL_SIZE = 256;
export const STORED_SIZE = 258;
export const GUTTER_CELLS = 1;
export const QUANTIZATION = 64;
export const MAX_HEIGHT_METRES = 100_000;
export const MAX_DECODED_BYTES = STORED_SIZE * STORED_SIZE * 4 * 8;

export type ComponentKind = "terrain" | "buildings" | "canopy";
/** Component planes stay source-relative; the six canonical planes exist only after composition. */
export type PlaneName =
  | "groundQ"
  | "foundationQ"
  | "foundationPresent"
  | "buildingAglQ"
  | "buildingMask"
  | "buildingSupport"
  | "buildingFeatureId"
  | "buildingPriority"
  | "canopyHeightAglQ"
  | "canopyBaseAglQ"
  | "canopyMask"
  | "canopySupport"
  | "fallbackCrownTopAglQ"
  | "fallbackCrownBaseAglQ"
  | "fallbackCanopyMask"
  | "fallbackFeatureId"
  | "crownBaseAglQ"
  | "crownTopAglQ"
  | "flagsAndMaterial"
  | "provenanceIndex";
export type PlaneType = "i32" | "u32";
export type Predictor = "none" | "horizontal-delta-u32";
export type Codec = "gzip";
export type SupportState = "present" | "known-empty" | "nodata" | "unknown";

export const COMPONENT_FLAGS = {
  buildingPresent: 1 << 0,
  canopyPresent: 1 << 1,
  canopyInferredBase: 1 << 2,
  canopyFallback: 1 << 3,
  canopyConflict: 1 << 4,
  terrainUnknown: 1 << 5,
  buildingUnknown: 1 << 6,
  canopyUnknown: 1 << 7,
} as const;

export interface ComponentPlane {
  name: PlaneName;
  type: PlaneType;
  /** Canonical little-endian u32 words; i32 values use two's-complement. */
  words: Uint32Array;
  predictor?: Predictor;
  provenanceTableIndex?: number;
  materialTableIndex?: number;
}

export interface ComponentIdentity {
  generation: string;
  tile: string;
  sourceHash: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  licenceHash: string;
  normalizerHash?: string;
  compositorHash?: string;
  treeModelHash?: string;
  receiverHash?: string;
}

export interface LicenceRecord {
  id: string;
  notice: string;
  url?: string;
}
export interface ProvenanceRecord {
  id: string;
  source: string;
  acquiredAt?: string;
  support: SupportState;
}
export interface EvidenceRecord {
  id: string;
  subject: string;
  hash: string;
}
export interface ComponentTables {
  licences: LicenceRecord[];
  provenance: ProvenanceRecord[];
  evidence: EvidenceRecord[];
}

export interface Component {
  kind: ComponentKind;
  identity: ComponentIdentity;
  planes: ComponentPlane[];
  /** Component-level support remains source-separated and is never inferred as empty. */
  support?: SupportState;
  /** Legacy compact evidence labels; the indexed table is the portable public contract. */
  evidence: Record<string, string>;
  tables?: ComponentTables;
  /** Present only after decoding an object; never serialized into its directory. */
  transportHash?: string;
}

export interface EncodedComponent {
  bytes: Uint8Array;
  transportHash: string;
  physicsHash: string;
}
export interface ManifestComponent
  extends Pick<
    ComponentIdentity,
    "tile" | "sourceHash" | "recipeHash" | "datumHash" | "hierarchyHash" | "licenceHash"
  > {
  kind: ComponentKind;
  objectHash: string;
}
export interface GenerationManifest {
  generation: string;
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  components: ManifestComponent[];
}
export type Compressor = (plain: Uint8Array) => Promise<Uint8Array>;

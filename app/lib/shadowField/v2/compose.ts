import { validateManifestDependencies } from "./format";
import { composeCrown } from "./treeModel";
import {
  COMPONENT_FLAGS,
  STORED_SIZE,
  type Component,
  type ComponentPlane,
  type GenerationManifest,
} from "./types";

export interface CompositionReservation {
  reserve(bytes: number): boolean;
}
export interface CompositionEvidence {
  terrain: "present";
  buildings: "present" | "known-empty";
  canopy: "present" | "known-empty";
  complete: boolean;
}
export interface CompositionAccounting {
  outputBytes: number;
  reservedBytes: number;
}
export interface ComposedTile {
  groundQ: Int32Array;
  buildingTopQ: Int32Array;
  crownBaseQ: Int32Array;
  crownTopQ: Int32Array;
  flagsAndMaterial: Uint32Array;
  provenanceIndex: Uint32Array;
  evidence?: CompositionEvidence;
  accounting?: CompositionAccounting;
}
export interface BuildingCandidate {
  featureId: number;
  priority: number;
  foundationQ: number;
  heightAglQ: number;
}
/** Normalization calls this before clipping; roof height wins, then the stable feature ID. */
export function chooseBuildingCandidate(
  candidates: readonly BuildingCandidate[],
): BuildingCandidate | undefined {
  return candidates.reduce<BuildingCandidate | undefined>(
    (winner, candidate) =>
      !winner ||
      candidate.foundationQ + candidate.heightAglQ > winner.foundationQ + winner.heightAglQ ||
      (candidate.foundationQ + candidate.heightAglQ === winner.foundationQ + winner.heightAglQ &&
        (candidate.priority > winner.priority ||
          (candidate.priority === winner.priority && candidate.featureId < winner.featureId)))
        ? candidate
        : winner,
    undefined,
  );
}

function plane(
  component: Component | undefined,
  name: ComponentPlane["name"],
): Uint32Array | undefined {
  return component?.planes.find((item) => item.name === name)?.words;
}
function signed(words: Uint32Array | undefined, index: number): number {
  return words?.[index] === undefined ? 0 : words[index] | 0;
}
function add(left: number, right: number): number {
  const value = left + right;
  if (value < -0x80000000 || value > 0x7fffffff) throw new Error("composed height exceeds i32");
  return value;
}
function component(components: Component[], kind: Component["kind"]): Component | undefined {
  return components.find((item) => item.kind === kind);
}
function isReservation(
  value: GenerationManifest | CompositionReservation,
): value is CompositionReservation {
  return "reserve" in value;
}

/** Pure source join; the two-argument form is retained only for the existing item-3 fixture. */
export function composeTile(
  components: Component[],
  manifest: GenerationManifest,
  reservation: CompositionReservation,
): ComposedTile;
export function composeTile(
  components: Component[],
  reservation: CompositionReservation,
): ComposedTile;
export function composeTile(
  components: Component[],
  manifestOrReservation: GenerationManifest | CompositionReservation,
  maybeReservation?: CompositionReservation,
): ComposedTile {
  const reservation = isReservation(manifestOrReservation)
    ? manifestOrReservation
    : maybeReservation;
  if (!reservation) throw new Error("composition reservation is required");
  const pinned = !isReservation(manifestOrReservation);
  if (pinned) validateManifestDependencies(manifestOrReservation, components);
  const terrain = component(components, "terrain");
  const buildings = component(components, "buildings");
  const canopy = component(components, "canopy");
  if (!terrain || terrain.support === "unknown" || terrain.support === "nodata")
    throw new Error("terrain support is required for composition");
  if (pinned && (!buildings || !canopy))
    throw new Error("component support is required for composition");
  if (
    buildings?.support === "unknown" ||
    buildings?.support === "nodata" ||
    canopy?.support === "unknown"
  )
    throw new Error("component support is unresolved");
  const words = STORED_SIZE * STORED_SIZE;
  const outputBytes = words * 24;
  if (!reservation.reserve(outputBytes)) throw new Error("composition reservation failed");
  const ground = plane(terrain, "groundQ");
  if (!ground) throw new Error("terrain object has no ground plane");
  const foundation = plane(terrain, "foundationQ");
  const foundationPresent = plane(terrain, "foundationPresent");
  const buildingAgl = plane(buildings, "buildingAglQ");
  const buildingMask = plane(buildings, "buildingMask");
  const buildingFeature = plane(buildings, "buildingFeatureId");
  const flagsSource = plane(canopy, "flagsAndMaterial") ?? plane(buildings, "flagsAndMaterial");
  const provenanceSource = plane(canopy, "provenanceIndex") ?? plane(buildings, "provenanceIndex");
  const result: ComposedTile = {
    groundQ: new Int32Array(
      ground.buffer.slice(ground.byteOffset, ground.byteOffset + ground.byteLength),
    ),
    buildingTopQ: new Int32Array(words),
    crownBaseQ: new Int32Array(words),
    crownTopQ: new Int32Array(words),
    flagsAndMaterial: flagsSource?.slice() ?? new Uint32Array(words),
    provenanceIndex: provenanceSource?.slice() ?? new Uint32Array(words),
    evidence: {
      terrain: "present",
      buildings: buildings?.support === "known-empty" || !buildings ? "known-empty" : "present",
      canopy: canopy?.support === "known-empty" || !canopy ? "known-empty" : "present",
      complete: true,
    },
    accounting: { outputBytes, reservedBytes: outputBytes },
  };
  for (let index = 0; index < words; index++) {
    const hasBuilding = buildingMask ? buildingMask[index] !== 0 : signed(buildingAgl, index) !== 0;
    if (hasBuilding) {
      if (pinned && (!foundation || !foundationPresent?.[index]))
        throw new Error("building foundation support is required");
      // v1 fixture compatibility treats a supplied foundation plane as present;
      // new objects use foundationPresent so an actual zero is unambiguous.
      const base = foundationPresent
        ? foundationPresent[index]
          ? signed(foundation, index)
          : result.groundQ[index]
        : foundation
          ? signed(foundation, index)
          : result.groundQ[index];
      const roof = add(base, signed(buildingAgl, index));
      if (roof < result.groundQ[index]) throw new Error("roof below terrain");
      result.buildingTopQ[index] = roof;
      result.flagsAndMaterial[index] |= COMPONENT_FLAGS.buildingPresent;
      if (buildingFeature) result.provenanceIndex[index] = buildingFeature[index];
    }
    const crown = composeCrown(index, canopy, result.groundQ[index], result.buildingTopQ[index]);
    if (crown) {
      result.crownBaseQ[index] = crown.baseQ;
      result.crownTopQ[index] = crown.topQ;
      result.flagsAndMaterial[index] |= COMPONENT_FLAGS.canopyPresent | crown.flags;
      if (crown.provenance) result.provenanceIndex[index] = crown.provenance;
    }
  }
  return result;
}

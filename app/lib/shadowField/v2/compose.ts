import { STORED_SIZE, type Component, type ComponentPlane } from "./types";

export interface CompositionReservation { reserve(bytes: number): boolean; }
export interface ComposedTile { groundQ: Int32Array; buildingTopQ: Int32Array; crownBaseQ: Int32Array; crownTopQ: Int32Array; flagsAndMaterial: Uint32Array; provenanceIndex: Uint32Array; }

function plane(component: Component | undefined, name: ComponentPlane["name"]): Uint32Array | undefined { return component?.planes.find((item) => item.name === name)?.words; }
function signed(words: Uint32Array | undefined, index: number): number { return words ? (words[index] | 0) : 0; }

/** Pure, allocation-accounted source join. It deliberately does not publish fused output. */
export function composeTile(components: Component[], reservation: CompositionReservation): ComposedTile {
  const terrain = components.find((item) => item.kind === "terrain");
  const buildings = components.find((item) => item.kind === "buildings");
  const canopy = components.find((item) => item.kind === "canopy");
  if (!terrain) throw new Error("terrain support is required for composition");
  const words = STORED_SIZE * STORED_SIZE;
  if (!reservation.reserve(words * 24)) throw new Error("composition reservation failed");
  const ground = plane(terrain, "groundQ");
  if (!ground) throw new Error("terrain object has no ground plane");
  const buildingAgl = plane(buildings, "buildingAglQ");
  const foundation = plane(terrain, "foundationQ");
  const crownBase = plane(canopy, "crownBaseAglQ");
  const crownTop = plane(canopy, "crownTopAglQ");
  const flags = plane(canopy, "flagsAndMaterial") ?? plane(buildings, "flagsAndMaterial") ?? new Uint32Array(words);
  const provenance = plane(canopy, "provenanceIndex") ?? plane(buildings, "provenanceIndex") ?? new Uint32Array(words);
  const result: ComposedTile = { groundQ: new Int32Array(ground.buffer.slice(ground.byteOffset, ground.byteOffset + ground.byteLength)), buildingTopQ: new Int32Array(words), crownBaseQ: new Int32Array(words), crownTopQ: new Int32Array(words), flagsAndMaterial: flags.slice(), provenanceIndex: provenance.slice() };
  for (let index = 0; index < words; index++) {
    const base = signed(foundation, index) || result.groundQ[index];
    if (buildingAgl?.[index]) result.buildingTopQ[index] = base + signed(buildingAgl, index);
    if (crownTop?.[index]) {
      result.crownBaseQ[index] = result.groundQ[index] + signed(crownBase, index);
      result.crownTopQ[index] = result.groundQ[index] + signed(crownTop, index);
    }
  }
  return result;
}

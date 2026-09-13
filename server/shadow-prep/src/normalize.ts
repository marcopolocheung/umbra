import { STORED_SIZE, type ComponentPlane } from "../../../app/lib/shadowField/v2/types";
import type { Admission } from "./admission";
import { normalizeBuildings, type RawBuilding } from "./buildings";
import { selectCanopy, type CanopyCell } from "./canopy";
import { receipt } from "./sources";
import { inspectTerrain } from "./terrain";

export interface NormalizedTile { tile: string; terrain: ComponentPlane[]; buildings: ComponentPlane[]; canopy: ComponentPlane[]; evidence: Record<string, string>; }
const cells = STORED_SIZE * STORED_SIZE;
const plane = (name: ComponentPlane["name"], type: ComponentPlane["type"], words: Uint32Array): ComponentPlane => ({ name, type, words });

/** Fixture-only normalizer; it is intentionally not reachable from the production CLI. */
export function normalizeFixture(tile: string, groundQ: number, features: RawBuilding[], canopy: CanopyCell[]): NormalizedTile {
  if (canopy.length !== cells) throw new Error("fixture canopy must include true 258×258 border support");
  const terrain = new Uint32Array(cells); terrain.fill(groundQ >>> 0);
  const buildingAgl = new Uint32Array(cells); const foundation = new Uint32Array(cells); const crownTop = new Uint32Array(cells); const flags = new Uint32Array(cells);
  const buildings = normalizeBuildings(features); // validates stable IDs, holes and parts before any clipping.
  for (const building of buildings) for (const part of building.parts) { buildingAgl[0] = Math.max(buildingAgl[0], Math.round(part.height * 64)); foundation[0] = groundQ >>> 0; }
  canopy.forEach((cell, index) => { const chosen = selectCanopy(cell); crownTop[index] = chosen.heightQ >>> 0; flags[index] = chosen.source === "native" ? 1 : chosen.source === "osm" ? 2 : 4; });
  return { tile, terrain: [plane("groundQ", "i32", terrain), plane("foundationQ", "i32", foundation)], buildings: [plane("buildingAglQ", "i32", buildingAgl)], canopy: [plane("crownBaseAglQ", "i32", new Uint32Array(cells)), plane("crownTopAglQ", "i32", crownTop), plane("flagsAndMaterial", "u32", flags)], evidence: { fixture: "explicit-test-only", wholeFeatureCount: String(buildings.length) } };
}

/** Production build boundary: it consumes admitted raw assets, never normalized JSON. */
export async function normalizeProduction(admission: Admission): Promise<NormalizedTile[]> {
  await inspectTerrain(receipt(admission, "fabdem-v1.2"));
  // The raw readers are deliberately gated here. A regional build needs actual full-support
  // GDAL windows and Overture feature extraction; no hand-authored intermediate is accepted.
  receipt(admission, "overture-buildings"); receipt(admission, "overture-building-parts"); receipt(admission, "chmv2-height"); receipt(admission, "chmv2-validity-mask");
  throw new Error("raw-source normalization requires declared NYC z18 extraction windows; no production normalized JSON fallback exists");
}

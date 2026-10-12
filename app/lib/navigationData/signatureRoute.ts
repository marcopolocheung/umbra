/**
 * A calculated walk route's sidewalks, labelled by street shade group (#321).
 *
 * A route records the node path it walked and, per edge, which sidewalk it
 * took. The signature table keys sidewalks by canonical segment and canonical
 * side, so each edge is joined after converting the traveller's side back to
 * the canonical frame; skip that and the opposite sidewalk is coloured on every
 * edge walked against the canonical direction.
 *
 * Pure: the view comes from `signatureView`, the route from `routing`.
 */

import { swapSideAgainstCanonical, type SidewalkSide } from "../routing";
import { shadeSegmentKey } from "./shadeSlots";
import type { NavigationSignatureModel } from "./shardContract";
import type { SignatureSide, SignatureView } from "./signatureView";

/**
 * Four plain groups for the map, ordered sunny → shaded. Eight types can't each
 * get a distinct colour here: orange, blue, green, purple and red all carry a
 * meaning already, and the rest can't make eight that read apart.
 */
export type StreetShadeGroup = 1 | 2 | 3 | 4;

export const STREET_SHADE_GROUP_LABELS: Record<StreetShadeGroup, string> = {
  1: "Sunny all day",
  2: "Sunny midday, shaded at one end",
  3: "Partly shaded",
  4: "Shaded all day",
};

/**
 * Groups a type by its summer shade, from the model's own clock windows: a type
 * with summer sun windows is sunny (shaded at one end if it also has a summer
 * shade window); without sun, how shaded it is overall in summer decides.
 */
export function streetShadeGroup(type: NavigationSignatureModel["types"][number]): StreetShadeGroup {
  if (type.summerSun.length > 0) return type.summerShade.length > 0 ? 2 : 1;
  return type.summerShaded >= 0.8 ? 4 : 3;
}

export interface StreetTypeSegment {
  from: [number, number];
  to: [number, number];
  /** Which sidewalk was walked, in the traveller's frame (for the map offset). */
  side: SidewalkSide;
  type: number;
  group: StreetShadeGroup;
}

/**
 * Every walked edge with a known type. Edges without a side (snap edges,
 * connectors) or outside the loaded cells are skipped, not guessed.
 */
export function routeStreetTypes(
  nodeIds: readonly number[],
  sides: ReadonlyArray<SidewalkSide | null>,
  coordinates: ReadonlyMap<number, [number, number]>,
  view: SignatureView,
): StreetTypeSegment[] {
  const out: StreetTypeSegment[] = [];
  for (let i = 0; i < sides.length && i + 1 < nodeIds.length; i++) {
    const side = sides[i];
    const fromId = nodeIds[i];
    const toId = nodeIds[i + 1];
    const from = coordinates.get(fromId);
    const to = coordinates.get(toId);
    if (!side || !from || !to) continue;
    const canonical: SignatureSide = swapSideAgainstCanonical(fromId, toId, side) === "left" ? 0 : 1;
    const type = view.typeOf(shadeSegmentKey(Math.min(fromId, toId), Math.max(fromId, toId)), canonical);
    const definition = type === null ? undefined : view.type(type);
    if (type === null || !definition) continue;
    out.push({ from, to, side, type, group: streetShadeGroup(definition) });
  }
  return out;
}

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
 * Four plain groups for the map, ordered sunny → shaded by **summer** daylight,
 * which is what the grouping reads. Eight types can't each get a distinct
 * colour here: orange, blue, green, purple and red all carry a meaning already,
 * and the rest can't make eight that read apart. The legend keeps each type's
 * own hours, winter included.
 */
export type StreetShadeGroup = 1 | 2 | 3 | 4;

export const STREET_SHADE_GROUP_LABELS: Record<StreetShadeGroup, string> = {
  1: "Summer: sunny through the day",
  2: "Summer: sunny midday, shaded at one end",
  3: "Summer: partly shaded",
  4: "Summer: shaded all day",
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

/**
 * The selected route's walked distance per group, as one line for its card:
 * largest share first, groups under 5% folded away. Null without data.
 * Distance, not edge count: short crossing edges would otherwise skew it.
 * The shares are of the sidewalks that have a type; `routeMetres`, when given,
 * says how much of the walk that covers.
 */
export function streetTypeBreakdown(
  segments: readonly StreetTypeSegment[],
  routeMetres?: number,
): string | null {
  const metres = new Map<StreetShadeGroup, number>();
  let total = 0;
  for (const { from, to, group } of segments) {
    const dx = (to[0] - from[0]) * 111_320 * Math.cos((((from[1] + to[1]) / 2) * Math.PI) / 180);
    const d = Math.hypot(dx, (to[1] - from[1]) * 110_540);
    metres.set(group, (metres.get(group) ?? 0) + d);
    total += d;
  }
  if (total === 0) return null;
  const parts = [...metres]
    .map(([group, d]) => [group, Math.round((d / total) * 100)] as const)
    .filter(([, pct]) => pct >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([group, pct]) => `${pct}% ${STREET_SHADE_GROUP_LABELS[group].replace("Summer: ", "")}`);
  if (!parts.length) return null;
  const covered =
    routeMetres && routeMetres > 0 && total / routeMetres < 0.95
      ? ` (of the ${Math.round(Math.min(1, total / routeMetres) * 100)}% of the walk with shade data)`
      : "";
  return `Summer shade, by sidewalk: ${parts.join(" · ")}${covered}`;
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
 * Every walked edge with a known type; anything else is skipped, not guessed.
 * That includes the stretch to a mid-block start or end: a snap node (negative
 * id) copies one of its segment's two sidewalk edges, so its side was never
 * chosen by the search and names no walked kerb. The card states the coverage.
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
    if (!side || !from || !to || fromId < 0 || toId < 0) continue;
    const canonical: SignatureSide = swapSideAgainstCanonical(fromId, toId, side) === "left" ? 0 : 1;
    const type = view.typeOf(shadeSegmentKey(Math.min(fromId, toId), Math.max(fromId, toId)), canonical);
    const definition = type === null ? undefined : view.type(type);
    if (type === null || !definition) continue;
    out.push({ from, to, side, type, group: streetShadeGroup(definition) });
  }
  return out;
}

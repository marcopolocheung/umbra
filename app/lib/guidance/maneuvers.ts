import { bearingDegrees, haversineMeters, type OsmNode } from "../routing";
import type { Maneuver, ManeuverType } from "./types";

/** Classify a signed bearing delta in [-180, 180). Positive turns go right. */
export function classifyTurn(bearingDelta: number): ManeuverType {
  const angle = Math.abs(bearingDelta);
  if (angle < 20) return "continue";
  if (angle < 50) return bearingDelta < 0 ? "slight-left" : "slight-right";
  if (angle <= 120) return bearingDelta < 0 ? "turn-left" : "turn-right";
  return bearingDelta < 0 ? "sharp-left" : "sharp-right";
}

/**
 * Ordered walking-route nodes → guidance, with distances along the supplied geometry.
 * Pass nodes in travel order (e.g. RouteResult.nodeIds mapped through graph.nodes).
 * Call per walking leg: transit RouteOption.geojson can join disconnected walk legs.
 * Distances are local to this path; legIndex identifies it for later journey composition.
 * Small bends/continues need no instruction. Duplicate positions have no bearing and
 * are skipped. An empty path yields nothing; a stationary path yields arrive at 0 m.
 */
export function generateManeuvers(
  nodes: readonly Pick<OsmNode, "lon" | "lat">[],
  legIndex = 0,
  /**
   * Optional per-segment street names, length `nodes.length - 1`. B2: the name
   * of the street the walker proceeds along after each maneuver — the street you
   * turn *onto*, not the one you left. Omit it and maneuvers carry no name.
   */
  names?: readonly (string | undefined)[],
): Maneuver[] {
  if (nodes.length === 0) return [];

  const maneuvers: Maneuver[] = [];
  let distanceM = 0;
  let previousBearing: number | null = null;
  const nameAt = (segmentIndex: number): string | undefined => names?.[segmentIndex];

  for (let i = 1; i < nodes.length; i++) {
    const from: [number, number] = [nodes[i - 1].lon, nodes[i - 1].lat];
    const to: [number, number] = [nodes[i].lon, nodes[i].lat];
    const segmentM = haversineMeters(from, to);
    if (segmentM === 0) continue;

    // The maneuver at segment i happens at nodes[i-1], onto that segment.
    const streetName = nameAt(i - 1);
    const bearing = bearingDegrees(from, to);
    if (previousBearing === null) {
      maneuvers.push({ type: "depart", bearingDelta: 0, distanceFromStartM: 0, legIndex, streetName });
    } else {
      const bearingDelta = ((bearing - previousBearing + 540) % 360) - 180;
      const type = classifyTurn(bearingDelta);
      if (type !== "continue") {
        maneuvers.push({ type, bearingDelta, distanceFromStartM: distanceM, legIndex, streetName });
      }
    }
    previousBearing = bearing;
    distanceM += segmentM;
  }

  maneuvers.push({
    type: "arrive",
    bearingDelta: 0,
    distanceFromStartM: distanceM,
    legIndex,
    streetName: nameAt(nodes.length - 2),
  });
  return maneuvers;
}

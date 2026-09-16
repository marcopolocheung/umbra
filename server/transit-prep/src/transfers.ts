/**
 * Nearest-stop subway↔bus transfer stubs. Bus feeds ship no transfers.txt,
 * so these edges are spatial: every bus stop within radiusM of a subway
 * parent station, capped per station, weighted by walk time. Constants are
 * recorded in the manifest so Step 6 can tune without rebuilding blind.
 */

import type { StopNode, TransferEdge } from "./model";
import { haversineMeters } from "./util";

export const SPATIAL_TRANSFER_RADIUS_M = 200;
export const SPATIAL_TRANSFER_CAP_PER_STATION = 10;
export const SPATIAL_WALK_MPS = 1.4;

export function buildSpatialStubs(
  subwayStops: StopNode[],
  busStops: StopNode[],
  options?: { radiusM?: number; cap?: number; walkMps?: number },
): TransferEdge[] {
  const radiusM = options?.radiusM ?? SPATIAL_TRANSFER_RADIUS_M;
  const cap = options?.cap ?? SPATIAL_TRANSFER_CAP_PER_STATION;
  const walkMps = options?.walkMps ?? SPATIAL_WALK_MPS;
  const stubs: TransferEdge[] = [];
  for (const station of subwayStops) {
    const nearby: { stop: StopNode; distM: number }[] = [];
    for (const stop of busStops) {
      const distM = haversineMeters(station.lat, station.lon, stop.lat, stop.lon);
      if (distM <= radiusM) nearby.push({ stop, distM });
    }
    nearby.sort((a, b) => a.distM - b.distM);
    for (const { stop, distM } of nearby.slice(0, cap)) {
      const walkSec = Math.max(30, Math.ceil(distM / walkMps));
      stubs.push({ from: station.id, to: stop.id, minSec: walkSec, kind: "spatial" });
      stubs.push({ from: stop.id, to: station.id, minSec: walkSec, kind: "spatial" });
    }
  }
  return stubs;
}

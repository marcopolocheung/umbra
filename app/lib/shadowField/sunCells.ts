/**
 * The producer's 2 km sun-position batches. Shared with shade-window queries:
 * a night byte is indistinguishable from daytime full shade, so both readers
 * must use exactly the observer points the shadow sweep used when writing it.
 * Preserve input order and arithmetic: the complete shade index is the batch.
 */
import { metersPerDegree } from "./geometry";
import type { EdgeRef } from "./ShadowField";

/** ~0.018° of sun-altitude spread: <0.8 m of shadow error at 10° altitude. */
const SUN_CELL_M = 2000;

export interface SunCellPartition {
  members: number[];
  lng: number;
  lat: number;
}

export function partitionSunCells(edges: readonly EdgeRef[]): SunCellPartition[] {
  if (edges.length === 0) return [];
  const batchLat = edges.reduce((sum, e) => sum + (e.from[1] + e.to[1]) / 2, 0) / edges.length;
  const batch = metersPerDegree(batchLat);
  const cellLng = SUN_CELL_M / batch.mPerLng;
  const cellLat = SUN_CELL_M / batch.mPerLat;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const midLng = (edges[i].from[0] + edges[i].to[0]) / 2;
    const midLat = (edges[i].from[1] + edges[i].to[1]) / 2;
    const key = `${Math.floor(midLng / cellLng)},${Math.floor(midLat / cellLat)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [i]);
    else group.push(i);
  }
  return [...groups.values()].map((members) => {
    let sumLng = 0;
    let sumLat = 0;
    for (const i of members) {
      sumLng += (edges[i].from[0] + edges[i].to[0]) / 2;
      sumLat += (edges[i].from[1] + edges[i].to[1]) / 2;
    }
    return { members, lng: sumLng / members.length, lat: sumLat / members.length };
  });
}

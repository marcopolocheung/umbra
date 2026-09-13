export interface CanopyCell { heightQ: number; valid: boolean; nodata: boolean; osmFallbackQ?: number; }

/** Native valid cells win, including height zero. OSM fills only unavailable/nodata cells. */
export function selectCanopy(cell: CanopyCell): { heightQ: number; source: "native" | "osm" | "unknown" } {
  if (cell.valid && !cell.nodata) return { heightQ: cell.heightQ, source: "native" };
  if (cell.nodata && cell.osmFallbackQ !== undefined) return { heightQ: cell.osmFallbackQ, source: "osm" };
  return { heightQ: 0, source: "unknown" };
}

export interface RawRing { coordinates: number[][]; }
export interface RawBuilding { id: string; outer: RawRing; holes: RawRing[]; parts: Array<{ id: string; height: number; minHeight: number }>; height: number; minHeight: number; }

/** Whole Overture features are retained before a later tile rasterization/clipping pass. */
export function normalizeBuildings(features: RawBuilding[]): RawBuilding[] {
  const ids = new Set<string>();
  return [...features].sort((a, b) => a.id.localeCompare(b.id)).map((feature) => {
    if (!feature.id || ids.has(feature.id) || feature.outer.coordinates.length < 4) throw new Error("invalid or duplicate complete building feature");
    ids.add(feature.id);
    if (feature.height < 0 || feature.minHeight < 0 || feature.minHeight > feature.height) throw new Error(`invalid heights for ${feature.id}`);
    return { ...feature, holes: feature.holes.map((hole) => ({ coordinates: [...hole.coordinates] })), parts: [...feature.parts].sort((a, b) => a.id.localeCompare(b.id)) };
  });
}

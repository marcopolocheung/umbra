export interface RawRing { coordinates: number[][]; }
export interface RawBuilding { id: string; outer: RawRing; holes: RawRing[]; parts: Array<{ id: string; height: number; minHeight: number }>; height: number; minHeight: number; }
export interface OverturePart { id: string; buildingId: string; height: number; minHeight: number; outer?: RawRing; holes?: RawRing[]; }
export interface JoinedBuilding extends Omit<RawBuilding, "parts"> { parts: OverturePart[]; }

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

/** Parent/part association happens on full features, before tile clipping. */
export function joinBuildingParts(buildings: Omit<RawBuilding, "parts">[], parts: OverturePart[]): JoinedBuilding[] {
  const byParent = new Map<string, OverturePart[]>();
  for (const part of [...parts].sort((a,b) => a.id.localeCompare(b.id))) {
    if (!part.id || !part.buildingId || !Number.isFinite(part.height) || !Number.isFinite(part.minHeight) || part.height < 0 || part.minHeight < 0 || part.minHeight > part.height) throw new Error(`missing, invalid, or contradictory building/part height: ${part.id || "unnamed"}`);
    byParent.set(part.buildingId, [...(byParent.get(part.buildingId) ?? []), part]);
  }
  const ids = new Set(buildings.map((building) => building.id)); for (const parent of byParent.keys()) if (!ids.has(parent)) throw new Error(`building part has no complete parent ${parent}`);
  return [...buildings].sort((a,b) => a.id.localeCompare(b.id)).map((building) => {
    if (!building.id || !Number.isFinite(building.height) || !Number.isFinite(building.minHeight) || building.height < 0 || building.minHeight < 0 || building.minHeight > building.height) throw new Error(`missing, invalid, or contradictory building/part height: ${building.id || "unnamed"}`);
    return { ...building, holes: building.holes.map((hole) => ({ coordinates: [...hole.coordinates] })), parts: byParent.get(building.id) ?? [] };
  });
}

/** Fixed top/left half-open ownership makes a shared edge belong to exactly one
 * cell. Holes are excluded even when an exterior ring owns the centre. */
export function ownsCellCentre(outer: RawRing, holes: RawRing[], x: number, y: number): boolean {
  const contains = (ring: RawRing): boolean => { let inside=false; const points=ring.coordinates; for(let i=0,j=points.length-1;i<points.length;j=i++) { const a=points[i],b=points[j]; if ((a[1]>y)!==(b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside; } return inside; };
  return contains(outer) && !holes.some(contains);
}
export function wholeFoundationQ(boundaryTerrainQ: readonly number[]): number {
  const values = boundaryTerrainQ.filter(Number.isFinite).sort((a,b)=>a-b); if (!values.length) throw new Error("complete building footprint has no valid terrain boundary support"); const middle=Math.floor(values.length/2); return values.length % 2 ? values[middle] : Math.round((values[middle-1]+values[middle])/2);
}

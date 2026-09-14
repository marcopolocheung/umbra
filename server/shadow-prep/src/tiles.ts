import type { PolygonalCoverage } from "./admission";
export interface Z18Tile { z: 18; x: number; y: number; key: string; }
type P = readonly [number, number];
const N = 1 << 18;
function projected([lon, lat]: P): P { const x = (lon + 180) / 360 * N; const clipped = Math.max(-85.05112878, Math.min(85.05112878, lat)); const y = (1 - Math.asinh(Math.tan(clipped * Math.PI / 180)) / Math.PI) / 2 * N; return [x, y]; }
function rings(coverage: PolygonalCoverage): P[][] { return (coverage.type === "Polygon" ? coverage.coordinates as number[][][] : (coverage.coordinates as number[][][][]).flat()).map((ring) => ring.map((point) => projected([point[0], point[1]]))); }
/** Exact support intersection, evaluated in the globally anchored Web Mercator tile lattice. */
export function supportTiles(coverage: PolygonalCoverage): Z18Tile[] {
  const all = rings(coverage); const points = all.flat(); if (!points.length) throw new Error("support geometry is empty");
  const minX=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0])))), maxX=Math.min(N-1,Math.floor(Math.max(...points.map(p=>p[0]))));
  const minY=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1])))), maxY=Math.min(N-1,Math.floor(Math.max(...points.map(p=>p[1])))); const hit = new Set<string>();
  const add=(x:number,y:number) => { if(x>=0&&x<N&&y>=0&&y<N) hit.add(`${x}/${y}`); };
  // Mark boundary cells with a grid DDA. This avoids O(tileCount × vertexCount)
  // work for the full NYC support outline.
  for (const ring of all) for (let i=0;i<ring.length-1;i++) { const a=ring[i], b=ring[i+1], steps=Math.max(1,Math.ceil(Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])))); for(let step=0;step<=steps;step++) add(Math.floor(a[0]+(b[0]-a[0])*step/steps),Math.floor(a[1]+(b[1]-a[1])*step/steps)); }
  // Even/odd scanlines fill polygon interiors and preserve holes. A centre-line
  // is sufficient after the boundary pass has captured every edge-touching tile.
  for(let y=minY;y<=maxY;y++) { const line=y+.5; const crossings:number[]=[]; for(const ring of all) for(let i=0;i<ring.length-1;i++) { const a=ring[i],b=ring[i+1]; if((a[1]>line)!==(b[1]>line)) crossings.push(a[0]+(line-a[1])*(b[0]-a[0])/(b[1]-a[1])); } crossings.sort((a,b)=>a-b); for(let i=0;i+1<crossings.length;i+=2) for(let x=Math.max(minX,Math.floor(crossings[i]));x<=Math.min(maxX,Math.floor(crossings[i+1]));x++) add(x,y); }
  return [...hit].map((value) => { const [x,y]=value.split("/").map(Number); return {z:18 as const,x,y,key:`18/${x}/${y}`}; }).sort((a,b)=>a.y-b.y || a.x-b.x);
}
export function tileCentre(tile: Z18Tile, localX: number, localY: number): P { return [(tile.x + localX / 256) / N, (tile.y + localY / 256) / N]; }
function latitude(mercatorY: number): number { return Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI; }
/** Centre coordinates include the stored one-cell gutter: -0.5 and 256.5 are
 * real neighbouring z18 cell centres, not duplicated edge pixels. */
export function tileCellLonLat(tile: Z18Tile, storedX: number, storedY: number): P {
  const x = (tile.x + (storedX - .5) / 256) / N;
  const y = (tile.y + (storedY - .5) / 256) / N;
  return [x * 360 - 180, latitude(y)];
}
export function tileBounds(tile: Z18Tile, gutterCells = 0): { west: number; south: number; east: number; north: number } {
  const west = (tile.x - gutterCells / 256) / N * 360 - 180;
  const east = (tile.x + 1 + gutterCells / 256) / N * 360 - 180;
  return { west, east, north: latitude((tile.y - gutterCells / 256) / N), south: latitude((tile.y + 1 + gutterCells / 256) / N) };
}

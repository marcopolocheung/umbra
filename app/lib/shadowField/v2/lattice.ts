import { STORED_SIZE } from "./types";

export const TILE_CELLS = STORED_SIZE - 2;
export function storedIndex(localX: number, localY: number): number {
  if (
    !Number.isInteger(localX) ||
    !Number.isInteger(localY) ||
    localX < -1 ||
    localY < -1 ||
    localX > TILE_CELLS ||
    localY > TILE_CELLS
  )
    throw new Error("stored coordinate outside one-cell border");
  return (localY + 1) * STORED_SIZE + localX + 1;
}
/** Fixed half-open, top/left ownership: a point on a right/bottom edge belongs to its neighbour. */
export function ownerCell(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x), y: Math.floor(y) };
}
/** Piecewise-planar terrain sample at a cell point with the required NW–SE diagonal. */
export function terrainAtCellPoint(
  groundQ: Int32Array,
  cellX: number,
  cellY: number,
  localX: number,
  localY: number,
): number {
  if (localX < 0 || localX > 1 || localY < 0 || localY > 1)
    throw new Error("point is outside terrain cell");
  const nw = groundQ[storedIndex(cellX, cellY)];
  const ne = groundQ[storedIndex(cellX + 1, cellY)];
  const sw = groundQ[storedIndex(cellX, cellY + 1)];
  const se = groundQ[storedIndex(cellX + 1, cellY + 1)];
  return localY <= localX
    ? nw + (ne - nw) * localX + (se - ne) * localY
    : nw + (se - sw) * localX + (sw - nw) * localY;
}

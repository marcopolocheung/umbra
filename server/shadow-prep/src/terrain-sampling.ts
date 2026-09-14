import { quantizeHeight } from "../../../app/lib/shadowField/v2/format";

export interface RasterGrid { width: number; height: number; values: Float64Array; }
/** Bilinear interpolation deliberately retains the four real neighbours; callers
 * must supply a grid/window that includes the one-cell candidate gutter. */
export function bilinearTerrain(grid: RasterGrid, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > grid.width - 1 || y > grid.height - 1) throw new Error("terrain sample lies outside admitted source support");
  const left = Math.floor(x), top = Math.floor(y), right = Math.min(grid.width - 1, left + 1), bottom = Math.min(grid.height - 1, top + 1);
  const nw=grid.values[top*grid.width+left], ne=grid.values[top*grid.width+right], sw=grid.values[bottom*grid.width+left], se=grid.values[bottom*grid.width+right];
  if (![nw,ne,sw,se].every(Number.isFinite)) throw new Error("terrain bilinear neighbourhood contains nodata");
  const fx=x-left, fy=y-top; return nw*(1-fx)*(1-fy)+ne*fx*(1-fy)+sw*(1-fx)*fy+se*fx*fy;
}
/** Datum conversion occurs on metres, and this is the sole quantization point. */
export function transformedTerrainQ(sample: number, egm08ToEgm96: number): number { return quantizeHeight(sample + egm08ToEgm96); }

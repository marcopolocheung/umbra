import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdmittedReceipt } from "./admission";
const exec = promisify(execFile);

/** Container-only GDAL probe. FABDEM stays EGM2008 until the explicit PROJ operation is recorded. */
export async function inspectTerrain(source: AdmittedReceipt): Promise<void> {
  if (source.role !== "terrain" || source.verticalDatum !== "EGM2008") throw new Error("FABDEM receipt is not EGM2008 terrain");
  await exec("gdalinfo", ["-json", source.path]);
}

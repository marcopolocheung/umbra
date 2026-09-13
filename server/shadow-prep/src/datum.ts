import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const NYC_DATUM_BBOX = "-74.26,40.49,-73.70,40.92";
export const DATUM_CONTROL_THRESHOLD_BLOCKER = "datum-control residual threshold is unadmitted; retained controls cannot admit the region";
export const NGA_GRID_SHA256: Record<string, string> = {
  "us_nga_egm08_25.tif": "4191d471eefebf24091b56dbc604353cb3b8cf8cc70e448bb9ae56a272bef17a",
  "us_nga_egm96_15.tif": "db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d",
};

/** AGL building and canopy heights never receive an absolute geoid shift. */
export function transformHeight(heightMetres: number, egm08MinusEgm96: number, isAgl: boolean): number {
  return isAgl ? heightMetres : heightMetres + egm08MinusEgm96;
}

/**
 * Accept only an NYC-applicable, installed-grid EGM2008-to-EGM96 operation.
 * `projinfo --grid-check known_available` does the availability check; these
 * checks make the persisted command output auditable and reject its fallbacks.
 */
export function validateDatumOutput(output: string): string | undefined {
  if (!output.trim()) return "EGM2008→EGM96 operation is absent";
  if (/ballpark|outside (?:the )?area|no operation found|unknown area/i.test(output)) return "EGM2008→EGM96 operation is ballpark, out of the NYC area, or unavailable";
  if (!/us_nga_egm08_25\.tif/i.test(output) || !/us_nga_egm96_15\.tif/i.test(output)) return "EGM2008→EGM96 operation does not name both required NGA grids";
  return undefined;
}

export async function validateDatumOperation(gridPaths: string[]): Promise<{ output: string; error?: string }> {
  if (gridPaths.length !== 2) return { output: "", error: "required EGM grids are absent" };
  try {
    const result = await exec("projinfo", ["-s", "EPSG:4326+3855", "-t", "EPSG:4326+5773", "--bbox", NYC_DATUM_BBOX, "--spatial-test", "intersects", "--grid-check", "known_available"]);
    const output = `${result.stdout}${result.stderr}`;
    const error = validateDatumOutput(output);
    return error ? { output, error } : { output };
  } catch (error) {
    return { output: "", error: `PROJ datum operation check failed: ${(error as Error).message}` };
  }
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileHash, requireRoot, sha256, writeJson } from "./util";

const PIPELINE = [
  "+proj=pipeline",
  "+step", "+proj=axisswap", "+order=2,1",
  "+step", "+proj=unitconvert", "+xy_in=deg", "+xy_out=rad",
  "+step", "+proj=vgridshift", "+grids=us_nga_egm08_25.tif", "+multiplier=1",
  "+step", "+inv", "+proj=vgridshift", "+grids=us_nga_egm96_15.tif",
  "+step", "+proj=unitconvert", "+xy_in=rad", "+xy_out=deg",
  "+step", "+proj=axisswap", "+order=2,1",
];
const OUTPUT_FILENAME = "datum-controls-transformed.json";
const REPORT_FILENAME = "datum-controls-residual-report.json";

interface EpqsResponse { location?: { x?: number; y?: number }; value?: string | number; rasterId?: number; resolution?: number; attributes?: Record<string, unknown>; }
interface Control { filename: string; longitude: number; latitude: number; height: number; sourceSha256: string; rasterId?: number; resolutionMetres?: number; acquisitionDate?: unknown; }
interface CctPoint { longitude: number; latitude: number; height: number; }

function cct(input: CctPoint, inverse = false): Promise<CctPoint> {
  return new Promise((resolve, reject) => {
    const process = spawn("cct", ["-d", "12", ...(inverse ? ["-I"] : []), ...PIPELINE]);
    let output = ""; let error = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { error += chunk; });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code !== 0) return reject(new Error(`cct failed (${code}): ${error.trim()}`));
      const values = output.trim().split(/\s+/).slice(0, 3).map(Number);
      if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return reject(new Error(`cct returned malformed control output: ${output.trim()}`));
      resolve({ longitude: values[0], latitude: values[1], height: values[2] });
    });
    process.stdin.end(`${input.longitude} ${input.latitude} ${input.height}\n`);
  });
}

async function controls(directory: string): Promise<Control[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  if (!names.length) throw new Error("no raw USGS 3DEP control responses are present");
  return Promise.all(names.map(async (filename) => {
    const path = join(directory, filename); const response = JSON.parse(await readFile(path, "utf8")) as EpqsResponse;
    const longitude = response.location?.x; const latitude = response.location?.y; const height = Number(response.value);
    if (![longitude, latitude, height].every(Number.isFinite)) throw new Error(`malformed USGS 3DEP control ${filename}`);
    return { filename, longitude: longitude!, latitude: latitude!, height, sourceSha256: await fileHash(path), rasterId: response.rasterId, resolutionMetres: response.resolution, acquisitionDate: response.attributes?.AcquisitionDate };
  }));
}

/**
 * Emits external evidence for numerical reversibility of the pinned operation.
 * EPQS responses do not state an EGM2008 vertical datum, so this package never
 * labels the result as a physical-datum or terrain-accuracy measurement.
 */
export async function packageDatumControls(): Promise<{ outputFilename: string; outputSha256: string; reportFilename: string; reportSha256: string; operation: string; operationHash: string; metric: string; units: string; evaluatedPopulation: number; methodVersionHash: string; observedWorstResidual: number; }> {
  const root = requireRoot();
  const operation = await readFile(join(root, "evidence", "datum-operation.txt"), "utf8");
  if (!/us_nga_egm08_25\.tif/i.test(operation) || !/us_nga_egm96_15\.tif/i.test(operation)) throw new Error("the retained NYC PROJ operation is absent or does not name both pinned grids");
  const inputs = await controls(join(root, "raw", "3dep-controls"));
  const method = { version: "nyc-datum-controls-v1", runner: "cct", pipeline: PIPELINE, residual: "absolute forward/inverse height round-trip difference", sourceInterpretation: "USGS EPQS heights are passed through the recorded EGM2008-to-EGM96 operation solely to measure numerical reversibility; no source vertical datum or physical accuracy is asserted" };
  const methodVersionHash = sha256(Buffer.from(JSON.stringify(method)));
  const transformed = await Promise.all(inputs.map(async (control) => {
    const forward = await cct({ longitude: control.longitude, latitude: control.latitude, height: control.height });
    const inverse = await cct(forward, true);
    return { ...control, pipelineOutputHeight: forward.height, returnedInputHeight: inverse.height, residual: Math.abs(inverse.height - control.height) };
  }));
  const observedWorstResidual = Math.max(...transformed.map((control) => control.residual));
  const output = { schemaVersion: 1, generatedAt: new Date().toISOString(), operation, operationHash: sha256(Buffer.from(operation)), methodVersionHash, controls: transformed };
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), metric: "absolute forward/inverse height round-trip residual", units: "metres", evaluatedPopulation: transformed.length, methodVersionHash, observedWorstResidual, interpretation: "Numerical PROJ-pipeline reversibility only. This package is not a physical-accuracy or datum-agreement claim.", perControl: transformed.map(({ filename, residual }) => ({ filename, residual })) };
  const evidence = join(root, "evidence");
  await writeJson(join(evidence, OUTPUT_FILENAME), output); await writeJson(join(evidence, REPORT_FILENAME), report);
  return { outputFilename: OUTPUT_FILENAME, outputSha256: await fileHash(join(evidence, OUTPUT_FILENAME)), reportFilename: REPORT_FILENAME, reportSha256: await fileHash(join(evidence, REPORT_FILENAME)), operation, operationHash: output.operationHash, metric: report.metric, units: report.units, evaluatedPopulation: report.evaluatedPopulation, methodVersionHash, observedWorstResidual };
}

/** Records the sole-authority threshold decision outside Git for receipt assembly. */
export async function approveDatumControls(signedDecisionId: string, maximumResidual: number): Promise<{ signedDecisionId: string; maximumResidual: number; observedWorstResidual: number; metric: string; units: string; }> {
  if (!/^[A-Za-z0-9._-]+$/.test(signedDecisionId) || !Number.isFinite(maximumResidual) || maximumResidual < 0) throw new Error("approval requires a safe signed decision ID and a non-negative finite maximum residual");
  const root = requireRoot(); const evidence = join(root, "evidence");
  const report = JSON.parse(await readFile(join(evidence, REPORT_FILENAME), "utf8")) as { metric?: string; units?: string; evaluatedPopulation?: number; methodVersionHash?: string; observedWorstResidual?: number };
  const output = JSON.parse(await readFile(join(evidence, OUTPUT_FILENAME), "utf8")) as { operation?: string; operationHash?: string };
  if (typeof report.metric !== "string" || typeof report.units !== "string" || !Number.isInteger(report.evaluatedPopulation) || !/^[a-f0-9]{64}$/.test(String(report.methodVersionHash)) || !Number.isFinite(report.observedWorstResidual)) throw new Error("the retained datum-control report is incomplete");
  if (typeof output.operation !== "string" || !/^[a-f0-9]{64}$/.test(String(output.operationHash)) || output.operationHash !== sha256(Buffer.from(output.operation))) throw new Error("the retained datum-control output does not identify its exact PROJ operation");
  const observedWorstResidual = report.observedWorstResidual as number;
  if (observedWorstResidual > maximumResidual) throw new Error("the observed worst residual exceeds the proposed approved maximum residual");
  const decision = { schemaVersion: 1, recordedAt: new Date().toISOString(), thresholdStatus: "approved", signedDecisionId, maximumResidual, operation: output.operation, operationHash: output.operationHash, metric: report.metric, units: report.units, evaluatedPopulation: report.evaluatedPopulation, methodVersionHash: report.methodVersionHash, observedWorstResidual, outputFilename: OUTPUT_FILENAME, outputSha256: await fileHash(join(evidence, OUTPUT_FILENAME)), reportFilename: REPORT_FILENAME, reportSha256: await fileHash(join(evidence, REPORT_FILENAME)) };
  await writeJson(join(evidence, "datum-control-decision.json"), decision);
  return { signedDecisionId, maximumResidual, observedWorstResidual, metric: report.metric, units: report.units };
}

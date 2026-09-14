import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { admit } from "./admission";
import { build, current, verifyGeneration } from "./build";
import { approveDatumControls, packageDatumControls } from "./controls";
import { assembleReceipts } from "./receipts";
import { normalizeAdmitted, planNormalization } from "./normalize";
import { directoryBytes, files, requireRoot, writeJson } from "./util";
import { S3Store } from "./storage";
import { readFile } from "node:fs/promises";
import { stageAdmittedInputs } from "./stage";
import { acquire } from "./acquire";

const exec = promisify(execFile);
async function versions(): Promise<Record<string, string>> {
  const result: Record<string, string> = { node: process.version };
  for (const [command, args] of [["gdalinfo", ["--version"]], ["proj", []], ["projinfo", ["--searchpaths"]]] as const) {
    try { const output = await exec(command, args); result[command] = `${output.stdout}${output.stderr}`.trim().split(/\r?\n/, 1)[0] || "available"; } catch { result[command] = "unavailable"; }
  }
  return result;
}
async function normalizeCommand(root: string): Promise<unknown> {
  const admission = await admit(); const plan = await planNormalization(admission);
  if (process.argv[3] === "--plan") {
    const summary = { normalizationId: plan.normalizationId, supportHash: plan.supportHash, tileCount: plan.tiles.length, maximumCandidateBytes: plan.maximumCandidateBytes, requiredFreeBytes: plan.requiredFreeBytes };
    await writeJson(join(root, "evidence", `normalize-plan-${plan.normalizationId}.json`), { ...summary, supportPath: plan.supportPath, tiles: plan.tiles.map((tile) => tile.key), policy: "plan-only; no candidate output" }); return summary;
  }
  const smoke = process.argv.includes("--smoke"); const shardArgument = process.argv.indexOf("--shard"); const shardValue = shardArgument >= 0 ? process.argv[shardArgument + 1] : undefined;
  const match = shardValue?.match(/^(\d+)\/(\d+)$/); if (shardValue && !match) throw new Error("--shard requires <zero-based-index>/<count>");
  // Smoke output is isolated under normalized/validation/, never the
  // production-candidate normalization id/prefix.
  const candidatePlan = smoke ? { ...plan, normalizationId: `validation/${plan.normalizationId}` } : plan;
  return normalizeAdmitted(admission, candidatePlan, { smoke, shard: match ? { index: Number(match[1]), count: Number(match[2]) } : undefined });
}
async function retainEvidence(root: string, command: string, path: string): Promise<void> {
  const bucket = process.env.SHADE_PREP_EVIDENCE_BUCKET; if (!bucket) return;
  const jobStore = new S3Store(bucket, "jobs"); const evidenceStore = new S3Store(bucket, process.env.SHADE_PREP_EVIDENCE_PREFIX ?? "evidence");
  await jobStore.write(`${command}/${Date.now()}.json`, new Uint8Array(await readFile(path)), "application/json");
  for (const directory of [join(root, "evidence"), join(root, "admission")]) for (const file of await files(directory)) await evidenceStore.write(relative(root, file), new Uint8Array(await readFile(file)), file.endsWith(".json") ? "application/json" : "text/plain");
}
async function main(): Promise<void> {
  const command = process.argv[2]; if (!(["acquire", "stage", "admit", "controls", "approve-controls", "receipts", "normalize", "build", "verify"] as string[]).includes(command)) throw new Error("usage: shadow-prep <acquire --plan|--execute|stage|admit|controls|approve-controls <signed-decision-id> <maximum-residual>|receipts|normalize [--plan|--smoke|--shard <index>/<count>]|build|verify>");
  // A planning invocation is explicitly observational: it must not create an
  // evidence directory or even a command timing record.
  if (command === "acquire" && process.argv[3] === "--plan") { process.stdout.write(`${JSON.stringify(await acquire("plan"), null, 2)}\n`); return; }
  if (command === "acquire" && process.argv[3] !== "--execute") throw new Error("acquire requires exactly --plan or --execute");
  const started = process.hrtime.bigint(); const cpuStart = process.cpuUsage(); const root = requireRoot(); let result: unknown;
  try {
    // Cloud jobs use immutable objects in the raw bucket. Stage before any
    // command that invokes admission; local runs remain entirely untouched.
    if (command === "acquire") result = await acquire("execute");
    else if (command === "stage") result = await stageAdmittedInputs();
    else if (process.env.SHADE_PREP_RAW_BUCKET && ["admit", "controls", "approve-controls", "normalize", "build"].includes(command)) {
      await stageAdmittedInputs();
      if (command === "admit") result = await admit();
      else if (command === "controls") result = await packageDatumControls();
      else if (command === "approve-controls") result = await approveDatumControls(String(process.argv[3] ?? ""), Number(process.argv[4]));
      else if (command === "normalize") result = await normalizeCommand(root);
      else result = await build();
    }
    else if (command === "admit") result = await admit();
    else if (command === "controls") result = await packageDatumControls();
    else if (command === "approve-controls") result = await approveDatumControls(String(process.argv[3] ?? ""), Number(process.argv[4]));
    else if (command === "receipts") result = await assembleReceipts();
    else if (command === "normalize") result = await normalizeCommand(root);
    else if (command === "build") result = await build();
    else { const generation = await current(); await verifyGeneration(generation); result = { generation }; }
  }
  finally {
    const usage = process.resourceUsage(); const evidence = { command, at: new Date().toISOString(), versions: await versions(), wallMs: Number(process.hrtime.bigint() - started) / 1e6, cpuMicros: process.cpuUsage(cpuStart), peakRssKiB: usage.maxRSS, rawBytes: await directoryBytes(join(root, "raw")), outputBytes: await directoryBytes(join(root, "generations")), scratchBytes: await directoryBytes(join(root, "staging")) };
    const evidencePath = join(root, "evidence", `${command}-${Date.now()}.json`); await writeJson(evidencePath, evidence); await retainEvidence(root, command, evidencePath);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { admit } from "./admission";
import { build, current, verifyGeneration } from "./build";
import { approveDatumControls, packageDatumControls } from "./controls";
import { assembleReceipts } from "./receipts";
import { directoryBytes, requireRoot, writeJson } from "./util";

const exec = promisify(execFile);
async function versions(): Promise<Record<string, string>> {
  const result: Record<string, string> = { node: process.version };
  for (const [command, args] of [["gdalinfo", ["--version"]], ["proj", []], ["projinfo", ["--searchpaths"]]] as const) {
    try { const output = await exec(command, args); result[command] = `${output.stdout}${output.stderr}`.trim().split(/\r?\n/, 1)[0] || "available"; } catch { result[command] = "unavailable"; }
  }
  return result;
}
async function main(): Promise<void> {
  const command = process.argv[2]; if (!(["admit", "controls", "approve-controls", "receipts", "build", "verify"] as string[]).includes(command)) throw new Error("usage: shadow-prep <admit|controls|approve-controls <signed-decision-id> <maximum-residual>|receipts|build|verify>");
  const started = process.hrtime.bigint(); const cpuStart = process.cpuUsage(); const root = requireRoot(); let result: unknown;
  try {
    if (command === "admit") result = await admit();
    else if (command === "controls") result = await packageDatumControls();
    else if (command === "approve-controls") result = await approveDatumControls(String(process.argv[3] ?? ""), Number(process.argv[4]));
    else if (command === "receipts") result = await assembleReceipts();
    else if (command === "build") result = await build();
    else { const generation = await current(); await verifyGeneration(generation); result = { generation }; }
  }
  finally {
    const usage = process.resourceUsage(); const evidence = { command, at: new Date().toISOString(), versions: await versions(), wallMs: Number(process.hrtime.bigint() - started) / 1e6, cpuMicros: process.cpuUsage(cpuStart), peakRssKiB: usage.maxRSS, rawBytes: await directoryBytes(join(root, "raw")), outputBytes: await directoryBytes(join(root, "generations")), scratchBytes: await directoryBytes(join(root, "staging")) };
    await writeJson(join(root, "evidence", `${command}-${Date.now()}.json`), evidence);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { admit } from "./admission";
import { build, current, verifyGeneration } from "./build";
import { directoryBytes, requireRoot, writeJson } from "./util";

const exec = promisify(execFile);
async function versions(): Promise<Record<string, string>> { const result: Record<string, string> = { node: process.version }; for (const command of ["gdalinfo", "proj"]) try { result[command] = (await exec(command, ["--version"])).stdout.trim(); } catch { result[command] = "unavailable"; } return result; }
async function main(): Promise<void> {
  const command = process.argv[2]; if (!(["admit", "build", "verify"] as string[]).includes(command)) throw new Error("usage: shadow-prep <admit|build|verify>");
  const started = process.hrtime.bigint(); const cpuStart = process.cpuUsage(); const root = requireRoot(); let result: unknown;
  try {
    if (command === "admit") result = await admit();
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

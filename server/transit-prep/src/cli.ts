/**
 * transit-prep <acquire --plan|--execute|receipts|validate|normalize|build|verify|publish [--dry-run|--execute]>
 *
 * Steps 1–5 of the GTFS pipeline. Data lives outside git under
 * TRANSIT_PREP_ROOT; every command writes an evidence record.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireExecute, acquirePlan, writeFetchLog } from "./acquire";
import { buildGeneration, normalizeAll } from "./build";
import { publishExecute, publishPlan } from "./publish";
import { assembleReceipts, readReceipts } from "./receipts";
import { requireRoot } from "./util";
import { validate } from "./validate";
import { verifyGeneration } from "./verify";

async function evidence(command: string, result: unknown): Promise<void> {
  const root = requireRoot();
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(
    join(root, "evidence", `${command}-${Date.now()}.json`),
    `${JSON.stringify({ command, at: new Date().toISOString(), node: process.version, result }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const flag = process.argv[3];
  const valid = ["acquire", "receipts", "validate", "normalize", "build", "verify", "publish"];
  if (!valid.includes(command ?? "")) {
    throw new Error(`usage: transit-prep <${valid.join("|")}> [--plan|--dry-run|--execute|--only subway|bus|--update-baseline]`);
  }
  let result: unknown;
  if (command === "acquire" && flag === "--plan") {
    process.stdout.write(`${JSON.stringify(await acquirePlan(), null, 2)}\n`);
    return;
  }
  if (command === "acquire" && flag === "--execute") {
    let previous: Map<string, { sha256: string; lastModified: string }> | undefined;
    try {
      const receipts = await readReceipts();
      previous = new Map(
        receipts.receipts.map((receipt) => [receipt.id, { sha256: receipt.sha256, lastModified: receipt.lastModified }]),
      );
    } catch {
      previous = undefined;
    }
    result = await acquireExecute(previous);
    await writeFetchLog(result as Parameters<typeof writeFetchLog>[0]);
  } else if (command === "receipts") {
    result = await assembleReceipts();
  } else if (command === "validate") {
    result = await validate();
  } else if (command === "normalize") {
    const only = process.argv.includes("--only")
      ? (process.argv[process.argv.indexOf("--only") + 1] as "subway" | "bus")
      : undefined;
    if (only && only !== "subway" && only !== "bus") throw new Error("--only requires subway|bus");
    if (flag === "--plan") {
      result = { plan: "loads all feeds, no writes", only: only ?? "subway+bus" };
    } else {
      const { subway, bus, stubs } = await normalizeAll({ only, updateBaseline: process.argv.includes("--update-baseline") });
      result = {
        subway: subway
          ? { stops: subway.stops.length, edges: subway.edges.length, headways: subway.headways.length }
          : null,
        bus: bus
          ? { stops: bus.stops.length, edges: bus.edges.length, headways: bus.headways.length }
          : null,
        stubs: stubs.length,
      };
    }
  } else if (command === "build") {
    const only = process.argv.includes("--only")
      ? (process.argv[process.argv.indexOf("--only") + 1] as "subway" | "bus")
      : undefined;
    if (only && only !== "subway" && only !== "bus") throw new Error("--only requires subway|bus");
    result = await buildGeneration({ only, updateBaseline: process.argv.includes("--update-baseline") });
  } else if (command === "verify") {
    result = await verifyGeneration(typeof flag === "string" && !flag.startsWith("--") ? flag : undefined);
  } else if (command === "publish") {
    const checked = await verifyGeneration(undefined);
    if (flag === "--execute") {
      result = await publishExecute(checked.generation);
    } else {
      result = await publishPlan(checked.generation);
    }
  } else {
    throw new Error(`usage: transit-prep <acquire --plan|--execute|receipts|validate|normalize|build|verify|publish>`);
  }
  await evidence(command as string, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});

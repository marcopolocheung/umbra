import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireRoot } from "./util";

/** Every mutating command retains a timestamped evidence record under the root. */
export async function writeEvidence(command: string, result: unknown): Promise<string> {
  const root = requireRoot();
  const directory = join(root, "evidence");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${command}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(
    path,
    `${JSON.stringify(
      { command, at: new Date().toISOString(), node: process.version, result },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return path;
}

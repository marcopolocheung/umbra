import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { candidateDescriptorKey, type CandidateDescriptor } from "./candidates";
import { benchmarkCandidatePack } from "./pack";
import { FilesystemStore, S3Store } from "./storage";

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  const result = index < 0 ? undefined : process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} is required`);
  return result;
}

async function main(): Promise<void> {
  const normalizationId = value("--normalization-id");
  const tiles = value("--tiles").split(",").map((tile) => tile.trim()).filter(Boolean);
  if (!/^[a-f0-9]{32}$/.test(normalizationId) || !tiles.length || tiles.some((tile) => !/^18\/\d+\/\d+$/.test(tile)))
    throw new Error("use a 32-character normalization id and one or more comma-separated z18 tiles");
  const bucket = process.env.SHADE_PREP_S3_BUCKET;
  if (!bucket) throw new Error("SHADE_PREP_S3_BUCKET must name the candidate bucket");
  const source = new S3Store(bucket, process.env.SHADE_PREP_S3_PREFIX ?? "");
  const outputArgument = process.argv.indexOf("--write-dir");
  const output = outputArgument < 0 ? undefined : new FilesystemStore(resolve(value("--write-dir")));
  const concurrencyArgument = process.argv.indexOf("--concurrency");
  const concurrency = concurrencyArgument < 0 ? 1 : Number(value("--concurrency"));
  const descriptors = await Promise.all(tiles.sort().map(async (tile) => {
    const key = candidateDescriptorKey(normalizationId, tile);
    const metadata = await source.head(key);
    if (!metadata) throw new Error(`candidate descriptor does not exist: ${tile}`);
    const descriptor = JSON.parse(new TextDecoder().decode(await source.read(key))) as CandidateDescriptor;
    if (descriptor.normalizationId !== normalizationId || descriptor.tile !== tile)
      throw new Error(`candidate descriptor identity mismatch: ${tile}`);
    return descriptor;
  }));
  const result = await benchmarkCandidatePack(source, descriptors, output, concurrency);
  const report = JSON.stringify(result, null, 2);
  if (process.argv.includes("--report")) await writeFile(resolve(value("--report")), `${report}\n`);
  process.stdout.write(`${report}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});

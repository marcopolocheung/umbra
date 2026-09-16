import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { candidateDescriptorKey, type CandidateDescriptor } from "./candidates";
import { benchmarkCandidatePack, browserPackIdentity, browserPackIdentityV2, reconcileBrowserPack, type PackedBrowserTile, type RepairContext } from "./pack";
import { repairPolicyHash, REPAIR_POLICY_VERSION } from "./repair";
import { loadAdmittedLicenceInput } from "./notices";
import { FilesystemStore, r2StoreFromEnvironment, S3Store } from "./storage";
import { supportGeometry } from "./support";
import { sha256 } from "./util";

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  const result = index < 0 ? undefined : process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} is required`);
  return result;
}

function optionalValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} needs a value`);
  return result;
}

async function main(): Promise<void> {
  const normalizationId = value("--normalization-id");
  const tiles = value("--tiles").split(",").map((tile) => tile.trim()).filter(Boolean);
  if (!/^[a-f0-9]{32}$/.test(normalizationId) || !tiles.length || tiles.some((tile) => !/^18\/\d+\/\d+$/.test(tile)))
    throw new Error("use a 32-character normalization id and one or more comma-separated z18 tiles");
  const recipe = optionalValue("--recipe") === "2" ? 2 : 1;
  const bucket = process.env.SHADE_PREP_S3_BUCKET;
  if (!bucket) throw new Error("SHADE_PREP_S3_BUCKET must name the candidate bucket");
  const source = new S3Store(bucket, process.env.SHADE_PREP_S3_PREFIX ?? "");
  const outputArgument = process.argv.indexOf("--write-dir");
  const output = outputArgument < 0 ? undefined : new FilesystemStore(resolve(value("--write-dir")));
  const writeR2 = process.argv.includes("--write-r2");
  if (writeR2 && output) throw new Error("choose either --write-dir or --write-r2");
  const concurrencyArgument = process.argv.indexOf("--concurrency");
  const concurrency = concurrencyArgument < 0 ? 1 : Number(value("--concurrency"));
  const descriptors: CandidateDescriptor[] = [];
  const descriptorHashes = new Map<string, string>();
  for (const tile of tiles.sort()) {
    const key = candidateDescriptorKey(normalizationId, tile);
    const metadata = await source.head(key);
    if (!metadata) throw new Error(`candidate descriptor does not exist: ${tile}`);
    const bytes = await source.read(key);
    descriptorHashes.set(tile, sha256(bytes));
    const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as CandidateDescriptor;
    if (descriptor.normalizationId !== normalizationId || descriptor.tile !== tile)
      throw new Error(`candidate descriptor identity mismatch: ${tile}`);
    descriptors.push(descriptor);
  }
  let repairFor: ((descriptor: CandidateDescriptor) => RepairContext) | undefined;
  let generationSuffix = "";
  if (recipe === 2) {
    const geometryPath = value("--support-geometry");
    const geometryHash = value("--support-sha256");
    const geometryBytes = new Uint8Array(await readFile(resolve(geometryPath)));
    if (sha256(geometryBytes) !== geometryHash) throw new Error("support geometry hash mismatch");
    const geometry = supportGeometry(JSON.parse(new TextDecoder().decode(geometryBytes)));
    // Smoke tiles are a strict subset, so the full index-equality proof cannot
    // run here; the hash pin plus the shard-time proof carry authentication.
    const admissionManifest = value("--admission-manifest");
    const regionInput = await loadAdmittedLicenceInput(admissionManifest, optionalValue("--region-file"));
    repairFor = (descriptor) => {
      const descriptorHash = descriptorHashes.get(descriptor.tile);
      if (!descriptorHash) throw new Error(`missing descriptor hash for ${descriptor.tile}`);
      return { geometry, geometryHash, descriptorHash, regionInput };
    };
    generationSuffix = optionalValue("--generation-suffix") ?? "repair-smoke-v2";
  }
  const r2 = writeR2 ? r2StoreFromEnvironment() : undefined;
  const destination = output ?? r2;
  const entries: PackedBrowserTile[] = [];
  const identity = recipe === 2 ? browserPackIdentityV2(normalizationId, generationSuffix) : browserPackIdentity(normalizationId);
  const result = await benchmarkCandidatePack(source, descriptors, destination, concurrency, (entry) => entries.push(entry), identity, recipe === 2 ? { recipe: 2, repairFor } : {});
  // Manifest reconciliation stays v1-only: a v2 smoke verifies per-tile
  // decode/compose readback inside the pack step and writes no manifest.
  const reconciliation = r2 && recipe === 1
    ? await reconcileBrowserPack(r2, entries, browserPackIdentity(normalizationId))
    : undefined;
  const repairProvenance = recipe === 2
    ? { policy: REPAIR_POLICY_VERSION, policyHash: repairPolicyHash() }
    : undefined;
  const report = JSON.stringify({ ...result, reconciliation, repairProvenance }, null, 2);
  if (process.argv.includes("--report")) await writeFile(resolve(value("--report")), `${report}\n`);
  process.stdout.write(`${report}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});

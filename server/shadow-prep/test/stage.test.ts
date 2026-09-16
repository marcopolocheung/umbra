import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Region } from "../src/admission";
import { stageAdmittedInputs } from "../src/stage";
import { FilesystemStore, type ObjectStore } from "../src/storage";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("raw staging copies only receipt-listed objects, verifies hashes, and configures pinned PROJ data", async () => {
  const source = await mkdtemp(join(tmpdir(), "stage-source-")); const target = await mkdtemp(join(tmpdir(), "stage-target-"));
  try {
    const boundary = "boundary", asset = "immutable-asset", firstGrid = "grid-one", secondGrid = "grid-two";
    const region = { id: "test", boundary: { url: "https://example.invalid/boundary", localName: "boundary.geojson", sha256: hash(boundary), release: "test", requiredBoroughs: [], licence: "test" }, support: { initialBufferMetres: 1, exteriorPolicy: "test" }, datum: { horizontal: "EPSG:4326", inputVertical: "EGM2008", outputVertical: "EGM96", operation: "test", grids: ["one.tif", "two.tif"] }, sources: [], workloads: { requiredCategories: [], graphCapture: "test" } } satisfies Region;
    const receipt = [{ id: "workload-open", assets: [{ filename: "snapshot.json", sha256: hash(asset) }] }];
    await mkdir(join(source, "raw"), { recursive: true }); await mkdir(join(source, "proj"), { recursive: true }); await mkdir(join(source, "acquisition"), { recursive: true });
    await writeFile(join(source, "raw", "source-receipts.json"), JSON.stringify(receipt)); await writeFile(join(source, "raw", "boundary.geojson"), boundary); await writeFile(join(source, "raw", "snapshot.json"), asset); await writeFile(join(source, "proj", "one.tif"), firstGrid); await writeFile(join(source, "proj", "two.tif"), secondGrid); await writeFile(join(source, "acquisition", "nyc-five-borough-20km-support.geojson"), "support"); await writeFile(join(source, "acquisition", "nyc-acquisition-manifest.json"), "manifest");
    const result = await stageAdmittedInputs(new FilesystemStore(source), { root: target, region, gridHashes: { "one.tif": hash(firstGrid), "two.tif": hash(secondGrid) }, maxScratchBytes: 1024 * 1024 });
    assert.equal(result.staged, 6); assert.equal(await readFile(join(target, "raw", "snapshot.json"), "utf8"), asset); assert.equal(await readFile(join(target, "proj", "one.tif"), "utf8"), firstGrid); assert.equal(process.env.PROJ_DATA, `${join(target, "proj")}:/usr/share/proj`);
    const repeat = await stageAdmittedInputs(new FilesystemStore(source), { root: target, region, gridHashes: { "one.tif": hash(firstGrid), "two.tif": hash(secondGrid) }, maxScratchBytes: 1024 * 1024 }); assert.ok(repeat.reused >= 4);
  } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test("raw staging fails before download when the bounded scratch allowance is too small", async () => {
  const source = await mkdtemp(join(tmpdir(), "stage-source-")); const target = await mkdtemp(join(tmpdir(), "stage-target-"));
  try {
    await mkdir(join(source, "raw"), { recursive: true }); await writeFile(join(source, "raw", "source-receipts.json"), "[]");
    await assert.rejects(stageAdmittedInputs(new FilesystemStore(source), { root: target, maxScratchBytes: 1 }), /exceeding SHADE_PREP_SCRATCH_MAX_BYTES/);
  } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test("raw staging rejects expected objects without S3 sha256 metadata", async () => {
  const source = await mkdtemp(join(tmpdir(), "stage-source-")); const target = await mkdtemp(join(tmpdir(), "stage-target-"));
  try {
    const backing = new FilesystemStore(source); const missingMetadata: ObjectStore = { kind: "s3", read: backing.read.bind(backing), write: backing.write.bind(backing), writeConditional: backing.writeConditional.bind(backing), copyToFile: backing.copyToFile.bind(backing), async head(key) { const value = await backing.head(key); return value && { bytes: value.bytes }; } };
    await mkdir(join(source, "raw"), { recursive: true }); await writeFile(join(source, "raw", "source-receipts.json"), "[]"); await writeFile(join(source, "raw", "nyc-borough-boundaries-26b.geojson"), "not accepted without metadata");
    await assert.rejects(stageAdmittedInputs(missingMetadata, { root: target, maxScratchBytes: 1024 * 1024 }), /sha256 metadata is missing/);
  } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

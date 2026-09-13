import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRegion, validateBoundary, validateDatumOutput, validateReceipts, validateRecordedRawFiles, type Receipt } from "../src/admission";
import { NGA_GRID_SHA256, validateDatumOperation } from "../src/datum";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ids: Receipt["id"][] = ["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls", "workload-dense-tall", "workload-open", "workload-canopy-heavy", "workload-waterfront-boundary", "workload-long-low-sun"];

test("DCP 26b known hash is pinned and hash mismatch is rejected", async () => {
  const region = await loadRegion();
  assert.equal(region.boundary.sha256, "3c7cd4002cb34b8b818af903338c0292d5a1b1ca61bc7a5d365bad66220d050a");
  const directory = await mkdtemp(join(tmpdir(), "shadow-boundary-")); const file = join(directory, "boundary.json");
  const body = JSON.stringify({ features: ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"].map((boroname) => ({ properties: { boroname } })) }); await writeFile(file, body);
  const localBoundary = { ...region.boundary, sha256: digest(body) };
  await assert.doesNotReject(validateBoundary(file, localBoundary));
  await assert.rejects(validateBoundary(file, { ...localBoundary, sha256: "0".repeat(64) }), /hash mismatch/);
});

test("the documented NGA grids and an NYC non-ballpark operation are required", async () => {
  const region = await loadRegion();
  assert.deepEqual(region.datum.grids, ["us_nga_egm08_25.tif", "us_nga_egm96_15.tif"]);
  assert.equal(NGA_GRID_SHA256["us_nga_egm08_25.tif"], "4191d471eefebf24091b56dbc604353cb3b8cf8cc70e448bb9ae56a272bef17a");
  assert.equal(NGA_GRID_SHA256["us_nga_egm96_15.tif"], "db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d");
  assert.equal(validateDatumOutput("pipeline uses us_nga_egm08_25.tif then us_nga_egm96_15.tif for NYC"), undefined);
  assert.match(validateDatumOutput("Ballpark geographic offset") ?? "", /ballpark/);
  assert.match(validateDatumOutput("us_nga_egm08_25.tif us_nga_egm96_15.tif outside area") ?? "", /out of the NYC area/);
});

test("receipt admission rejects missing, extra, unknown, invalid-rights and hash-mismatched production inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-receipts-"));
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const filename = `${id}.bin`; const contents = `pinned:${id}`; await writeFile(join(directory, filename), contents);
    const role = id === "fabdem-v1.2" ? "terrain" : id === "overture-buildings" ? "buildings" : id === "overture-building-parts" ? "building-parts" : id === "chmv2-height" ? "canopy-height" : id === "chmv2-validity-mask" ? "canopy-mask" : id === "osm-tree-fallback" ? "canopy-fallback" : id === "usgs-3dep-controls" ? "control" : "workload";
    const base = { id, assetId: `${id}-asset`, filename, sha256: digest(contents), url: `https://example.invalid/${id}`, release: "snapshot-1", horizontalCrs: "EPSG:4326", verticalDatum: "AGL", licence: "test", rights: "https://example.invalid/rights", supportExtent: "NYC five boroughs plus declared 20 km support", acquiredAt: "2026-09-12T00:00:00Z", role } as Receipt;
    if (id === "usgs-3dep-controls") {
      const outputFilename = "usgs-3dep-controls-output.json"; const output = "retained transform output"; const operation = "EGM2008 -> EGM96 via us_nga_egm08_25.tif and us_nga_egm96_15.tif";
      await writeFile(join(directory, outputFilename), output);
      base.datumControlEvidence = { outputFilename, outputSha256: digest(output), operation, operationHash: digest(operation), thresholdStatus: "unadmitted" };
    }
    if (id === "chmv2-height") { base.validZero = true; base.nodata = "-9999"; }
    if (id === "chmv2-validity-mask") { base.validZero = false; base.nodata = "0"; }
    receipts.push(base);
  }
  assert.deepEqual((await validateReceipts(directory, receipts)).blockers, ["datum-control residual threshold is unadmitted; retained controls cannot admit the region"]);
  assert.match((await validateReceipts(directory, receipts.slice(1))).blockers.join("\n"), /missing required source receipt fabdem/);
  assert.match((await validateReceipts(directory, [...receipts, { ...receipts[0], id: "bad" }])).blockers.join("\n"), /unknown source receipt/);
  assert.match((await validateReceipts(directory, [{ ...receipts[0], sha256: "0".repeat(64) }, ...receipts.slice(1)])).blockers.join("\n"), /hash mismatch/);
  assert.match((await validateReceipts(directory, [...receipts, receipts[0]])).blockers.join("\n"), /exactly 12 receipts|duplicate source receipt/);
  assert.match((await validateReceipts(directory, [{ ...receipts[0], rights: "unlicensed" }, ...receipts.slice(1)])).blockers.join("\n"), /incomplete pinned receipt fabdem/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "usgs-3dep-controls" ? { ...receipt, datumControlEvidence: undefined } : receipt))).blockers.join("\n"), /independent datum-control evidence is missing/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "usgs-3dep-controls" ? { ...receipt, datumControlEvidence: { ...receipt.datumControlEvidence!, outputFilename: receipt.filename } } : receipt))).blockers.join("\n"), /transformation output must be a distinct/);
});

test("admission helpers fail closed on absent grids, non-array receipts, and unrecorded raw files", async () => {
  assert.match((await validateDatumOperation([])).error ?? "", /required EGM grids are absent/);
  const directory = await mkdtemp(join(tmpdir(), "shadow-unrecorded-"));
  const recorded = join(directory, "recorded.bin"); const extra = join(directory, "unexpected.bin");
  await writeFile(recorded, "recorded"); await writeFile(extra, "unexpected");
  assert.match((await validateReceipts(directory, { receipts: [] })).blockers.join("\n"), /not an array/);
  assert.deepEqual(await validateRecordedRawFiles(directory, [recorded]), [`unrecorded production input ${extra}`]);
});

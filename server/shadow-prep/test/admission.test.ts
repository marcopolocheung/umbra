import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRegion, validateBoundary, validateDatumOutput, validateReceipts, validateRecordedRawFiles, type PolygonalCoverage, type Receipt, type ReceiptId } from "../src/admission";
import { NGA_GRID_SHA256, validateDatumOperation } from "../src/datum";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ids: ReceiptId[] = ["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls", "workload-dense-tall", "workload-open", "workload-canopy-heavy", "workload-waterfront-boundary", "workload-long-low-sun"];
const coverage: PolygonalCoverage = { type: "Polygon", coordinates: [[[-74.5, 40.3], [-73.4, 40.3], [-73.4, 41.1], [-74.5, 41.1], [-74.5, 40.3]]] };
const operation = "EGM2008 -> EGM96 via us_nga_egm08_25.tif and us_nga_egm96_15.tif";

function role(id: ReceiptId): Receipt["role"] {
  return id === "fabdem-v1.2" ? "terrain" : id === "overture-buildings" ? "buildings" : id === "overture-building-parts" ? "building-parts" : id === "chmv2-height" ? "canopy-height" : id === "chmv2-validity-mask" ? "canopy-mask" : id === "osm-tree-fallback" ? "canopy-fallback" : id === "usgs-3dep-controls" ? "control" : "workload";
}
function normalization(id: ReceiptId): Receipt["normalization"] {
  if (id === "fabdem-v1.2") return { kind: "terrain", datumOperation: operation, datumOperationHash: digest(operation) };
  if (id === "overture-buildings" || id === "overture-building-parts") return { kind: id === "overture-buildings" ? "buildings" : "building-parts", selection: "release=2026-01-01; stable-id ascending", priority: "overture-then-osm", missingHeight: "reject", raisedStructure: "retain-conflict" };
  if (id === "chmv2-height" || id === "chmv2-validity-mask") return { kind: id, heightFormat: "GeoTIFF Float32 metres AGL", maskFormat: "GeoTIFF uint8 validity mask", validZero: true, nodata: "-9999", maskHole: "unavailable", osmFallback: "only-on-unavailable" };
  if (id === "osm-tree-fallback") return { kind: "osm-tree-fallback", policy: "only-when-chmv2-unavailable" };
  return undefined;
}

async function fixtureReceipts(thresholdStatus: "unadmitted" | "approved" = "unadmitted"): Promise<{ directory: string; receipts: Receipt[] }> {
  const directory = await mkdtemp(join(tmpdir(), "shadow-receipts-"));
  const evidence = join(directory, "..", "evidence"); await mkdir(evidence, { recursive: true });
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const filename = `${id}.raw`; const contents = `pinned:${id}`; await writeFile(join(directory, filename), contents);
    const asset = { filename, publisherUrl: `https://example.invalid/${id}/snapshot-1`, release: "snapshot-1", sha256: digest(contents), format: "GeoJSON", acquiredAt: "2026-09-12T00:00:00Z", horizontalCrs: "EPSG:4326", verticalDatum: id === "fabdem-v1.2" ? "EGM2008" : "AGL", supportCoverage: coverage };
    receipts.push({ id, licence: "test", rights: "https://example.invalid/rights", role: role(id), assets: [asset], normalization: normalization(id) });
  }
  const outputFilename = "3dep-controls-transformed.ndjson"; const output = "retained transformed controls";
  const reportFilename = "3dep-controls-residuals.json"; const report = "retained per-control residual report";
  await writeFile(join(evidence, outputFilename), output); await writeFile(join(evidence, reportFilename), report);
  const controls = receipts.find((receipt) => receipt.id === "usgs-3dep-controls")!;
  controls.datumControlEvidence = { outputFilename, outputSha256: digest(output), reportFilename, reportSha256: digest(report), operation, operationHash: digest(operation), metric: "absolute vertical residual", units: "metres", evaluatedPopulation: 5, methodVersionHash: digest("control-method-v1"), observedWorstResidual: 0.25, thresholdStatus, ...(thresholdStatus === "approved" ? { signedDecisionId: "DECISION-2026-09-13", maximumResidual: 0.3 } : {}) };
  return { directory, receipts };
}

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

test("receipts support multiple immutable raw assets and reject corrupt, incomplete, or unrecorded raw inputs", async () => {
  const { directory, receipts } = await fixtureReceipts();
  const terrain = receipts[0]; const extraName = "fabdem-v1.2-second.raw"; const extraBody = "second pinned terrain partition";
  await writeFile(join(directory, extraName), extraBody);
  terrain.assets.push({ ...terrain.assets[0], filename: extraName, sha256: digest(extraBody), publisherUrl: "https://example.invalid/fabdem/partition-2" });
  assert.deepEqual((await validateReceipts(directory, receipts)).blockers, ["datum-control residual threshold is unadmitted; retained controls cannot admit the region"]);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "fabdem-v1.2" ? { ...receipt, assets: receipt.assets.map((asset) => ({ ...asset, sha256: "0".repeat(64) })) } : receipt))).blockers.join("\n"), /hash mismatch/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "fabdem-v1.2" ? { ...receipt, assets: receipt.assets.map(({ supportCoverage, ...asset }) => asset) } : receipt))).blockers.join("\n"), /incomplete immutable raw asset/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "fabdem-v1.2" ? { ...receipt, assets: receipt.assets.map(({ format, ...asset }) => asset) } : receipt))).blockers.join("\n"), /incomplete immutable raw asset/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "fabdem-v1.2" ? { ...receipt, assets: receipt.assets.map((asset) => ({ ...asset, filename: "regional-mosaic.tif", format: "GeoTIFF mosaic" })) } : receipt))).blockers.join("\n"), /regional mosaic/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt.id === "fabdem-v1.2" ? { ...receipt, normalization: undefined } : receipt))).blockers.join("\n"), /normalization metadata/);
  await writeFile(join(directory, "unrecorded.raw"), "not in a receipt");
  const allowed = (await validateReceipts(directory, receipts)).recordedPaths;
  assert.match((await validateRecordedRawFiles(directory, allowed)).join("\n"), /unrecorded production input/);
});

test("CHMv2 policy preserves valid zero and refuses nodata or mask-hole without its declared fallback policy", async () => {
  const { directory, receipts } = await fixtureReceipts();
  const height = receipts.find((receipt) => receipt.id === "chmv2-height")!;
  const mask = receipts.find((receipt) => receipt.id === "chmv2-validity-mask")!;
  assert.equal((await validateReceipts(directory, receipts)).blockers[0], "datum-control residual threshold is unadmitted; retained controls cannot admit the region");
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt === height ? { ...receipt, normalization: { ...height.normalization!, validZero: false } } : receipt))).blockers.join("\n"), /normalization metadata/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt === mask ? { ...receipt, normalization: { ...mask.normalization!, nodata: "" } } : receipt))).blockers.join("\n"), /normalization metadata/);
  assert.match((await validateReceipts(directory, receipts.map((receipt) => receipt === mask ? { ...receipt, normalization: { ...mask.normalization!, maskHole: "valid" } } : receipt))).blockers.join("\n"), /normalization metadata/);
});

test("datum-control evidence fails closed until a signed in-threshold approval exists", async () => {
  const unadmitted = await fixtureReceipts();
  assert.deepEqual((await validateReceipts(unadmitted.directory, unadmitted.receipts)).blockers, ["datum-control residual threshold is unadmitted; retained controls cannot admit the region"]);
  const approved = await fixtureReceipts("approved");
  assert.deepEqual((await validateReceipts(approved.directory, approved.receipts)).blockers, []);
  const controls = approved.receipts.find((receipt) => receipt.id === "usgs-3dep-controls")!;
  const unsigned = approved.receipts.map((receipt) => receipt === controls ? { ...receipt, datumControlEvidence: { ...controls.datumControlEvidence!, signedDecisionId: undefined } } : receipt);
  assert.match((await validateReceipts(approved.directory, unsigned)).blockers.join("\n"), /unsigned or incomplete/);
  const overLimit = approved.receipts.map((receipt) => receipt === controls ? { ...receipt, datumControlEvidence: { ...controls.datumControlEvidence!, maximumResidual: 0.2 } } : receipt);
  assert.match((await validateReceipts(approved.directory, overLimit)).blockers.join("\n"), /exceeds the approved maximum/);
  const malformed = approved.receipts.map((receipt) => receipt === controls ? { ...receipt, datumControlEvidence: { ...controls.datumControlEvidence!, reportSha256: "bad" } } : receipt);
  assert.match((await validateReceipts(approved.directory, malformed)).blockers.join("\n"), /incomplete datum-control/);
});

test("admission helpers fail closed on absent grids, non-array receipts, and unrecorded raw files", async () => {
  assert.match((await validateDatumOperation([])).error ?? "", /required EGM grids are absent/);
  const directory = await mkdtemp(join(tmpdir(), "shadow-unrecorded-"));
  const recorded = join(directory, "recorded.bin"); const extra = join(directory, "unexpected.bin");
  await writeFile(recorded, "recorded"); await writeFile(extra, "unexpected");
  assert.match((await validateReceipts(directory, { receipts: [] })).blockers.join("\n"), /not an array/);
  assert.deepEqual(await validateRecordedRawFiles(directory, [recorded]), [`unrecorded production input ${extra}`]);
});

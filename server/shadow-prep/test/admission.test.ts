import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRegion, validateBoundary, validateDatumOutput, validateReceipts, type Receipt } from "../src/admission";

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

test("the documented NGA grids and a non-ballpark operation are required", async () => {
  const region = await loadRegion();
  assert.deepEqual(region.datum.grids, ["us_nga_egm08_25.tif", "us_nga_egm96_15.tif"]);
  assert.equal(validateDatumOutput("pipeline uses us_nga_egm08_25.tif then us_nga_egm96_15.tif"), undefined);
  assert.match(validateDatumOutput("Ballpark geographic offset") ?? "", /ballpark/);
});

test("receipt admission rejects missing, unknown and hash-mismatched production inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-receipts-"));
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const filename = `${id}.bin`; const contents = `pinned:${id}`; await writeFile(join(directory, filename), contents);
    receipts.push({ id, assetId: `${id}-asset`, filename, sha256: digest(contents), url: `https://example.invalid/${id}`, release: "snapshot-1", horizontalCrs: "EPSG:4326", verticalDatum: "AGL", licence: "test", acquiredAt: "2026-09-12T00:00:00Z", role: id === "fabdem-v1.2" ? "terrain" : id === "overture-buildings" ? "buildings" : id === "overture-building-parts" ? "building-parts" : id === "chmv2-height" ? "canopy-height" : id === "chmv2-validity-mask" ? "canopy-mask" : id === "osm-tree-fallback" ? "canopy-fallback" : id === "usgs-3dep-controls" ? "control" : "workload", ...(id === "chmv2-height" ? { validZero: true, nodata: "-9999" } : {}) });
  }
  assert.deepEqual((await validateReceipts(directory, receipts)).blockers, []);
  assert.match((await validateReceipts(directory, receipts.slice(1))).blockers.join("\n"), /missing required source receipt fabdem/);
  assert.match((await validateReceipts(directory, [...receipts, { ...receipts[0], id: "bad" }])).blockers.join("\n"), /unknown source receipt/);
  assert.match((await validateReceipts(directory, [{ ...receipts[0], sha256: "0".repeat(64) }, ...receipts.slice(1)])).blockers.join("\n"), /hash mismatch/);
});

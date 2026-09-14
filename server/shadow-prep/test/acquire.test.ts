import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadImmutable, selectChmTiles } from "../src/acquire";
import type { PolygonalCoverage } from "../src/admission";
import { canonicalSupportFeature } from "../src/support";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const box = (west: number, south: number, east: number, north: number): PolygonalCoverage => ({ type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });

test("immutable download retries an interrupted transfer, verifies expected hashes, and reuses a valid object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-acquire-")); const target = join(directory, "raw", "object.bin");
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) throw new Error("interrupted"); return new Response("pinned bytes", { headers: { etag: "etag" } }); };
  await assert.rejects(downloadImmutable("https://example.invalid/object", target, { expectedHash: digest("pinned bytes") }), /interrupted/);
  assert.equal(await import("node:fs/promises").then(({ access }) => access(target).then(() => true, () => false)), false);
  const first = await downloadImmutable("https://example.invalid/object", target, { expectedHash: digest("pinned bytes") });
  assert.equal(first.reused, false); assert.equal(await readFile(target, "utf8"), "pinned bytes");
  const second = await downloadImmutable("https://example.invalid/object", target, { expectedHash: digest("pinned bytes") });
  assert.equal(second.reused, true); assert.equal(calls, 2);
  globalThis.fetch = original;
  await assert.rejects(downloadImmutable("https://example.invalid/object", target, { expectedHash: "0".repeat(64) }), /existing object has no matching immutable hash/);
});

test("support serialization is deterministic and the CHMv2 selector requires exactly fourteen intersecting COGs", () => {
  const support = box(0, 0, 10, 10); const reversed = { type: "Polygon", coordinates: [[[10, 10], [10, 0], [0, 0], [0, 10], [10, 10]]] } as PolygonalCoverage;
  assert.equal(JSON.stringify(canonicalSupportFeature(support)), JSON.stringify(canonicalSupportFeature(reversed)));
  const features = Array.from({ length: 14 }, (_, index) => ({ type: "Feature", properties: { tile: `tile-${index}`, href: `https://example.invalid/${index}.tif` }, geometry: box(index % 7, Math.floor(index / 7), index % 7 + 0.5, Math.floor(index / 7) + 0.5) }));
  assert.equal(selectChmTiles({ type: "FeatureCollection", features }, support).length, 14);
  assert.throws(() => selectChmTiles({ type: "FeatureCollection", features: features.slice(1) }, support), /exactly 14/);
});

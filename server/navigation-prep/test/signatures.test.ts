import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseNavigationManifest } from "../../../app/lib/navigationData/shardContract";
import { SHADE_BYTES_PER_SEGMENT, SHADE_SLOT_COUNT } from "../../../app/lib/navigationData/shadeSlots";
import { build } from "../src/build";
import { canonicalJson, sha256Hex } from "../src/canonical";
import { publishPlan } from "../src/publish";
import { writeShadeCell, type ShadeCellInput } from "../src/shade";
import {
  SIGNATURE_BYTES_PER_SIDE,
  SIGNATURE_COMPONENTS,
  loadSignatureModel,
  modelPath,
  projectSignatures,
  signaturesExecute,
} from "../src/signatures";
import { verifyGeneration } from "../src/verify";

/**
 * The signature stage against the frozen model: the TS projection reproduces
 * the Python reference that fitted it, the payload is 17 bytes per side in the
 * shade columns' order, and a generation carrying signatures rebuilds to the
 * same bytes and id, verifies, and plans every object for publication.
 */

interface ParityFixture {
  segments: number;
  payloadBase64: string;
  expected: { z: number[][]; q: number[][]; types: number[] };
}

async function parityFixture(): Promise<ParityFixture> {
  return JSON.parse(
    await readFile(join(import.meta.dirname, "fixtures", "signatures-parity.json"), "utf8"),
  ) as ParityFixture;
}

const int8 = (byte: number) => (byte > 127 ? byte - 256 : byte);

test("TS projection equals the Python reference on real Midtown sides", async () => {
  const { model } = await loadSignatureModel();
  const fixture = await parityFixture();
  const shade = new Uint8Array(Buffer.from(fixture.payloadBase64, "base64"));
  const out = projectSignatures(model, shade, fixture.segments);
  const sides = fixture.segments * 2;
  assert.equal(fixture.expected.types.length, sides);
  // Every one of the K types is exercised, so a centroid mix-up cannot pass.
  assert.equal(new Set(fixture.expected.types).size, model.centers.length);
  for (let side = 0; side < sides; side++) {
    const row = out.subarray(side * SIGNATURE_BYTES_PER_SIDE, (side + 1) * SIGNATURE_BYTES_PER_SIDE);
    assert.equal(row[SIGNATURE_COMPONENTS], fixture.expected.types[side], `type of side ${side}`);
    for (let c = 0; c < SIGNATURE_COMPONENTS; c++) {
      // Within one quantization step of the float reference, and almost
      // always the same int8 code.
      const decoded = int8(row[c]) * model.scales[c];
      assert.ok(
        Math.abs(decoded - fixture.expected.z[side][c]) <= model.scales[c] / 2 + 1e-9,
        `side ${side} component ${c}: ${decoded} vs ${fixture.expected.z[side][c]}`,
      );
      assert.equal(int8(row[c]), fixture.expected.q[side][c], `code of side ${side}/${c}`);
    }
  }
});

test("payload is segments × 2 × 17 bytes, rows following the shade columns", async () => {
  const { model } = await loadSignatureModel();
  const fixture = await parityFixture();
  const shade = new Uint8Array(Buffer.from(fixture.payloadBase64, "base64"));
  const out = projectSignatures(model, shade, fixture.segments);
  assert.equal(out.byteLength, fixture.segments * SHADE_BYTES_PER_SEGMENT * SIGNATURE_BYTES_PER_SIDE);

  // Swap two segment columns in the slot-major shade payload: their signature
  // rows swap with them, and nothing else moves.
  const stride = fixture.segments * 2;
  const swapped = shade.slice();
  for (let slot = 0; slot < SHADE_SLOT_COUNT; slot++) {
    for (let side = 0; side < 2; side++) {
      const a = slot * stride + side;
      const b = slot * stride + 2 + side;
      [swapped[a], swapped[b]] = [shade[b], shade[a]];
    }
  }
  const moved = projectSignatures(model, swapped, fixture.segments);
  const segmentRow = (bytes: Uint8Array, segment: number) =>
    Buffer.from(bytes.subarray(segment * 2 * SIGNATURE_BYTES_PER_SIDE, (segment + 1) * 2 * SIGNATURE_BYTES_PER_SIDE));
  assert.deepEqual(segmentRow(moved, 0), segmentRow(out, 1));
  assert.deepEqual(segmentRow(moved, 1), segmentRow(out, 0));
  for (let segment = 2; segment < fixture.segments; segment++)
    assert.deepEqual(segmentRow(moved, segment), segmentRow(out, segment));

  assert.throws(() => projectSignatures(model, shade.subarray(1), fixture.segments), /shade payload/);
});

// ─── End to end through build → verify → publish plan ───────────────────────

const RECEIPTS = {
  version: 1,
  acquiredAt: "2026-09-18T00:00:00Z",
  receipts: [
    {
      id: "osm-new-york",
      release: "synthetic snapshot",
      url: "https://example.invalid/new-york.pbf",
      bytes: 100,
      timestamp: "2026-09-18T00:00:00Z",
      sha256: "a".repeat(64),
    },
    {
      id: "nyc-building-footprints",
      release: "synthetic pages",
      url: "https://example.invalid/buildings/query",
      bytes: 100,
      timestamp: "2026-09-18T00:00:00Z",
      sha256: "b".repeat(64),
    },
  ],
};

const NODES = [
  { id: 1001, lat: 40.755, lon: -73.9885, isIntersection: true },
  { id: 1002, lat: 40.7555, lon: -73.987, isIntersection: true },
];

async function setupRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nav-prep-signatures-"));
  await mkdir(join(root, "raw"), { recursive: true });
  await mkdir(join(root, "work", "shade", "inputs"), { recursive: true });
  await writeFile(join(root, "raw", "source-receipts.json"), `${JSON.stringify(RECEIPTS)}\n`);
  await writeFile(
    join(root, "work", "streets.json"),
    `${canonicalJson({
      streets: {
        nodes: NODES,
        edges: [
          { id: "w1s0f", from: 1001, to: 1002, distanceM: 142, tags: { highway: "residential" } },
          { id: "w1s0r", from: 1002, to: 1001, distanceM: 142, tags: { highway: "residential" } },
        ],
      },
      recipe: "nyc-navigation/recipe-v1",
      osmSnapshotTimestamp: 1_758_000_000,
    })}\n`,
  );
  await writeFile(
    join(root, "work", "buildings.ndjson"),
    `${canonicalJson({
      doittId: 2001,
      featureCode: 2100,
      status: "active",
      statusType: "Constructed",
      lastEdited: null,
      heightFt: 125,
      heightM: 38.1,
      heightSource: "source",
      rings: [
        [
          [-73.98735, 40.75515],
          [-73.9869, 40.75515],
          [-73.9869, 40.75565],
          [-73.98735, 40.75565],
          [-73.98735, 40.75515],
        ],
      ],
    })}\n`,
  );
  // A built shade cell: the parity fixture's real bytes under a synthetic key,
  // standing in for `shade --execute` (which needs the canopy inputs).
  const fixture = await parityFixture();
  const segments: Array<[number, number]> = Array.from({ length: fixture.segments }, (_, i) => [
    i + 1,
    i + 2,
  ]);
  const input: Partial<ShadeCellInput> = { key: "z14-4824-6157", segments };
  await writeFile(
    join(root, "work", "shade", "inputs", "z14-4824-6157.json"),
    `${canonicalJson(input)}\n`,
  );
  return root;
}

async function allFiles(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.set(full, sha256Hex(await readFile(full)));
    }
  };
  await walk(directory);
  return result;
}

test("a generation with signatures rebuilds identically, verifies, and plans every object", async () => {
  const root = await setupRoot();
  const previous = process.env.NAVIGATION_PREP_ROOT;
  process.env.NAVIGATION_PREP_ROOT = root;
  try {
    const fixture = await parityFixture();
    const bounds = { south: 40.7549, west: -73.989, north: 40.7561, east: -73.9865 };
    await writeShadeCell({
      key: "z14-4824-6157",
      segments: fixture.segments,
      slots: SHADE_SLOT_COUNT,
      bytes: new Uint8Array(Buffer.from(fixture.payloadBase64, "base64")),
      geometryBounds: bounds,
      supportBounds: bounds,
    });

    // Without the stage, the generation has no signatures at all.
    const plain = await build({ grid: 14, dryRun: true });
    assert.equal(plain.signatureCells, 0);
    assert.equal(plain.budgets.signatureBytes, undefined);

    const progress = await signaturesExecute();
    assert.equal(progress.cells, 1);
    assert.equal(progress.bytes, fixture.segments * 2 * SIGNATURE_BYTES_PER_SIDE);
    assert.deepEqual(
      progress.types,
      Array.from({ length: 8 }, (_, t) => fixture.expected.types.filter((x) => x === t).length),
    );

    const first = await build({ grid: 14 });
    assert.equal(first.signatureCells, 1);
    assert.notEqual(first.generation, plain.generation, "signatures are hashed into the id");
    const directory = join(root, "normalized", first.generation);
    const firstFiles = await allFiles(directory);
    const second = await build({ grid: 14 });
    assert.equal(second.generation, first.generation);
    assert.deepEqual(await allFiles(directory), firstFiles);

    const nested = join(directory, "navigation", "nyc", first.generation);
    const manifest = parseNavigationManifest(
      JSON.parse(await readFile(join(nested, "manifest.json"), "utf8")),
      first.generation,
    );
    assert.equal(manifest.signatures?.model, "signatures-v1");
    assert.equal(manifest.signatures?.cells, 1);

    // Row alignment: the payload's rows are the shade index's segments.
    const shadeIndex = JSON.parse(
      await readFile(join(nested, "shades", "z14-4824-6157.json"), "utf8"),
    ) as { segments: Array<[number, number]> };
    const payload = await readFile(join(nested, "signatures", "z14-4824-6157.bin"));
    assert.equal(payload.byteLength, shadeIndex.segments.length * 2 * SIGNATURE_BYTES_PER_SIDE);
    for (let side = 0; side < fixture.expected.types.length; side++)
      assert.equal(payload[side * SIGNATURE_BYTES_PER_SIDE + SIGNATURE_COMPONENTS], fixture.expected.types[side]);

    const verified = await verifyGeneration(first.generation);
    assert.equal(verified.signatureCells, 1);
    assert.equal(verified.budgets.actual.signatureBytes, manifest.budgets.signatureBytes);

    const plan = await publishPlan(first.generation);
    assert.deepEqual(
      plan.objects.filter((object) => object.kind.startsWith("signature")).map((object) => object.kind),
      ["signatureIndex", "signaturePayload"],
    );
    assert.equal(plan.payloadBytes, verified.budgets.actual.totalBytes);
    assert.equal(plan.objects.at(-1)?.kind, "pointer");

    // A stray file beside the claimed signatures must never be published.
    const stray = join(nested, "signatures", "z14-0-0.bin");
    await writeFile(stray, new Uint8Array(17));
    await assert.rejects(publishPlan(first.generation), /unclaimed signature files/);
    await rm(stray);

    // A model edited after projection makes the signatures stale.
    const model = modelPath();
    const saved = join(root, "model-backup.json");
    await copyFile(model, saved);
    try {
      await writeFile(model, `${(await readFile(saved, "utf8")).trimEnd()} \n`);
      await assert.rejects(build({ grid: 14, dryRun: true }), /stale/);
    } finally {
      await copyFile(saved, model);
    }

    // A shade cell rebuilt after projection makes the signatures stale.
    const stale = new Uint8Array(Buffer.from(fixture.payloadBase64, "base64"));
    stale[0] ^= 1;
    await writeShadeCell({
      key: "z14-4824-6157",
      segments: fixture.segments,
      slots: SHADE_SLOT_COUNT,
      bytes: stale,
      geometryBounds: bounds,
      supportBounds: bounds,
    });
    await assert.rejects(build({ grid: 14, dryRun: true }), /stale/);
  } finally {
    if (previous === undefined) delete process.env.NAVIGATION_PREP_ROOT;
    else process.env.NAVIGATION_PREP_ROOT = previous;
  }
});

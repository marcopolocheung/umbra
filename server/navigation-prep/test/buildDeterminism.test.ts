import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "../src/build";
import { verifyGeneration } from "../src/verify";
import { canonicalJson } from "../src/canonical";

/**
 * End-to-end tiny generation: identical committed inputs rebuild to identical
 * bytes and the same generation id, and the independent verifier re-reads
 * only the final serialized bytes and accepts them. Runs entirely in a temp
 * directory — no network, no real sources.
 */

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

function streetsDoc() {
  // A small connected Midtown graph crossing a z14 cell boundary.
  const nodes = [
    { id: 1001, lat: 40.755, lon: -73.9885, isIntersection: true },
    { id: 1002, lat: 40.7555, lon: -73.987, isIntersection: true },
    { id: 1003, lat: 40.756, lon: -73.9862, isIntersection: true },
    { id: 1004, lat: 40.7558, lon: -73.988, isIntersection: false },
  ];
  const edges = [
    {
      id: "w1s0f",
      from: 1001,
      to: 1002,
      distanceM: 142,
      tags: { highway: "residential", surface: "asphalt" },
    },
    {
      id: "w1s0r",
      from: 1002,
      to: 1001,
      distanceM: 142,
      tags: { highway: "residential", surface: "asphalt" },
    },
    {
      id: "w2s0f",
      from: 1002,
      to: 1003,
      distanceM: 75,
      tags: { highway: "pedestrian", foot: "yes" },
    },
    {
      id: "w2s0r",
      from: 1003,
      to: 1002,
      distanceM: 75,
      tags: { highway: "pedestrian", foot: "yes" },
    },
    {
      id: "w3s0f",
      from: 1002,
      to: 1004,
      distanceM: 48,
      tags: { highway: "steps", surface: "concrete", access: "yes" },
    },
    {
      id: "w3s0r",
      from: 1004,
      to: 1002,
      distanceM: 48,
      tags: { highway: "steps", surface: "concrete", access: "yes" },
    },
  ];
  return {
    streets: { nodes, edges },
    recipe: "nyc-navigation/recipe-v1",
    osmSnapshotTimestamp: 1_758_000_000,
  };
}

const BUILDINGS = [
  {
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
  },
];

async function setupRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nav-prep-build-"));
  await mkdir(join(root, "raw"), { recursive: true });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(
    join(root, "raw", "source-receipts.json"),
    `${JSON.stringify(RECEIPTS, null, 2)}\n`,
  );
  await writeFile(join(root, "work", "streets.json"), `${canonicalJson(streetsDoc())}\n`);
  await writeFile(
    join(root, "work", "buildings.ndjson"),
    `${BUILDINGS.map((building) => canonicalJson(building)).join("\n")}\n`,
  );
  return root;
}

async function allFiles(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.set(full, await readFile(full, "utf8"));
    }
  };
  await walk(directory);
  return result;
}

test("identical inputs rebuild to identical bytes and a reproducible generation id", async () => {
  const root = await setupRoot();
  const previous = process.env.NAVIGATION_PREP_ROOT;
  process.env.NAVIGATION_PREP_ROOT = root;
  try {
    const first = await build({ grid: 14 });
    assert.equal(first.dryRun, false);
    assert.ok(first.streetShards >= 1);
    assert.ok(first.buildingShards >= 1);
    const firstFiles = await allFiles(join(root, "normalized", first.generation));

    const second = await build({ grid: 14 });
    assert.equal(second.generation, first.generation);
    assert.deepEqual(
      {
        budgets: second.budgets,
        streetShards: second.streetShards,
        buildingShards: second.buildingShards,
      },
      {
        budgets: first.budgets,
        streetShards: first.streetShards,
        buildingShards: first.buildingShards,
      },
    );
    const secondFiles = await allFiles(join(root, "normalized", second.generation));
    assert.deepEqual(secondFiles, firstFiles);

    // The verifier re-reads the serialized bytes and accepts the generation.
    const verified = await verifyGeneration(first.generation);
    assert.equal(verified.generation, first.generation);
    assert.equal(verified.graph.ghostNodesLocalOnly, 0);
    assert.ok(verified.requests.some((request) => request.borough === "Manhattan"));

    // Dry run changes nothing on disk and reports the same identity.
    const dry = await build({ grid: 14, dryRun: true });
    assert.equal(dry.generation, first.generation);
    assert.equal(dry.written.length, 0);
    assert.deepEqual(await allFiles(join(root, "normalized", first.generation)), firstFiles);
  } finally {
    if (previous === undefined) delete process.env.NAVIGATION_PREP_ROOT;
    else process.env.NAVIGATION_PREP_ROOT = previous;
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../src/canonical";
import { build } from "../src/build";
import {
  BOROUGH_PUBLISH_SAMPLES,
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  POINTER_KEY,
  publishExecute,
  publishPlan,
  publishRollback,
  specimenKeysForSample,
  type PublishSample,
  type PublishStore,
} from "../src/publish";
import { verifyGeneration } from "../src/verify";

/**
 * Publication state machine, deliberately disconnected from the real network:
 * the S3-backed store is replaced by an in-memory one, and the full build
 * runs in a temp preparation root. The suite proves ordering and recovery
 * behaviour — immutable-first upload, resume after interruption, specimen
 * re-verification, inventory reconciliation, and pointer-last promotion —
 * without any R2 or SDK traffic.
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
  const nodes = [
    { id: 1001, lat: 40.755, lon: -73.9885, isIntersection: true },
    { id: 1002, lat: 40.7555, lon: -73.987, isIntersection: true },
    { id: 1003, lat: 40.756, lon: -73.9862, isIntersection: true },
    { id: 1004, lat: 40.7558, lon: -73.988, isIntersection: false },
  ];
  const edges = [
    { id: "w1s0f", from: 1001, to: 1002, distanceM: 142, tags: { highway: "residential", surface: "asphalt" } },
    { id: "w1s0r", from: 1002, to: 1001, distanceM: 142, tags: { highway: "residential", surface: "asphalt" } },
    { id: "w2s0f", from: 1002, to: 1003, distanceM: 75, tags: { highway: "pedestrian", foot: "yes" } },
    { id: "w2s0r", from: 1003, to: 1002, distanceM: 75, tags: { highway: "pedestrian", foot: "yes" } },
    { id: "w3s0f", from: 1002, to: 1004, distanceM: 48, tags: { highway: "steps", surface: "concrete", access: "yes" } },
    { id: "w3s0r", from: 1004, to: 1002, distanceM: 48, tags: { highway: "steps", surface: "concrete", access: "yes" } },
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

const MIDTOWN_SAMPLE: PublishSample = {
  borough: "Manhattan (fixture)",
  bbox: { south: 40.7545, west: -73.988, north: 40.7565, east: -73.986 },
  note: "the fixture cell in Midtown",
};

async function setupRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nav-prep-publish-"));
  await mkdir(join(root, "raw"), { recursive: true });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "raw", "source-receipts.json"), `${JSON.stringify(RECEIPTS, null, 2)}\n`);
  await writeFile(join(root, "work", "streets.json"), `${canonicalJson(streetsDoc())}\n`);
  await writeFile(
    join(root, "work", "buildings.ndjson"),
    `${BUILDINGS.map((building) => canonicalJson(building)).join("\n")}\n`,
  );
  return root;
}

class MemoryStore implements PublishStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; cacheControl: string }>();
  readonly puts: Array<{ key: string; contentType: string; cacheControl: string }> = [];

  constructor(private readonly failPutsAfter?: number) {}

  async head(key: string): Promise<{ key: string; size: number; etag: string } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, etag: createHash("md5").update(object.bytes).digest("hex") };
  }

  async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void> {
    if (this.failPutsAfter !== undefined && this.puts.length >= this.failPutsAfter) {
      throw new Error(`injected upload failure after ${this.failPutsAfter} puts`);
    }
    this.objects.set(key, { bytes, contentType, cacheControl });
    this.puts.push({ key, contentType, cacheControl });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number; etag: string }>> {
    const metas: Array<{ key: string; size: number; etag: string }> = [];
    for (const [key, object] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      metas.push({ key, size: object.bytes.byteLength, etag: createHash("md5").update(object.bytes).digest("hex") });
    }
    return metas;
  }
}

async function withEnv<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = {
    root: process.env.NAVIGATION_PREP_ROOT,
    bucket: process.env.R2_NAVIGATION_BUCKET,
    base: process.env.R2_PUBLIC_BASE,
  };
  process.env.NAVIGATION_PREP_ROOT = root;
  process.env.R2_NAVIGATION_BUCKET = "test-navigation-bucket";
  process.env.R2_PUBLIC_BASE = "https://navigation.example.test";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("BOROUGH_PUBLISH_SAMPLES retains exactly the five boroughs", () => {
  assert.deepEqual(
    BOROUGH_PUBLISH_SAMPLES.map((sample) => sample.borough),
    ["Manhattan", "The Bronx", "Brooklyn", "Queens", "Staten Island"],
  );
});

test("specimen selection uses the client's street and caster-padded building semantics", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const plan = await publishPlan(built.generation);
    const keys = specimenKeysForSample(plan.manifest, MIDTOWN_SAMPLE);
    assert.ok(keys, "the fixture cell must select at least one street and one building shard");
    assert.ok(keys.streets.length > 0);
    assert.ok(keys.buildings.length > 0);
    assert.ok(keys.streets.every((key) => key.startsWith("streets/")));
    assert.ok(keys.buildings.every((key) => key.startsWith("buildings/")));
  });
});

test("publishPlan orders every immutable object before the pointer", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const plan = await publishPlan(built.generation);
    assert.equal(plan.objects.length, built.streetShards + built.buildingShards + 3);
    assert.equal(plan.objects[0].kind, "manifest");
    assert.equal(plan.objects[1].kind, "notices");
    const pointer = plan.objects[plan.objects.length - 1];
    assert.equal(pointer.kind, "pointer");
    assert.equal(pointer.key, POINTER_KEY);
    for (const object of plan.objects.slice(0, -1)) {
      assert.equal(object.cacheControl, IMMUTABLE_CACHE_CONTROL);
      assert.ok(object.key.startsWith(`navigation/nyc/${built.generation}/`), object.key);
    }
    assert.equal(pointer.cacheControl, POINTER_CACHE_CONTROL);
    // payloadBytes = shards + notices, exactly what the verifier reports.
    const verified = await verifyGeneration(built.generation);
    assert.equal(plan.payloadBytes, verified.budgets.actual.totalBytes);
  });
});

test("publishPlan rejects drifted bytes and unclaimed files", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const nested = join(root, "normalized", built.generation, "navigation", "nyc", built.generation);

    // Byte drift in a shard fails the digest check.
    const streetPath = join(nested, "streets", (await readdir(join(nested, "streets"))).sort()[0]);
    const original = await readFile(streetPath);
    await writeFile(streetPath, original.subarray(0, original.byteLength - 8));
    await assert.rejects(() => publishPlan(built.generation), /digest drifted|byte count drifted/);
    await writeFile(streetPath, original);

    // A stray file that no ref claims must never be uploaded.
    await writeFile(join(nested, "streets", "stray.json"), "{}");
    await assert.rejects(() => publishPlan(built.generation), /unclaimed street files/);
  });
});

test("execute uploads immutable objects first, promotes the pointer last, and reports the evidence", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const store = new MemoryStore();
    const report = await publishExecute(built.generation, { store, samples: [MIDTOWN_SAMPLE] });
    assert.equal(report.mode, "execute");
    assert.equal(report.objects.count, built.streetShards + built.buildingShards + 3);

    const pushes = store.puts.map((put) => put.key);
    assert.equal(pushes[pushes.length - 1], POINTER_KEY, "the pointer must be the last upload");
    assert.equal(pushes.filter((putting) => putting === POINTER_KEY).length, 1);

    // Cache content types are exact on upload, not conventions asserted after.
    for (const put of store.puts) {
      assert.equal(put.contentType, "application/json");
      assert.equal(
        put.cacheControl,
        put.key === POINTER_KEY ? POINTER_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
      );
    }

    // Every byte the verifier accepted is what the store holds.
    const pointerBytes = await store.get(POINTER_KEY);
    assert.ok(pointerBytes);
    assert.equal(sha256Hex(pointerBytes), report.pointerSha256);
    const localPointer = await readFile(join(root, "normalized", built.generation, "pointer-candidate.json"));
    assert.deepEqual(pointerBytes, new Uint8Array(localPointer), "pointer promoted byte-exact");

    // Report carries counts, hashes, public base, and the local marker.
    assert.equal(report.verifier.objects, built.streetShards + built.buildingShards + 3);
    assert.equal(report.publicBase, "https://navigation.example.test");
    assert.equal(report.reconciled.count, built.streetShards + built.buildingShards + 2);
    assert.equal(report.specimens[0].borough, "Manhattan (fixture)");
    assert.equal(report.fetchedForVerification.length, 2);
    assert.equal(report.rollbackCommand, null); // no previous pointer yet
    const marker = await readFile(join(root, "normalized", built.generation, "current.json"));
    assert.deepEqual(pointerBytes, new Uint8Array(marker));
  });
});

test("an interrupted upload never touches the pointer and resumes past completed objects", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const store = new MemoryStore(1); // fail the second put
    await assert.rejects(
      () => publishExecute(built.generation, { store, samples: [MIDTOWN_SAMPLE] }),
      /injected upload failure/,
    );
    assert.equal(store.puts.some((put) => put.key === POINTER_KEY), false);
    assert.equal(store.puts.length, 1);
    const firstKey = store.puts[0].key;

    // Resume on the same store: the completed object is skipped, the rest
    // upload, the pointer goes last.
    const store2 = new MemoryStore();
    for (const [key, object] of store.objects) store2.objects.set(key, object);
    const report = await publishExecute(built.generation, { store: store2, samples: [MIDTOWN_SAMPLE] });
    assert.ok(report.resumed.includes(firstKey));
    assert.equal(report.uploaded[report.uploaded.length - 1], POINTER_KEY);
    const pushes = store2.puts.map((put) => put.key);
    assert.equal(pushes[pushes.length - 1], POINTER_KEY);
  });
});

test("reconciliation rejects stray bucket keys before the pointer is promoted", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const built = await build({ grid: 14 });
    const store = new MemoryStore();
    const first = await publishExecute(built.generation, { store, samples: [MIDTOWN_SAMPLE] });
    assert.equal(store.puts.filter((put) => put.key === POINTER_KEY).length, 1);

    // An unrelated object under the generation prefix poisons the inventory.
    store.objects.set(`navigation/nyc/${built.generation}/buildings/stray.json`, {
      bytes: new TextEncoder().encode("{}"),
      contentType: "application/json",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    await assert.rejects(
      () => publishExecute(built.generation, { store, samples: [MIDTOWN_SAMPLE] }),
      /unreferenced key/,
    );
    assert.equal(
      store.puts.filter((put) => put.key === POINTER_KEY).length,
      1,
      "a failed reconcile must not re-promote the pointer",
    );
    // Removing the stray key makes the same generation publish cleanly again.
    store.objects.delete(`navigation/nyc/${built.generation}/buildings/stray.json`);
    const second = await publishExecute(built.generation, { store, samples: [MIDTOWN_SAMPLE] });
    assert.equal(second.reconciled.count, first.reconciled.count);
    assert.equal(second.resumed.length, built.streetShards + built.buildingShards + 2);
  });
});

test("rollback re-promotes only the pointer and records the prior generation", async () => {
  const root = await setupRoot();
  await withEnv(root, async () => {
    const first = await build({ grid: 14 });
    const second = await build({ grid: 13 }); // different grid → distinct generation
    assert.notEqual(first.generation, second.generation);

    const store = new MemoryStore();
    const promoted = await publishExecute(first.generation, { store, samples: [MIDTOWN_SAMPLE] });
    const promotedNext = await publishExecute(second.generation, { store, samples: [MIDTOWN_SAMPLE] });
    assert.equal(promoted.rollbackCommand, null);
    assert.equal(promotedNext.previousPointer?.generation, first.generation);
    assert.ok(promotedNext.rollbackCommand?.includes("--rollback"));

    const putCount = store.puts.length;
    const rolled = await publishRollback(first.generation, { store });
    assert.equal(rolled.mode, "rollback");
    assert.equal(rolled.rollbackTo, first.generation);
    assert.equal(rolled.previousPointer?.generation, second.generation);
    assert.equal(store.puts.length, putCount + 1, "rollback uploads exactly the pointer");
    assert.equal(store.puts[store.puts.length - 1].key, POINTER_KEY);

    const pointerBytes = await store.get(POINTER_KEY);
    assert.ok(pointerBytes);
    const localFirst = await readFile(join(root, "normalized", first.generation, "pointer-candidate.json"));
    assert.deepEqual(pointerBytes, new Uint8Array(localFirst), "rollback repoints at the old generation");
  });
});

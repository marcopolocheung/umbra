import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendFile } from "node:fs/promises";
import { buildGeneration } from "../src/build";
import { publishPlan } from "../src/publish";
import { assembleReceipts, checkWorkTrees } from "../src/receipts";
import { validate } from "../src/validate";
import { verifyGeneration } from "../src/verify";
import { busFixtureA, busFixtureB, busFixtureBusco, SUBWAY_FIXTURE, writeFeed } from "./helpers";

const BUS_DIRS = ["gtfs_bx", "gtfs_b", "gtfs_m", "gtfs_q", "gtfs_si", "gtfs_busco"];

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tp-pipe-"));
  await writeFeed(root, "gtfs_subway", SUBWAY_FIXTURE);
  for (const [index, dir] of BUS_DIRS.entries()) {
    // Alternate NYCT-shaped fixtures; gtfs_busco gets the BusCo-shaped one
    // (minimal stops, route_url column, disjoint route ids).
    if (dir === "gtfs_busco") await writeFeed(root, dir, busFixtureBusco());
    else await writeFeed(root, dir, index % 2 === 0 ? busFixtureA() : busFixtureB());
  }
  return root;
}

function withRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TRANSIT_PREP_ROOT;
  process.env.TRANSIT_PREP_ROOT = root;
  return run().finally(() => {
    if (previous === undefined) delete process.env.TRANSIT_PREP_ROOT;
    else process.env.TRANSIT_PREP_ROOT = previous;
  });
}

test("receipts assemble from unzipped seeds and detect tampering", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    const { receipts, fromZips } = await assembleReceipts();
    assert.equal(fromZips, false);
    assert.equal(receipts.receipts.length, 7);
    await checkWorkTrees(receipts);
    await appendFile(join(root, "gtfs_bx", "stops.txt"), "X,X,,40.7,-74.0,,,0,\n");
    await assert.rejects(() => checkWorkTrees(receipts), /work tree changed/);
  });
});

test("validate accepts the seeded feeds with shared-stop dedup", async () => {
  const root = await seedRoot();
  const report = await withRoot(root, async () => {
    await assembleReceipts();
    return validate();
  });
  const subway = report.feeds.find((feed) => feed.id === "subway");
  assert.equal(subway?.parentStations, 2);
  assert.equal(subway?.transfers, 1);
  // V1/V2/V3 + X1/X2/X3 union by route_id.
  assert.equal(report.busRouteIds, 6);
  // S1 shared everywhere; A2 in NYCT-A feeds; B2 in NYCT-B feeds; C2 in BusCo.
  assert.equal(report.busStopRows, 12);
  assert.equal(report.busUniqueStops, 4);
  // Fixture B's S1 is metres off fixture A's: recorded, not fatal.
  assert.ok(report.sharedStopConflicts.length > 0);
  assert.ok(report.maxSharedDisagreementM < 100);
});

test("validate fails loudly on header drift", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = join(root, "gtfs_bx", "trips.txt");
    const body = await readFile(path, "utf8");
    await writeFile(path, body.replace("block_id,", ""));
    // Re-receipt the tampered tree so the header pin (not the receipt) fires.
    await assembleReceipts();
    await assert.rejects(() => validate(), /header drift/);
  });
});

test("build + verify produce checkable shards end to end", async () => {
  const root = await seedRoot();
  const { manifest } = await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const built = await buildGeneration({ updateBaseline: true });
    const checked = await verifyGeneration(built.generation);
    assert.equal(checked.shards, 7);
    return built;
  });
  assert.equal(manifest.shards.length, 7);
  assert.ok(manifest.notes.length >= 3);
  assert.equal(manifest.budgets.shardBytes, 3_000_000);
  for (const shard of manifest.shards) {
    assert.ok(shard.bytes < 3_000_000);
  }
  const plan = await withRoot(root, async () => publishPlan(manifest.generation));
  // 7 shards + manifest + current.json pointer.
  assert.equal(plan.objects.length, 9);
  assert.ok(plan.objects.every((object) => object.key.includes(manifest.generation) || object.key.endsWith("current.json")));
  const pointer = plan.objects.find((object) => object.key.endsWith("current.json"));
  assert.equal(pointer?.cacheControl, "public, max-age=300");
  assert.ok((pointer?.bytes ?? 0) > 0);
});

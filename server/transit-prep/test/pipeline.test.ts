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
import { busFixtureA, busFixtureB, busFixtureBusco, SUBWAY_FIXTURE, withFeedTripIds, writeFeed } from "./helpers";

const BUS_DIRS = ["gtfs_bx", "gtfs_b", "gtfs_m", "gtfs_q", "gtfs_si", "gtfs_busco"];

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tp-pipe-"));
  await writeFeed(root, "gtfs_subway", SUBWAY_FIXTURE);
  for (const [index, dir] of BUS_DIRS.entries()) {
    // Alternate NYCT-shaped fixtures; gtfs_busco gets the BusCo-shaped one
    // (minimal stops, route_url column, disjoint route ids).
    const fixture =
      dir === "gtfs_busco" ? busFixtureBusco() : index % 2 === 0 ? busFixtureA() : busFixtureB();
    await writeFeed(root, dir, withFeedTripIds(fixture, dir));
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

test("a bus-only feed change produces a different generation", async () => {
  const root = await seedRoot();
  const generations = await withRoot(root, async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const first = await (async () => {
      await assembleReceipts();
      await validate();
      return (await buildGeneration({ updateBaseline: true })).generation;
    })();
    // A quarterly bus pick: only the last bus feed's version moves. The subway
    // feed, and therefore any prefix of the joined feed versions, is unchanged.
    const info = join(root, "gtfs_busco", "feed_info.txt");
    await writeFile(info, (await readFile(info, "utf8")).replace("test-bus-1", "test-bus-2"));
    const second = await (async () => {
      await assembleReceipts();
      await validate();
      return (await buildGeneration({ updateBaseline: true })).generation;
    })();
    return { first, second };
  });
  assert.notEqual(generations.first, generations.second);
});

test("rebuilding the same inputs reproduces the same generation", async () => {
  const root = await seedRoot();
  const { first, second } = await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const a = await buildGeneration({ updateBaseline: true });
    const b = await buildGeneration({ updateBaseline: true });
    return { first: a.generation, second: b.generation };
  });
  assert.equal(first, second);
});

test("verify picks the newest generation, not the last one alphabetically", async () => {
  const root = await seedRoot();
  const picked = await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const built = await buildGeneration({ updateBaseline: true });
    // An older generation whose directory name sorts after the new one: what a
    // rebuild leaves behind, and what publish must not push.
    const { cp, readFile, writeFile } = await import("node:fs/promises");
    const stale = "nyc-9999-99-99-zzzzzzzzzzzz";
    const staleDir = join(root, "normalized", stale);
    await cp(built.directory, staleDir, { recursive: true });
    const manifestPath = join(staleDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.generation = stale;
    manifest.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { chosen: (await verifyGeneration()).generation, expected: built.generation };
  });
  assert.equal(picked.chosen, picked.expected);
});

test("validate rejects a trip_id that two bus feeds share", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    // Hand gtfs_m one of gtfs_bx's trip_ids. normalizeBus pools stop_times by
    // bare trip_id, so a collision silently interleaves two boroughs' stops
    // into one trip rather than failing.
    for (const file of ["trips.txt", "stop_times.txt"]) {
      const path = join(root, "gtfs_m", file);
      await writeFile(path, (await readFile(path, "utf8")).replaceAll("gtfs_m-a-1", "gtfs_bx-a-1"));
    }
    await assembleReceipts();
    await assert.rejects(() => validate(), /trip_id gtfs_bx-a-1 appears in gtfs_bx and bus-m/);
  });
});

test("validate rejects a service_id two bus feeds define differently", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    // Sharing a service_id is fine while the definitions agree — normalizeBus
    // pools calendars by bare id and keeps one. Disagreeing is not.
    const path = join(root, "gtfs_m", "calendar.txt");
    await writeFile(path, (await readFile(path, "utf8")).replace("WD,1,1,1,1,1,0,0", "WD,1,1,1,0,0,0,0"));
    await assembleReceipts();
    await assert.rejects(() => validate(), /service_id WD differs between/);
  });
});

test("validate rejects a transfer the feed marks impossible", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    // transfer_type 3 means "transfer not possible"; the type is parsed and
    // would otherwise become a walkable edge with the fallback time.
    const path = join(root, "gtfs_subway", "transfers.txt");
    await writeFile(path, (await readFile(path, "utf8")).replace("P1,P2,2,120", "P1,P2,3,"));
    await assembleReceipts();
    await assert.rejects(() => validate(), /transfer_type 3/);
  });
});

test("validate records the transfer types it saw", async () => {
  const root = await seedRoot();
  const report = await withRoot(root, async () => {
    await assembleReceipts();
    return validate();
  });
  assert.deepEqual(report.subwayTransferTypes, { 2: 1 });
});

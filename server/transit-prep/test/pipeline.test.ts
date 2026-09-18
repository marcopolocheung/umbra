import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { buildGeneration } from "../src/build";
import { writeOsmCache } from "../src/osm";
import { publishPlan } from "../src/publish";
import { assembleReceipts, checkWorkTrees } from "../src/receipts";
import { validate } from "../src/validate";
import { decodePolyline } from "../src/shapeSlice";
import { haversineMeters } from "../src/util";
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
  assert.equal(subway?.transfers, 3);
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

test("build publishes each shard's computed stop extent", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const { manifest, generation } = await buildGeneration({ updateBaseline: true });
    const directory = join(root, "normalized", generation);
    for (const ref of manifest.shards) {
      const shard = JSON.parse(await readFile(join(directory, ref.key), "utf8")) as {
        stops: { lat: number; lon: number }[];
      };
      assert.ok(shard.stops.length > 0);
      // The extent of the stops this shard actually ships, not the borough it
      // is named after: a shard is self-contained, so a route crossing a
      // boundary carries the far side's stops with it.
      assert.deepEqual(ref.bounds, {
        south: Math.min(...shard.stops.map((stop) => stop.lat)),
        west: Math.min(...shard.stops.map((stop) => stop.lon)),
        north: Math.max(...shard.stops.map((stop) => stop.lat)),
        east: Math.max(...shard.stops.map((stop) => stop.lon)),
      });
    }
  });
});

test("verify rejects bounds that disagree with the shard's stops", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const { generation } = await buildGeneration({ updateBaseline: true });
    const manifestPath = join(root, "normalized", generation, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // A plausible-looking extent that excludes stops the shard really ships.
    // The client skips a download on this, so a wrong one silently drops
    // transit rather than failing loudly.
    manifest.shards[0].bounds = { south: 0, west: 0, north: 0.1, east: 0.1 };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => verifyGeneration(generation), /bounds/);
  });
});

/** Track along the straight line from Station Alpha to Station Beta. */
function osmCacheFor(tags: Record<string, string>) {
  const steps = 20;
  return {
    relations: [
      {
        id: 900,
        tags: { type: "route", route: "subway", ref: "R1", operator: "New York City Transit Authority" },
        members: [{ type: "way", ref: 901, role: "" }],
      },
    ],
    ways: [
      {
        id: 901,
        tags: { railway: "subway", ...tags },
        geometry: Array.from({ length: steps + 1 }, (_, i) => ({
          lat: 40.75 + (0.01 * i) / steps,
          lon: -73.99 + (0.01 * i) / steps,
        })),
      },
    ],
    receipt: {
      fetchedAt: "2026-09-17T00:00:00.000Z",
      endpoint: "fixture",
      bbox: { south: 40.4, west: -74.3, north: 40.95, east: -73.6 },
      relations: { count: 1, bytes: 0, sha256: "0".repeat(64) },
      ways: { count: 1, bytes: 0, sha256: "0".repeat(64) },
    },
  };
}

test("build attaches OSM structure to subway edges when the cache is present", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    await writeOsmCache(osmCacheFor({ tunnel: "yes" }));
    const built = await buildGeneration({ updateBaseline: true });
    const shard = JSON.parse(
      await readFile(join(root, "normalized", built.generation, "subway.json"), "utf8"),
    ) as { edges: { route: string; structure?: Record<string, number> }[] };
    const r1 = shard.edges.filter((e) => e.route === "R1");
    assert.ok(r1.length > 0);
    for (const e of r1) assert.deepEqual(e.structure, { underground: 1 });
    assert.equal(built.structure?.determined, r1.length);
    // The honesty note only appears when there is structure to explain.
    assert.ok(built.manifest.notes.some((n) => n.includes("joined from OpenStreetMap")));
  });
});

test("an elevated line is reported elevated, not defaulted to underground", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    await writeOsmCache(osmCacheFor({ bridge: "yes" }));
    const built = await buildGeneration({ updateBaseline: true });
    const shard = JSON.parse(
      await readFile(join(root, "normalized", built.generation, "subway.json"), "utf8"),
    ) as { edges: { route: string; structure?: Record<string, number> }[] };
    for (const e of shard.edges.filter((x) => x.route === "R1"))
      assert.deepEqual(e.structure, { elevated: 1 });
  });
});

test("build without an OSM cache ships no structure and says nothing about it", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const built = await buildGeneration({ updateBaseline: true });
    const shard = JSON.parse(
      await readFile(join(root, "normalized", built.generation, "subway.json"), "utf8"),
    ) as { edges: { structure?: unknown }[] };
    // Additive: absent OSM means the shard it always was, minus one field.
    assert.ok(shard.edges.every((e) => e.structure === undefined));
    assert.equal(built.structure, undefined);
    assert.ok(!built.manifest.notes.some((n) => n.includes("joined from OpenStreetMap")));
  });
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
  assert.deepEqual(report.subwayTransferTypes, { 2: 3 });
});

test("build ships each edge's sliced geometry and measures distM along it", async () => {
  const root = await seedRoot();
  const { manifest, generation } = await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const built = await buildGeneration({ updateBaseline: true });
    // verify re-derives the drawn line against the distance beside it.
    await verifyGeneration(built.generation);
    return built;
  });
  const directory = join(root, "normalized", generation);
  const subway = JSON.parse(
    await readFile(join(directory, "subway.json"), "utf8"),
  ) as { edges: { from: string; to: string; distM: number; geom?: string }[] };
  const edge = subway.edges.find((e) => e.from === "subway:P1" && e.to === "subway:P2");
  assert.ok(edge, "the fixture's weekday edge");
  // S1 bends ~67 m east of the P1-P2 chord; the interior is that one bend.
  assert.deepEqual(decodePolyline(edge.geom ?? ""), [{ lat: 40.756, lon: -73.983 }]);
  // distM follows the track, so it is longer than the chord it replaced.
  assert.ok(edge.distM > Math.round(haversineMeters(40.75, -73.99, 40.76, -73.98)));
  assert.ok(
    manifest.notes.some((note) => note.startsWith("Route geometry ships per edge")),
    "the manifest says how geometry ships",
  );
});

test("verify rejects a shard whose geometry was edited after the build", async () => {
  const root = await seedRoot();
  await withRoot(root, async () => {
    await assembleReceipts();
    await validate();
    const { generation, manifest } = await buildGeneration({ updateBaseline: true });
    const directory = join(root, "normalized", generation);
    const path = join(directory, "subway.json");
    const shard = JSON.parse(await readFile(path, "utf8")) as {
      edges: { geom?: string }[];
    };
    const target = shard.edges.find((edge) => edge.geom !== undefined);
    assert.ok(target, "a subway edge ships geometry");
    // Same shape of value, somewhere else entirely: a check that only parsed
    // the string would wave this through.
    target.geom = "_p~iF~ps|U";
    const bytes = new TextEncoder().encode(JSON.stringify(shard));
    await writeFile(path, bytes);
    const ref = manifest.shards.find((entry) => entry.key === "subway.json");
    assert.ok(ref);
    ref.bytes = bytes.length;
    ref.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => verifyGeneration(generation), /reports distM/);
  });
});

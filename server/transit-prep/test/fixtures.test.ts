import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FeedVersion } from "../src/model";
import { normalizeBus } from "../src/normalizeBus";
import { normalizeSubway } from "../src/normalizeSubway";
import { buildSpatialStubs } from "../src/transfers";
import { busFixtureA, busFixtureB, SUBWAY_FIXTURE, writeFeed } from "./helpers";

/** Inside every fixture calendar window, so "typical" is unambiguous. */
const REFERENCE_DATE = "20260101";

const subwayFeed: FeedVersion = {
  id: "subway",
  version: "test-subway-1",
  startDate: "20260101",
  endDate: "20261231",
  sha256: "x",
};

test("subway normalizes parents, edges, transfers, shapes and headways", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-subway-"));
  await writeFeed(root, "subway-mini", SUBWAY_FIXTURE);
  const result = await normalizeSubway(root, "subway-mini", subwayFeed, REFERENCE_DATE);
  assert.deepEqual(result.stops.map((s) => s.id), ["subway:P1", "subway:P2"]);
  assert.equal(result.edges.length, 1);
  assert.deepEqual(
    { from: result.edges[0]?.from, to: result.edges[0]?.to, medianSec: result.edges[0]?.medianSec, trips: result.edges[0]?.trips },
    { from: "subway:P1", to: "subway:P2", medianSec: 300, trips: 4 },
  );
  // The lone Saturday reverse trip is below the sample minimum.
  assert.equal(result.stats.edges.droppedSparse, 1);
  assert.deepEqual(result.transfers, [
    { from: "subway:P1", to: "subway:P2", minSec: 120, kind: "gtfs" },
  ]);
  assert.ok((result.shapes["R1:0"]?.length ?? 0) >= 2);
  const headway = result.headways.find((row) => row.route === "R1" && row.hour === 8);
  assert.deepEqual(
    { medianSec: headway?.medianSec, trips: headway?.trips, dayType: headway?.dayType },
    { medianSec: 600, trips: 4, dayType: "weekday" },
  );
  assert.equal(result.stats.parents, 2);
  assert.equal(result.stats.children, 4);
  assert.equal(result.stats.orphanStops, 0);
});

test("bus pools feeds, dedupes stops and collapses variants", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-bus-"));
  await writeFeed(root, "bus-a", busFixtureA());
  await writeFeed(root, "bus-b", busFixtureB());
  const feeds: FeedVersion[] = ["bus-a", "bus-b"].map((id) => ({
    id,
    version: "test-bus-1",
    startDate: "20260101",
    endDate: "20261231",
    sha256: "x",
  }));
  const result = await normalizeBus(
    root,
    [{ feedId: "bus-a", dir: "bus-a" }, { feedId: "bus-b", dir: "bus-b" }],
    feeds,
    REFERENCE_DATE,
  );
  assert.deepEqual(result.stops.map((s) => s.id), ["bus:A2", "bus:B2", "bus:S1"]);
  const shared = result.stops.find((s) => s.id === "bus:S1");
  assert.deepEqual(shared?.feeds, ["bus-a", "bus-b"]);
  // First-wins keeps feed A's coords for the drifted shared stop.
  assert.deepEqual([shared?.lat, shared?.lon], [40.751, -73.989]);
  assert.equal(result.stats.uniqueStops, 3);
  assert.equal(result.stats.stopRows, 4);
  const b1 = result.routes.find((r) => r.id === "B1");
  assert.equal(b1?.variants, 2);
  assert.equal(result.stats.displayRoutes, 2);
  // V1 (4 trips) + V2 (1 trip) + HOL dates-only service (1 trip) pool into
  // one B1 edge with 6 samples.
  const edge = result.edges.find((e) => e.route === "B1");
  assert.deepEqual(
    { from: edge?.from, to: edge?.to, medianSec: edge?.medianSec, trips: edge?.trips },
    { from: "bus:S1", to: "bus:A2", medianSec: 240, trips: 6 },
  );
  const headway = result.headways.find((row) => row.route === "B1" && row.hour === 8);
  assert.equal(headway?.medianSec, 720);
  assert.equal(headway?.trips, 5);
  // HOL exists only in calendar_dates (2026-11-26, a Thursday). It is a holiday
  // service, not part of a typical weekday, so its trips stay out of the table.
  assert.deepEqual(result.stats.unrepresentedServices, ["HOL"]);
  assert.equal(result.stats.representativeDates.weekday?.services.join(), "WD");
});

test("spatial stubs link the subway fixture to the shared bus stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-stub-"));
  await writeFeed(root, "subway-mini", SUBWAY_FIXTURE);
  await writeFeed(root, "bus-a", busFixtureA());
  const subway = await normalizeSubway(root, "subway-mini", subwayFeed, REFERENCE_DATE);
  const bus = await normalizeBus(
    root,
    [{ feedId: "bus-a", dir: "bus-a" }],
    [{ id: "bus-a", version: "t", startDate: "20260101", endDate: "20261231", sha256: "x" }],
    REFERENCE_DATE,
  );
  const stubs = buildSpatialStubs(subway.stops, bus.stops);
  // Only S1 (~140 m from P1) is inside the 200 m radius, both directions.
  assert.equal(stubs.length, 2);
  assert.deepEqual(
    stubs.map((s) => `${s.from}→${s.to}`).sort(),
    ["bus:S1→subway:P1", "subway:P1→bus:S1"],
  );
});

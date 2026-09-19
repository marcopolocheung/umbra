/**
 * Pins the seeded NYC-scale generator the latency-attribution benches load.
 *
 * `e2e/fixtures/transitShards.ts` builds it for the browser bench's stub
 * network; this test holds the contract around it: the exact counts the
 * bench's scenario names quote, the digest chain the client would verify, the
 * pinned byte stream (one seed, one dataset — a before/after comparison cannot
 * drift because a fixture rewrote itself), and the geometry facts the
 * showcase scenarios rely on (the bus corridor answers at the waypoint pair,
 * scatter stops never crowd it out).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTransitShardFixture,
  TRANSIT_SCALE_COUNTS,
  transitFixtureArtifacts,
} from "../../../../e2e/fixtures/transitShards";
import {
  parseTransitManifest,
  parseTransitPointer,
  parseTransitShard,
  type TransitManifest,
  type TransitShard,
} from "../shardContract";
import { buildTrainGraphFromShards } from "../trainGraphAdapter";
import {
  findBestTrainRoute,
  nearestStations,
  stationServesMode,
  type TrainStation,
} from "../../trainGraph";

const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

// The browser bench's TRANSIT_WAYPOINT pair (`e2e/helpers/scenario.ts`),
// duplicated here rather than importing the Playwright-shaped helper module.
const WAYPOINT_A: [number, number] = [-73.9871, 40.7518];
const WAYPOINT_B: [number, number] = [-73.9809, 40.7562];

const haversineM = (a: [number, number], b: [number, number]) => {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la = (a[1] * Math.PI) / 180;
  const lb = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function fixture() {
  const artifacts = buildTransitShardFixture({});
  const pointer = parseTransitPointer(JSON.parse(artifacts.pointer));
  const manifest = parseTransitManifest(JSON.parse(artifacts.manifest), pointer.generation);
  const shards = manifest.shards.map((ref) =>
    parseTransitShard(JSON.parse(artifacts.shards.get(ref.key)!), ref),
  );
  return { artifacts, pointer, manifest, shards };
}

describe("buildTransitShardFixture — digest chain", () => {
  it("pins the exact byte stream it serves", () => {
    const { artifacts, pointer } = fixture();
    expect(sha256(artifacts.manifest)).toBe(pointer.manifestSha256);
    // One seed, one dataset. Updating this constant is a deliberate fixture
    // change; nothing routine gets to rewrite it silently.
    expect(pointer.manifestSha256).toBe(
      "5d6883ae892ff541252e304f7a3f268e3e155249fd62eed27abc2cc683b7788e",
    );
    for (const ref of JSON.parse(artifacts.manifest).shards) {
      expect(sha256(artifacts.shards.get(ref.key)!)).toBe(ref.sha256);
      expect(Buffer.byteLength(artifacts.shards.get(ref.key)!, "utf8")).toBe(ref.bytes);
    }
  });
});

describe("buildTransitShardFixture — pinned counts", () => {
  it("ships the station and shard counts the benchmark names", () => {
    const { manifest, shards } = fixture();
    const subway = shards.find((shard) => shard.kind === "subway")!;
    const busShards = shards.filter((shard) => shard.kind === "bus-shard");

    expect(subway.stops.length).toBe(TRANSIT_SCALE_COUNTS.subwayStations);
    expect(subway.routes.map((r) => r.id).sort()).toEqual(["1", "E"]);
    expect(busShards.length).toBe(TRANSIT_SCALE_COUNTS.busShards);
    expect(busShards.reduce((sum, shard) => sum + shard.stops.length, 0)).toBe(
      TRANSIT_SCALE_COUNTS.busStops,
    );
    const busRouteIds = busShards.flatMap((shard) => shard.routes.map((r) => r.id));
    expect(new Set(busRouteIds).size).toBe(busRouteIds.length);
    expect(busRouteIds.length).toBe(TRANSIT_SCALE_COUNTS.busLines);

    // Every manifest ref re-derives from the shard it describes — a count
    // mismatch would fail the client's own contract check on the browser side.
    expect(manifest.shards.length).toBe(busShards.length + 1);
  });

  it("builds 506 subway stations / 638 (station, line) states from shards", () => {
    const { manifest, shards } = fixture();
    const graph = buildTrainGraphFromShards(
      shards.filter((shard) => shard.kind === "subway"),
      manifest.headwayDates,
    )!;
    let states = 0;
    for (const station of graph.stations.values()) states += station.lines.length;
    expect(graph.stations.size).toBe(TRANSIT_SCALE_COUNTS.subwayStations);
    expect(states).toBe(TRANSIT_SCALE_COUNTS.trainStates);
    // Exactly `transferStations` of them serve both lines.
    const onTwoLines = [...graph.stations.values()].filter((s) => s.lines.length === 2).length;
    expect(onTwoLines).toBe(TRANSIT_SCALE_COUNTS.transferStations);
  });

  it("builds the full 16,390-stop bus graph and the combined graph", () => {
    const { manifest, shards } = fixture();
    const bus = buildTrainGraphFromShards(
      shards.filter((shard) => shard.kind === "bus-shard"),
      manifest.headwayDates,
    )!;
    expect(bus.stations.size).toBe(TRANSIT_SCALE_COUNTS.busStops);
    const combined = buildTrainGraphFromShards(shards, manifest.headwayDates)!;
    expect(combined.stations.size).toBe(
      TRANSIT_SCALE_COUNTS.subwayStations + TRANSIT_SCALE_COUNTS.busStops,
    );
  });
});

describe("buildTransitShardFixture — determinism", () => {
  it("reproduces the exact same bytes for the same inputs", () => {
    const one = buildTransitShardFixture({});
    const two = buildTransitShardFixture({});
    expect(one.pointer).toBe(two.pointer);
    expect(one.manifest).toBe(two.manifest);
    expect([...one.shards].map(([key, body]) => `${key}:${body}`)).toEqual(
      [...two.shards].map(([key, body]) => `${key}:${body}`),
    );
  });

  it("changes the bytes when the seed changes", () => {
    const one = buildTransitShardFixture({});
    const two = buildTransitShardFixture({ seed: 446 });
    expect(one.manifest).not.toBe(two.manifest);
    expect(one.shards.get("subway.json")).not.toBe(two.shards.get("subway.json"));
  });

  it("omits a mode cleanly when its count is zero", () => {
    const busOnly = buildTransitShardFixture({
      subwayStations: 0,
      busStops: TRANSIT_SCALE_COUNTS.busStops,
    });
    const manifest = JSON.parse(busOnly.manifest) as TransitManifest & {
      shards: { key: string }[];
    };
    expect(manifest.shards.some((ref) => ref.key === "subway.json")).toBe(false);
    expect(transitFixtureArtifacts("scale-bus-only").shards.has("subway.json")).toBe(false);
    expect(transitFixtureArtifacts("fixture").shards.has("subway.json")).toBe(true);
  });
});

describe("buildTransitShardFixture — geometry facts the bench relies on", () => {
  it("keeps the bus corridor the nearest five answers near both waypoints", () => {
    const { manifest, shards } = fixture();
    const bus = buildTrainGraphFromShards(
      shards.filter((shard) => shard.kind === "bus-shard"),
      manifest.headwayDates,
    )!;
    const serveBus = (station: TrainStation) => stationServesMode(bus, station, "bus");
    const onCorridor = (id: string) =>
      Number(id.split(":")[1]) < TRANSIT_SCALE_COUNTS.corridorStops;
    const nearestA = nearestStations(WAYPOINT_A, bus.stations, 5, 1500, serveBus);
    const nearestB = nearestStations(WAYPOINT_B, bus.stations, 5, 1500, serveBus);
    expect(nearestA.every((s) => onCorridor(s.id))).toBe(true);
    expect(nearestB.every((s) => onCorridor(s.id))).toBe(true);

    // The scatter region stays clear of the bench grid…
    for (const station of bus.stations.values()) {
      if (onCorridor(station.id)) continue;
      expect(haversineM(WAYPOINT_A, [station.lon, station.lat])).toBeGreaterThan(500);
      expect(haversineM(WAYPOINT_B, [station.lon, station.lat])).toBeGreaterThan(500);
    }
    // …and the corridor actually reaches the pair.
    expect(haversineM(WAYPOINT_A, [nearestA[0].lon, nearestA[0].lat])).toBeLessThan(400);
    expect(haversineM(WAYPOINT_B, [nearestB[0].lon, nearestB[0].lat])).toBeLessThan(400);
  });

  it("publishes hourly-9 Sunday headways for every line the search can board", () => {
    const { shards } = fixture();
    const corridorRows = (shard: TransitShard, routeId: string) =>
      shard.headways.filter((h) => h.route === routeId && h.dayType === "sunday" && h.hour === 9);
    const subway = shards.find((shard) => shard.kind === "subway")!;
    for (const direction of [0, 1]) {
      expect(corridorRows(subway, "E").some((h) => h.direction === direction)).toBe(true);
      expect(corridorRows(subway, "1").some((h) => h.direction === direction)).toBe(true);
    }
    const firstBus = shards.find((shard) => shard.kind === "bus-shard")!;
    for (const direction of [0, 1]) {
      expect(corridorRows(firstBus, "B1").some((h) => h.direction === direction)).toBe(true);
    }
  });

  it("finds a subway and a bus answer at the bench's waypoint pair (showcase guard)", () => {
    const { manifest, shards } = fixture();
    const combined = buildTrainGraphFromShards(shards, manifest.headwayDates)!;
    const departure = { at: new Date("2026-06-21T13:00:00Z"), utcOffsetMin: -240 };
    const subway = findBestTrainRoute(
      WAYPOINT_A,
      WAYPOINT_B,
      combined,
      1500,
      5,
      departure,
      "subway",
    );
    const bus = findBestTrainRoute(WAYPOINT_A, WAYPOINT_B, combined, 1500, 5, departure, "bus");
    expect(subway).not.toBeNull();
    expect(subway!.path.stationIds.length).toBeGreaterThanOrEqual(3);
    expect(bus).not.toBeNull();
    expect(bus!.path.stationIds.length).toBeGreaterThanOrEqual(3);
  });
});

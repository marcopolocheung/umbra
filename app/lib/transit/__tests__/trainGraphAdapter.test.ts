import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBestTrainRoute,
  headwayKey,
  nearestStations,
  readHeadway,
  trainDijkstra,
  TRAIN_SUN_EXPOSURE,
} from "../../trainGraph";
import type { HeadwayDates, TransitShard } from "../shardContract";
import { buildTrainGraphFromShards } from "../trainGraphAdapter";
import { fetchBestTrainGraph } from "../trainGraphSource";
import { clearTransitCache } from "../remoteTransit";

/**
 * A four-stop toy line plus a second line meeting it at a transfer. Stops sit
 * ~500 m apart and a hop takes 90 s, which is the real shard's own ratio
 * (subway:101 -> subway:103 is 544 m in 90 s) — so the train genuinely outruns
 * a walk, as it must for any of these comparisons to mean anything.
 *
 *   A ──500m/90s── B ──500m/90s── C        (route "1")
 *                                 │ transfer, 180 s
 *                                 D ──500m/90s── E     (route "2")
 */
function shard(overrides: Partial<TransitShard> = {}): TransitShard {
  const stops = [
    { id: "subway:A", name: "Alpha", lat: 40.7, lon: -74.0, changeSec: 180 },
    { id: "subway:B", name: "Bravo", lat: 40.7045, lon: -74.0 },
    { id: "subway:C", name: "Charlie", lat: 40.709, lon: -74.0, changeSec: 0 },
    { id: "subway:D", name: "Charlie", lat: 40.7091, lon: -74.0 },
    { id: "subway:E", name: "Echo", lat: 40.7136, lon: -74.0 },
    // Carried for a spatial transfer only — no edge serves it.
    { id: "bus:900", name: "Bus stop", lat: 40.7005, lon: -74.0, feeds: ["bus-m"] },
  ];
  const edge = (from: string, to: string, route: string, direction: number) => ({
    from, to, route, direction, medianSec: 90, trips: 100, distM: 500,
  });
  return {
    kind: "subway",
    stops,
    edges: [
      edge("subway:A", "subway:B", "1", 0), edge("subway:B", "subway:A", "1", 1),
      edge("subway:B", "subway:C", "1", 0), edge("subway:C", "subway:B", "1", 1),
      edge("subway:D", "subway:E", "2", 0), edge("subway:E", "subway:D", "2", 1),
    ],
    routes: [
      { id: "1", shortName: "1", longName: "First Line", type: 1, color: "D82233", textColor: "FFFFFF" },
      { id: "2", shortName: "2", longName: "Second Line", type: 1, color: "00933C", textColor: "FFFFFF" },
    ],
    headways: [],
    transfers: [
      { from: "subway:C", to: "subway:D", minSec: 180, kind: "gtfs" },
      { from: "subway:D", to: "subway:C", minSec: 180, kind: "gtfs" },
      { from: "subway:B", to: "bus:900", minSec: 57, kind: "spatial" },
    ],
    ...overrides,
  };
}

describe("buildTrainGraphFromShards", () => {
  it("keeps only stops an edge actually serves", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    // The bus stop ships with the shard but nothing loaded can route over it.
    expect([...graph.stations.keys()].sort()).toEqual([
      "subway:A", "subway:B", "subway:C", "subway:D", "subway:E",
    ]);
  });

  it("derives each station's lines from the edges that serve it", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.stations.get("subway:B")!.lines).toEqual(["1"]);
    expect(graph.stations.get("subway:E")!.lines).toEqual(["2"]);
  });

  it("carries route naming and colour through as CSS", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.lineColors.get("1")).toBe("#D82233");
    expect(graph.lineNames.get("1")).toBe("First Line");
    expect(graph.lineModes.get("1")).toBe("subway");
  });

it("prices edges in the seconds the feed publishes, not in metres", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const fromC = graph.adj.get("subway:C")!;
    // The scheduled run time, not distM / an assumed speed.
    expect(fromC.find((e) => e.to === "subway:B")).toMatchObject({ weightSec: 90, type: "rail" });
    // The agency's own min_transfer_time, not a stand-in penalty.
    expect(fromC.find((e) => e.to === "subway:D")).toMatchObject({
      weightSec: 180,
      type: "transfer",
    });
  });

  it("drops a transfer whose far end no loaded shard serves", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.adj.get("subway:B")!.some((e) => e.to === "bus:900")).toBe(false);
  });

  it("does not invent service in the reverse direction", () => {
    const oneWay = shard();
    oneWay.edges = oneWay.edges.filter((e) => !(e.from === "subway:B" && e.to === "subway:A"));
    const graph = buildTrainGraphFromShards([oneWay])!;
    expect(graph.adj.get("subway:A")!.some((e) => e.to === "subway:B")).toBe(true);
    expect(graph.adj.get("subway:B")!.some((e) => e.to === "subway:A")).toBe(false);
  });

  it("builds a graph from a bus shard, at its own exposure", () => {
    // This used to be refused outright, because defaulting an unpriced mode to
    // `subway` would have claimed a bus ride is fully shaded. It is priced now.
    const bus = shard({
      kind: "bus-shard",
      routes: [
        { id: "B1", shortName: "B1", longName: "Bus One", type: 3, color: "00AEEF", textColor: "FFFFFF" },
      ],
      edges: [
        { from: "subway:A", to: "subway:B", route: "B1", direction: 0, medianSec: 120, trips: 90, distM: 400 },
        { from: "subway:B", to: "subway:A", route: "B1", direction: 1, medianSec: 120, trips: 90, distM: 400 },
      ],
      transfers: [],
    });
    const graph = buildTrainGraphFromShards([bus]);
    expect(graph?.lineModes.get("B1")).toBe("bus");
    expect(graph?.adj.get("subway:A")?.some((e) => e.line === "B1")).toBe(true);
  });

  it("still refuses a shard of no recognised kind, and an empty set", () => {
    expect(buildTrainGraphFromShards([shard({ kind: "ferry-shard" })])).toBeNull();
    expect(buildTrainGraphFromShards([])).toBeNull();
  });

  it("prices a bus ride as a windowed vehicle, never as fully shaded", () => {
    // The whole reason the refusal existed: TRAIN_SUN_EXPOSURE.subway is 0.0,
    // so a bus falling through to it would be labelled underground.
    expect(TRAIN_SUN_EXPOSURE.bus).toBeGreaterThan(0);
    expect(TRAIN_SUN_EXPOSURE.bus).toBe(TRAIN_SUN_EXPOSURE.light_rail);
  });

  it("routes across a transfer with string ids end to end", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const path = trainDijkstra(graph, "subway:A", "subway:E")!;
    expect(path.stationIds).toEqual(["subway:A", "subway:B", "subway:C", "subway:D", "subway:E"]);
    expect(path.lines).toEqual(["1", "2"]);
    // 3 scheduled hops at 90 s + the published 180 s transfer.
    expect(path.totalSec).toBe(3 * 90 + 180);
    expect(path.segments.some((s) => s.type === "transfer")).toBe(true);
  });

  it("feeds findBestTrainRoute, which picks real entry and exit stations", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const best = findBestTrainRoute([-74.0, 40.7], [-74.0, 40.7136], graph)!;
    expect(best.entryStation.id).toBe("subway:A");
    expect(best.path.stationIds[0]).toBe("subway:A");
    expect(best.walkInDistM).toBeCloseTo(0, 5);
  });

  it("pays for a transfer when riding beats walking the same ground", () => {
    // The inverse of what the metres model did. Alighting early at Charlie and
    // walking the last 511 m costs 180 s of riding + 365 s on foot = 545 s;
    // staying on through the transfer to Echo costs 270 s + 180 s = 450 s. In
    // metres the walk was free-ish and Charlie always won, which is exactly the
    // seam this slice closes.
    const graph = buildTrainGraphFromShards([shard()])!;
    const best = findBestTrainRoute([-74.0, 40.7], [-74.0, 40.7136], graph)!;
    expect(best.exitStation.id).toBe("subway:E");
    expect(best.path.segments.some((seg) => seg.type === "transfer")).toBe(true);
    expect(best.totalCostSec).toBeCloseTo(450, 0);
  });
});

describe("fetchBestTrainGraph", () => {
  const base = "https://transit.test";

  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  type Handler = (url: string) => Promise<unknown>;

  /** Serves a real pointer/manifest/shard triple, plus an empty Overpass reply. */
  async function stubPublished(
    override?: (url: string, fallthrough: Handler) => Promise<unknown> | undefined,
  ): Promise<string[]> {
    const gen = "nyc-2026-09-16-f8c5f275d305";
    const encoder = new TextEncoder();
    const body = encoder.encode(JSON.stringify(shard()));
    const manifest = {
      generation: gen,
      createdAt: "2026-09-16T18:09:07.605Z",
      schedulesAsOf: {},
      headwayDates: { referenceDate: "20260916" },
      feeds: [],
      shards: [
        {
          key: "subway.json",
          bytes: body.byteLength,
          sha256: await sha256Hex(body),
          stops: shard().stops.length,
          edges: shard().edges.length,
          routes: shard().routes.length,
        },
      ],
      budgets: { shardBytes: 3_000_000, totalBytes: 15_000_000 },
      constants: {},
      notes: [],
    };
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const pointer = {
      version: 1,
      dataset: "nyc-transit",
      generation: gen,
      manifestPath: `transit/nyc/${gen}/manifest.json`,
      manifestSha256: await sha256Hex(manifestBytes),
    };
    const asBytes = (b: Uint8Array) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    });

    const calls: string[] = [];
    const serve: Handler = async (url) => {
      if (url.endsWith("/current.json")) return { ok: true, status: 200, json: async () => pointer };
      if (url.endsWith("/manifest.json")) return asBytes(manifestBytes);
      if (url.endsWith("subway.json")) return asBytes(body);
      // Anything else is the Overpass proxy.
      return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) };
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return (override?.(String(url), serve) ?? serve(String(url))) as unknown;
      }),
    );
    return calls;
  }

  beforeEach(() => clearTransitCache());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to Overpass when the dataset is not configured", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", "");
    const overpass = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", overpass);
    // No transit request is made at all; the only call is Overpass's own.
    const graph = await fetchBestTrainGraph(40.6, -74.1, 40.8, -73.9);
    expect(graph).toBeNull();
    for (const [url] of overpass.mock.calls) expect(String(url)).not.toContain("current.json");
  });

  it("routes on the shards where they serve the bbox", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", base);
    const calls = await stubPublished();
    const graph = await fetchBestTrainGraph(40.69, -74.01, 40.72, -73.99);
    expect([...(graph?.stations.keys() ?? [])]).toContain("subway:A");
    // Overpass is not consulted when the published data answers.
    expect(calls.some((u) => u.includes("overpass"))).toBe(false);
  });

  it("hands a bbox the shards do not cover back to Overpass", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", base);
    const calls = await stubPublished();
    // Tokyo. Without this gate, an NYC-only dataset would answer with Manhattan
    // stations, and the user would get no transit option at all.
    const graph = await fetchBestTrainGraph(35.6, 139.6, 35.8, 139.8);
    expect(graph).toBeNull();
    expect(calls.some((u) => u.includes("overpass"))).toBe(true);
  });

  it("hands a bbox holding a single station back to Overpass too", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", base);
    const calls = await stubPublished();
    // A transit option needs somewhere to board AND somewhere to alight.
    const graph = await fetchBestTrainGraph(40.6995, -74.001, 40.7005, -73.999);
    expect(graph).toBeNull();
    expect(calls.some((u) => u.includes("overpass"))).toBe(true);
  });

  it("keeps the walking route when the published data is corrupt", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", base);
    const calls = await stubPublished((url) =>
      url.endsWith("subway.json")
        ? Promise.resolve({
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode("[]").buffer,
          })
        : undefined,
    );
    // A shard that fails its byte contract must cost the walking route nothing.
    await expect(fetchBestTrainGraph(40.69, -74.01, 40.72, -73.99)).resolves.toBeNull();
    expect(calls.some((u) => u.includes("overpass"))).toBe(true);
  });
});

// ─── What the router needs and the adapter used to drop ─────────────────────

/**
 * The manifest's own statement of which morning each table's hours 24+ fall on.
 * Shaped exactly as the published document: one block per dataset, keyed by the
 * shard `kind` beside it.
 */
const headwayDates = {
  referenceDate: "20260916",
  subway: {
    weekday: {
      date: "20260916",
      nextDate: "20260917",
      nextDayType: "weekday",
      matchingDates: 33,
      candidateDates: 33,
    },
    saturday: {
      date: "20260919",
      nextDate: "20260920",
      nextDayType: "sunday",
      matchingDates: 7,
      candidateDates: 7,
    },
  },
} as unknown as HeadwayDates;

describe("buildTrainGraphFromShards: the boarding terms", () => {
  it("carries the feed's change cost, and carries its absence as an absence", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.stations.get("subway:A")!.changeSec).toBe(180);
    // A cross-platform interchange: 0 is a real published value.
    expect(graph.stations.get("subway:C")!.changeSec).toBe(0);
    // And a station the feed prices no change for keeps no number at all — the
    // two are different statements, and only one of them is zero (#384).
    expect("changeSec" in graph.stations.get("subway:B")!).toBe(false);
  });

  it("carries a station's published doors, an empty list included", () => {
    const base = shard();
    const stops = base.stops.map((stop) =>
      stop.id === "subway:A"
        ? { ...stop, entrances: [{ lat: 40.7002, lon: -74.0003, exitOnly: true as const }] }
        : stop.id === "subway:C"
          ? { ...stop, entrances: [] }
          : stop,
    );
    const graph = buildTrainGraphFromShards([shard({ stops })])!;
    expect(graph.stations.get("subway:A")!.entrances).toEqual([
      { lat: 40.7002, lon: -74.0003, exitOnly: true },
    ]);
    expect(graph.stations.get("subway:C")!.entrances).toEqual([]);
    expect("entrances" in graph.stations.get("subway:B")!).toBe(false);
  });

  it("keys each rail edge to the direction it runs", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.adj.get("subway:A")!.find((e) => e.to === "subway:B")!.direction).toBe(0);
    expect(graph.adj.get("subway:B")!.find((e) => e.to === "subway:A")!.direction).toBe(1);
  });

  it("builds the headway table out of the shard and the manifest together", () => {
    const withHeadways = shard({
      headways: [
        { route: "1", direction: 0, dayType: "weekday", hour: 10, medianSec: 240, trips: 12, services: 1 },
      ],
    });
    const graph = buildTrainGraphFromShards([withHeadways], headwayDates)!;
    expect(graph.headways!.medianSec.get(headwayKey("1", 0, "weekday", 10))).toBe(240);
    // Without `nextDayType` an overnight boarding cannot be priced at all, and
    // it lives in the manifest rather than the shard.
    expect(graph.headways!.nextDayType.get("saturday")).toBe("sunday");
  });

  it("prices no wait at all when the manifest is not passed", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    expect(graph.headways!.nextDayType.size).toBe(0);
  });

  it("sends a rider to the slower line when it is the one that turns up", () => {
    // Two ways from A to C: route "1" via B in 180 s, route "3" direct in 200 s.
    const twoRoutes = shard({
      edges: [
        ...shard().edges,
        { from: "subway:A", to: "subway:C", route: "3", direction: 0, medianSec: 200, trips: 90, distM: 1000 },
      ],
      routes: [
        ...shard().routes,
        { id: "3", shortName: "3", longName: "Third Line", type: 1, color: "0039A6", textColor: "FFFFFF" },
      ],
      headways: [
        // The 1 every twenty minutes against the 3 every minute.
        { route: "1", direction: 0, dayType: "weekday", hour: 10, medianSec: 1200, trips: 3, services: 1 },
        { route: "3", direction: 0, dayType: "weekday", hour: 10, medianSec: 60, trips: 60, services: 1 },
      ],
    });
    const graph = buildTrainGraphFromShards([twoRoutes], headwayDates)!;
    const at = new Date("2026-09-16T14:00:00Z"); // 10:00 in New York

    expect(trainDijkstra(graph, "subway:A", "subway:C")!.lines).toEqual(["1"]);
    const timed = trainDijkstra(graph, "subway:A", "subway:C", { at, utcOffsetMin: -240 })!;
    expect(timed.lines).toEqual(["3"]);
    expect(timed.waitSec).toBe(30);
  });
});

// ─── Spatial transfer stubs ─────────────────────────────────────────────────

describe("spatial transfer stubs", () => {
  /**
   * The published subway shard carries 150 agency transfers and 5,172 spatial
   * stubs — every bus stop within 200 m of a station, nearest 10 kept, timed at
   * 1.4 m/s on a straight line, with nothing checking a walkable path exists.
   * They are inert today only because no loaded edge serves a bus stop, so they
   * would all go live in one step when bus shards load.
   */
  function withServedStub(): TransitShard {
    const base = shard();
    return {
      ...base,
      // Give the bus stop an edge of its own, so it becomes a station and the
      // "no loaded edge serves it" accident no longer hides the stub.
      edges: [
        ...base.edges,
        { from: "bus:900", to: "bus:901", route: "B1", direction: 0, medianSec: 120, trips: 50, distM: 400 },
        { from: "bus:901", to: "bus:900", route: "B1", direction: 1, medianSec: 120, trips: 50, distM: 400 },
      ],
      stops: [...base.stops, { id: "bus:901", name: "Bus stop 2", lat: 40.6975, lon: -74.0, feeds: ["bus-m"] }],
      routes: [
        ...base.routes,
        { id: "B1", shortName: "B1", longName: "Bus One", type: 1, color: "000000", textColor: "FFFFFF" },
      ],
    };
  }

  it("refuses a spatial stub even when both of its endpoints are served", () => {
    // The point of the test: today they drop out incidentally, and this must
    // hold for the reason we chose instead — that a straight-line guess is not
    // something to route a rider across.
    const graph = buildTrainGraphFromShards([withServedStub()]);
    expect(graph?.stations.has("bus:900")).toBe(true);
    const fromB = graph?.adj.get("subway:B") ?? [];
    expect(fromB.some((e) => e.to === "bus:900")).toBe(false);
  });

  it("keeps the agency's own transfer, and says where it came from", () => {
    const graph = buildTrainGraphFromShards([withServedStub()]);
    const transfer = (graph?.adj.get("subway:C") ?? []).find((e) => e.to === "subway:D");
    expect(transfer?.type).toBe("transfer");
    expect(transfer?.weightSec).toBe(180);
    // Provenance survives to the graph edge; it used to be dropped here, which
    // left a guess indistinguishable from an agency fact once loaded.
    expect(transfer?.transferKind).toBe("gtfs");
  });

  it("still routes over the agency transfer with stubs refused", () => {
    // Refusing the stubs must not cost the subway network its real interchange.
    const path = trainDijkstra(buildTrainGraphFromShards([withServedStub()])!, "subway:A", "subway:E");
    expect(path?.stationIds).toEqual([
      "subway:A", "subway:B", "subway:C", "subway:D", "subway:E",
    ]);
    expect(path?.totalSec).toBe(3 * 90 + 180);
  });
});

// ─── Walked subway↔bus changes ──────────────────────────────────────────────

describe("walked transfers", () => {
  /**
   * The toy line, plus a bus route whose two stops each sit by a subway station:
   *
   *   bus:900 ─(walked)─ A ── B ── C          (route "1")
   *                                          bus:900 ── bus:901   (route "B1")
   *   bus:901 ─(walked)─ C ─(gtfs)─ D ─(walked)─ bus:902 ── bus:903   (route "B2")
   *
   * Every stop pair that is joined is joined by a walk the producer routed;
   * none is spatial. C and D are one complex joined by the agency's transfer.
   */
  function withWalks(): TransitShard {
    const base = shard();
    const walk = (station: string, stop: string, minSec: number) => [
      { from: station, to: stop, minSec, kind: "walked" as const },
      { from: stop, to: station, minSec, kind: "walked" as const },
    ];
    const bus = (from: string, to: string, route: string) => [
      { from, to, route, direction: 0, medianSec: 600, trips: 50, distM: 1000 },
      { from: to, to: from, route, direction: 1, medianSec: 600, trips: 50, distM: 1000 },
    ];
    return {
      ...base,
      stops: [
        ...base.stops,
        { id: "bus:901", name: "Stop by Charlie", lat: 40.7092, lon: -74.0005, feeds: ["bus-m"] },
        { id: "bus:902", name: "Stop by Charlie 2", lat: 40.7088, lon: -74.0005, feeds: ["bus-m"] },
        { id: "bus:903", name: "Far stop", lat: 40.72, lon: -74.01, feeds: ["bus-m"] },
      ],
      edges: [...base.edges, ...bus("bus:900", "bus:901", "B1"), ...bus("bus:902", "bus:903", "B2")],
      routes: [
        ...base.routes,
        { id: "B1", shortName: "B1", longName: "Bus One", type: 3, color: "00AEEF", textColor: "FFFFFF" },
        { id: "B2", shortName: "B2", longName: "Bus Two", type: 3, color: "00AEEF", textColor: "FFFFFF" },
      ],
      transfers: [
        ...base.transfers.filter((t) => t.kind !== "spatial"),
        ...walk("subway:A", "bus:900", 60),
        ...walk("subway:C", "bus:901", 45),
        ...walk("subway:D", "bus:902", 50),
      ],
    };
  }

  it("routes on a walked change and says where it came from", () => {
    const graph = buildTrainGraphFromShards([withWalks()])!;
    const walk = graph.adj.get("subway:A")!.find((e) => e.to === "bus:900");
    expect(walk).toMatchObject({ type: "transfer", weightSec: 60, transferKind: "walked" });
  });

  it("changes from the subway onto a bus, paying the walk and the bus's wait", () => {
    const graph = buildTrainGraphFromShards([withWalks()])!;
    // Alpha to the far stop: ride the 1 to Charlie, change to D, walk to
    // bus:902, ride B2.
    const path = trainDijkstra(graph, "subway:A", "bus:903")!;
    expect(path.stationIds).toEqual([
      "subway:A", "subway:B", "subway:C", "subway:D", "bus:902", "bus:903",
    ]);
    expect(path.lines).toEqual(["1", "B2"]);
    expect(path.totalSec).toBe(2 * 90 + 180 + 50 + 600);
  });

  it("never starts or ends a journey on a walked change", () => {
    const graph = buildTrainGraphFromShards([withWalks()])!;
    // bus:900 → A is a walk, then the 1: the walk in belongs on the street.
    const fromStop = trainDijkstra(graph, "bus:900", "subway:C");
    expect(fromStop).not.toBeNull();
    expect(fromStop!.stationIds[1]).not.toBe("subway:A");
    // Ending C → bus:901 on foot would hand the last walk to the bus stop.
    const toStop = trainDijkstra(graph, "subway:A", "bus:901");
    expect(toStop).not.toBeNull();
    expect(toStop!.stationIds.at(-2)).not.toBe("subway:C");
    // Nor may the agency's C → D transfer launder a walk into the first move:
    // from C, the only way onto B2 without riding is C → D → walk.
    const viaComplex = trainDijkstra(graph, "subway:C", "bus:903");
    expect(viaComplex?.stationIds.slice(0, 3)).not.toEqual(["subway:C", "subway:D", "bus:902"]);
  });

  it("does not change bus to bus through a station's doors", () => {
    const graph = buildTrainGraphFromShards([withWalks()])!;
    // B1 to Charlie's stop, then walk bus:901 → C, take the agency's C → D
    // transfer and walk D → bus:902 onto B2: two walked changes with no ride
    // between them, which is a synthesised bus-to-bus transfer.
    const path = trainDijkstra(graph, "bus:900", "bus:903");
    expect(path).not.toBeNull();
    // Whatever it costs instead, it never walks C → D → out again unridden.
    expect(path!.stationIds.join(" ")).not.toContain("bus:901 subway:C subway:D bus:902");
  });
});

// ─── Bus beside subway ──────────────────────────────────────────────────────

describe("bus and subway in one graph", () => {
  /** A bus route whose stops crowd the subway station at subway:A. */
  function busShard(): TransitShard {
    const stops = Array.from({ length: 8 }, (_, i) => ({
      id: `bus:${900 + i}`,
      name: `Stop ${i}`,
      // ~17 m apart and packed just south of subway:A at 40.7/-74.0 — the
      // crowding that makes an unfiltered nearest-station search return
      // nothing but bus stops, which is what a real Manhattan block looks like.
      lat: 40.6988 + i * 0.00015,
      lon: -74.0,
      feeds: ["bus-m"],
    }));
    return {
      kind: "bus-shard",
      stops,
      edges: stops.slice(0, -1).flatMap((s, i) => [
        { from: s.id, to: stops[i + 1].id, route: "M1", direction: 0, medianSec: 120, trips: 60, distM: 40 },
        { from: stops[i + 1].id, to: s.id, route: "M1", direction: 1, medianSec: 120, trips: 60, distM: 40 },
      ]),
      routes: [
        { id: "M1", shortName: "M1", longName: "Bus One", type: 3, color: "00AEEF", textColor: "FFFFFF" },
      ],
      headways: [],
      transfers: [],
    };
  }

  it("still finds the subway option when bus stops crowd the station", () => {
    // Unfiltered, the five nearest "stations" to this point are all bus stops
    // within a block, so every candidate Dijkstra would be a bus one and the
    // subway would never be offered at all.
    const graph = buildTrainGraphFromShards([shard(), busShard()])!;
    // Standing mid-block on the bus chain, ~110 m short of subway:A — close
    // enough to walk to the station, far enough that five bus stops are nearer.
    const a: [number, number] = [-74.0, 40.699];
    const b: [number, number] = [-74.0, 40.7136];

    // The precondition: unfiltered, every candidate is a bus stop.
    const unfiltered = nearestStations(a, graph.stations, 5, 1500);
    expect(unfiltered.every((s) => s.id.startsWith("bus:"))).toBe(true);

    // Unfiltered, the result is not a worse option — it is *no option at all*.
    // Every entry candidate is a bus stop, every exit candidate near the far
    // end is a subway station, and since the spatial stubs are refused the two
    // are disconnected components, so all 25 searches fail. Per-mode search is
    // a correctness requirement here, not a nicer way to show two cards.
    expect(findBestTrainRoute(a, b, graph, 1500, 5)).toBeNull();

    const subwayRoute = findBestTrainRoute(a, b, graph, 1500, 5, {}, "subway");
    expect(subwayRoute?.entryStation.id.startsWith("subway:")).toBe(true);
    expect(subwayRoute?.exitStation.id).toBe("subway:E");
  });

  it("answers per mode, so the rider can compare them", () => {
    const graph = buildTrainGraphFromShards([shard(), busShard()])!;
    const a: [number, number] = [-74.0, 40.6989];
    const b: [number, number] = [-74.0, 40.6999];
    const busRoute = findBestTrainRoute(a, b, graph, 1500, 5, {}, "bus");
    expect(busRoute?.entryStation.id.startsWith("bus:")).toBe(true);
    expect(busRoute?.path.lines).toEqual(["M1"]);
  });

  it("does not let one feed's covered hours speak for another's", () => {
    // The subway tables reach weekday hour 10; the bus tables here do not. A
    // single shared coveredHours set makes the bus route's silence read as "no
    // bus is scheduled", and boardingCost then refuses the edge outright.
    const withSubwayHours = shard({
      headways: [
        { route: "1", direction: 0, dayType: "weekday", hour: 10, medianSec: 300, trips: 12, services: 1 },
      ],
    });
    const graph = buildTrainGraphFromShards([withSubwayHours, busShard()])!;
    const at = new Date("2026-09-17T14:00:00Z"); // 10:00 New York
    expect(readHeadway(graph.headways, "M1", 0, at, -240).kind).toBe("unreadable");
    expect(readHeadway(graph.headways, "1", 0, at, -240).kind).toBe("published");
  });
});

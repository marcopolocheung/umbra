import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBestTrainRoute, trainDijkstra, TRANSFER_PENALTY_M } from "../../trainGraph";
import type { TransitShard } from "../shardContract";
import { buildTrainGraphFromShards } from "../trainGraphAdapter";
import { fetchBestTrainGraph } from "../trainGraphSource";
import { clearTransitCache } from "../remoteTransit";

/**
 * A four-stop toy line plus a second line meeting it at a transfer:
 *
 *   A ──100m── B ──100m── C        (route "1")
 *                 │ transfer
 *                 D ──100m── E     (route "2")
 */
function shard(overrides: Partial<TransitShard> = {}): TransitShard {
  const stops = [
    { id: "subway:A", name: "Alpha", lat: 40.7, lon: -74.0, changeSec: 180 },
    { id: "subway:B", name: "Bravo", lat: 40.701, lon: -74.0 },
    { id: "subway:C", name: "Charlie", lat: 40.702, lon: -74.0, changeSec: 0 },
    { id: "subway:D", name: "Charlie", lat: 40.7021, lon: -74.0 },
    { id: "subway:E", name: "Echo", lat: 40.703, lon: -74.0 },
    // Carried for a spatial transfer only — no edge serves it.
    { id: "bus:900", name: "Bus stop", lat: 40.7005, lon: -74.0, feeds: ["bus-m"] },
  ];
  const edge = (from: string, to: string, route: string, direction: number) => ({
    from, to, route, direction, medianSec: 60, trips: 100, distM: 100,
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

  it("weights rail edges by published distance and transfers by the shared penalty", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const fromC = graph.adj.get("subway:C")!;
    expect(fromC.find((e) => e.to === "subway:B")).toMatchObject({ weight: 100, type: "rail" });
    expect(fromC.find((e) => e.to === "subway:D")).toMatchObject({
      weight: TRANSFER_PENALTY_M,
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

  it("refuses a bus shard rather than pricing it as a train", () => {
    // TRAIN_SUN_EXPOSURE has no bus figure; defaulting to `subway` would claim
    // a bus ride is fully shaded.
    expect(buildTrainGraphFromShards([shard({ kind: "bus-shard" })])).toBeNull();
    expect(buildTrainGraphFromShards([])).toBeNull();
  });

  it("routes across a transfer with string ids end to end", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const path = trainDijkstra(graph, "subway:A", "subway:E")!;
    expect(path.stationIds).toEqual(["subway:A", "subway:B", "subway:C", "subway:D", "subway:E"]);
    expect(path.lines).toEqual(["1", "2"]);
    // 3 rail hops at 100 m + one transfer penalty.
    expect(path.totalDistM).toBe(300 + TRANSFER_PENALTY_M);
    expect(path.segments.some((s) => s.type === "transfer")).toBe(true);
  });

  it("feeds findBestTrainRoute, which picks real entry and exit stations", () => {
    const graph = buildTrainGraphFromShards([shard()])!;
    const best = findBestTrainRoute([-74.0, 40.7], [-74.0, 40.703], graph)!;
    expect(best.entryStation.id).toBe("subway:A");
    expect(best.path.stationIds[0]).toBe("subway:A");
    expect(best.walkInDistM).toBeCloseTo(0, 5);
  });

  it("will not pay for a transfer while the cost model is in metres", () => {
    // `distM` is straight-line, and the walk legs are priced in the same
    // metres, so riding one more stop can never beat walking it — and the flat
    // 300 m transfer penalty is pure surcharge on top. The route therefore
    // alights at Charlie and walks, even though Echo is the exact destination.
    // This is the metres model showing its seam, not the adapter misbehaving:
    // S3 puts both sides in seconds, where a train outruns a walk.
    const graph = buildTrainGraphFromShards([shard()])!;
    const best = findBestTrainRoute([-74.0, 40.7], [-74.0, 40.703], graph)!;
    expect(best.exitStation.id).toBe("subway:C");
    expect(best.path.segments.some((seg) => seg.type === "transfer")).toBe(false);
  });
});

describe("fetchBestTrainGraph", () => {
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
});

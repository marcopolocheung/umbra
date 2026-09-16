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

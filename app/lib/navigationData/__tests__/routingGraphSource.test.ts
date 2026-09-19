/**
 * Source selection for the static walking graph: configured NYC requests with
 * Overpass forced to fail must still route from verified static shards, while
 * unconfigured builds, outside-support bboxes, and missing or corrupt shards take the
 * current Overpass path — with exactly one Overpass request per fallback.
 *
 * Hermetic: navigation bytes are served through the loader's `fetchFn` seam
 * with real digests, and the Overpass proxy is a stubbed global fetch. The
 * Overpass cache cannot mask a duplicated upstream call here: every fallback
 * case uses a bbox that no earlier test has fetched, and none nests inside an
 * earlier fallback's cached bbox (a cache hit would read as zero calls).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dijkstra, haversineMeters } from "../../routing";
import type { GeoBounds } from "../shardContract";
import { acquireNavigationSnapshot, clearNavigationCache } from "../remoteNavigation";
import { fetchBestRoutingGraph, TRANSIT_ACCESS_RADIUS_M } from "../routingGraphSource";

const generation = "nyc-2026-09-18-abcdef123456";
const base = "https://navigation.test";

// Support covers two z14-shaped Midtown cells; nothing else.
const supportBounds: GeoBounds = { south: 40.74, west: -74.0, north: 40.76, east: -73.98 };

interface CellSpec {
  key: string;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  nodes: { id: number; lat: number; lon: number; isIntersection: boolean }[];
  edges: { id: string; from: number; to: number; tags: Record<string, string> }[];
}

const cellWest: CellSpec = {
  key: "streets/cell-west.json",
  geometryBounds: { south: 40.74, west: -74.0, north: 40.76, east: -73.99 },
  supportBounds: { south: 40.74, west: -74.0, north: 40.76, east: -73.989 },
  nodes: [
    { id: 101, lat: 40.75, lon: -73.995, isIntersection: false },
    { id: 102, lat: 40.751, lon: -73.995, isIntersection: true },
    { id: 103, lat: 40.751, lon: -73.9895, isIntersection: false },
  ],
  edges: [
    { id: "w1-fwd", from: 101, to: 102, tags: { highway: "residential" } },
    { id: "w1-bwd", from: 102, to: 101, tags: { highway: "residential" } },
    { id: "seam-fwd", from: 102, to: 103, tags: { highway: "footway" } },
  ],
};

const cellEast: CellSpec = {
  key: "streets/cell-east.json",
  geometryBounds: { south: 40.74, west: -73.99, north: 40.76, east: -73.98 },
  supportBounds: { south: 40.74, west: -73.991, north: 40.76, east: -73.98 },
  nodes: [
    { id: 103, lat: 40.751, lon: -73.9895, isIntersection: true },
    { id: 104, lat: 40.752, lon: -73.985, isIntersection: false },
    // Ghost endpoint across the seam, owned by the west cell.
    { id: 102, lat: 40.751, lon: -73.995, isIntersection: true },
  ],
  edges: [
    { id: "seam-bwd", from: 103, to: 102, tags: { highway: "footway" } },
    { id: "w2-fwd", from: 103, to: 104, tags: { highway: "residential" } },
    { id: "w2-bwd", from: 104, to: 103, tags: { highway: "residential" } },
  ],
};

// Straight-line metres between both cells' corners, by the same haversine the
// producer uses — parity with the Overpass path needs no tolerance.
function distM(from: { lon: number; lat: number }, to: { lon: number; lat: number }): number {
  return haversineMeters([from.lon, from.lat], [to.lon, to.lat]);
}

function shardBody(cell: CellSpec): Record<string, unknown> {
  const byId = new Map(cell.nodes.map((node) => [node.id, node]));
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds: cell.geometryBounds,
    supportBounds: cell.supportBounds,
    nodes: cell.nodes,
    edges: cell.edges.map((edge) => ({
      ...edge,
      distanceM: distM(byId.get(edge.from)!, byId.get(edge.to)!),
    })),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Published {
  pointer: Record<string, unknown>;
  manifestBytes: Uint8Array;
  bodies: Map<string, Uint8Array>;
}

/** Self-consistent pointer/manifest/shards with real digests. */
async function publish(cells: CellSpec[]): Promise<Published> {
  const encoder = new TextEncoder();
  const bodies = new Map<string, Uint8Array>();
  const streetShards = [];
  for (const cell of cells) {
    const bytes = encoder.encode(JSON.stringify(shardBody(cell)));
    bodies.set(cell.key, bytes);
    streetShards.push({
      key: cell.key,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      geometryBounds: cell.geometryBounds,
      supportBounds: cell.supportBounds,
      nodes: cell.nodes.length,
      edges: cell.edges.length,
    });
  }
  const manifestObj = {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: "2026-09-18T12:00:00.000Z",
    supportBounds,
    recipe: "test-fixture-v1",
    sources: [
      {
        id: "test",
        release: "test",
        url: "https://example.invalid/source",
        bytes: 1000,
        timestamp: "2026-09-18T12:00:00Z",
        sha256: "1".repeat(64),
      },
    ],
    noticesPath: `navigation/nyc/${generation}/notices.json`,
    noticesSha256: "2".repeat(64),
    streetShards,
    // The manifest contract requires a non-empty building list; the street
    // source must never request it.
    buildingShards: [
      {
        key: "buildings/cell-west.json",
        bytes: 128,
        sha256: "3".repeat(64),
        geometryBounds: cellWest.geometryBounds,
        supportBounds: cellWest.supportBounds,
        buildings: 0,
        rings: 0,
        missingHeights: 0,
        maxHeightM: 0,
      },
    ],
    budgets: { streetShardBytes: 5_000_000, buildingShardBytes: 5_000_000, totalBytes: 10_000_000 },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifestObj));
  return {
    pointer: {
      version: 1,
      dataset: "nyc-navigation",
      generation,
      manifestPath: `navigation/nyc/${generation}/manifest.json`,
      manifestSha256: await sha256Hex(manifestBytes),
    },
    manifestBytes,
    bodies,
  };
}

interface StubCall {
  url: string;
}

/** Serves published navigation bytes; optionally fails listed shard keys. */
function stubNavigationFetch(published: Published, failKeys: Set<string> = new Set()) {
  const calls: StubCall[] = [];
  const fetchFn = (async (url: unknown) => {
    const href = String(url);
    calls.push({ url: href });
    const bytes = (body: Uint8Array) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const copy = new Uint8Array(body.byteLength);
        copy.set(body);
        return copy.buffer;
      },
    });
    if (href.endsWith("/current.json"))
      return bytes(new TextEncoder().encode(JSON.stringify(published.pointer)));
    if (href.endsWith("/manifest.json")) return bytes(published.manifestBytes);
    const key = href.split(`/navigation/nyc/${generation}/`)[1];
    if (!key || failKeys.has(key))
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = published.bodies.get(key);
    if (!body)
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return bytes(body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const overpassWay = {
  type: "way",
  id: 9,
  nodes: [501, 502],
  geometry: [
    { lat: 40.7, lon: -73.99 },
    { lat: 40.701, lon: -73.99 },
  ],
  tags: { highway: "residential" },
};

/** Counts Overpass proxy calls; answers one fixed way per bbox. */
function stubOverpass() {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ elements: [overpassWay] }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  clearNavigationCache();
  vi.stubEnv("VITE_NAVIGATION_BASE", base);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchBestRoutingGraph", () => {
  it("serves the static graph without touching Overpass, which is armed to fail", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    // Tripwire, not the assertion: any fallback attempt rejects here instead
    // of succeeding quietly through Overpass.
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("proxy down"));

    const graph = await fetchBestRoutingGraph(
      40.745,
      -73.998,
      40.755,
      -73.982,
      undefined,
      { fetchFn },
    );

    expect(graph.nodes.size).toBe(4);
    expect(graph.nodes.get(103)?.isIntersection).toBe(true);
    expect(graph.adj.get(102)?.map((edge) => edge.toId).sort()).toEqual([101, 103]);
    // And the fetched graph routes: the west–east chain is one component.
    const route = dijkstra(graph, 101, 104, 0);
    expect(route?.nodeIds).toEqual([101, 102, 103, 104]);
    expect(route?.distanceM).toBeGreaterThan(0);
    expect(overpassCalls).toHaveLength(0);
    // Streets verify; buildings are never requested by this source.
    expect(calls.some((call) => call.url.includes("buildings/"))).toBe(false);
  });

  it("preserves current behavior when unconfigured", async () => {
    vi.stubEnv("VITE_NAVIGATION_BASE", "");
    let navigated = 0;
    const fetchFn = (async () => {
      navigated += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(40.7, -73.99, 40.701, -73.989, undefined, {
      fetchFn,
    });

    expect(navigated).toBe(0);
    expect(overpassCalls).toHaveLength(1);
    expect(graph.nodes.size).toBe(2);
  });

  it("falls back outside verified support without fetching shards", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    // Madrid: far outside the NYC support bounds.
    const graph = await fetchBestRoutingGraph(40.41, -3.71, 40.42, -3.69, undefined, {
      fetchFn,
    });

    expect(graph.nodes.size).toBe(2);
    expect(overpassCalls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("streets/"))).toBe(false);
  });

  it("falls back for the whole request when one required shard fails", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn } = stubNavigationFetch(published, new Set(["streets/cell-east.json"]));
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(
      40.745,
      -73.998,
      40.755,
      -73.982,
      undefined,
      { fetchFn },
    );

    expect(graph.nodes.size).toBe(2);
    expect(overpassCalls).toHaveLength(1);
  });

  it("falls back for the whole request when one required shard is corrupt", async () => {
    const published = await publish([cellWest, cellEast]);
    // Same byte count, different bytes: the manifest digest no longer matches.
    const body = published.bodies.get("streets/cell-east.json")!;
    const tampered = new Uint8Array(body);
    tampered[tampered.length - 1] ^= 0x01;
    published.bodies.set("streets/cell-east.json", tampered);
    const { fetchFn } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(
      // South of the missing-shard case's bbox, so no cache entry contains it.
      40.744,
      -73.996,
      40.75,
      -73.983,
      undefined,
      { fetchFn },
    );

    expect(graph.nodes.size).toBe(2);
    expect(overpassCalls).toHaveLength(1);
  });

  it("does not launch Overpass fallback when the caller aborts", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchBestRoutingGraph(40.745, -73.998, 40.755, -73.982, controller.signal, { fetchFn }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(overpassCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("aborts a mid-flight shard load without launching Overpass fallback", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn: baseFetch } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    const controller = new AbortController();

    // Pointer and manifest resolve; the street shards hang until the test ends.
    let shardSeen!: () => void;
    const shardRequested = new Promise<void>((resolve) => {
      shardSeen = resolve;
    });
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("streets/")) {
        shardSeen();
        // Hang: the abort below must reject the waiter, not the fetch.
        await new Promise<never>(() => undefined);
      }
      return baseFetch(href, init);
    }) as unknown as typeof fetch;

    const pending = fetchBestRoutingGraph(
      40.746,
      -73.997,
      40.756,
      -73.983,
      controller.signal,
      { fetchFn },
    );
    await shardRequested;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(overpassCalls).toHaveLength(0);
  });

  it("serves a caller-pinned snapshot without re-reading the pointer", async () => {
    // The building provider binds this same snapshot: one calculation, one
    // generation, even if the pointer is promoted between the two loads.
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    const snapshot = await acquireNavigationSnapshot({ fetchFn });
    expect(snapshot).not.toBeNull();
    const pointerCalls = calls.filter((call) => call.url.endsWith("/current.json")).length;

    const graph = await fetchBestRoutingGraph(40.745, -73.998, 40.755, -73.982, undefined, {
      fetchFn,
      snapshot,
    });

    expect(graph.nodes.size).toBe(4);
    expect(overpassCalls).toHaveLength(0);
    expect(calls.filter((call) => call.url.endsWith("/current.json")).length).toBe(pointerCalls);
  });

  it("treats an explicit null snapshot as static-off and goes straight to Overpass", async () => {
    const published = await publish([cellWest, cellEast]);
    const { calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    // Tripwire: a pinned-null call must not touch the navigation dataset at all.
    const tripwire = (async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;

    const graph = await fetchBestRoutingGraph(
      // Fresh bbox no earlier test fetched, so the Overpass cache cannot mask
      // a missing upstream call.
      40.71,
      -73.985,
      40.711,
      -73.984,
      undefined,
      {
        fetchFn: tripwire,
        snapshot: null,
      },
    );

    expect(graph.nodes.size).toBe(2);
    expect(overpassCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("bounds the transit access radius to the candidate reach plus the door box", () => {
    // 1500 m candidate radius plus the 400 m entrance-match box, with a small
    // snap margin. A wider radius silently multiplies every transit
    // calculation's shard selection; a narrower one strands far doors off the
    // static graph.
    expect(TRANSIT_ACCESS_RADIUS_M).toBeGreaterThanOrEqual(1900);
    expect(TRANSIT_ACCESS_RADIUS_M).toBeLessThanOrEqual(2500);
  });

  // The route-stop bbox below ends in the west cell in every zoned test: it
  // intersects the west geometry ([-74.0, -73.99]) and stops short of the
  // east cell's west edge (-73.99) without touching it.

  it("covers a selected station outside the route-stop bbox through a bounded access zone", async () => {
    // A subway entrance across the street-shard seam: the walk corridor ends
    // in the west cell while boarding happens in the east one.
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(
      40.745,
      -73.999,
      40.755,
      -73.992,
      undefined,
      {
        fetchFn,
        accessZones: [{ south: 40.746, west: -73.989, north: 40.754, east: -73.983 }],
      },
    );

    expect(graph.nodes.size).toBe(4);
    // The seam-crossing walk the access leg needs is one component.
    const route = dijkstra(graph, 101, 104, 0);
    expect(route?.nodeIds).toEqual([101, 102, 103, 104]);
    expect(overpassCalls).toHaveLength(0);
    // Streets verify; buildings are never requested by this source.
    expect(calls.some((call) => call.url.includes("buildings/"))).toBe(false);
  });

  it("covers a destination-side bus stop outside the first endpoint cell", async () => {
    // Mirror image: the corridor ends in the east cell while alighting stands
    // in the west one. A bus stop carries no entrance geometry — the stop
    // point itself is the boarding point — so the same zone union covers it.
    const published = await publish([cellWest, cellEast]);
    const { fetchFn } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(
      40.745,
      -73.988,
      40.755,
      -73.981,
      undefined,
      {
        fetchFn,
        accessZones: [{ south: 40.746, west: -73.999, north: 40.754, east: -73.994 }],
      },
    );

    expect(graph.nodes.size).toBe(4);
    const route = dijkstra(graph, 104, 101, 0);
    expect(route?.nodeIds).toEqual([104, 103, 102, 101]);
    expect(overpassCalls).toHaveLength(0);
  });

  it("leaves walk-only requests on exactly the route bbox", async () => {
    // No accessZones: the east shard is never fetched and the graph holds the
    // west cell alone. Trips at or below the transit distance gate take this
    // path, so their routing is identical to before.
    const published = await publish([cellWest, cellEast]);
    const { fetchFn, calls } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(40.745, -73.999, 40.755, -73.992, undefined, {
      fetchFn,
    });

    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has(104)).toBe(false);
    expect(calls.some((call) => call.url.includes("cell-east"))).toBe(false);
    expect(overpassCalls).toHaveLength(0);
  });

  it("treats an access zone past support as best-effort, not failure", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(40.745, -73.999, 40.755, -73.992, undefined, {
      fetchFn,
      // Madrid: far outside the NYC support bounds.
      accessZones: [{ south: 40.41, west: -3.71, north: 40.42, east: -3.69 }],
    });

    expect(graph.nodes.size).toBe(3);
    expect(overpassCalls).toHaveLength(0);
  });

  it("falls back over the exact route bbox when an access-zone shard fails", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn } = stubNavigationFetch(published, new Set(["streets/cell-east.json"]));
    const overpassCalls = stubOverpass();

    const graph = await fetchBestRoutingGraph(
      // Fresh bbox west of every earlier fallback's cached bbox, so the
      // Overpass cache cannot mask a duplicated upstream call.
      40.745,
      -73.999,
      40.755,
      -73.992,
      undefined,
      {
        fetchFn,
        accessZones: [{ south: 40.746, west: -73.989, north: 40.754, east: -73.983 }],
      },
    );

    // Whole-request fallback: the Overpass graph answers, exactly once, for
    // the route bbox — zones never widen the public-mirror query.
    expect(graph.nodes.size).toBe(2);
    expect(overpassCalls).toHaveLength(1);
    const body = decodeURIComponent(overpassCalls[0]?.body ?? "");
    expect(body).toContain("40.745,-73.999,40.755,-73.992");
    expect(body).not.toContain("-73.989");
    expect(body).not.toContain("-73.983");
    expect(body).not.toContain("40.746");
  });

  it("does not launch fallback for zoned requests when the caller aborts", async () => {
    const published = await publish([cellWest, cellEast]);
    const { fetchFn } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchBestRoutingGraph(40.745, -73.999, 40.755, -73.992, controller.signal, {
        fetchFn,
        accessZones: [{ south: 40.746, west: -73.989, north: 40.754, east: -73.983 }],
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(overpassCalls).toHaveLength(0);
  });
});

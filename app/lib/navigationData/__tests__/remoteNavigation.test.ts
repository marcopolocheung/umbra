import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GeoBounds,
  NavigationBuildingShardRef,
  NavigationStreetShardRef,
} from "../shardContract";
import {
  acquireNavigationSnapshot,
  clearNavigationCache,
  loadNavigationPointer,
  loadNavigationSelection,
  loadNavigationStreetShard,
  navigationApiBase,
  selectNavigationShards,
  type NavigationSnapshot,
} from "../remoteNavigation";

const generation = "nyc-2026-09-18-abcdef123456";
const nextGeneration = "nyc-2026-10-01-abcdef123456";
const base = "https://navigation.test";

const supportBounds: GeoBounds = { south: 40.7, west: -74.03, north: 40.78, east: -73.95 };

// ─── Fixture bodies ───────────────────────────────────────────────────────────

function streetShardA(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "streets",
    geometryBounds: { south: 40.73, west: -74.0, north: 40.76, east: -73.98 },
    supportBounds: { south: 40.725, west: -74.005, north: 40.765, east: -73.975 },
    nodes: [
      { id: 101, lat: 40.74, lon: -73.99, isIntersection: true },
      { id: 102, lat: 40.75, lon: -73.985, isIntersection: true },
      // Ghost endpoint across the seam: owned by cell B, referenced here.
      { id: 201, lat: 40.75, lon: -73.975, isIntersection: false },
    ],
    edges: [
      {
        id: "w1-fwd",
        from: 101,
        to: 102,
        distanceM: 120,
        tags: { highway: "residential", surface: "asphalt" },
      },
      { id: "w1-bwd", from: 102, to: 101, distanceM: 120, tags: { highway: "residential" } },
      {
        id: "seam-fwd",
        from: 102,
        to: 201,
        distanceM: 90,
        tags: { highway: "footway", foot: "yes" },
      },
    ],
  };
}

function streetShardB(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "streets",
    geometryBounds: { south: 40.73, west: -73.977, north: 40.76, east: -73.96 },
    supportBounds: { south: 40.725, west: -73.985, north: 40.765, east: -73.955 },
    nodes: [
      { id: 201, lat: 40.75, lon: -73.975, isIntersection: true },
      { id: 202, lat: 40.745, lon: -73.965, isIntersection: false },
    ],
    edges: [
      { id: "w2-fwd", from: 201, to: 202, distanceM: 80, tags: { highway: "steps" } },
      { id: "w2-bwd", from: 202, to: 201, distanceM: 80, tags: { highway: "steps" } },
    ],
  };
}

function buildingShardA(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "buildings",
    geometryBounds: { south: 40.74, west: -73.995, north: 40.755, east: -73.985 },
    supportBounds: { south: 40.735, west: -74.0, north: 40.76, east: -73.98 },
    buildings: [
      {
        id: "100001",
        rings: [
          [
            [-73.99, 40.745],
            [-73.988, 40.745],
            [-73.988, 40.747],
            [-73.99, 40.747],
            [-73.99, 40.745],
          ],
        ],
        heightM: 30,
        heightSource: "source",
        featureCode: 2100,
        status: "active",
      },
    ],
  };
}

function buildingShardB(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "buildings",
    geometryBounds: { south: 40.74, west: -73.975, north: 40.755, east: -73.96 },
    supportBounds: { south: 40.735, west: -73.98, north: 40.76, east: -73.955 },
    buildings: [
      {
        id: "100002",
        rings: [
          [
            [-73.97, 40.745],
            [-73.968, 40.745],
            [-73.968, 40.747],
            [-73.97, 40.747],
            [-73.97, 40.745],
          ],
        ],
        heightM: null,
        heightSource: "unknown",
        featureCode: 2100,
        status: "active",
      },
    ],
  };
}

function bodiesFor(gen: string): Record<string, unknown> {
  return {
    "streets/cell-a.json": streetShardA(gen),
    "streets/cell-b.json": streetShardB(gen),
    "buildings/cell-a.json": buildingShardA(gen),
    "buildings/cell-b.json": buildingShardB(gen),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Published {
  pointer: Record<string, unknown>;
  manifestObj: {
    streetShards: NavigationStreetShardRef[];
    buildingShards: NavigationBuildingShardRef[];
    [key: string]: unknown;
  };
  manifestBytes: Uint8Array;
  bodies: Map<string, Uint8Array>;
}

function countBuildings(body: unknown): {
  buildings: number;
  rings: number;
  missingHeights: number;
  maxHeightM: number;
} {
  const buildings = (body as { buildings: { rings: unknown[]; heightM: number | null }[] })
    .buildings;
  return {
    buildings: buildings.length,
    rings: buildings.reduce((sum, building) => sum + building.rings.length, 0),
    missingHeights: buildings.filter((building) => building.heightM === null).length,
    maxHeightM: buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0),
  };
}

/** Builds a self-consistent pointer/manifest/shard set with real digests. */
async function publish(bodies: Record<string, unknown>, gen = generation): Promise<Published> {
  const encoder = new TextEncoder();
  const encoded = new Map<string, Uint8Array>();
  const streetShards: NavigationStreetShardRef[] = [];
  const buildingShards: NavigationBuildingShardRef[] = [];
  for (const [key, body] of Object.entries(bodies)) {
    const bytes = encoder.encode(JSON.stringify(body));
    encoded.set(key, bytes);
    const record = body as {
      geometryBounds: GeoBounds;
      supportBounds: GeoBounds;
      nodes?: unknown[];
      edges?: unknown[];
    };
    if (key.startsWith("streets/")) {
      streetShards.push({
        key,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        geometryBounds: record.geometryBounds,
        supportBounds: record.supportBounds,
        nodes: record.nodes?.length ?? 0,
        edges: record.edges?.length ?? 0,
      });
    } else {
      buildingShards.push({
        key,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        geometryBounds: record.geometryBounds,
        supportBounds: record.supportBounds,
        ...countBuildings(body),
      });
    }
  }
  const manifestObj: Published["manifestObj"] = {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    createdAt: "2026-09-18T12:00:00.000Z",
    supportBounds,
    recipe: "test-fixture-v1",
    sources: [
      {
        id: "test",
        release: "test",
        url: "https://example.invalid/source",
        sha256: "1".repeat(64),
      },
    ],
    noticesPath: `navigation/nyc/${gen}/notices.json`,
    noticesSha256: "2".repeat(64),
    streetShards,
    buildingShards,
    budgets: { streetShardBytes: 5_000_000, buildingShardBytes: 5_000_000, totalBytes: 10_000_000 },
  };
  const published: Published = {
    pointer: {
      version: 1,
      dataset: "nyc-navigation",
      generation: gen,
      manifestPath: `navigation/nyc/${gen}/manifest.json`,
      manifestSha256: "",
    },
    manifestObj,
    manifestBytes: new Uint8Array(),
    bodies: encoded,
  };
  await repackManifest(published);
  return published;
}

/** Re-encodes the (possibly mutated) manifest and re-signs the pointer. */
async function repackManifest(published: Published): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(published.manifestObj));
  published.manifestBytes = bytes;
  published.pointer.manifestSha256 = await sha256Hex(bytes);
}

/** Replaces one shard body and rebuilds its manifest ref (bytes, digest, counts, bounds). */
async function repackShard(published: Published, key: string, body: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  published.bodies.set(key, bytes);
  const record = body as { geometryBounds: GeoBounds; supportBounds: GeoBounds };
  const streetRef = published.manifestObj.streetShards.find((ref) => ref.key === key);
  if (streetRef) {
    const nodes = (body as { nodes: unknown[] }).nodes.length;
    const edges = (body as { edges: unknown[] }).edges.length;
    Object.assign(streetRef, {
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      geometryBounds: record.geometryBounds,
      supportBounds: record.supportBounds,
      nodes,
      edges,
    });
  } else {
    const ref = published.manifestObj.buildingShards.find((entry) => entry.key === key);
    if (!ref) throw new Error(`test bug: unknown shard key ${key}`);
    Object.assign(ref, {
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      geometryBounds: record.geometryBounds,
      supportBounds: record.supportBounds,
      ...countBuildings(body),
    });
  }
  await repackManifest(published);
}

// ─── Fake fetch ───────────────────────────────────────────────────────────────

interface StubCall {
  url: string;
  cache?: unknown;
}

interface StubResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function bytesResponse(bytes: Uint8Array): StubResponse {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
  };
}

/**
 * Serves whatever `getCurrent` points at for the pointer, and every listed
 * generation for manifest/shard paths — so a test can promote the generation
 * mid-flight by reassigning one variable while old-generation URLs keep
 * serving old bytes.
 */
function stubFetch(
  getCurrent: () => Published,
  options: { failKeys?: Set<string>; generations?: Published[] } = {},
) {
  const calls: StubCall[] = [];
  const failKeys = options.failKeys ?? new Set<string>();
  const byGeneration = new Map(
    (options.generations ?? [getCurrent()]).map((item) => [
      item.pointer.generation as string,
      item,
    ]),
  );
  const fetchFn = (async (url: unknown, init?: { cache?: unknown; headers?: unknown }) => {
    const href = String(url);
    calls.push({ url: href, cache: init?.cache });
    if (href.endsWith("/current.json"))
      return bytesResponse(new TextEncoder().encode(JSON.stringify(getCurrent().pointer)));
    const match = href.match(/\/navigation\/nyc\/([^/]+)\/(.+)$/);
    const published = match ? byGeneration.get(match[1]) : undefined;
    if (!published || !match)
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const key = match[2];
    if (key === "manifest.json") return bytesResponse(published.manifestBytes);
    if (failKeys.has(key))
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = published.bodies.get(key);
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return bytesResponse(body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function mustAcquire(fetchFn: typeof fetch): Promise<NavigationSnapshot> {
  const snapshot = await acquireNavigationSnapshot({ fetchFn });
  if (!snapshot) throw new Error("test bug: expected a snapshot");
  return snapshot;
}

function shardCalls(calls: StubCall[], key: string): StubCall[] {
  return calls.filter((call) => call.url.endsWith(`/${key}`));
}

beforeEach(() => {
  clearNavigationCache();
  vi.stubEnv("VITE_NAVIGATION_BASE", base);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Configuration ────────────────────────────────────────────────────────────

describe("navigation configuration", () => {
  it("is off and never fetches without configuration", async () => {
    vi.stubEnv("VITE_NAVIGATION_BASE", "");
    let fetched = 0;
    const fetchFn = (async () => {
      fetched += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    expect(navigationApiBase()).toBeUndefined();
    await expect(loadNavigationPointer({ fetchFn })).resolves.toBeNull();
    await expect(acquireNavigationSnapshot({ fetchFn })).resolves.toBeNull();
    await expect(
      loadNavigationSelection(
        { generation, manifest: {} as never, base },
        { south: 40.74, west: -73.99, north: 40.75, east: -73.98 },
        { fetchFn },
      ),
    ).rejects.toThrow(/not configured/);
    expect(fetched).toBe(0);
  });

  it("rejects a base URL that is not a bare HTTPS origin", () => {
    vi.stubEnv("VITE_NAVIGATION_BASE", "http://navigation.test");
    expect(() => navigationApiBase()).toThrow(/HTTPS/);
    vi.stubEnv("VITE_NAVIGATION_BASE", "https://navigation.test/navigation");
    expect(() => navigationApiBase()).toThrow(/without a path/);
    vi.stubEnv("VITE_NAVIGATION_BASE", "https://navigation.test/?token=abc");
    expect(() => navigationApiBase()).toThrow(/without a path/);
    vi.stubEnv("VITE_NAVIGATION_BASE", "https://navigation.test/#fragment");
    expect(() => navigationApiBase()).toThrow(/without a path/);
    vi.stubEnv("VITE_NAVIGATION_BASE", "not a url");
    expect(() => navigationApiBase()).toThrow(/HTTPS URL/);
  });
});

// ─── Pointer and manifest ─────────────────────────────────────────────────────

describe("navigation pointer and manifest", () => {
  it("loads a published pointer and manifest at the generation-bound URLs", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const snapshot = await acquireNavigationSnapshot({ fetchFn });
    expect(snapshot?.generation).toBe(generation);
    expect(snapshot?.manifest.streetShards).toHaveLength(2);
    expect(snapshot?.manifest.buildingShards).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${base}/navigation/nyc/current.json`);
    expect(calls[1]?.url).toBe(`${base}/navigation/nyc/${generation}/manifest.json`);
  });

  it("sends strict JSON headers and honors the response cache policy", async () => {
    let observedInit: { headers?: unknown; cache?: unknown } | undefined;
    const published = await publish(bodiesFor(generation));
    const { fetchFn } = stubFetch(() => published);
    const recording = (async (url: unknown, init?: { headers?: unknown; cache?: unknown }) => {
      if (String(url).endsWith("/current.json")) observedInit = init;
      return fetchFn(url as string, init as RequestInit);
    }) as unknown as typeof fetch;
    await acquireNavigationSnapshot({ fetchFn: recording });
    expect(observedInit).toMatchObject({ cache: "default", headers: { Accept: "application/json" } });
  });

  it("caches immutable bytes with force-cache", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    await loadNavigationSelection(
      snapshot,
      { south: 40.74, west: -73.995, north: 40.75, east: -73.985 },
      { fetchFn },
    );
    const modes = new Map(calls.map((call) => [call.url, call.cache]));
    expect(modes.get(`${base}/navigation/nyc/${generation}/manifest.json`)).toBe("force-cache");
    expect(modes.get(`${base}/navigation/nyc/${generation}/streets/cell-a.json`)).toBe("force-cache");
    expect(modes.get(`${base}/navigation/nyc/${generation}/buildings/cell-a.json`)).toBe(
      "force-cache",
    );
  });

  it("rejects a pointer that is not valid JSON", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn } = stubFetch(() => published);
    // Serve raw non-JSON pointer bytes for current.json.
    const raw = (async (url: unknown, init?: object) => {
      if (String(url).endsWith("/current.json"))
        return bytesResponse(new TextEncoder().encode("{not json"));
      return fetchFn(url as string, init as RequestInit);
    }) as unknown as typeof fetch;
    await expect(loadNavigationPointer({ fetchFn: raw })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an oversize pointer", async () => {
    const published = await publish(bodiesFor(generation));
    const padding = new TextEncoder().encode(" ".repeat(9_000));
    const pointerBytes = new TextEncoder().encode(JSON.stringify(published.pointer));
    const padded = new Uint8Array([...padding, ...pointerBytes]);
    published.pointer.manifestSha256 = await sha256Hex(padded);
    const { fetchFn } = stubFetch(() => published);
    const raw = (async (url: unknown, init?: object) => {
      if (String(url).endsWith("/current.json")) return bytesResponse(padded);
      return fetchFn(url as string, init as RequestInit);
    }) as unknown as typeof fetch;
    await expect(loadNavigationPointer({ fetchFn: raw })).rejects.toThrow(/budget/);
  });

  it("rejects a pointer naming another dataset", async () => {
    const published = await publish(bodiesFor(generation));
    published.pointer.dataset = "nyc-transit";
    const { fetchFn } = stubFetch(() => published);
    await expect(loadNavigationPointer({ fetchFn })).rejects.toThrow(/pointer/);
  });

  it("refuses a manifest whose bytes do not match the pointer digest", async () => {
    const published = await publish(bodiesFor(generation));
    published.pointer.manifestSha256 = "b".repeat(64);
    const { fetchFn } = stubFetch(() => published);
    await expect(acquireNavigationSnapshot({ fetchFn })).rejects.toThrow(/manifest hash/);
  });

  it("refuses an oversize manifest", async () => {
    const published = await publish(bodiesFor(generation));
    const padding = new TextEncoder().encode(" ".repeat(600_000));
    const padded = new Uint8Array([...padding, ...published.manifestBytes]);
    published.manifestBytes = padded;
    published.pointer.manifestSha256 = await sha256Hex(padded);
    const { fetchFn } = stubFetch(() => published);
    await expect(acquireNavigationSnapshot({ fetchFn })).rejects.toThrow(/budget/);
  });

  it("refuses a manifest describing a different generation", async () => {
    const published = await publish(bodiesFor(generation));
    published.manifestObj.generation = nextGeneration;
    await repackManifest(published);
    const { fetchFn } = stubFetch(() => published);
    await expect(acquireNavigationSnapshot({ fetchFn })).rejects.toThrow(/mismatch|invalid/);
  });
});

// ─── Selection ────────────────────────────────────────────────────────────────

describe("selectNavigationShards", () => {
  async function snapshotManifest() {
    const published = await publish(bodiesFor(generation));
    const { fetchFn } = stubFetch(() => published);
    return (await mustAcquire(fetchFn)).manifest;
  }

  it("selects the street cell intersecting the bbox", async () => {
    const manifest = await snapshotManifest();
    const selection = selectNavigationShards(manifest, {
      south: 40.74,
      west: -73.995,
      north: 40.75,
      east: -73.985,
    });
    expect(selection?.streets.map((ref) => ref.key)).toEqual(["streets/cell-a.json"]);
  });

  it("treats a touching cell edge as intersecting", async () => {
    const manifest = await snapshotManifest();
    // West edge sits exactly on cell A's east edge and cell B's west edge.
    const selection = selectNavigationShards(manifest, {
      south: 40.74,
      west: -73.98,
      north: 40.75,
      east: -73.97,
    });
    expect(selection?.streets.map((ref) => ref.key).sort()).toEqual([
      "streets/cell-a.json",
      "streets/cell-b.json",
    ]);
  });

  it("selects a building cell outside the bbox but within caster reach", async () => {
    const manifest = await snapshotManifest();
    // Cell B's west edge (-73.975) is ~340 m east of the bbox east edge.
    const near = { south: 40.745, west: -73.999, north: 40.75, east: -73.979 };
    expect(selectNavigationShards(manifest, near)?.buildings.map((ref) => ref.key).sort()).toEqual([
      "buildings/cell-a.json",
      "buildings/cell-b.json",
    ]);
    // With no reach, only the overlapping cell is selected.
    expect(
      selectNavigationShards(manifest, near, 0)?.buildings.map((ref) => ref.key),
    ).toEqual(["buildings/cell-a.json"]);
  });

  it("returns null without fetching for requests outside verified support", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    const tokyo = { south: 35.65, west: 139.68, north: 35.7, east: 139.78 };
    expect(selectNavigationShards(snapshot.manifest, tokyo)).toBeNull();
    await expect(loadNavigationSelection(snapshot, tokyo, { fetchFn })).resolves.toBeNull();
    expect(calls.some((call) => call.url.includes("/streets/"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/buildings/"))).toBe(false);
  });

  it("returns empty maps for a covered area with nothing published", async () => {
    const manifest = await snapshotManifest();
    // Inside support, southwest of every cell's geometry.
    const selection = selectNavigationShards(manifest, {
      south: 40.71,
      west: -74.02,
      north: 40.72,
      east: -74.01,
    });
    expect(selection).not.toBeNull();
    expect(selection?.streets).toEqual([]);
    expect(selection?.buildings).toEqual([]);
  });
});

// ─── Shard loading and verification ───────────────────────────────────────────

describe("navigation shard loading", () => {
  // Inside street cell A and building cell A; building cell B sits ~340 m
  // east of the bbox east edge, inside default caster reach.
  const bbox: GeoBounds = { south: 40.745, west: -73.993, north: 40.75, east: -73.979 };

  async function loadedSelection() {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    const selection = await loadNavigationSelection(snapshot, bbox, { fetchFn });
    if (!selection) throw new Error("test bug: expected a selection");
    return { published, fetchFn, calls, snapshot, selection };
  }

  it("loads verified streets and buildings through one snapshot", async () => {
    const { calls, selection } = await loadedSelection();
    expect([...selection.streets.keys()]).toEqual(["streets/cell-a.json"]);
    expect([...selection.buildings.keys()].sort()).toEqual([
      "buildings/cell-a.json",
      "buildings/cell-b.json",
    ]);
    const edge = selection.streets.get("streets/cell-a.json")?.edges.find((e) => e.id === "w1-fwd");
    expect(edge?.distanceM).toBe(120);
    expect(edge?.tags.surface).toBe("asphalt");
    expect(
      selection.buildings.get("buildings/cell-a.json")?.buildings[0]?.heightM,
    ).toBe(30);
    expect(
      selection.buildings.get("buildings/cell-b.json")?.buildings[0]?.heightM,
    ).toBeNull();
    expect(calls[0]?.url).toBe(`${base}/navigation/nyc/current.json`);
    expect(
      calls.some((call) => call.url === `${base}/navigation/nyc/${generation}/streets/cell-a.json`),
    ).toBe(true);
  });

  it("reuses the decoded cache instead of refetching", async () => {
    const { fetchFn, calls, snapshot } = await loadedSelection();
    await loadNavigationSelection(snapshot, bbox, { fetchFn });
    await acquireNavigationSnapshot({ fetchFn });
    // Pointer re-reads every acquisition (mutable); the manifest and every
    // shard serves from the generation cache after the first load.
    expect(calls.filter((call) => call.url.endsWith("/current.json"))).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith("/manifest.json"))).toHaveLength(1);
    expect(shardCalls(calls, "streets/cell-a.json")).toHaveLength(1);
    expect(shardCalls(calls, "buildings/cell-b.json")).toHaveLength(1);
  });

  it("coalesces concurrent identical requests into one fetch", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    const results = await Promise.all([
      loadNavigationSelection(snapshot, bbox, { fetchFn }),
      loadNavigationSelection(snapshot, bbox, { fetchFn }),
      loadNavigationSelection(snapshot, bbox, { fetchFn }),
    ]);
    expect(shardCalls(calls, "streets/cell-a.json")).toHaveLength(1);
    expect(shardCalls(calls, "buildings/cell-a.json")).toHaveLength(1);
    const [first, second, third] = results;
    expect(second?.streets.get("streets/cell-a.json")).toBe(first?.streets.get("streets/cell-a.json"));
    expect(third?.buildings.get("buildings/cell-b.json")).toBe(
      first?.buildings.get("buildings/cell-b.json"),
    );
  });

  it("lets one waiter abort without corrupting the shared fetch", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn: serve } = stubFetch(() => published);
    let streetAFetches = 0;
    let releaseStreetA!: (response: StubResponse) => void;
    const gate = new Promise<StubResponse>((resolve) => {
      releaseStreetA = resolve;
    });
    const streetBytes = published.bodies.get("streets/cell-a.json") as Uint8Array;
    const fetchFn = (async (url: unknown, init?: object) => {
      if (String(url).endsWith("streets/cell-a.json")) {
        streetAFetches += 1;
        return gate;
      }
      return serve(url as string, init as RequestInit);
    }) as unknown as typeof fetch;

    const snapshot = await mustAcquire(fetchFn);
    const controller = new AbortController();
    const aborted = loadNavigationSelection(snapshot, bbox, {
      fetchFn,
      signal: controller.signal,
    });
    const surviving = loadNavigationSelection(snapshot, bbox, { fetchFn });
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);
    releaseStreetA(bytesResponse(streetBytes));
    const selection = await surviving;
    expect(selection?.streets.get("streets/cell-a.json")?.edges).toHaveLength(3);
    // Both waiters shared the one gated request; the abort added no retry.
    expect(streetAFetches).toBe(1);
  });

  it("preserves a pre-aborted caller without fetching", async () => {
    const published = await publish(bodiesFor(generation));
    const { fetchFn, calls } = stubFetch(() => published);
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireNavigationSnapshot({ fetchFn, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    const snapshot = await mustAcquire(fetchFn);
    await expect(
      loadNavigationSelection(snapshot, bbox, {
        fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    // Only the un-aborted acquisition fetched; the aborted calls added nothing.
    expect(calls.filter((call) => call.url.endsWith("/current.json"))).toHaveLength(1);
  });

  it("fails the whole selection when one required shard fails", async () => {
    const published = await publish(bodiesFor(generation));
    const failKeys = new Set(["buildings/cell-b.json"]);
    const { fetchFn, calls } = stubFetch(() => published, { failKeys });
    const snapshot = await mustAcquire(fetchFn);
    await expect(loadNavigationSelection(snapshot, bbox, { fetchFn })).rejects.toThrow(
      /buildings\/cell-b\.json/,
    );

    // Nothing partial escapes: healing the shard makes the same snapshot
    // succeed, reusing the verified shards and refetching only the healed one.
    failKeys.clear();
    const selection = await loadNavigationSelection(snapshot, bbox, { fetchFn });
    expect([...(selection?.buildings.keys() ?? [])].sort()).toEqual([
      "buildings/cell-a.json",
      "buildings/cell-b.json",
    ]);
    expect(shardCalls(calls, "buildings/cell-a.json")).toHaveLength(1);
    expect(shardCalls(calls, "buildings/cell-b.json")).toHaveLength(2);
  });

  it("refuses a shard whose bytes do not match the manifest digest", async () => {
    const published = await publish(bodiesFor(generation));
    const bytes = published.bodies.get("streets/cell-a.json") as Uint8Array;
    const corrupted = Uint8Array.from(bytes);
    corrupted[corrupted.byteLength - 1] ^= 0xff;
    published.bodies.set("streets/cell-a.json", corrupted);
    const { fetchFn } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    // Length is unchanged, so this fails on the digest, not the byte count.
    await expect(loadNavigationSelection(snapshot, bbox, { fetchFn })).rejects.toThrow(
      /hash mismatch/,
    );
  });

  it("refuses a shard whose length contradicts the manifest", async () => {
    const published = await publish(bodiesFor(generation));
    const bytes = published.bodies.get("streets/cell-a.json") as Uint8Array;
    published.bodies.set("streets/cell-a.json", bytes.slice(0, bytes.byteLength - 10));
    const { fetchFn } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    await expect(loadNavigationSelection(snapshot, bbox, { fetchFn })).rejects.toThrow(
      /byte contract/,
    );
  });

  it("refuses a shard whose counts contradict the manifest", async () => {
    const published = await publish(bodiesFor(generation));
    published.manifestObj.streetShards[0].nodes += 1;
    await repackManifest(published);
    const { fetchFn } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    await expect(loadNavigationSelection(snapshot, bbox, { fetchFn })).rejects.toThrow(
      /street shard/,
    );
  });

  it("refuses a shard filed under the wrong cell bounds", async () => {
    const published = await publish(bodiesFor(generation));
    // Bytes, digest, and counts still verify, and the ref still parses (the
    // mutated geometry stays inside the ref support); only the ref bounds
    // disagree with the filed shard.
    published.manifestObj.streetShards[0].geometryBounds = {
      south: 40.731,
      west: -74.0,
      north: 40.76,
      east: -73.98,
    };
    await repackManifest(published);
    const { fetchFn } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    const ref = snapshot.manifest.streetShards[0] as NavigationStreetShardRef;
    await expect(loadNavigationStreetShard(snapshot, ref, { fetchFn })).rejects.toThrow(
      /bounds mismatch/,
    );
  });

  it("rejects an unsafe shard path before any request", async () => {
    const { fetchFn, calls, snapshot } = await loadedSelection();
    const ref = {
      ...(snapshot.manifest.streetShards[0] as NavigationStreetShardRef),
      key: "../../evil.json",
    };
    await expect(loadNavigationStreetShard(snapshot, ref, { fetchFn })).rejects.toThrow(
      /safe object path/,
    );
    expect(calls.some((call) => call.url.includes("evil"))).toBe(false);
  });

  it("never mixes generations inside one snapshot", async () => {
    const published = await publish(bodiesFor(generation));
    // Same counts and bounds, but the shard body names the next generation.
    await repackShard(published, "streets/cell-a.json", streetShardA(nextGeneration));
    const { fetchFn } = stubFetch(() => published);
    const snapshot = await mustAcquire(fetchFn);
    await expect(loadNavigationSelection(snapshot, bbox, { fetchFn })).rejects.toThrow(
      /street shard/,
    );
  });

  it("drops the cache atomically on generation rollover", async () => {
    const first = await publish(bodiesFor(generation));
    const second = await publish(bodiesFor(nextGeneration), nextGeneration);
    let current = first;
    const { fetchFn, calls } = stubFetch(() => current, { generations: [first, second] });
    const oldSnapshot = await mustAcquire(fetchFn);
    const oldSelection = await loadNavigationSelection(oldSnapshot, bbox, { fetchFn });
    expect(oldSelection?.streets.get("streets/cell-a.json")?.generation).toBe(generation);

    current = second;
    const newSnapshot = await mustAcquire(fetchFn);
    expect(newSnapshot.generation).toBe(nextGeneration);
    const newSelection = await loadNavigationSelection(newSnapshot, bbox, { fetchFn });
    // Nothing carries over: the new generation refetches its own bytes.
    expect(newSelection?.streets.get("streets/cell-a.json")?.generation).toBe(nextGeneration);
    expect(
      calls.filter((call) => call.url === `${base}/navigation/nyc/${nextGeneration}/streets/cell-a.json`),
    ).toHaveLength(1);

    // The pinned old snapshot still serves the old generation, unmixed.
    const pinned = await loadNavigationSelection(oldSnapshot, bbox, { fetchFn });
    expect(pinned?.streets.get("streets/cell-a.json")?.generation).toBe(generation);
    expect(pinned?.buildings.get("buildings/cell-b.json")?.generation).toBe(generation);
  });
});

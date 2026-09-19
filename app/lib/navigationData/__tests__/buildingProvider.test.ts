/**
 * Static NYC building prisms (Checkpoint 4): verified-shard selection by
 * caster reach, whole-footprint conversion through `prismsFromFootprints`,
 * atomic publication, generation pinning, and composition with both canopy
 * paths through the unchanged shadow field.
 *
 * Hermetic: navigation bytes are served through the loader's `fetchFn` seam
 * with real digests (mirroring `remoteNavigation.test.ts`), the canopy and
 * raster upstreams are stubbed, and no test reaches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SunCalc from "suncalc";
import {
  type BBox,
  confidenceFor,
  createGeometryShadowField,
  LOW_CONFIDENCE,
} from "../../shadowField/ShadowField";
import {
  type TileMapLike,
  createOverpassCanopyProvider,
  createOverpassPrismProvider,
  createRasterCanopyProvider,
  createTilePrismProvider,
} from "../../shadowField/providers";
import type { CanopyFeature } from "../../overpass";
import type {
  CanopyPatch,
  CanopyTileStore,
} from "../../canopyRaster/canopyTileStore";
import type { LonLatBbox } from "../../canopyRaster/tiles";
import {
  acquireNavigationSnapshot,
  clearNavigationCache,
  type NavigationSnapshot,
} from "../remoteNavigation";
import type { GeoBounds } from "../shardContract";
import {
  createNycStaticPrismProvider,
  NYC_UNKNOWN_HEIGHT_M,
} from "../buildingProvider";

const generation = "nyc-2026-09-18-abcdef123456";
const nextGeneration = "nyc-2026-10-01-abcdef123456";
const base = "https://navigation.test";

const supportBounds: GeoBounds = { south: 40.74, west: -74.0, north: 40.76, east: -73.96 };

// Midsummer solar noon in NYC: high sun, short shadows north of every caster.
const NOON = new Date("2026-06-21T17:00:00Z");
// A December morning: the sun is up but low enough to dock every answer.
const LOW_SUN = new Date("2026-12-21T13:15:00Z");

/** Square ring, closed, centred at (lng, lat) with half-size in metres. */
function ringMeters(clng: number, clat: number, halfM: number): Array<[number, number]> {
  const mPerLng = 111320 * Math.cos((clat * Math.PI) / 180);
  const dLat = halfM / 111320;
  const dLng = halfM / mPerLng;
  return [
    [clng - dLng, clat - dLat],
    [clng + dLng, clat - dLat],
    [clng + dLng, clat + dLat],
    [clng - dLng, clat + dLat],
    [clng - dLng, clat - dLat],
  ];
}

function building(
  id: string,
  rings: Array<Array<[number, number]>>,
  heightM: number | null,
  heightSource: "source" | "fallback" | "unknown",
) {
  return { id, rings, heightM, heightSource, featureCode: 2100, status: "active" };
}

// ─── Fixture shards ───────────────────────────────────────────────────────────

const KNOWN_RING = ringMeters(-73.99, 40.75, 20);
const UNKNOWN_RING = ringMeters(-73.989, 40.748, 10);
// Straddles the A/B seam at lng -73.985: owned by A, reaching into B.
const SEAM_RING: Array<[number, number]> = [
  [-73.9865, 40.7495],
  [-73.9835, 40.7495],
  [-73.9835, 40.7505],
  [-73.9865, 40.7505],
  [-73.9865, 40.7495],
];
const TALL_RING = ringMeters(-73.978, 40.752, 5);

function buildingShardA(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "buildings",
    geometryBounds: { south: 40.745, west: -73.995, north: 40.755, east: -73.985 },
    supportBounds: { south: 40.7445, west: -73.9955, north: 40.7555, east: -73.9845 },
    buildings: [
      building("a-known", [KNOWN_RING], 30, "source"),
      building("a-unknown", [UNKNOWN_RING], null, "unknown"),
      building("seam-1", [SEAM_RING], 24, "source"),
    ],
  };
}

function buildingShardB(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "buildings",
    geometryBounds: { south: 40.745, west: -73.985, north: 40.755, east: -73.975 },
    supportBounds: { south: 40.7445, west: -73.9855, north: 40.7555, east: -73.9745 },
    buildings: [
      building("b-known", [ringMeters(-73.98, 40.75, 15)], 12, "source"),
      building("b-tall", [TALL_RING], 60, "source"),
      building("b-multi", [ringMeters(-73.981, 40.747, 8), ringMeters(-73.9795, 40.747, 8)], 18, "fallback"),
    ],
  };
}

/** Minimal street shard: the manifest contract requires at least one. */
function streetShard(gen: string) {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: gen,
    kind: "streets",
    geometryBounds: { south: 40.745, west: -73.995, north: 40.755, east: -73.985 },
    supportBounds: { south: 40.7445, west: -73.9955, north: 40.7555, east: -73.9845 },
    nodes: [
      { id: 101, lat: 40.75, lon: -73.99, isIntersection: true },
      { id: 102, lat: 40.751, lon: -73.989, isIntersection: true },
    ],
    edges: [
      { id: "w1-fwd", from: 101, to: 102, distanceM: 120, tags: { highway: "residential" } },
      { id: "w1-bwd", from: 102, to: 101, distanceM: 120, tags: { highway: "residential" } },
    ],
  };
}

// ─── Publisher (real digests, like the loader tests) ──────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Published {
  generation: string;
  pointer: Record<string, unknown>;
  manifestBytes: Uint8Array;
  bodies: Map<string, Uint8Array>;
}

function countBuildings(body: {
  buildings: { rings: unknown[]; heightM: number | null }[];
}) {
  return {
    buildings: body.buildings.length,
    rings: body.buildings.reduce((sum, building) => sum + building.rings.length, 0),
    missingHeights: body.buildings.filter((building) => building.heightM === null).length,
    maxHeightM: body.buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0),
  };
}

async function publish(
  bodies: Record<string, unknown>,
  gen: string,
): Promise<Published> {
  const encoder = new TextEncoder();
  const encoded = new Map<string, Uint8Array>();
  const streetShards = [];
  const buildingShards = [];
  for (const [key, body] of Object.entries(bodies)) {
    const bytes = encoder.encode(JSON.stringify(body));
    encoded.set(key, bytes);
    const record = body as { geometryBounds: GeoBounds; supportBounds: GeoBounds };
    if (key.startsWith("streets/")) {
      const nodes = (body as { nodes: unknown[] }).nodes.length;
      const edges = (body as { edges: unknown[] }).edges.length;
      streetShards.push({
        key,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        geometryBounds: record.geometryBounds,
        supportBounds: record.supportBounds,
        nodes,
        edges,
      });
    } else {
      buildingShards.push({
        key,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        geometryBounds: record.geometryBounds,
        supportBounds: record.supportBounds,
        ...countBuildings(body as { buildings: { rings: unknown[]; heightM: number | null }[] }),
      });
    }
  }
  const manifestObj = {
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
  const manifestBytes = encoder.encode(JSON.stringify(manifestObj));
  return {
    generation: gen,
    pointer: {
      version: 1,
      dataset: "nyc-navigation",
      generation: gen,
      manifestPath: `navigation/nyc/${gen}/manifest.json`,
      manifestSha256: await sha256Hex(manifestBytes),
    },
    manifestBytes,
    bodies: encoded,
  };
}

function standardBodies(gen: string): Record<string, unknown> {
  return {
    "streets/cell-a.json": streetShard(gen),
    "buildings/cell-a.json": buildingShardA(gen),
    "buildings/cell-b.json": buildingShardB(gen),
  };
}

interface StubOptions {
  failKeys?: Set<string>;
  corruptKeys?: Set<string>;
  gate?: (key: string, respond: () => Promise<StubResponse>) => Promise<StubResponse>;
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
 * Serves the pointer from `getCurrent` and every listed generation for
 * manifest/shard paths, so a test can promote the pointer mid-flight while
 * old-generation URLs keep serving old bytes.
 */
function stubFetch(getCurrent: () => Published, generations: Published[], options: StubOptions = {}) {
  const calls: string[] = [];
  const byGeneration = new Map(generations.map((item) => [item.generation, item]));
  const fetchFn = (async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/current.json"))
      return bytesResponse(new TextEncoder().encode(JSON.stringify(getCurrent().pointer)));
    const match = href.match(/\/navigation\/nyc\/([^/]+)\/(.+)$/);
    const published = match ? byGeneration.get(match[1]) : undefined;
    if (!published || !match)
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const key = match[2];
    if (key === "manifest.json") return bytesResponse(published.manifestBytes);
    if (options.failKeys?.has(key))
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (options.corruptKeys?.has(key))
      return bytesResponse(new TextEncoder().encode('{"version":2,"nope":true}'));
    const body = published.bodies.get(key);
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const respond = async () => bytesResponse(body);
    if (options.gate) return options.gate(key, respond);
    return respond();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function mustAcquire(fetchFn: typeof fetch): Promise<NavigationSnapshot> {
  const snapshot = await acquireNavigationSnapshot({ fetchFn });
  if (!snapshot) throw new Error("test bug: expected a snapshot");
  return snapshot;
}

/** The whole fixture area: selects both building shards through caster reach. */
const WHOLE: BBox = { west: -73.993, south: 40.746, east: -73.977, north: 40.754 };
/** Small query on the B side of the seam: reach still selects shard A. */
const SEAM_QUERY: BBox = { west: -73.98386, south: 40.74973, east: -73.98314, north: 40.75027 };
/** Outside manifest support: the provider must decline without fetching. */
const ELSEWHERE: BBox = { west: -73.95, south: 40.7, east: -73.94, north: 40.71 };

beforeEach(() => {
  clearNavigationCache();
  vi.stubEnv("VITE_NAVIGATION_BASE", base);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Provider contract ────────────────────────────────────────────────────────

describe("createNycStaticPrismProvider", () => {
  it("declines everything while unbound, without reaching the network", async () => {
    let fetched = 0;
    const fetchFn = (async () => {
      fetched += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    const provider = createNycStaticPrismProvider({ fetchFn });

    expect(provider.source).toBe("nyc-static");
    expect(provider.generation).toBeNull();
    expect(provider.prismsFor(WHOLE)).toBeNull();
    await provider.load?.(WHOLE);
    expect(provider.prismsFor(WHOLE)).toBeNull();
    expect(fetched).toBe(0);
  });

  it("converts known heights and the unknown-height fallback through the prism path", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));

    await provider.load?.(WHOLE);

    const set = provider.prismsFor(WHOLE);
    expect(set).not.toBeNull();
    // A: known + unknown + seam straddler; B: known + tall + two-ring multipart.
    expect(set?.prisms).toHaveLength(7);
    expect(set?.maxHeightM).toBe(60);
    const heights = new Map(set?.prisms.map((prism) => [JSON.stringify(prism.ring), prism.heightM]));
    expect(heights.get(JSON.stringify(KNOWN_RING))).toBe(30);
    expect(heights.get(JSON.stringify(UNKNOWN_RING))).toBe(NYC_UNKNOWN_HEIGHT_M);
    expect(NYC_UNKNOWN_HEIGHT_M).toBe(10);
    const multi = set?.prisms.filter((prism) => prism.heightM === 18) ?? [];
    expect(multi).toHaveLength(2);
  });

  it("preserves prism-array identity while cached", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));

    await provider.load?.(WHOLE);

    expect(provider.prismsFor(WHOLE)).toBe(provider.prismsFor(WHOLE));
    // A narrower query inside the verified coverage reuses the same set.
    expect(provider.prismsFor(SEAM_QUERY)).toBe(provider.prismsFor(WHOLE));
  });

  it("returns a valid empty set only for verified covered areas with zero buildings", async () => {
    const emptyShard = {
      version: 1,
      dataset: "nyc-navigation",
      generation,
      kind: "buildings",
      geometryBounds: { south: 40.745, west: -73.995, north: 40.755, east: -73.975 },
      supportBounds: { south: 40.7445, west: -73.9955, north: 40.7555, east: -73.9745 },
      buildings: [],
    };
    const published = await publish(
      { "streets/cell-a.json": streetShard(generation), "buildings/empty.json": emptyShard },
      generation,
    );
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));

    await provider.load?.(WHOLE);

    const set = provider.prismsFor(WHOLE);
    expect(set).not.toBeNull();
    expect(set?.prisms).toEqual([]);
  });

  it("declines outside verified support without fetching", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn, calls } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    const shardCalls = calls.length;

    await provider.load?.(ELSEWHERE);

    expect(provider.prismsFor(ELSEWHERE)).toBeNull();
    expect(calls.length).toBe(shardCalls);
  });

  it("publishes nothing when any required shard is corrupt or missing", async () => {
    for (const options of [
      { corruptKeys: new Set(["buildings/cell-b.json"]) },
      { failKeys: new Set(["buildings/cell-b.json"]) },
    ]) {
      clearNavigationCache();
      const published = await publish(standardBodies(generation), generation);
      const { fetchFn, calls } = stubFetch(() => published, [published], options);
      const provider = createNycStaticPrismProvider({ fetchFn });
      provider.bindSnapshot(await mustAcquire(fetchFn));

      // A failed load leaves nothing cached rather than throwing: the field
      // reports unknown and the current providers answer instead.
      await expect(provider.load?.(WHOLE)).resolves.toBeUndefined();
      expect(provider.prismsFor(WHOLE)).toBeNull();
      // Both shards were attempted: no half-static publication from cell A.
      expect(calls.some((url) => url.endsWith("buildings/cell-a.json"))).toBe(true);
      expect(calls.some((url) => url.endsWith("buildings/cell-b.json"))).toBe(true);
      expect(calls.some((url) => url.includes("streets/"))).toBe(false);
    }
  });

  it("rejects a pre-aborted load without fetching", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn, calls } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    const before = calls.length;

    await expect(provider.load?.(WHOLE, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(provider.prismsFor(WHOLE)).toBeNull();
    expect(calls.length).toBe(before);
  });

  it("stops publication when the caller aborts mid-flight", async () => {
    const published = await publish(standardBodies(generation), generation);
    let release!: () => void;
    const gate = (_key: string, respond: () => Promise<StubResponse>) =>
      new Promise<StubResponse>((resolve) => {
        release = () => resolve(respond());
      });
    const { fetchFn } = stubFetch(() => published, [published], { gate });
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    const controller = new AbortController();

    const pending = provider.load?.(WHOLE, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.prismsFor(WHOLE)).toBeNull();
  });

  it("serves a whole seam-crossing footprint selected from one side only", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));

    // The query sits entirely east of the seam; shard A is selected only
    // through caster reach, and the straddler arrives whole.
    await provider.load?.(SEAM_QUERY);

    const set = provider.prismsFor(SEAM_QUERY);
    expect(set).not.toBeNull();
    const straddler = set?.prisms.filter(
      (prism) => JSON.stringify(prism.ring) === JSON.stringify(SEAM_RING),
    );
    expect(straddler).toHaveLength(1);
    expect(straddler?.[0].heightM).toBe(24);
    const lngs = straddler?.[0].ring.map(([lng]) => lng) ?? [];
    expect(Math.min(...lngs)).toBeLessThan(-73.985);
    expect(Math.max(...lngs)).toBeGreaterThan(-73.985);
  });

  it("casts a building id once even when two cells publish it", async () => {
    const bodies = standardBodies(generation);
    const shardB = bodies["buildings/cell-b.json"] as { buildings: unknown[] };
    const shardA = bodies["buildings/cell-a.json"] as { buildings: { id: string }[] };
    shardB.buildings.push({ ...(shardA.buildings[0] as object) });
    const published = await publish(bodies, generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));

    await provider.load?.(WHOLE);

    const set = provider.prismsFor(WHOLE);
    const known = set?.prisms.filter(
      (prism) => JSON.stringify(prism.ring) === JSON.stringify(KNOWN_RING),
    );
    expect(known).toHaveLength(1);
  });

  it("a generation rollover drops the old cache and never mixes", async () => {
    const oldPublished = await publish(standardBodies(generation), generation);
    const bodies = standardBodies(nextGeneration);
    const shardA = bodies["buildings/cell-a.json"] as {
      buildings: { id: string; heightM: number | null }[];
    };
    shardA.buildings[0].heightM = 45;
    const newPublished = await publish(bodies, nextGeneration);
    let current = oldPublished;
    const { fetchFn } = stubFetch(() => current, [oldPublished, newPublished]);
    const provider = createNycStaticPrismProvider({ fetchFn });

    provider.bindSnapshot(await mustAcquire(fetchFn));
    await provider.load?.(WHOLE);
    expect(provider.generation).toBe(generation);
    expect(provider.prismsFor(WHOLE)?.maxHeightM).toBe(60);

    // Promote the pointer, then bind the new snapshot: the old prisms must
    // vanish before the new load lands, not linger beside it.
    current = newPublished;
    clearNavigationCache();
    provider.bindSnapshot(await mustAcquire(fetchFn));
    expect(provider.generation).toBe(nextGeneration);
    expect(provider.prismsFor(WHOLE)).toBeNull();

    await provider.load?.(WHOLE);
    const set = provider.prismsFor(WHOLE);
    expect(set?.maxHeightM).toBe(60);
    const heights = new Map(set?.prisms.map((prism) => [JSON.stringify(prism.ring), prism.heightM]));
    expect(heights.get(JSON.stringify(KNOWN_RING))).toBe(45);
  });

  it("a stale in-flight load cannot publish under a newer binding", async () => {
    const oldPublished = await publish(standardBodies(generation), generation);
    const newPublished = await publish(standardBodies(nextGeneration), nextGeneration);
    let current = oldPublished;
    const releases = new Map<string, () => void>();
    const gate = (key: string, respond: () => Promise<StubResponse>) => {
      if (!key.startsWith("buildings/")) return respond();
      return new Promise<StubResponse>((resolve) => {
        releases.set(key, () => resolve(respond()));
      });
    };
    const { fetchFn } = stubFetch(() => current, [oldPublished, newPublished], { gate });
    const provider = createNycStaticPrismProvider({ fetchFn });

    provider.bindSnapshot(await mustAcquire(fetchFn));
    const stale = provider.load?.(WHOLE);
    expect(releases.has("buildings/cell-a.json")).toBe(true);

    current = newPublished;
    clearNavigationCache();
    provider.bindSnapshot(await mustAcquire(fetchFn));
    for (const release of releases.values()) release();
    await stale;

    expect(provider.prismsFor(WHOLE)).toBeNull();
  });
});

// ─── Shadow-field composition ─────────────────────────────────────────────────

describe("static buildings in the shadow field", () => {
  const TALL_CENTER: [number, number] = [-73.978, 40.752];
  const JULY_NOON = new Date("2026-07-15T17:00:00Z");

  async function loadedProvider(): Promise<ReturnType<typeof createNycStaticPrismProvider>> {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    await provider.load?.(WHOLE);
    return provider;
  }

  /** Metre offset a height casts at a moment, as [east, north] metres. */
  function shadowOffsetM(heightM: number, when: Date, lat: number, lng: number): [number, number] {
    const sun = SunCalc.getPosition(when, lat, lng);
    const lengthM = heightM / Math.tan(sun.altitude);
    return [Math.sin(sun.azimuth) * lengthM, Math.cos(sun.azimuth) * lengthM];
  }

  function edgeAlongShadow(
    center: [number, number],
    heightM: number,
    when: Date,
    halfM: number,
  ): { from: [number, number]; to: [number, number] } {
    const [dE, dN] = shadowOffsetM(heightM, when, center[1], center[0]);
    const length = Math.hypot(dE, dN);
    const mPerLng = 111320 * Math.cos((center[1] * Math.PI) / 180);
    const ux = dE / length / mPerLng;
    const uy = dN / length / 111320;
    return {
      from: [center[0] - ux * halfM, center[1] - uy * halfM],
      to: [center[0] + ux * halfM, center[1] + uy * halfM],
    };
  }

  it("answers from static geometry with static confidence", async () => {
    const provider = await loadedProvider();
    const [dE, dN] = shadowOffsetM(60, NOON, TALL_CENTER[1], TALL_CENTER[0]);
    const mPerLng = 111320 * Math.cos((TALL_CENTER[1] * Math.PI) / 180);
    const midShadow: [number, number] = [
      TALL_CENTER[0] + (0.6 * dE) / mPerLng,
      TALL_CENTER[1] + (0.6 * dN) / 111320,
    ];
    const edge = edgeAlongShadow(midShadow, 60, NOON, 4);
    const field = createGeometryShadowField([provider]);
    // Production path: readiness loads the padded cells sampling resolves.
    await field.readyEdges([edge]);

    const [sample] = field.sampleEdges([edge], NOON);

    expect(sample.source).toBe("nyc-static");
    expect(sample.buildingSource).toBe("nyc-static");
    expect(sample.canopySources).toEqual({ osm: false, raster: false });
    expect(sample.left).toBeGreaterThan(0.9);
    expect(sample.right).toBeGreaterThan(0.9);
    const sun = SunCalc.getPosition(NOON, midShadow[1], midShadow[0]);
    expect(sun.altitude).toBeGreaterThan(0);
    expect(sample.confidence).toBeCloseTo(confidenceFor("nyc-static", sun.altitude, 7), 10);
  });

  it("casts from a building outside the immediate query", async () => {
    const provider = await loadedProvider();
    // 60% of the way to the shadow tip: past the 5 m ring, inside the shadow.
    const [dE, dN] = shadowOffsetM(60, NOON, TALL_CENTER[1], TALL_CENTER[0]);
    const mPerLng = 111320 * Math.cos((TALL_CENTER[1] * Math.PI) / 180);
    const point: [number, number] = [
      TALL_CENTER[0] + (0.6 * dE) / mPerLng,
      TALL_CENTER[1] + (0.6 * dN) / 111320,
    ];
    const query: BBox = {
      west: point[0] - 4 / mPerLng,
      south: point[1] - 4 / 111320,
      east: point[0] + 4 / mPerLng,
      north: point[1] + 4 / 111320,
    };

    const set = provider.prismsFor(query);
    expect(set).not.toBeNull();
    // The caster's whole ring lies outside the query that selected it.
    const tall = set?.prisms.filter(
      (prism) => JSON.stringify(prism.ring) === JSON.stringify(TALL_RING),
    );
    expect(tall).toHaveLength(1);
    for (const [lng, lat] of tall?.[0].ring ?? []) {
      expect(lng >= query.west && lng <= query.east && lat >= query.south && lat <= query.north).toBe(
        false,
      );
    }

    const edge = edgeAlongShadow(point, 60, NOON, 2);
    const field = createGeometryShadowField([provider]);
    await field.readyEdges([edge]);
    const [sample] = field.sampleEdges([edge], NOON);
    expect(sample.source).toBe("nyc-static");
    expect(sample.left).toBeGreaterThan(0.9);
  });

  it("docks static answers as the sun drops, without changing the source", async () => {
    const provider = await loadedProvider();
    const edge = edgeAlongShadow(TALL_CENTER, 60, NOON, 4);
    const field = createGeometryShadowField([provider]);
    await field.readyEdges([edge]);

    const lowAlt = SunCalc.getPosition(LOW_SUN, TALL_CENTER[1], TALL_CENTER[0]).altitude;
    expect(lowAlt).toBeGreaterThan(0);
    expect(lowAlt).toBeLessThan((10 * Math.PI) / 180);

    const [low] = field.sampleEdges([edge], LOW_SUN);
    const [high] = field.sampleEdges([edge], NOON);
    expect(low.source).toBe("nyc-static");
    expect(high.source).toBe("nyc-static");
    expect(low.confidence).toBeLessThan(high.confidence);
  });

  function tileMapFor(bbox: BBox): TileMapLike {
    return {
      getZoom: () => 16,
      getBounds: () => ({
        getWest: () => bbox.west - 0.01,
        getSouth: () => bbox.south - 0.01,
        getEast: () => bbox.east + 0.01,
        getNorth: () => bbox.north + 0.01,
      }),
      querySourceFeatures: vi.fn(() => [
        {
          properties: { render_height: 20 },
          geometry: { type: "Polygon", coordinates: [ringMeters(-73.99, 40.75, 10)] },
        },
      ]),
    };
  }

  it("answers first while tiles and Overpass stand behind it", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    const fetchFootprints = vi.fn(async () => []);
    const field = createGeometryShadowField(
      [provider, createTilePrismProvider(() => tileMapFor(WHOLE)), createOverpassPrismProvider({ fetchFootprints })],
      [],
    );
    const edge = edgeAlongShadow(TALL_CENTER, 60, NOON, 4);

    // `ready` preloads unconditionally (unlike `readyEdges`, which skips an
    // area tiles already resolve — the existing fast path). The generous box
    // contains every padded cell the edge below resolves, so sampling must
    // meet the static prisms before the tiles the renderer holds.
    const generous: BBox = { west: -73.98393, south: 40.74751, east: -73.97207, north: 40.75649 };
    await field.ready(generous);

    const [sample] = field.sampleEdges([edge], NOON);
    expect(sample.buildingSource).toBe("nyc-static");
    expect(sample.source).toBe("nyc-static");
  });

  it("falls back to current providers on static failure", async () => {
    const published = await publish(standardBodies(generation), generation);
    const { fetchFn } = stubFetch(() => published, [published], {
      corruptKeys: new Set(["buildings/cell-b.json"]),
    });
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    const field = createGeometryShadowField(
      [provider, createTilePrismProvider(() => tileMapFor(WHOLE))],
      [],
    );
    const edge = edgeAlongShadow(TALL_CENTER, 60, NOON, 4);

    await field.readyEdges([edge]);

    const [sample] = field.sampleEdges([edge], NOON);
    expect(sample.buildingSource).toBe("tiles");
    expect(sample.source).toBe("tiles");
  });

  it("yields to current providers outside verified coverage", async () => {
    const provider = await loadedProvider();
    const fetchFootprints = vi.fn(async () => []);
    const field = createGeometryShadowField(
      [provider, createTilePrismProvider(() => null), createOverpassPrismProvider({ fetchFootprints })],
      [],
    );
    const far: BBox = { west: -73.951, south: 40.7005, east: -73.949, north: 40.7015 };

    await field.ready(far);

    expect(provider.prismsFor(far)).toBeNull();
    const sample = field.shadowAt(-73.95, 40.701, NOON);
    expect(sample.source).not.toBe("nyc-static");
    expect(fetchFootprints).toHaveBeenCalled();
  });

  it("blends OSM canopy over static buildings with mixed semantics", async () => {
    const provider = await loadedProvider();
    const tree: CanopyFeature = {
      id: 7,
      kind: "tree",
      points: [[-73.982, 40.7485]],
      tags: { leaf_type: "broadleaved" },
    };
    const canopy = createOverpassCanopyProvider({ fetchCanopy: async () => [tree] });
    await canopy.load?.(WHOLE);
    expect(canopy.prismsFor(WHOLE, JULY_NOON)?.prisms.length).toBeGreaterThan(0);

    const open: { from: [number, number]; to: [number, number] } = {
      from: [-73.9822, 40.7485],
      to: [-73.9818, 40.7485],
    };
    const buildingsOnlyField = createGeometryShadowField([provider]);
    await buildingsOnlyField.readyEdges([open]);
    const buildingsOnly = buildingsOnlyField.sampleEdges([open], JULY_NOON)[0];
    const mixedField = createGeometryShadowField([provider], [canopy]);
    await mixedField.readyEdges([open]);
    const [mixed] = mixedField.sampleEdges([open], JULY_NOON);

    expect(buildingsOnly.source).toBe("nyc-static");
    expect(mixed.source).toBe("mixed");
    expect(mixed.buildingSource).toBe("nyc-static");
    expect(mixed.canopySources).toEqual({ osm: true, raster: false });
    expect(mixed.confidence).toBeLessThan(buildingsOnly.confidence);
    expect(mixed.confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  function fakeStore(read: (aoi: LonLatBbox) => Promise<CanopyPatch>): CanopyTileStore {
    return {
      read: (aoi) => read(aoi),
      stats: () => ({
        cachedBlocks: 0, cachedBytes: 0, blockHits: 0, blockMisses: 0,
        runsFetched: 0, retries: 0, evictions: 0,
      }),
      clear: () => {},
    };
  }

  function flatPatch(aoi: LonLatBbox, heightM = 12): CanopyPatch {
    return {
      heights: new Uint8Array(16 * 16).fill(heightM),
      valid: null,
      width: 16,
      height: 16,
      bbox: [aoi[0] - 1e-4, aoi[1] - 1e-4, aoi[2] + 1e-4, aoi[3] + 1e-4],
      metresPerPixel: 2,
      overviewIndex: 2,
      quadkeys: ["0331110121"],
    };
  }

  it("blends raster canopy over static buildings with mixed semantics", async () => {
    const provider = await loadedProvider();
    const raster = createRasterCanopyProvider({ store: fakeStore(async (aoi) => flatPatch(aoi)) });
    await raster.load?.(WHOLE);

    const open: { from: [number, number]; to: [number, number] } = {
      from: [-73.9822, 40.7485],
      to: [-73.9818, 40.7485],
    };
    const buildingsOnlyField = createGeometryShadowField([provider]);
    await buildingsOnlyField.readyEdges([open]);
    const buildingsOnly = buildingsOnlyField.sampleEdges([open], NOON)[0];
    const mixedField = createGeometryShadowField([provider], [], [raster]);
    await mixedField.readyEdges([open]);
    const [mixed] = mixedField.sampleEdges([open], NOON);

    expect(buildingsOnly.source).toBe("nyc-static");
    expect(mixed.source).toBe("mixed");
    expect(mixed.buildingSource).toBe("nyc-static");
    expect(mixed.canopySources).toEqual({ osm: false, raster: true });
    expect(mixed.confidence).toBeLessThan(buildingsOnly.confidence);
  });

  it("masks raster canopy standing on static roofs back to the building answer", async () => {
    const slab: BBox = { west: -73.9856, south: 40.7495, east: -73.9844, north: 40.7505 };
    const slabBodies = {
      "streets/cell-a.json": streetShard(generation),
      "buildings/slab.json": {
        version: 1,
        dataset: "nyc-navigation",
        generation,
        kind: "buildings",
        geometryBounds: { south: 40.745, west: -73.995, north: 40.755, east: -73.975 },
        supportBounds: { south: 40.7445, west: -73.9955, north: 40.7555, east: -73.9745 },
        buildings: [building("slab", [ringMeters(-73.985, 40.75, 600)], 40, "source")],
      },
    };
    const published = await publish(slabBodies, generation);
    const { fetchFn } = stubFetch(() => published, [published]);
    const provider = createNycStaticPrismProvider({ fetchFn });
    provider.bindSnapshot(await mustAcquire(fetchFn));
    await provider.load?.(slab);

    const raster = createRasterCanopyProvider({ store: fakeStore(async (aoi) => flatPatch(aoi)) });
    await raster.load?.(slab);

    const edge: { from: [number, number]; to: [number, number] } = {
      from: [-73.9852, 40.75],
      to: [-73.9848, 40.75],
    };
    const field = createGeometryShadowField([provider], [], [raster]);
    await field.readyEdges([edge]);
    const [sample] = field.sampleEdges([edge], NOON);

    // Every raster pixel stands on the slab, so the mask removes it all: no
    // "and tree canopy", no confidence dock for evidence that was subtracted.
    expect(sample.source).toBe("nyc-static");
    expect(sample.buildingSource).toBe("nyc-static");
    expect(sample.canopySources).toEqual({ osm: false, raster: false });
  });
});

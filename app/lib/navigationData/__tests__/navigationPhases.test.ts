/**
 * Checkpoint 6 phase ledger: the per-calculation collector must attribute the
 * static path's work — pointer/manifest, street transfer/verify/decode/merge,
 * building transfer/verify/decode, shard cache hits/misses, byte figures, and
 * fallback reasons — without ever carrying coordinates.
 *
 * Hermetic: navigation bytes are served through the loader's `fetchFn` seam
 * with real digests; Overpass is a stubbed global fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoBounds } from "../shardContract";
import {
  acquireNavigationSnapshot,
  clearNavigationCache,
  loadNavigationSelection,
} from "../remoteNavigation";
import { fetchBestRoutingGraph } from "../routingGraphSource";
import {
  estimateBuildingShardDecodedBytes,
  estimateStreetShardDecodedBytes,
  newNavigationPhases,
} from "../navigationPhases";

const generation = "nyc-2026-09-18-abcdef123456";
const base = "https://navigation.test";
const supportBounds: GeoBounds = { south: 40.74, west: -74.0, north: 40.76, east: -73.98 };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function streetShardBody() {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "streets",
    geometryBounds: { south: 40.74, west: -74.0, north: 40.76, east: -73.99 },
    supportBounds: { south: 40.74, west: -74.0, north: 40.76, east: -73.989 },
    nodes: [
      { id: 101, lat: 40.75, lon: -73.995, isIntersection: false },
      { id: 102, lat: 40.751, lon: -73.995, isIntersection: true },
      { id: 103, lat: 40.751, lon: -73.9895, isIntersection: false },
    ],
    edges: [
      { id: "w-fwd", from: 101, to: 102, distanceM: 110, tags: { highway: "residential" } },
      { id: "w-bwd", from: 102, to: 101, distanceM: 110, tags: { highway: "residential" } },
      { id: "seam-fwd", from: 102, to: 103, distanceM: 90, tags: { highway: "footway" } },
    ],
  };
}

function buildingShardBody() {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "buildings",
    geometryBounds: { south: 40.741, west: -73.995, north: 40.759, east: -73.981 },
    supportBounds: { south: 40.741, west: -73.995, north: 40.759, east: -73.981 },
    buildings: [
      {
        id: "b-1",
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
      {
        id: "b-2",
        rings: [
          [
            [-73.985, 40.75],
            [-73.984, 40.75],
            [-73.984, 40.751],
            [-73.985, 40.751],
            [-73.985, 40.75],
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

async function publish() {
  const encoder = new TextEncoder();
  const streetBytes = encoder.encode(JSON.stringify(streetShardBody()));
  const buildingBytes = encoder.encode(JSON.stringify(buildingShardBody()));
  const streetSha = await sha256Hex(streetBytes);
  const buildingSha = await sha256Hex(buildingBytes);
  const refsFor = (
    key: string,
    bytes: Uint8Array,
    sha: string,
    body: unknown,
  ): Record<string, unknown> => {
    const record = body as { geometryBounds: GeoBounds; supportBounds: GeoBounds };
    if (key.startsWith("streets/")) {
      const { nodes, edges } = body as { nodes: unknown[]; edges: unknown[] };
      return {
        key,
        bytes: bytes.byteLength,
        sha256: sha,
        geometryBounds: record.geometryBounds,
        supportBounds: record.supportBounds,
        nodes: nodes.length,
        edges: edges.length,
      };
    }
    const { buildings } = body as { buildings: { rings: unknown[]; heightM: number | null }[] };
    return {
      key,
      bytes: bytes.byteLength,
      sha256: sha,
      geometryBounds: record.geometryBounds,
      supportBounds: record.supportBounds,
      buildings: buildings.length,
      rings: buildings.reduce((sum, building) => sum + building.rings.length, 0),
      missingHeights: buildings.filter((building) => building.heightM === null).length,
      maxHeightM: buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0),
    };
  };
  const streetRef = refsFor("streets/cell.json", streetBytes, streetSha, streetShardBody());
  const buildingRef = refsFor("buildings/cell.json", buildingBytes, buildingSha, buildingShardBody());
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
    streetShards: [streetRef],
    buildingShards: [buildingRef],
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
    streetBytes,
    buildingBytes,
    streetBytesLen: streetBytes.byteLength,
    buildingBytesLen: buildingBytes.byteLength,
  };
}

function stubNavigationFetch(published: Awaited<ReturnType<typeof publish>>) {
  const calls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    const href = String(url);
    calls.push(href);
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
    if (href.endsWith("/streets/cell.json")) return bytes(published.streetBytes);
    if (href.endsWith("/buildings/cell.json")) return bytes(published.buildingBytes);
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("phase estimator", () => {
  it("scales by the loader's schema, not by coordinates", () => {
    expect(estimateStreetShardDecodedBytes(streetShardBody() as never)).toBe(3 * 58 + 3 * 145);
    expect(estimateBuildingShardDecodedBytes(buildingShardBody() as never)).toBe(
      2 * 120 + 10 * 18,
    );
  });

  it("starts empty and neutral", () => {
    const phases = newNavigationPhases();
    expect(phases.streetSource).toBe("none");
    expect(phases.streetFallbackReason).toBeNull();
    expect(phases.generation).toBeNull();
    expect(phases.streetShardsServed + phases.streetShardsFetched).toBe(0);
  });
});

describe("loader phase accounting", () => {
  it("attributes pointer/manifest, shard fetch counts, bytes and estimates", async () => {
    const published = await publish();
    const { fetchFn } = stubNavigationFetch(published);
    const report = newNavigationPhases();
    const snapshot = await acquireNavigationSnapshot({ fetchFn, report });
    expect(snapshot).not.toBeNull();
    expect(report.pointerMs).toBeGreaterThanOrEqual(0);
    expect(report.manifestMs).toBeGreaterThanOrEqual(0);
    expect(report.snapshotGenerationCacheHit).toBe(false);

    await loadNavigationSelection(
      snapshot!,
      { south: 40.745, west: -73.998, north: 40.755, east: -73.982 },
      { fetchFn, report },
    );
    expect(report.streetShardsServed).toBe(0);
    expect(report.streetShardsFetched).toBe(1);
    expect(report.streetTransferBytes).toBe(published.streetBytesLen);
    expect(report.streetRefNodes).toBe(3);
    expect(report.streetRefEdges).toBe(3);
    expect(report.streetDecodedBytesEstimate).toBe(3 * 58 + 3 * 145);
    expect(report.buildingShardsFetched).toBe(1);
    expect(report.buildingTransferBytes).toBe(published.buildingBytesLen);
    expect(report.buildingRefCount).toBe(2);
    expect(report.buildingDecodedBytesEstimate).toBe(2 * 120 + 10 * 18);
    expect(report.streetTransferMs).toBeGreaterThanOrEqual(0);
    expect(report.buildingVerifyMs).toBeGreaterThanOrEqual(0);

    // A second selection over the same area serves everything from the decoded
    // generation cache: served counts go up, nothing new is fetched.
    await loadNavigationSelection(
      snapshot!,
      { south: 40.746, west: -73.997, north: 40.754, east: -73.983 },
      { fetchFn, report },
    );
    expect(report.streetShardsServed).toBe(1);
    expect(report.streetShardsFetched).toBe(1);
    expect(report.buildingShardsServed).toBe(1);
    expect(report.buildingShardsFetched).toBe(1);

    // The generation cache also skips the manifest on the next acquire.
    await acquireNavigationSnapshot({ fetchFn, report });
    expect(report.snapshotGenerationCacheHit).toBe(true);
  });
});

describe("street source attribution", () => {
  it("labels the static path with its generation and merged sizes", async () => {
    const published = await publish();
    const { fetchFn } = stubNavigationFetch(published);
    stubOverpass();
    const report = newNavigationPhases();
    const graph = await fetchBestRoutingGraph(40.745, -73.998, 40.755, -73.982, undefined, {
      fetchFn,
      report,
    });
    expect(report.streetSource).toBe("nyc-static");
    expect(report.generation).toBe(generation);
    expect(report.streetShardsFetched).toBe(1);
    expect(report.streetMergeMs).toBeGreaterThanOrEqual(0);
    expect(report.streetMergedNodes).toBe(graph.nodes.size);
    expect(report.streetMergedEdges).toBe(3);

    // A second request over the same supported area serves the decoded
    // generation cache: nothing goes over the wire again, nothing re-decodes.
    await fetchBestRoutingGraph(40.746, -73.997, 40.754, -73.983, undefined, {
      fetchFn,
      report,
    });
    expect(report.streetSource).toBe("nyc-static");
    expect(report.streetShardsServed).toBe(1);
    expect(report.streetShardsFetched).toBe(1);
    expect(report.streetTransferMs).toBeGreaterThanOrEqual(0);
  });

  it("labels an outside-support request with its fallback reason", async () => {
    const published = await publish();
    const { fetchFn } = stubNavigationFetch(published);
    const overpassCalls = stubOverpass();
    const report = newNavigationPhases();
    const graph = await fetchBestRoutingGraph(40.6, -73.9, 40.62, -73.88, undefined, {
      fetchFn,
      report,
    });
    // The Overpass stub answered, so the graph builds; the labels must say so.
    expect(graph.nodes.size).toBeGreaterThan(0);
    expect(report.streetSource).toBe("overpass");
    expect(report.streetFallbackReason).toBe("outside support");
    expect(report.streetShardsFetched).toBe(0);
    expect(overpassCalls.some((call) => call.body.includes("highway"))).toBe(true);
  });
});

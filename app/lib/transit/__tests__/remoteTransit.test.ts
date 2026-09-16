import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTransitManifest,
  parseTransitPointer,
  parseTransitShard,
  type TransitShardRef,
} from "../shardContract";
import {
  clearTransitCache,
  loadTransitDataset,
  loadTransitPointer,
  selectShardRefs,
  transitApiBase,
} from "../remoteTransit";

const generation = "nyc-2026-09-16-f8c5f275d305";
const base = "https://transit.test";
const manifestPath = `transit/nyc/${generation}/manifest.json`;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function subwayShard() {
  return {
    kind: "subway",
    feed: { id: "subway", version: "v", startDate: "20260526", endDate: "20261031" },
    stops: [
      { id: "subway:101", name: "Van Cortlandt Park-242 St", lat: 40.889248, lon: -73.898583, changeSec: 180 },
      { id: "subway:103", name: "238 St", lat: 40.884667, lon: -73.90087, changeSec: 0 },
      { id: "subway:127", name: "Times Sq-42 St", lat: 40.75529, lon: -73.987495 },
    ],
    edges: [
      { from: "subway:101", to: "subway:103", route: "1", direction: 1, medianSec: 90, trips: 550, distM: 544 },
    ],
    routes: [
      { id: "1", shortName: "1", longName: "Broadway - 7 Avenue Local", type: 1, color: "D82233", textColor: "FFFFFF" },
    ],
    headways: [
      { route: "1", direction: 0, dayType: "saturday", hour: 6, medianSec: 750, trips: 5, services: 1 },
      { route: "1", direction: 0, dayType: "weekday", hour: 24, medianSec: 570, trips: 4, services: 1 },
    ],
    transfers: [{ from: "subway:112", to: "subway:A09", minSec: 180, kind: "gtfs" }],
  };
}

function busShard() {
  return {
    kind: "bus-shard",
    feed: "bus-si",
    feeds: [{ id: "bus-si", version: "20260813", startDate: "20260906", endDate: "20270102" }],
    stops: [{ id: "bus:200001", name: "GOETHALS RD NORTH", lat: 40.628713, lon: -74.182687, feeds: ["bus-si"] }],
    edges: [],
    routes: [
      { id: "S53", shortName: "S53", longName: "Port Richmond", type: 3, color: "00AEEF", textColor: "FFFFFF", variants: 1 },
    ],
    headways: [],
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

/** Builds a self-consistent pointer/manifest/shard set with real digests. */
async function publish(
  shards: Record<string, ReturnType<typeof subwayShard> | ReturnType<typeof busShard>>,
  gen = generation,
): Promise<Published> {
  const encoder = new TextEncoder();
  const bodies = new Map<string, Uint8Array>();
  const refs: TransitShardRef[] = [];
  for (const [key, shard] of Object.entries(shards)) {
    const bytes = encoder.encode(JSON.stringify(shard));
    bodies.set(key, bytes);
    refs.push({
      key,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      stops: shard.stops.length,
      edges: shard.edges.length,
      routes: shard.routes.length,
    });
  }
  const manifest = {
    generation: gen,
    createdAt: "2026-09-16T18:09:07.605Z",
    schedulesAsOf: { subway: { version: "v", startDate: "20260526", endDate: "20261031" } },
    headwayDates: { referenceDate: "20260916" },
    feeds: [
      { id: "subway", version: "v", startDate: "20260526", endDate: "20261031", sha256: "1".repeat(64) },
    ],
    shards: refs,
    budgets: { shardBytes: 3_000_000, totalBytes: 15_000_000 },
    constants: { spatialWalkMps: 1.4 },
    notes: ["Bus travel times are scheduled, not traffic-aware."],
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return {
    pointer: {
      version: 1,
      dataset: "nyc-transit",
      generation: gen,
      manifestPath: `transit/nyc/${gen}/manifest.json`,
      manifestSha256: await sha256Hex(manifestBytes),
    },
    manifestBytes,
    bodies,
  };
}

function bytesResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** Routes fetches to a published set; returns the URLs actually requested. */
function stubFetch(published: Published): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/current.json")) return { ok: true, status: 200, json: async () => published.pointer };
      if (url.endsWith("/manifest.json")) return bytesResponse(published.manifestBytes);
      const key = url.slice(url.lastIndexOf("/") + 1);
      const body = published.bodies.get(key);
      if (!body) return { ok: false, status: 404 };
      return bytesResponse(body);
    }),
  );
  return calls;
}

beforeEach(() => {
  clearTransitCache();
  vi.stubEnv("VITE_TRANSIT_BASE", base);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Pointer ────────────────────────────────────────────────────────────────

describe("transit pointer", () => {
  const valid = {
    version: 1,
    dataset: "nyc-transit",
    generation,
    manifestPath,
    manifestSha256: "a".repeat(64),
  };

  it("parses a published pointer", () => {
    expect(parseTransitPointer(valid).generation).toBe(generation);
  });

  it("rejects malformed pointers", () => {
    expect(() => parseTransitPointer({ ...valid, version: 2 })).toThrow(/pointer/);
    expect(() => parseTransitPointer({ ...valid, dataset: "nyc-shadow" })).toThrow(/pointer/);
    expect(() => parseTransitPointer({ ...valid, manifestSha256: "zz" })).toThrow(/pointer/);
    expect(() => parseTransitPointer(null)).toThrow(/pointer/);
    expect(() => parseTransitPointer([])).toThrow(/pointer/);
  });

  it("refuses a manifestPath that is not this generation's", () => {
    // A pointer must not be able to steer a fetch at an arbitrary bucket key.
    expect(() =>
      parseTransitPointer({ ...valid, manifestPath: "transit/nyc/other/manifest.json" }),
    ).toThrow(/pointer/);
    expect(() =>
      parseTransitPointer({ ...valid, manifestPath: `${manifestPath}/../../secret` }),
    ).toThrow(/pointer/);
    expect(() =>
      parseTransitPointer({ ...valid, generation: "../../../etc/passwd" }),
    ).toThrow(/pointer/);
  });
});

// ─── Manifest ───────────────────────────────────────────────────────────────

describe("transit manifest", () => {
  it("rejects a manifest describing a different generation", async () => {
    const { manifestBytes } = await publish({ "subway.json": subwayShard() });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(() => parseTransitManifest(manifest, "nyc-2026-01-01-aaaaaaaaaaaa")).toThrow(/mismatch/);
  });

  it("rejects duplicate shard keys", async () => {
    const { manifestBytes } = await publish({ "subway.json": subwayShard() });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    manifest.shards.push({ ...manifest.shards[0] });
    expect(() => parseTransitManifest(manifest, generation)).toThrow(/duplicate/);
  });

  it("keeps the honesty notes", async () => {
    const { manifestBytes } = await publish({ "subway.json": subwayShard() });
    const manifest = parseTransitManifest(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
      generation,
    );
    expect(manifest.notes).toContain("Bus travel times are scheduled, not traffic-aware.");
  });
});

// ─── Shard ──────────────────────────────────────────────────────────────────

describe("transit shard", () => {
  function refFor(shard: { stops: unknown[]; edges: unknown[]; routes: unknown[] }): TransitShardRef {
    return {
      key: "subway.json",
      bytes: 1,
      sha256: "a".repeat(64),
      stops: shard.stops.length,
      edges: shard.edges.length,
      routes: shard.routes.length,
    };
  }

  it("distinguishes a zero change cost from an absent one", () => {
    const shard = subwayShard();
    const parsed = parseTransitShard(shard, refFor(shard));
    // 0 is a real cross-platform interchange, not a missing value (#384).
    expect(parsed.stops[1].changeSec).toBe(0);
    expect("changeSec" in parsed.stops[2]).toBe(false);
  });

  it("keeps service-day hours past midnight distinct", () => {
    const shard = subwayShard();
    const parsed = parseTransitShard(shard, refFor(shard));
    expect(parsed.headways.map((h) => h.hour)).toEqual([6, 24]);
  });

  it("defaults transfers to empty for shards that ship none", () => {
    const shard = busShard();
    const parsed = parseTransitShard(shard, { ...refFor(shard), key: "bus-si.json" });
    expect(parsed.transfers).toEqual([]);
  });

  it("rejects a shard whose record counts contradict the manifest", () => {
    const shard = subwayShard();
    const ref = refFor(shard);
    expect(() => parseTransitShard(shard, { ...ref, stops: ref.stops + 1 })).toThrow(/count/);
  });

  it("rejects records that break the contract", () => {
    const badHour = subwayShard();
    badHour.headways[0].hour = 28;
    expect(() => parseTransitShard(badHour, refFor(badHour))).toThrow(/headway/);

    const badDay = subwayShard();
    (badDay.headways[0] as { dayType: string }).dayType = "holiday";
    expect(() => parseTransitShard(badDay, refFor(badDay))).toThrow(/headway/);

    const badStop = subwayShard();
    (badStop.stops[0] as { id: unknown }).id = 101;
    expect(() => parseTransitShard(badStop, refFor(badStop))).toThrow(/stop/);
  });
});

// ─── Shard selection ────────────────────────────────────────────────────────

describe("selectShardRefs", () => {
  it("picks shards by kind", async () => {
    const { manifestBytes } = await publish({
      "subway.json": subwayShard(),
      "bus-si.json": busShard(),
    });
    const manifest = parseTransitManifest(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
      generation,
    );
    expect(selectShardRefs(manifest, { subway: true }).map((r) => r.key)).toEqual(["subway.json"]);
    expect(selectShardRefs(manifest, { bus: true }).map((r) => r.key)).toEqual(["bus-si.json"]);
    expect(selectShardRefs(manifest, {})).toEqual([]);
  });
});

// ─── Transport ──────────────────────────────────────────────────────────────

describe("transit transport", () => {
  it("is off and never fetches without configuration", async () => {
    vi.stubEnv("VITE_TRANSIT_BASE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(transitApiBase()).toBeUndefined();
    await expect(loadTransitPointer()).resolves.toBeNull();
    await expect(loadTransitDataset({ subway: true })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a base URL that is not a bare HTTPS origin", () => {
    vi.stubEnv("VITE_TRANSIT_BASE", "http://transit.test");
    expect(() => transitApiBase()).toThrow(/HTTPS/);
    vi.stubEnv("VITE_TRANSIT_BASE", "https://transit.test/transit");
    expect(() => transitApiBase()).toThrow(/without a path/);
  });

  it("loads only the shards asked for", async () => {
    const published = await publish({
      "subway.json": subwayShard(),
      "bus-si.json": busShard(),
    });
    const calls = stubFetch(published);
    const dataset = await loadTransitDataset({ subway: true });

    expect(dataset?.generation).toBe(generation);
    expect([...(dataset?.shards.keys() ?? [])]).toEqual(["subway.json"]);
    expect(dataset?.shards.get("subway.json")?.edges[0].medianSec).toBe(90);
    expect(calls.some((u) => u.includes("bus-si.json"))).toBe(false);
    expect(calls[0]).toBe(`${base}/transit/nyc/current.json`);
  });

  it("refuses a manifest whose bytes do not match the pointer digest", async () => {
    const published = await publish({ "subway.json": subwayShard() });
    published.pointer.manifestSha256 = "b".repeat(64);
    stubFetch(published);
    await expect(loadTransitDataset({ subway: true })).rejects.toThrow(/manifest hash/);
  });

  it("refuses a shard whose length contradicts the manifest", async () => {
    const published = await publish({ "subway.json": subwayShard() });
    published.bodies.set("subway.json", new TextEncoder().encode("[]"));
    stubFetch(published);
    await expect(loadTransitDataset({ subway: true })).rejects.toThrow(/byte contract/);
  });

  it("reuses a loaded shard instead of refetching it", async () => {
    const published = await publish({ "subway.json": subwayShard() });
    const calls = stubFetch(published);
    await loadTransitDataset({ subway: true });
    const afterFirst = calls.filter((u) => u.endsWith("subway.json")).length;
    await loadTransitDataset({ subway: true });
    expect(afterFirst).toBe(1);
    expect(calls.filter((u) => u.endsWith("subway.json"))).toHaveLength(1);
  });

  it("drops everything when a new generation is promoted", async () => {
    const first = await publish({ "subway.json": subwayShard() });
    stubFetch(first);
    await loadTransitDataset({ subway: true });

    const nextGen = "nyc-2026-10-01-abcdef123456";
    const promoted = await publish({ "subway.json": subwayShard() }, nextGen);
    const calls = stubFetch(promoted);
    const dataset = await loadTransitDataset({ subway: true });

    // Stop ids only mean anything within one generation, so nothing carries over.
    expect(dataset?.generation).toBe(nextGen);
    expect(calls.filter((u) => u.endsWith("subway.json"))).toHaveLength(1);
    expect(calls.some((u) => u.includes(nextGen))).toBe(true);
  });
});

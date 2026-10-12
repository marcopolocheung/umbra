import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNavigationCache,
  loadNavigationSignatureIndex,
  loadNavigationSignatureShard,
  type NavigationSnapshot,
} from "../remoteNavigation";
import { shadeSegmentKey } from "../shadeSlots";
import {
  parseNavigationSignatureIndex,
  SIGNATURE_BYTES_PER_SIDE,
  SIGNATURE_COMPONENTS,
  type NavigationShadeShard,
  type NavigationSignatureRef,
} from "../shardContract";
import { createSignatureView, type SignatureSide } from "../signatureView";

/**
 * The client's read side of the shade signatures (#321), against the frozen
 * model the producer commits and real Midtown sides whose int8 codes and types
 * the Python reference computed (`server/navigation-prep/test/fixtures`).
 */

const prep = join(import.meta.dirname, "..", "..", "..", "..", "server", "navigation-prep");
const model = JSON.parse(readFileSync(join(prep, "models", "signatures-v1.json"), "utf8"));
const parity = JSON.parse(
  readFileSync(join(prep, "test", "fixtures", "signatures-parity.json"), "utf8"),
) as { segments: number; expected: { q: number[][]; types: number[] } };

const generation = "nyc-2026-09-18-abcdef123456";
const base = "https://navigation.test";
const cellKey = "z14-4824-6157";
const segments: Array<[number, number]> = Array.from({ length: parity.segments }, (_, i) => [
  1000 + 2 * i,
  1001 + 2 * i,
]);

/** The signature payload the producer writes for the fixture's sides. */
function fixturePayload(): Uint8Array {
  const payload = new Uint8Array(parity.segments * 2 * SIGNATURE_BYTES_PER_SIDE);
  parity.expected.q.forEach((codes, side) => {
    codes.forEach((code, c) => {
      payload[side * SIGNATURE_BYTES_PER_SIDE + c] = code & 0xff;
    });
    payload[side * SIGNATURE_BYTES_PER_SIDE + SIGNATURE_COMPONENTS] = parity.expected.types[side];
  });
  return payload;
}

const shadeShard = {
  version: 1,
  dataset: "nyc-navigation",
  generation,
  kind: "shade",
  geometryBounds: { south: 40.75, west: -73.99, north: 40.76, east: -73.98 },
  supportBounds: { south: 40.75, west: -73.99, north: 40.76, east: -73.98 },
  slots: 768,
  segments,
  payload: { key: `shades/${cellKey}.bin`, bytes: 1, sha256: "0".repeat(64) },
} as NavigationShadeShard;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function published() {
  const payload = fixturePayload();
  const index = {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    kind: "signatures",
    model,
    bytesPerSide: SIGNATURE_BYTES_PER_SIDE,
    cells: [
      {
        key: cellKey,
        shadeKey: `shades/${cellKey}.json`,
        segments: parity.segments,
        payloadKey: `signatures/${cellKey}.bin`,
        bytes: payload.byteLength,
        sha256: await sha256Hex(payload),
      },
    ],
  };
  const indexBytes = new TextEncoder().encode(JSON.stringify(index));
  const ref: NavigationSignatureRef = {
    key: "signatures/index.json",
    bytes: indexBytes.byteLength,
    sha256: await sha256Hex(indexBytes),
    model: "signatures-v1",
    cells: 1,
    payloadBytes: payload.byteLength,
  };
  const snapshot: NavigationSnapshot = {
    generation,
    base,
    manifest: { signatures: ref } as NavigationSnapshot["manifest"],
  };
  return { index, indexBytes, payload, ref, snapshot };
}

function stubFetch(bodies: Record<string, Uint8Array>) {
  const calls: Array<{ url: string; cache?: unknown }> = [];
  const fetchFn = (async (url: unknown, init?: { cache?: unknown }) => {
    const href = String(url);
    calls.push({ url: href, cache: init?.cache });
    const key = href.replace(`${base}/navigation/nyc/${generation}/`, "");
    const body = bodies[key];
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.slice().buffer };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

beforeEach(() => {
  clearNavigationCache();
  vi.stubEnv("VITE_NAVIGATION_BASE", base);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Contract ─────────────────────────────────────────────────────────────────

describe("signature index contract", () => {
  it("parses the committed frozen model", async () => {
    const { index, ref } = await published();
    const parsed = parseNavigationSignatureIndex(index, ref, generation);
    expect(parsed.model.types).toHaveLength(8);
    expect(parsed.model.daySlots).toHaveLength(581);
    expect(parsed.cells[0].payloadKey).toBe(`signatures/${cellKey}.bin`);
  });

  it("rejects an index that disagrees with its ref or its own shapes", async () => {
    const { index, ref } = await published();
    const mutate = (change: (copy: typeof index) => void) => {
      const copy = structuredClone(index);
      change(copy);
      return () => parseNavigationSignatureIndex(copy, ref, generation);
    };
    expect(() => parseNavigationSignatureIndex(index, ref, "nyc-2026-10-01-abcdef123456")).toThrow();
    expect(() => parseNavigationSignatureIndex(index, { ...ref, model: "signatures-v2" })).toThrow();
    expect(() => parseNavigationSignatureIndex(index, { ...ref, payloadBytes: 1 })).toThrow();
    expect(mutate((copy) => (copy.bytesPerSide = 16))).toThrow();
    expect(mutate((copy) => copy.model.components.pop())).toThrow();
    expect(mutate((copy) => (copy.model.scales[3] = 0))).toThrow();
    expect(mutate((copy) => (copy.model.daySlots[1] = copy.model.daySlots[0]))).toThrow();
    expect(mutate((copy) => (copy.model.types[2].id = 5))).toThrow();
    expect(mutate((copy) => (copy.cells[0].payloadKey = "signatures/../manifest.json"))).toThrow();
    expect(mutate((copy) => (copy.cells[0].bytes += 17))).toThrow();
    expect(mutate((copy) => ((copy as Record<string, unknown>).extra = true))).toThrow();
    expect(
      mutate((copy) => {
        copy.cells.push({ ...copy.cells[0] });
      }),
    ).toThrow();
  });
});

// ─── Loaders ──────────────────────────────────────────────────────────────────

describe("signature loading", () => {
  it("returns null for a generation without signatures, without fetching", async () => {
    const { fetchFn, calls } = stubFetch({});
    const snapshot = { generation, base, manifest: {} } as NavigationSnapshot;
    expect(await loadNavigationSignatureIndex(snapshot, { fetchFn })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("loads the index and a cell at generation-bound URLs with force-cache", async () => {
    const { indexBytes, payload, snapshot } = await published();
    const { fetchFn, calls } = stubFetch({
      "signatures/index.json": indexBytes,
      [`signatures/${cellKey}.bin`]: payload,
    });
    const index = await loadNavigationSignatureIndex(snapshot, { fetchFn });
    expect(index?.cells).toHaveLength(1);
    const bytes = await loadNavigationSignatureShard(snapshot, index!, cellKey, { fetchFn });
    expect(bytes).toEqual(payload);
    expect(calls.map((call) => call.url)).toEqual([
      `${base}/navigation/nyc/${generation}/signatures/index.json`,
      `${base}/navigation/nyc/${generation}/signatures/${cellKey}.bin`,
    ]);
    expect(calls.every((call) => call.cache === "force-cache")).toBe(true);
  });

  it("coalesces concurrent loads into one request", async () => {
    const { indexBytes, snapshot } = await published();
    const { fetchFn, calls } = stubFetch({ "signatures/index.json": indexBytes });
    await Promise.all([
      loadNavigationSignatureIndex(snapshot, { fetchFn }),
      loadNavigationSignatureIndex(snapshot, { fetchFn }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("rejects bytes that disagree with the ref or the index entry", async () => {
    const { indexBytes, payload, snapshot } = await published();
    const tamperedIndex = indexBytes.slice();
    tamperedIndex[tamperedIndex.length - 2] ^= 1;
    await expect(
      loadNavigationSignatureIndex(snapshot, {
        fetchFn: stubFetch({ "signatures/index.json": tamperedIndex }).fetchFn,
      }),
    ).rejects.toThrow(/hash mismatch/);
    clearNavigationCache();
    await expect(
      loadNavigationSignatureIndex(snapshot, {
        fetchFn: stubFetch({ "signatures/index.json": indexBytes.subarray(1) }).fetchFn,
      }),
    ).rejects.toThrow(/byte contract/);

    clearNavigationCache();
    const { fetchFn } = stubFetch({ "signatures/index.json": indexBytes });
    const index = (await loadNavigationSignatureIndex(snapshot, { fetchFn }))!;
    const tamperedPayload = payload.slice();
    tamperedPayload[0] ^= 1;
    await expect(
      loadNavigationSignatureShard(snapshot, index, cellKey, {
        fetchFn: stubFetch({ [`signatures/${cellKey}.bin`]: tamperedPayload }).fetchFn,
      }),
    ).rejects.toThrow(/hash mismatch/);
    clearNavigationCache();
    await expect(
      loadNavigationSignatureShard(snapshot, index, cellKey, {
        fetchFn: stubFetch({ [`signatures/${cellKey}.bin`]: payload.subarray(1) }).fetchFn,
      }),
    ).rejects.toThrow(/byte contract/);
    await expect(
      loadNavigationSignatureShard(snapshot, index, "z14-1-1", { fetchFn }),
    ).rejects.toThrow(/not published/);
  });
});

// ─── View ─────────────────────────────────────────────────────────────────────

describe("signature view", () => {
  async function view() {
    const { index, ref, payload } = await published();
    const parsed = parseNavigationSignatureIndex(index, ref, generation);
    return createSignatureView(parsed, [{ shard: shadeShard, payload }]);
  }

  it("reads every side's type as the Python reference labelled it", async () => {
    const signatures = await view();
    expect(signatures.size).toBe(parity.segments * 2);
    segments.forEach(([lo, hi], segment) => {
      for (const side of [0, 1] as SignatureSide[]) {
        expect(signatures.typeOf(shadeSegmentKey(lo, hi), side)).toBe(
          parity.expected.types[segment * 2 + side],
        );
      }
    });
    expect(signatures.typeOf("1,2", 0)).toBeNull();
    expect(signatures.type(6)?.name).toMatch(/^75% shaded overall/);
  });

  it("returns the same neighbours as a full sort over the dequantized rows", async () => {
    const signatures = await view();
    const vector = (side: number) =>
      parity.expected.q[side].map((code, c) => code * model.scales[c]);
    const distance = (a: number[], b: number[]) =>
      Math.sqrt(a.reduce((sum, value, c) => sum + (value - b[c]) ** 2, 0));
    const sides = parity.segments * 2;
    for (const query of [0, 7, sides - 1]) {
      const key = shadeSegmentKey(...segments[Math.floor(query / 2)]);
      const got = signatures.nearest(key, (query % 2) as SignatureSide, 5)!;
      const expected = Array.from({ length: sides }, (_, side) => side)
        .filter((side) => side !== query)
        .map((side) => distance(vector(side), vector(query)))
        .sort((a, b) => a - b)
        .slice(0, 5);
      expect(got.map((n) => n.distance)).toEqual(expected.map((d) => expect.closeTo(d, 4)));
      expect(got.some((n) => n.key === key && n.side === query % 2)).toBe(false);
    }
    const key = shadeSegmentKey(...segments[0]);
    expect(signatures.nearest(key, 0, 1000)).toHaveLength(sides - 1);
    expect(signatures.nearest(key, 0, 0)).toEqual([]);
    expect(signatures.nearest(key, 0, 2.5)?.map((n) => n.distance)).toEqual(
      signatures.nearest(key, 0, 2)?.map((n) => n.distance),
    );
    expect(signatures.nearest("1,2", 0, 3)).toBeNull();
  });

  it("refuses a payload that does not match its shade index or repeats a segment", async () => {
    const { index, ref, payload } = await published();
    const parsed = parseNavigationSignatureIndex(index, ref, generation);
    expect(() =>
      createSignatureView(parsed, [{ shard: shadeShard, payload: payload.subarray(17) }]),
    ).toThrow();
    expect(() =>
      createSignatureView(parsed, [
        { shard: shadeShard, payload },
        { shard: shadeShard, payload },
      ]),
    ).toThrow(/two cells/);
  });
});

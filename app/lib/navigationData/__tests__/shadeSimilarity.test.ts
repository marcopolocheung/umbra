import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { buildFixtureGeneration } from "../../../../server/navigation-prep/src/fixture";
import {
  jsonBytes,
  canonicalJson,
  sha256Hex,
} from "../../../../server/navigation-prep/src/canonical";
import { packProfiles, profilePageHashes } from "../../../../server/navigation-prep/src/profiles";
import { projectSignatures } from "../../../../server/navigation-prep/src/signatures";
import { findSimilarShadeSpots, annualSquaredDistance } from "../shadeSimilaritySource";
import { createShadeSpotsView, shadeSpots } from "../shadeSpots";
import { clearNavigationCache } from "../remoteNavigation";
import { createSignatureView } from "../signatureView";
import { isShadeWindowPayload } from "../../agent/shadeWindows";
import {
  shadeCell,
  SHADE_QUERY,
  SHADE_GENERATION,
  SHADE_BOUNDS,
} from "../../agent/__tests__/shadeFixture";
import type {
  NavigationSignatureIndex,
  NavigationSignatureModel,
  NavigationManifest,
} from "../shardContract";
import type { ProfileCellIndex, ProfileIndex } from "../profileContract";
const model: NavigationSignatureModel = JSON.parse(
  await readFile("server/navigation-prep/models/signatures-v1.json", "utf8"),
);
let sequence = 0;
beforeEach(() => {
  clearNavigationCache();
  vi.stubEnv("VITE_NAVIGATION_BASE", `https://similar-${sequence++}.test`);
});
function fixture(withProfiles = true) {
  const cells = [10, 20, 30, 40, 50].map((id) => shadeCell(id));
  const street = {
    ...cells[0].street,
    nodes: cells.flatMap((c, i) => c.street.nodes.map((n) => ({ ...n, lat: n.lat + i * 0.0002 }))),
    edges: cells.flatMap((c) => c.street.edges),
  };
  const shard = { ...cells[0].shade.shard, segments: cells.map((c) => c.shade.shard.segments[0]) };
  const sides = shard.segments.length * 2;
  const raw = new Uint8Array(768 * sides);
  for (let slot = 0; slot < 768; slot++)
    for (let row = 0; row < sides; row++) raw[slot * sides + row] = row * 20;
  shard.payload = { ...shard.payload, bytes: raw.length, sha256: sha256Hex(raw) };
  const table = {
    shard,
    blocks: new Map(
      Array.from({ length: 768 }, (_, s) => [s, raw.subarray(s * sides, (s + 1) * sides)]),
    ),
  };
  const reference = shadeSpots(createShadeSpotsView([street], [table]), {
    ...SHADE_QUERY,
    mode: "sun",
  }).results[0];
  const base = buildFixtureGeneration().manifest;
  const files = new Map<string, Uint8Array>();
  const add = (key: string, bytes: Uint8Array) => {
    files.set(key, bytes);
    return { key, bytes: bytes.length, sha256: sha256Hex(bytes) };
  };
  const streetRef = {
    ...add("streets/cell-a.json", jsonBytes(street)),
    geometryBounds: SHADE_BOUNDS,
    supportBounds: SHADE_BOUNDS,
    nodes: street.nodes.length,
    edges: street.edges.length,
  };
  const shadeRef = {
    ...add("shades/cell-a.json", jsonBytes(shard)),
    geometryBounds: SHADE_BOUNDS,
    supportBounds: SHADE_BOUNDS,
    segments: shard.segments.length,
    slots: 768,
    payloadKey: shard.payload.key,
    payloadBytes: raw.length,
    payloadSha256: shard.payload.sha256,
  };
  files.set(shard.payload.key, raw);
  const sigPayload = projectSignatures(model, raw, shard.segments.length);
  const sigRef = add("signatures/cell-a.bin", sigPayload);
  const signatureIndex: NavigationSignatureIndex = {
    version: 1,
    dataset: "nyc-navigation",
    generation: SHADE_GENERATION,
    kind: "signatures",
    model,
    bytesPerSide: 17,
    cells: [
      {
        key: "cell-a",
        shadeKey: shadeRef.key,
        segments: shard.segments.length,
        payloadKey: sigRef.key,
        bytes: sigRef.bytes,
        sha256: sigRef.sha256,
      },
    ],
  };
  const signatureRef = {
    ...add("signatures/index.json", jsonBytes(signatureIndex)),
    model: model.version,
    cells: 1,
    payloadBytes: sigPayload.length,
  };
  const packed = packProfiles(raw, sides, model.daySlots);
  const profilePayload = add("profiles/cell-a.bin", packed);
  const cell: ProfileCellIndex = {
    version: 1,
    kind: "profile-cell",
    shadeKey: shadeRef.key,
    segmentsSha256: sha256Hex(canonicalJson(shard.segments)),
    sourceSha256: shard.payload.sha256,
    sides,
    payload: profilePayload,
    pageHashes: profilePageHashes(packed, 581),
  };
  const cellRef = add("profiles/cell-a.json", jsonBytes(cell));
  const index: ProfileIndex = {
    version: 1,
    kind: "profiles",
    generation: SHADE_GENERATION,
    model: model.version,
    daySlots: model.daySlots,
    pageSides: 32,
    cells: [cellRef],
  };
  const profileRef = {
    ...add("profiles/index.json", jsonBytes(index)),
    key: "profiles/index.json" as const,
    cells: 1,
    payloadBytes: packed.length,
    indexBytes: cellRef.bytes,
  };
  const manifest: NavigationManifest = {
    ...base,
    generation: SHADE_GENERATION,
    supportBounds: SHADE_BOUNDS,
    noticesPath: `navigation/nyc/${SHADE_GENERATION}/notices.json`,
    streetShards: [streetRef],
    shadeShards: [shadeRef],
    signatures: signatureRef,
    profiles: profileRef,
    budgets: {
      ...base.budgets,
      streetShardBytes: streetRef.bytes,
      shadeShardBytes: shadeRef.bytes + raw.length,
      signatureBytes: signatureRef.bytes + sigPayload.length,
      profileBytes: profileRef.bytes + cellRef.bytes + packed.length,
      totalBytes: 1_000_000,
    },
  };
  if (!withProfiles) {
    delete manifest.profiles;
    delete manifest.budgets.profileBytes;
  }
  const manifestBytes = jsonBytes(manifest);
  files.set("manifest.json", manifestBytes);
  const pointer = jsonBytes({
    version: 1,
    dataset: "nyc-navigation",
    generation: SHADE_GENERATION,
    manifestPath: `navigation/nyc/${SHADE_GENERATION}/manifest.json`,
    manifestSha256: sha256Hex(manifestBytes),
  });
  const requests: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = url.endsWith("current.json")
      ? "current.json"
      : url.split(`${SHADE_GENERATION}/`)[1];
    requests.push(key);
    const bytes = key === "current.json" ? pointer : files.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    const range = new Headers(init?.headers).get("Range");
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
      });
    }
    return new Response(bytes.slice());
  });
  return { reference, files, fetchFn, requests, shard, signatureIndex, sigPayload, cell, packed };
}
describe("A3 exact local comparison", () => {
  it("reports unavailable for generations without profile artifacts", async () => {
    const f = fixture(false);
    expect(
      await findSimilarShadeSpots(f.reference, SHADE_QUERY, { fetchFn: f.fetchFn }),
    ).toMatchObject({ reason: "no_similarity_data", results: [] });
    expect(f.requests.some((k) => k.startsWith("profiles/") || k.startsWith("streets/"))).toBe(
      false,
    );
  });
  it("loads selective profiles, excludes the reference face, reranks and returns grounded windows", async () => {
    const f = fixture();
    const result = await findSimilarShadeSpots(f.reference, SHADE_QUERY, { fetchFn: f.fetchFn });
    expect(result.status).toBe("ok");
    expect(isShadeWindowPayload(result)).toBe(true);
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.results).toHaveLength(4);
    expect(result.similarity?.reference.candidateId).toBe(f.reference.candidateId);
    expect(result.results.every((s) => s.blockFaceId !== f.reference.blockFaceId)).toBe(true);
    expect(Object.values(result.similarity!.squaredDistances)).toEqual([
      581 * 20 ** 2,
      581 * 40 ** 2,
      581 * 60 ** 2,
      581 * 80 ** 2,
    ]);
    expect(f.requests.filter((k) => k.endsWith("profiles/cell-a.bin"))).toHaveLength(1);
    expect(f.requests.some((k) => k.startsWith("buildings/"))).toBe(false);
  });
  it("rejects corrupt profile pages before loading display windows", async () => {
    const f = fixture();
    f.files.get("profiles/cell-a.bin")![0] ^= 1;
    expect(
      await findSimilarShadeSpots(f.reference, SHADE_QUERY, { fetchFn: f.fetchFn }),
    ).toMatchObject({ status: "unavailable", reason: "load_failed" });
    expect(f.requests.filter((k) => k === "shades/cell-a.bin")).toHaveLength(0);
  });
  it("rejects stale references before fetching profile cells", async () => {
    const f = fixture();
    expect(
      await findSimilarShadeSpots(
        {
          ...f.reference,
          candidateId: f.reference.candidateId.replace("000000000000", "111111111111"),
        },
        SHADE_QUERY,
        { fetchFn: f.fetchFn },
      ),
    ).toMatchObject({ reason: "stale_reference" });
    expect(f.requests).toContain("current.json");
    expect(f.requests.some((k) => k.startsWith("profiles/"))).toBe(false);
  });

  it.each(["whole-object", "wrong-range", "oversized"])(
    "rejects %s responses without a whole-cell fallback",
    async (failure) => {
      const f = fixture();
      const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await f.fetchFn(input, init);
        if (!String(input).endsWith("profiles/cell-a.bin")) return response;
        const raw = new Uint8Array(await response.arrayBuffer());
        if (failure === "whole-object") return new Response(raw, { status: 200 });
        return new Response(failure === "oversized" ? new Uint8Array(raw.length + 1) : raw, {
          status: 206,
          headers: {
            "Content-Range":
              failure === "wrong-range" ? "bytes 1-2/3" : response.headers.get("Content-Range")!,
          },
        });
      };
      expect(await findSimilarShadeSpots(f.reference, SHADE_QUERY, { fetchFn })).toMatchObject({
        reason: "load_failed",
      });
      expect(f.requests.filter((k) => k === "shades/cell-a.bin")).toHaveLength(0);
    },
  );
  it("cancels an in-flight profile comparison without producing results", async () => {
    const f = fixture(),
      controller = new AbortController();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await f.fetchFn(input, init);
      if (String(input).endsWith("profiles/cell-a.bin")) controller.abort();
      return response;
    };
    expect(
      await findSimilarShadeSpots(f.reference, SHADE_QUERY, { fetchFn, signal: controller.signal }),
    ).toMatchObject({ status: "unavailable", results: [] });
  });
  it("filters before nearest search and handles fewer eligible sides than k", () => {
    const f = fixture();
    const view = createSignatureView(f.signatureIndex, [{ shard: f.shard, payload: f.sigPayload }]);
    expect(view.nearest("10,11", 0, 500, new Set(["20,21/0"]))).toEqual([
      expect.objectContaining({ key: "20,21", side: 0 }),
    ]);
    expect(view.nearest("10,11", 0, 500, new Set())).toEqual([]);
  });
  it("uses integer-byte squared distance, including full shade", () => {
    expect(annualSquaredDistance(new Uint8Array(581), new Uint8Array(581).fill(255))).toBe(
      581 * 255 * 255,
    );
  });
});

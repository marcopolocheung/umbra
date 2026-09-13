import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeComponent,
  encodeComponent,
  quantizeHeight,
  validateManifestDependencies,
} from "../format";
import {
  encodeSyntheticFixture,
  gzipLevel6,
  syntheticComponents,
  syntheticManifest,
} from "./formatFixtures";
import { STORED_SIZE, type Component, type PlaneName, type PlaneType } from "../types";

const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));
const words = STORED_SIZE * STORED_SIZE;
function component(kind: Component["kind"] = "terrain"): Component {
  const signed = new Uint32Array(words);
  signed.fill(64);
  signed[0] = -64 >>> 0;
  signed[STORED_SIZE - 1] = 0;
  signed[words - 1] = 128;
  const unsigned = new Uint32Array(words);
  unsigned.fill(2);
  unsigned[0] = 0xffffffff;
  unsigned[STORED_SIZE - 1] = 0;
  unsigned[words - 1] = 0x80000000;
  return {
    kind,
    identity: {
      generation: "g1",
      tile: "18/77123/98543",
      sourceHash: `${kind}-source`,
      recipeHash: "recipe",
      datumHash: "datum",
      hierarchyHash: "tree",
      licenceHash: `${kind}-licence`,
    },
    support: "present",
    evidence: { source: "fixture" },
    tables: {
      licences: [{ id: "l", notice: "synthetic" }],
      provenance: [{ id: "p", source: "synthetic", support: "present" }],
      evidence: [{ id: "e", subject: "fixture", hash: "e" }],
    },
    planes: [
      {
        name: kind === "terrain" ? "groundQ" : "buildingAglQ",
        type: "i32",
        words: signed,
        predictor: "horizontal-delta-u32",
        provenanceTableIndex: 0,
      },
      {
        name: "provenanceIndex",
        type: "u32",
        words: unsigned,
        predictor: "none",
        provenanceTableIndex: 0,
        materialTableIndex: 0,
      },
    ],
  };
}

function rewriteDirectory(
  source: Uint8Array,
  change: (directory: Record<string, unknown>) => void,
  payload?: Uint8Array,
): Uint8Array {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const initialLength = view.getUint32(8, true);
  const directory = JSON.parse(
    new TextDecoder().decode(source.subarray(16, 16 + initialLength)),
  ) as Record<string, unknown>;
  const body = payload ?? source.subarray(16 + initialLength);
  change(directory);
  let json = new TextEncoder().encode(JSON.stringify(directory));
  directory.payloadOffset = 16 + json.byteLength;
  directory.payloadLength = body.byteLength;
  json = new TextEncoder().encode(JSON.stringify(directory));
  directory.payloadOffset = 16 + json.byteLength;
  json = new TextEncoder().encode(JSON.stringify(directory));
  const result = new Uint8Array(16 + json.byteLength + body.byteLength);
  result.set(source.subarray(0, 16));
  new DataView(result.buffer).setUint32(8, json.byteLength, true);
  result.set(json, 16);
  result.set(body, 16 + json.byteLength);
  return result;
}

describe("v2 component format", () => {
  it("quantizes finite heights once while preserving zero and negative values", () => {
    expect(quantizeHeight(-1.5)).toBe(-96);
    expect(quantizeHeight(0)).toBe(0);
    expect(quantizeHeight(0.01)).toBe(1);
    expect(() => quantizeHeight(Number.NaN)).toThrow(/nonfinite/);
    expect(() => quantizeHeight(100_001)).toThrow(/range/);
  });

  it("round trips signed, unsigned, first/last rows, borders and both predictors", async () => {
    const encoded = await encodeComponent(component(), gzip);
    const decoded = await decodeComponent(encoded.bytes);
    expect(decoded.planes[0].words[0] | 0).toBe(-64);
    expect(decoded.planes[0].words[STORED_SIZE - 1]).toBe(0);
    expect(decoded.planes[0].words.at(-1)).toBe(128);
    expect(decoded.planes[1].words[0]).toBe(0xffffffff);
    expect(decoded.planes[1].words.at(-1)).toBe(0x80000000);
    expect(encoded.transportHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("round trips every declared band name and canonical word type", async () => {
    const names: PlaneName[] = [
      "groundQ",
      "foundationQ",
      "foundationPresent",
      "buildingAglQ",
      "buildingMask",
      "buildingFeatureId",
      "buildingPriority",
      "canopyHeightAglQ",
      "canopyBaseAglQ",
      "canopyMask",
      "canopySupport",
      "fallbackCrownTopAglQ",
      "fallbackCrownBaseAglQ",
      "fallbackCanopyMask",
      "fallbackFeatureId",
      "crownBaseAglQ",
      "crownTopAglQ",
      "flagsAndMaterial",
      "provenanceIndex",
    ];
    const unsigned = new Set<PlaneName>([
      "foundationPresent",
      "buildingMask",
      "buildingFeatureId",
      "buildingPriority",
      "canopyMask",
      "canopySupport",
      "fallbackCanopyMask",
      "fallbackFeatureId",
      "flagsAndMaterial",
      "provenanceIndex",
    ]);
    const planes = names.map((name, index) => {
      const data = new Uint32Array(words);
      data[0] = index === 0 ? -1 >>> 0 : index;
      data[words - 1] = 0xffffffff - index;
      return {
        name,
        type: (unsigned.has(name) ? "u32" : "i32") as PlaneType,
        words: data,
        predictor: index % 2 ? ("none" as const) : ("horizontal-delta-u32" as const),
      };
    });
    for (let offset = 0; offset < planes.length; offset += 8) {
      const batch = planes.slice(offset, offset + 8);
      const decoded = await decodeComponent(
        (await encodeComponent({ ...component(), planes: batch }, gzip)).bytes,
      );
      expect(decoded.planes.map((entry) => entry.name)).toEqual(batch.map((entry) => entry.name));
      expect(decoded.planes.map((entry) => entry.words.at(-1))).toEqual(
        batch.map((entry) => entry.words.at(-1)),
      );
    }
  });

  it("rejects format, codec, predictor, range, table, checksum and decompression failures", async () => {
    const encoded = await encodeComponent(component(), gzip);
    const corrupted = encoded.bytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(decodeComponent(corrupted)).rejects.toThrow();
    const mutations: Array<(directory: Record<string, unknown>) => void> = [
      (d) => {
        d.codec = "br";
      },
      (d) => {
        d.version = 99;
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].predictor = "mystery";
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].name = "unknown-plane";
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].type = "u16";
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[1].decodedOffset = 0;
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].decodedLength = 4;
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].provenanceTableIndex = 9;
      },
      (d) => {
        (d.planes as Array<Record<string, unknown>>)[0].checksum = "bad";
      },
    ];
    for (const mutation of mutations)
      await expect(decodeComponent(rewriteDirectory(encoded.bytes, mutation))).rejects.toThrow();
    const unknownHeader = encoded.bytes.slice();
    new DataView(unknownHeader.buffer).setUint16(4, 2, true);
    await expect(decodeComponent(unknownHeader)).rejects.toThrow(/format/);
    await expect(decodeComponent(encoded.bytes.subarray(0, 19))).rejects.toThrow();
    const huge = new Uint8Array(words * 4 * 9);
    const hugeGzip = new Uint8Array(gzipSync(huge, { level: 6 }));
    await expect(
      decodeComponent(rewriteDirectory(encoded.bytes, () => {}, hugeGzip)),
    ).rejects.toThrow(/decoded payload exceeds limit/);
  });

  it("pins only matching manifest dependencies and preserves independent fixture bytes", async () => {
    const fixture = await encodeSyntheticFixture();
    const changedTerrain = await encodeSyntheticFixture(1);
    expect(changedTerrain.encoded[0].bytes).not.toEqual(fixture.encoded[0].bytes);
    expect(changedTerrain.encoded[1].bytes).toEqual(fixture.encoded[1].bytes);
    expect(changedTerrain.encoded[2].bytes).toEqual(fixture.encoded[2].bytes);
    expect(() =>
      validateManifestDependencies(syntheticManifest(fixture.components), fixture.components),
    ).not.toThrow();
    const mixed = syntheticComponents();
    mixed[1].identity.datumHash = "mixed";
    expect(() => validateManifestDependencies(syntheticManifest(), mixed)).toThrow(/mixed/);
    const one = component();
    const encoded = await encodeComponent(one, gzip);
    const decoded = await decodeComponent(encoded.bytes);
    const manifest = {
      generation: one.identity.generation,
      recipeHash: one.identity.recipeHash,
      datumHash: one.identity.datumHash,
      hierarchyHash: one.identity.hierarchyHash,
      components: [
        {
          kind: one.kind,
          tile: one.identity.tile,
          sourceHash: one.identity.sourceHash,
          recipeHash: one.identity.recipeHash,
          datumHash: one.identity.datumHash,
          hierarchyHash: one.identity.hierarchyHash,
          licenceHash: one.identity.licenceHash,
          objectHash: encoded.transportHash,
        },
      ],
    };
    expect(() => validateManifestDependencies(manifest, [decoded])).not.toThrow();
    manifest.components[0].objectHash = "wrong-object";
    expect(() => validateManifestDependencies(manifest, [decoded])).toThrow(/mixed/);
  });

  it("uses the reusable node level-6 compressor", async () => {
    const encoded = await encodeComponent(component(), gzipLevel6);
    await expect(decodeComponent(encoded.bytes)).resolves.toMatchObject({ kind: "terrain" });
  });
});

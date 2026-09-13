import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeComponent, encodeComponent, validateManifestDependencies } from "../format";
import { STORED_SIZE, type Component } from "../types";

const gzip = async (plain: Uint8Array) => new Uint8Array(gzipSync(plain, { level: 6 }));
function signedWords(value: number): Uint32Array { const result = new Uint32Array(STORED_SIZE * STORED_SIZE); result.fill(value); result[0] = (-64) >>> 0; result[result.length - 1] = 128; return result; }
function unsignedWords(value: number): Uint32Array { const result = new Uint32Array(STORED_SIZE * STORED_SIZE); result.fill(value); result[0] = 0xffffffff; result[result.length - 1] = 0x80000000; return result; }
function component(kind: Component["kind"] = "terrain"): Component {
  return { kind, identity: { generation: "g1", tile: "18/77123/98543", sourceHash: `${kind}-source`, recipeHash: "recipe", datumHash: "datum", hierarchyHash: "tree", licenceHash: `${kind}-licence` }, evidence: { source: "fixture" }, planes: [{ name: kind === "terrain" ? "groundQ" : "buildingAglQ", type: "i32", words: signedWords(64), predictor: "horizontal-delta-u32" }, { name: "provenanceIndex", type: "u32", words: unsignedWords(2), predictor: "none" }] };
}

describe("v2 component format", () => {
  it("round trips signed, unsigned, first/last and border words", async () => {
    const encoded = await encodeComponent(component(), gzip);
    const decoded = await decodeComponent(encoded.bytes);
    expect(decoded.planes[0].words[0] | 0).toBe(-64);
    expect(decoded.planes[0].words.at(-1)).toBe(128);
    expect(decoded.planes[1].words[0]).toBe(0xffffffff);
    expect(decoded.planes[1].words.at(-1)).toBe(0x80000000);
    expect(encoded.transportHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects corruption and mixed dependencies", async () => {
    const encoded = await encodeComponent(component(), gzip);
    const corrupt = encoded.bytes.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    await expect(decodeComponent(corrupt)).rejects.toThrow();
    const terrain = component();
    const building = component("buildings");
    expect(() => validateManifestDependencies({ generation: "g1", recipeHash: "recipe", datumHash: "datum", hierarchyHash: "tree", components: [
      { kind: "terrain", tile: terrain.identity.tile, sourceHash: terrain.identity.sourceHash, recipeHash: "recipe", datumHash: "datum", hierarchyHash: "tree", licenceHash: terrain.identity.licenceHash, objectHash: "a" },
      { kind: "buildings", tile: building.identity.tile, sourceHash: building.identity.sourceHash, recipeHash: "recipe", datumHash: "datum", hierarchyHash: "tree", licenceHash: building.identity.licenceHash, objectHash: "b" },
    ] }, [terrain, building])).not.toThrow();
    building.identity.datumHash = "mixed";
    expect(() => validateManifestDependencies({ generation: "g1", recipeHash: "recipe", datumHash: "datum", hierarchyHash: "tree", components: [] }, [building])).toThrow(/component count/);
  });
});

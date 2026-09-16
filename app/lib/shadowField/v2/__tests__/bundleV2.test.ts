import { describe, expect, it } from "vitest";
import {
  assertSharedIdentity,
  decodeBrowserTileBundle,
  encodeBrowserTileBundle,
} from "../bundle";
import { encodeComponent } from "../format";
import { STORED_SIZE, type Component, type ComponentKind } from "../types";
import { gzipLevel6 } from "./formatFixtures";

const cells = STORED_SIZE * STORED_SIZE;
const model = {
  normalizerHash: "n".repeat(64),
  compositorHash: "o".repeat(64),
  treeModelHash: "t".repeat(64),
  receiverHash: "r".repeat(64),
};

function v2Identity(kind: ComponentKind, recipe = "recipe-v2") {
  return {
    generation: "test-gen-v2",
    tile: "18/77123/98543",
    sourceHash: `source-${kind}`,
    recipeHash: recipe,
    datumHash: "datum-v2",
    hierarchyHash: "hierarchy-v2",
    licenceHash: `licence-${kind}`,
    ...model,
  };
}

function v2Components(recipe = "recipe-v2"): Component[] {
  const ground = new Uint32Array(cells).fill(64);
  const mask = new Uint32Array(cells);
  mask[7] = 1;
  const agl = new Uint32Array(cells);
  agl[7] = 640;
  const known = new Uint32Array(cells).fill(1);
  const zeros = new Uint32Array(cells);
  const component = (kind: ComponentKind, support: Component["support"], planes: Component["planes"]): Component => ({
    kind,
    identity: v2Identity(kind, recipe),
    support,
    evidence: {},
    tables: {
      licences: [{ id: `${kind}-licence`, notice: `${kind} notice` }],
      provenance: [{ id: `${kind}-provenance`, source: "test", support: support ?? "present" }],
      evidence: [{ id: `${kind}-evidence`, subject: kind, hash: "e".repeat(64) }],
    },
    planes,
  });
  return [
    component("terrain", "present", [
      { name: "groundQ", type: "i32", words: ground },
      { name: "foundationQ", type: "i32", words: zeros.slice() },
      { name: "foundationPresent", type: "u32", words: zeros.slice() },
    ]),
    component("buildings", "present", [
      { name: "buildingAglQ", type: "i32", words: agl },
      { name: "buildingMask", type: "u32", words: mask },
      { name: "buildingSupport", type: "u32", words: known },
      { name: "buildingFeatureId", type: "u32", words: zeros.slice() },
    ]),
    component("canopy", "known-empty", [
      { name: "canopyHeightAglQ", type: "i32", words: zeros.slice() },
      { name: "canopyBaseAglQ", type: "i32", words: zeros.slice() },
      { name: "canopyMask", type: "u32", words: zeros.slice() },
      { name: "canopySupport", type: "u32", words: known.slice() },
    ]),
  ];
}

async function v2Bundle(recipe = "recipe-v2") {
  const components = v2Components(recipe);
  const encoded = await Promise.all(components.map((component) => encodeComponent(component, gzipLevel6)));
  return {
    components,
    componentEncoded: encoded,
    encoded: encodeBrowserTileBundle(
      "18/77123/98543",
      components.map((component, index) => ({ component, encoded: encoded[index] })),
    ),
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function slicesOf(bundle: Uint8Array) {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const directoryLength = view.getUint32(8, true);
  const directory = JSON.parse(
    new TextDecoder().decode(bundle.subarray(12, 12 + directoryLength)),
  ) as {
    version: number;
    tile: string;
    components: Array<{ kind: string; offset: number; length: number; transportHash: string; physicsHash: string }>;
  };
  const body = bundle.subarray(12 + directoryLength);
  const slices = directory.components.map((entry) => body.subarray(entry.offset, entry.offset + entry.length).slice());
  return { directoryLength, directory, body, slices };
}

describe("v2 bundle physics and identity verification", () => {
  it("round-trips a v2 generation bundle", async () => {
    const { encoded } = await v2Bundle();
    const decoded = await decodeBrowserTileBundle(encoded.bytes);
    expect(decoded.map((item) => item.support)).toEqual(["present", "present", "known-empty"]);
  });

  it("rejects a mismatched outer physics record", async () => {
    const { encoded } = await v2Bundle();
    const { directoryLength, directory, body } = slicesOf(encoded.bytes);
    const tampered = {
      ...directory,
      components: directory.components.map((entry, index) =>
        index === 0 ? { ...entry, physicsHash: "f".repeat(64) } : entry,
      ),
    };
    const directoryBytes = new TextEncoder().encode(JSON.stringify(tampered));
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode("SMB1"));
    new DataView(header.buffer).setUint16(4, 1, true);
    new DataView(header.buffer).setUint16(6, 3, true);
    new DataView(header.buffer).setUint32(8, directoryBytes.byteLength, true);
    const out = new Uint8Array(12 + directoryBytes.byteLength + body.byteLength);
    out.set(header, 0);
    out.set(directoryBytes, 12);
    out.set(body, 12 + directoryBytes.byteLength);
    await expect(decodeBrowserTileBundle(out)).rejects.toThrow(/physics/);
    void directoryLength;
  });

  it("never mixes generations inside one bundle", async () => {
    const a = await v2Bundle("recipe-a");
    const b = await v2Bundle("recipe-b");
    // The encoder refuses to build a mixed bundle in the first place.
    expect(() =>
      encodeBrowserTileBundle("18/77123/98543", [
        { component: a.components[0], encoded: a.componentEncoded[0] },
        { component: b.components[1], encoded: b.componentEncoded[1] },
        { component: a.components[2], encoded: a.componentEncoded[2] },
      ]),
    ).toThrow(/identity/);
    expect(() =>
      assertSharedIdentity([
        v2Identity("terrain", "recipe-a"),
        v2Identity("buildings", "recipe-b"),
        v2Identity("canopy", "recipe-a"),
      ]),
    ).toThrow(/identity/);
    // A hand-spliced hybrid with consistent framing still fails on decode.
    const both = [slicesOf(a.encoded.bytes), slicesOf(b.encoded.bytes)];
    const body = concatBytes([both[0].slices[0], both[1].slices[1], both[0].slices[2]]);
    const hybrid = {
      ...both[0].directory,
      components: [both[0].directory.components[0], both[1].directory.components[1], both[0].directory.components[2]],
    };
    let offset = 0;
    for (const entry of hybrid.components) {
      entry.offset = offset;
      offset += entry.length;
    }
    const directoryBytes = new TextEncoder().encode(JSON.stringify(hybrid));
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode("SMB1"));
    new DataView(header.buffer).setUint16(4, 1, true);
    new DataView(header.buffer).setUint16(6, 3, true);
    new DataView(header.buffer).setUint32(8, directoryBytes.byteLength, true);
    const out = new Uint8Array(12 + directoryBytes.byteLength + body.byteLength);
    out.set(header, 0);
    out.set(directoryBytes, 12);
    out.set(body, 12 + directoryBytes.byteLength);
    await expect(decodeBrowserTileBundle(out)).rejects.toThrow(/identity/);
  });

  it("rejects legacy-unset support cells in v2 bundles", async () => {
    const components = v2Components();
    const support = components[1].planes.find((plane) => plane.name === "buildingSupport")!.words;
    support[3] = 0;
    const encoded = await Promise.all(components.map((component) => encodeComponent(component, gzipLevel6)));
    const bundle = encodeBrowserTileBundle(
      "18/77123/98543",
      components.map((component, index) => ({ component, encoded: encoded[index] })),
    );
    await expect(decodeBrowserTileBundle(bundle.bytes)).rejects.toThrow(/legacy-unset/);
  });

  it("rejects known-empty over a nonempty v2 mask", async () => {
    const components = v2Components();
    components[1].support = "known-empty";
    const provenance = components[1].tables!.provenance;
    provenance[0] = { ...provenance[0], support: "known-empty" };
    const encoded = await Promise.all(components.map((component) => encodeComponent(component, gzipLevel6)));
    const bundle = encodeBrowserTileBundle(
      "18/77123/98543",
      components.map((component, index) => ({ component, encoded: encoded[index] })),
    );
    await expect(decodeBrowserTileBundle(bundle.bytes)).rejects.toThrow(/known-empty/);
  });

  it("grandfathers v1 all-zero support for support semantics only", async () => {
    // v1 shape: no model identity, all-zero building support, nonempty mask,
    // coarse known-empty — the exact Times Square defect stays decodable.
    const components = v2Components();
    for (const component of components) {
      const identity = component.identity as unknown as Record<string, unknown>;
      delete identity.normalizerHash;
      delete identity.compositorHash;
      delete identity.treeModelHash;
      delete identity.receiverHash;
    }
    const buildings = components[1];
    buildings.planes.find((plane) => plane.name === "buildingSupport")!.words.fill(0);
    buildings.support = "known-empty";
    buildings.tables!.provenance[0] = { ...buildings.tables!.provenance[0], support: "known-empty" };
    const encoded = await Promise.all(components.map((component) => encodeComponent(component, gzipLevel6)));
    const bundle = encodeBrowserTileBundle(
      "18/77123/98543",
      components.map((component, index) => ({ component, encoded: encoded[index] })),
    );
    const decoded = await decodeBrowserTileBundle(bundle.bytes);
    expect(decoded).toHaveLength(3);
    expect(decoded[1].support).toBe("known-empty");
  });
});

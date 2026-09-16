import { describe, expect, it } from "vitest";
import {
  decodeBrowserTileBundle,
  encodeBrowserTileBundle,
} from "../bundle";
import { encodeSyntheticFixture } from "./formatFixtures";

const HEADER_BYTES = 12;

async function validBundle() {
  const fixture = await encodeSyntheticFixture();
  const tile = "18/77123/98543";
  const encoded = encodeBrowserTileBundle(
    tile,
    fixture.components.map((component, index) => ({
      component,
      encoded: fixture.encoded[index],
    })),
  );
  return { fixture, tile, encoded };
}

function splitBundle(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryLength = view.getUint32(8, true);
  const directory = JSON.parse(
    new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + directoryLength)),
  ) as {
    version: number;
    tile: string;
    components: Array<{
      kind: string;
      offset: number;
      length: number;
      transportHash: string;
      physicsHash: string;
    }>;
  };
  const body = bytes.subarray(HEADER_BYTES + directoryLength);
  return { directoryLength, directory, body };
}

function rebuildBundle(
  source: Uint8Array,
  mutate: (directory: ReturnType<typeof splitBundle>["directory"]) => void,
  body?: Uint8Array,
) {
  const { directoryLength, directory, body: originalBody } = splitBundle(source);
  void directoryLength;
  mutate(directory);
  const directoryBytes = new TextEncoder().encode(JSON.stringify(directory));
  const payload = body ?? originalBody;
  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode("SMB1"));
  const view = new DataView(header.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 3, true);
  view.setUint32(8, directoryBytes.byteLength, true);
  const out = new Uint8Array(HEADER_BYTES + directoryBytes.byteLength + payload.byteLength);
  out.set(header, 0);
  out.set(directoryBytes, HEADER_BYTES);
  out.set(payload, HEADER_BYTES + directoryBytes.byteLength);
  return out;
}

describe("v2 browser tile bundle transport", () => {
  it("round-trips three independently verifiable components", async () => {
    const { encoded } = await validBundle();
    const components = await decodeBrowserTileBundle(encoded.bytes);
    expect(components.map((item) => item.kind).sort()).toEqual([
      "buildings",
      "canopy",
      "terrain",
    ]);
  });

  it("rejects framing failures and truncated directories", async () => {
    const { encoded } = await validBundle();
    const badMagic = encoded.bytes.slice();
    badMagic[0] = 0x58; // XMB1
    await expect(decodeBrowserTileBundle(badMagic)).rejects.toThrow(/format/);
    const badVersion = encoded.bytes.slice();
    new DataView(badVersion.buffer).setUint16(4, 2, true);
    await expect(decodeBrowserTileBundle(badVersion)).rejects.toThrow(/version/);
    await expect(decodeBrowserTileBundle(encoded.bytes.subarray(0, 11))).rejects.toThrow();
    const view = new DataView(encoded.bytes.buffer, encoded.bytes.byteOffset, encoded.bytes.byteLength);
    const fullLength = view.getUint32(8, true);
    const truncated = encoded.bytes.subarray(0, HEADER_BYTES + fullLength - 1);
    await expect(decodeBrowserTileBundle(truncated)).rejects.toThrow(/truncat/);
  });

  it("rejects overlapping entries", async () => {
    const { encoded } = await validBundle();
    const overlapping = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[1].offset = directory.components[0].offset;
    });
    await expect(decodeBrowserTileBundle(overlapping)).rejects.toThrow(/entry/);
  });

  it("rejects gaps and trailing unclaimed bytes", async () => {
    const { encoded } = await validBundle();
    const gapped = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[1].offset += 1;
      directory.components[2].offset += 1;
    });
    await expect(decodeBrowserTileBundle(gapped)).rejects.toThrow(/entry/);
    const { body } = splitBundle(encoded.bytes);
    const extended = new Uint8Array(body.byteLength + 1);
    extended.set(body, 0);
    const trailed = rebuildBundle(encoded.bytes, () => {}, extended);
    await expect(decodeBrowserTileBundle(trailed)).rejects.toThrow(/entry/);
  });

  it("rejects out-of-range and non-integer ranges", async () => {
    const { encoded } = await validBundle();
    const { body } = splitBundle(encoded.bytes);
    const pastEnd = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[2].length = body.byteLength;
    });
    await expect(decodeBrowserTileBundle(pastEnd)).rejects.toThrow(/entry/);
    const fractional = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].offset = 0.5;
    });
    await expect(decodeBrowserTileBundle(fractional)).rejects.toThrow(/entry/);
    const negative = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].offset = -1;
    });
    await expect(decodeBrowserTileBundle(negative)).rejects.toThrow(/entry/);
  });

  it("rejects wrong kind, duplicate kind, and tile mismatch", async () => {
    const { encoded } = await validBundle();
    const duplicate = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[1].kind = directory.components[0].kind;
    });
    await expect(decodeBrowserTileBundle(duplicate)).rejects.toThrow(/entry|mismatch/);
    const badKind = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].kind = "roads";
    });
    await expect(decodeBrowserTileBundle(badKind)).rejects.toThrow(/entry/);
    const badTile = rebuildBundle(encoded.bytes, (directory) => {
      directory.tile = "18/1/1";
    });
    await expect(decodeBrowserTileBundle(badTile)).rejects.toThrow(/mismatch/);
  });

  it("rejects invalid hash syntax without decoding components", async () => {
    const { encoded } = await validBundle();
    const badTransport = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].transportHash = "not-hex";
    });
    await expect(decodeBrowserTileBundle(badTransport)).rejects.toThrow(/entry/);
    const badPhysics = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].physicsHash = "0".repeat(63);
    });
    await expect(decodeBrowserTileBundle(badPhysics)).rejects.toThrow(/entry/);
  });

  it("rejects truncation and component corruption", async () => {
    const { encoded } = await validBundle();
    await expect(
      decodeBrowserTileBundle(encoded.bytes.subarray(0, encoded.bytes.byteLength - 1)),
    ).rejects.toThrow();
    const corrupted = encoded.bytes.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(decodeBrowserTileBundle(corrupted)).rejects.toThrow();
    const wrongHash = rebuildBundle(encoded.bytes, (directory) => {
      directory.components[0].transportHash = "0".repeat(64);
    });
    await expect(decodeBrowserTileBundle(wrongHash)).rejects.toThrow(/mismatch/);
  });
});

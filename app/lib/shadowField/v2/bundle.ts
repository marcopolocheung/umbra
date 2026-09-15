import { decodeComponent, type encodeComponent } from "./format";
import type { Component, EncodedComponent } from "./types";

/**
 * A browser tile is one request containing the three independently encoded v2
 * components.  Components remain independently verifiable; the bundle only
 * removes two network round trips from the critical path.
 */
const MAGIC = "SMB1";
const HEADER_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BrowserTileBundleEntry {
  kind: Component["kind"];
  offset: number;
  length: number;
  transportHash: string;
  physicsHash: string;
}

export interface BrowserTileBundleDirectory {
  version: 1;
  tile: string;
  components: BrowserTileBundleEntry[];
}

export interface EncodedBrowserTileBundle {
  bytes: Uint8Array;
  directory: BrowserTileBundleDirectory;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Create a compact, deterministic one-request container for exactly one tile. */
export function encodeBrowserTileBundle(
  tile: string,
  components: Array<{ component: Component; encoded: EncodedComponent }>,
): EncodedBrowserTileBundle {
  if (!/^18\/\d+\/\d+$/.test(tile) || components.length !== 3)
    throw new Error("a browser tile bundle requires exactly three z18 components");
  const kinds = components.map(({ component }) => component.kind);
  if (new Set(kinds).size !== 3 || !["terrain", "buildings", "canopy"].every((kind) => kinds.includes(kind as Component["kind"])))
    throw new Error("a browser tile bundle requires terrain, buildings, and canopy");
  if (components.some(({ component }) => component.identity.tile !== tile))
    throw new Error("bundle component tile mismatch");

  let offset = 0;
  const entries = components.map(({ component, encoded }) => {
    const entry: BrowserTileBundleEntry = {
      kind: component.kind,
      offset,
      length: encoded.bytes.byteLength,
      transportHash: encoded.transportHash,
      physicsHash: encoded.physicsHash,
    };
    offset += encoded.bytes.byteLength;
    return entry;
  });
  const directory: BrowserTileBundleDirectory = { version: 1, tile, components: entries };
  const directoryBytes = encoder.encode(JSON.stringify(directory));
  const header = new Uint8Array(HEADER_BYTES);
  header.set(encoder.encode(MAGIC));
  const view = new DataView(header.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, components.length, true);
  view.setUint32(8, directoryBytes.byteLength, true);
  return { bytes: concat([header, directoryBytes, ...components.map(({ encoded }) => encoded.bytes)]), directory };
}

/** Parse and independently verify every embedded component before composition. */
export async function decodeBrowserTileBundle(bytes: Uint8Array): Promise<Component[]> {
  if (bytes.byteLength < HEADER_BYTES || decoder.decode(bytes.subarray(0, 4)) !== MAGIC)
    throw new Error("unknown browser tile bundle format");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 3)
    throw new Error("unsupported browser tile bundle version");
  const length = view.getUint32(8, true);
  if (length === 0 || HEADER_BYTES + length > bytes.byteLength)
    throw new Error("truncated browser tile bundle directory");
  let directory: BrowserTileBundleDirectory;
  try {
    directory = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))) as BrowserTileBundleDirectory;
  } catch {
    throw new Error("invalid browser tile bundle directory");
  }
  if (directory.version !== 1 || !/^18\/\d+\/\d+$/.test(directory.tile) || !Array.isArray(directory.components) || directory.components.length !== 3)
    throw new Error("invalid browser tile bundle directory");
  const seen = new Set<Component["kind"]>();
  const components: Component[] = [];
  for (const entry of directory.components) {
    const end = entry.offset + entry.length;
    if (!(["terrain", "buildings", "canopy"] as const).includes(entry.kind) || seen.has(entry.kind) || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) || entry.offset < 0 || entry.length <= 0 || end > bytes.byteLength - HEADER_BYTES - length)
      throw new Error("invalid browser tile bundle entry");
    seen.add(entry.kind);
    const start = HEADER_BYTES + length + entry.offset;
    const component = await decodeComponent(bytes.subarray(start, start + entry.length));
    if (component.kind !== entry.kind || component.identity.tile !== directory.tile || component.transportHash !== entry.transportHash)
      throw new Error("browser tile bundle component mismatch");
    components.push(component);
  }
  return components;
}

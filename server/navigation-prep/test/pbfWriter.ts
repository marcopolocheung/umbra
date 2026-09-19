/**
 * Minimal PBF writer for hermetic producer tests. Nodes are non-dense with
 * absolute ids; way refs are delta+zigzag encoded per the OSM PBF spec, and
 * coordinates are stored at the default 100-nanodegree granularity.
 */

import { deflateSync } from "node:zlib";

export interface TestNode {
  id: number;
  lat: number;
  lon: number;
}

export interface TestWay {
  id: number;
  refs: number[];
  tags?: Record<string, string>;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let v = value < 0 ? BigInt.asUintN(64, BigInt(value)) : BigInt(value);
  while (true) {
    const byte = Number(v & BigInt(0x7f));
    v >>= BigInt(7);
    if (v === BigInt(0)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

function zigzag(value: number): number {
  const v = BigInt.asIntN(64, BigInt(value));
  return Number((v << BigInt(1)) ^ (v >> BigInt(63)));
}

function fieldVarint(field: number, value: number): number[] {
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldBytes(field: number, bytes: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

function packedVarint(field: number, values: number[]): number[] {
  return fieldBytes(
    field,
    values.flatMap((value) => varint(value)),
  );
}

/** delta+zigzag encoding for a way ref list. */
function encodeDeltaRefs(values: number[]): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const value of values) {
    out.push(...varint(zigzag(value - previous)));
    previous = value;
  }
  return out;
}

export function encodeTestPbf(nodes: TestNode[], ways: TestWay[]): Buffer {
  const strings: string[] = [];
  const indexOf = (value: string): number => {
    let index = strings.indexOf(value);
    if (index < 0) {
      index = strings.length;
      strings.push(value);
    }
    return index;
  };

  const dense: number[] = (() => {
    const sorted = [...nodes].sort((a, b) => a.id - b.id);
    let prevId = 0;
    let prevLat = 0;
    let prevLon = 0;
    const ids: number[] = [];
    const lats: number[] = [];
    const lons: number[] = [];
    for (const node of sorted) {
      const lat = Math.round((node.lat * 1e9) / 100);
      const lon = Math.round((node.lon * 1e9) / 100);
      ids.push(zigzag(node.id - prevId));
      lats.push(zigzag(lat - prevLat));
      lons.push(zigzag(lon - prevLon));
      prevId = node.id;
      prevLat = lat;
      prevLon = lon;
    }
    return [...packedVarint(1, ids), ...packedVarint(8, lats), ...packedVarint(9, lons)];
  })();
  const wayGroup: number[][] = [...ways]
    .sort((a, b) => a.id - b.id)
    .map((way): number[] => {
      const entries = Object.entries(way.tags ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
      return fieldBytes(3, [
        ...fieldVarint(1, way.id),
        ...packedVarint(
          2,
          entries.map(([key]) => indexOf(key)),
        ),
        ...packedVarint(
          3,
          entries.map(([, value]) => indexOf(value)),
        ),
        ...packedVarint(8, encodeDeltaRefs(way.refs)),
      ]);
    });

  // StringTable.s is a repeated bytes field: one tag + length per entry, and
  // the whole StringTable message is itself the field-1 payload of the block.
  const stringTableRows = strings.map((value): number[] =>
    fieldBytes(1, [...Buffer.from(value, "utf8")]),
  );
  const groupParts: number[] = [];
  if (nodes.length > 0) groupParts.push(...fieldBytes(2, dense));
  for (const row of wayGroup) groupParts.push(...row);
  const primitiveGroup = fieldBytes(2, groupParts);
  const block: number[] = [...fieldBytes(1, stringTableRows.flat())];
  block.push(...primitiveGroup);
  block.push(...fieldVarint(17, 100));
  block.push(...fieldVarint(18, 1000));
  block.push(...fieldVarint(19, 0));
  block.push(...fieldVarint(20, 0));

  const headerBlock: number[] = [];
  headerBlock.push(...fieldBytes(4, [...Buffer.from("OsmSchema-V0.6", "utf8")]));
  headerBlock.push(...fieldBytes(4, [...Buffer.from("DenseNodes", "utf8")]));
  headerBlock.push(...fieldVarint(32, 1_758_000_000));

  const blobMessage = (type: string, payload: number[]): Buffer => {
    const compressed = deflateSync(Buffer.from(payload));
    const blob: number[] = [
      ...fieldVarint(2, Buffer.from(payload).length), // raw_size (deprecated)
      ...fieldBytes(3, [...compressed]), // zlib_data
    ];
    const header: number[] = [
      ...fieldBytes(1, [...Buffer.from(type, "utf8")]),
      ...fieldVarint(3, blob.length), // datasize
    ];
    const frameSize = Buffer.alloc(4);
    frameSize.writeUInt32BE(header.length);
    return Buffer.concat([frameSize, Buffer.from(header), Buffer.from(blob)]);
  };

  return Buffer.concat([blobMessage("OSMHeader", headerBlock), blobMessage("OSMData", block)]);
}

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { inflateSync } from "node:zlib";
import parseOSM from "osm-pbf-parser";
import { PREP_BOUNDS, expandBounds } from "./boundary";

/**
 * Streaming New York PBF intake. Reproduces the Overpass query the app makes,
 * not some richer graph semantics:
 *
 *   way["highway"~"^(footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps|track|bridleway)$"]["area"!="yes"](bbox)
 *
 * Ways are kept whole when any node coordinate falls inside PREP_BOUNDS, with
 * the same tag subset the graph edge carries. Nodes more than
 * NODE_KEEP_BUFFER_M outside the prep bounds are not stored: the browser path
 * can only emit an edge between coords it actually received, and edges whose
 * end lacks coordinates are dropped with a count, exactly like the client
 * skips a missing `geom[i]`.
 */

export const HIGHWAY_FILTER =
  "^(footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps|track|bridleway)$";

const NODE_KEEP_BOUNDS = expandBounds(PREP_BOUNDS, 5_000);

export interface RetainedWay {
  id: number;
  /** Exactly the tag fields `GraphEdge` carries, from the way's own tags. */
  tags: {
    highway?: string;
    surface?: string;
    smoothness?: string;
    cycleway?: string;
    bicycle?: string;
    foot?: string;
    access?: string;
  };
  refs: number[];
}

export interface ParsedRoads {
  ways: RetainedWay[];
  /** Coordinates for nodes inside NODE_KEEP_BOUNDS, keyed by id. */
  coords: Map<number, [number, number]>;
  replicationTimestamp: number | null;
  stats: {
    nodesSeen: number;
    waysSeen: number;
    waysByHighway: number;
    waysRejectedByTags: number;
    waysRejectedByBounds: number;
    waysMissingNodes: number;
  };
}

const highwayPattern = new RegExp(HIGHWAY_FILTER);

function keepsWay(tags: Record<string, string> | undefined, refs: number[]): boolean {
  const highway = tags?.highway;
  if (typeof highway !== "string" || !highwayPattern.test(highway)) return false;
  if (tags?.area === "yes") return false;
  if (refs.length < 2) return false;
  return true;
}

function tagStrings(tags: Record<string, string> | undefined): RetainedWay["tags"] {
  const read = (key: string): string | undefined =>
    typeof tags?.[key] === "string" ? tags[key] : undefined;
  return {
    ...(read("highway") !== undefined ? { highway: read("highway") } : {}),
    ...(read("surface") !== undefined ? { surface: read("surface") } : {}),
    ...(read("smoothness") !== undefined ? { smoothness: read("smoothness") } : {}),
    ...(read("cycleway") !== undefined ? { cycleway: read("cycleway") } : {}),
    ...(read("bicycle") !== undefined ? { bicycle: read("bicycle") } : {}),
    ...(read("foot") !== undefined ? { foot: read("foot") } : {}),
    ...(read("access") !== undefined ? { access: read("access") } : {}),
  };
}

interface Item {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  refs?: number[];
}

function inBounds(bounds: typeof NODE_KEEP_BOUNDS, lat: number, lon: number): boolean {
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

/**
 * Streams one complete pass over the PBF. Node coords are collected as a
 * first pass fact because dense nodes always precede ways in Geofabrik files;
 * a way missing its node is dropped and counted rather than half-emitted.
 */
export async function parseRoads(path: string): Promise<ParsedRoads> {
  const coords = new Map<number, [number, number]>();
  const ways: RetainedWay[] = [];
  const stats: ParsedRoads["stats"] = {
    nodesSeen: 0,
    waysSeen: 0,
    waysByHighway: 0,
    waysRejectedByTags: 0,
    waysRejectedByBounds: 0,
    waysMissingNodes: 0,
  };

  const parser: ReturnType<typeof parseOSM> = parseOSM();
  const sink = new Transform({
    objectMode: true,
    transform(items: Item[], _enc, callback) {
      for (const item of items) {
        if (item.type === "node") {
          stats.nodesSeen += 1;
          if (
            item.lat !== undefined &&
            item.lon !== undefined &&
            inBounds(NODE_KEEP_BOUNDS, item.lat, item.lon)
          ) {
            coords.set(item.id, [item.lon, item.lat]);
          }
          continue;
        }
        if (item.type !== "way") continue;
        stats.waysSeen += 1;
        const refs = (item.refs ?? []).filter((id) => id > 0);
        if (!keepsWay(item.tags, refs)) {
          stats.waysRejectedByTags += 1;
          continue;
        }
        stats.waysByHighway += 1;
        const hits = refs.some((id) => {
          const coord = coords.get(id);
          return coord !== undefined && inBounds(PREP_BOUNDS, coord[1], coord[0]);
        });
        if (!hits) {
          stats.waysRejectedByBounds += 1;
          continue;
        }
        ways.push({ id: item.id > 0 ? item.id : -item.id, tags: tagStrings(item.tags), refs });
      }
      callback();
    },
  });

  const done = new Promise<void>((resolve, reject) => {
    sink.on("error", reject);
    parser.on("error", reject);
    sink.on("finish", resolve);
  });
  const source = createReadStream(path);
  source.pipe(parser).pipe(sink);

  await done;
  const missing = ways.filter((way) => way.refs.some((id) => !coords.has(id)));
  stats.waysMissingNodes = missing.length;
  const replicationTimestamp = await readHeaderTimestamp(path).catch(() => null);
  return { ways, coords, replicationTimestamp, stats };
}

// ─── PBF header (block format), for the snapshot timestamp in receipts ─────

/** Framed protobuf blob reader for the PBF file header. */
function pbVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = start; i < bytes.length && i < start + 10; i += 1) {
    const byte = bytes[i];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
  }
  return null;
}

function pbFields(bytes: Uint8Array): Array<[number, Uint8Array]> {
  const fields: Array<[number, Uint8Array]> = [];
  let at = 0;
  while (at < bytes.length) {
    const tag = pbVarint(bytes, at);
    if (!tag) break;
    const wire = tag.value & 0x07;
    if (wire === 2) {
      const len = pbVarint(bytes, tag.next);
      if (!len) break;
      fields.push([tag.value >> 3, bytes.slice(len.next, len.next + len.value)]);
      at = len.next + len.value;
    } else if (wire === 0) {
      const value = pbVarint(bytes, tag.next);
      if (!value) break;
      fields.push([tag.value >> 3, bytes.slice(tag.next, value.next)]);
      at = value.next;
    } else {
      break;
    }
  }
  return fields;
}

/**
 * Reads the `osmosis_replication_timestamp` from the PBF header block, which
 * is part of the Geofabrik file header area. Returns null when absent.
 */
async function readHeaderTimestamp(path: string): Promise<number | null> {
  const handle = await (await import("node:fs/promises")).open(path, "r");
  try {
    const buffer = Buffer.alloc(1_048_576);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const head = new Uint8Array(buffer.buffer, buffer.byteOffset, read.bytesRead);
    if (head.length < 8) return null;
    const headerSize = head[0] * 2 ** 24 + head[1] * 2 ** 16 + head[2] * 2 ** 8 + head[3];
    if (headerSize <= 0 || headerSize > 64 * 1024) return null;
    // BlobHeader messages carry only sizes, not the blob itself: field 3 is the
    // datasize of the Blob that follows the BlobHeader bytes.
    const headerFields = pbFields(head.slice(4, 4 + headerSize));
    const dataSizeField = headerFields.find(([field]) => field === 3);
    if (!dataSizeField || dataSizeField[1].length === 0) return null;
    const dataSize = pbVarint(dataSizeField[1], 0)?.value ?? 0;
    if (dataSize <= 0 || dataSize > 64 * 1024) return null;
    const blob = head.slice(4 + headerSize, 4 + headerSize + dataSize);
    if (blob.length < dataSize) return null;
    const blobFields = pbFields(blob);
    let raw: Uint8Array | null = null;
    for (const [field, value] of blobFields) {
      if (field === 1) raw = value;
      if (field === 3) raw = inflateSync(value);
    }
    if (!raw) return null;
    // HeaderBlock: field 1 = bbox, 4 = required_features, 32 = timestamp
    const timestamp = pbFields(raw).find(([field]) => field === 32);
    if (!timestamp) return null;
    const value = pbVarint(timestamp[1], 0)?.value ?? null;
    return value ?? null;
  } finally {
    void handle.close();
  }
}

export { readFile as readFileBytes };

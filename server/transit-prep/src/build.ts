/**
 * Step 5: assemble the 8 R2 shard objects + manifest.json under
 * normalized/<gen>/, enforcing the size budget and count baselines.
 * Shards are sharded per borough so the client lazy-loads only the
 * boroughs intersecting its bbox; bus edges reference the shared global
 * stop registry, which ships inside every bus shard that needs it.
 */

import { normalizeBus, type BusNormalized } from "./normalizeBus";
import { normalizeSubway, type SubwayNormalized } from "./normalizeSubway";
import { FEED_SOURCES } from "./sources";
import { buildSpatialStubs, SPATIAL_TRANSFER_CAP_PER_STATION, SPATIAL_TRANSFER_RADIUS_M, SPATIAL_WALK_MPS } from "./transfers";
import type { FeedVersion, StopNode, TransferEdge } from "./model";
import { readReceipts } from "./receipts";
import { requireRoot, sha256, writeJson } from "./util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SHARD_BUDGET_BYTES = 3_000_000;
export const TOTAL_BUDGET_BYTES = 15_000_000;

export interface ShardRecord {
  key: string;
  bytes: number;
  sha256: string;
  stops: number;
  edges: number;
  routes: number;
}

export interface GenerationManifest {
  generation: string;
  createdAt: string;
  /** Honesty label for the transit card (Step 6 reads this). */
  schedulesAsOf: Record<string, { version: string; startDate: string; endDate: string }>;
  feeds: FeedVersion[];
  shards: ShardRecord[];
  budgets: { shardBytes: number; totalBytes: number };
  constants: {
    spatialTransferRadiusM: number;
    spatialTransferCapPerStation: number;
    spatialWalkMps: number;
    subwayMaxKmh: number;
    busMaxKmh: number;
  };
  notes: string[];
}

export interface NormalizeOptions {
  only?: "subway" | "bus";
  updateBaseline?: boolean;
}

export interface BaselineCounts {
  subwayParents: number;
  busUniqueStops: number;
}

export const CURRENT_BASELINE: BaselineCounts = {
  subwayParents: 496,
  busUniqueStops: 13461,
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Content-addressed generation id: `nyc-<date>-<hash12>`. The date orders the
 * directories for a human; the hash is what discriminates.
 *
 * It replaces a 24-character slice of the seven feed_version strings joined
 * together, which discriminated almost nothing. The subway version alone
 * ("20260826-X-long-term-supplement-trip-ids") is 40 characters once
 * punctuation is stripped, so the slice dropped all six bus picks and cut the
 * subway string mid-word: a quarterly bus pick rebuilt the same day reused the
 * id, and reusing an id overwrites shards already served
 * `Cache-Control: immutable`. Hashing the shard bytes as well as the feed
 * identities means a pipeline change earns a new id too, which a hash over the
 * upstream inputs alone would not.
 */
export function generationId(
  feeds: FeedVersion[],
  shards: { key: string; sha256: string }[],
  at: Date,
): string {
  // Sorted so neither receipt order nor shard order can move the hash.
  const identity = [
    ...feeds.map((feed) => `feed\t${feed.id}\t${feed.version}\t${feed.sha256}`),
    ...shards.map((shard) => `shard\t${shard.key}\t${shard.sha256}`),
  ].sort();
  const digest = sha256(new TextEncoder().encode(identity.join("\n")));
  return `nyc-${at.toISOString().slice(0, 10)}-${digest.slice(0, 12)}`;
}

export async function normalizeAll(options?: NormalizeOptions): Promise<{
  subway: SubwayNormalized | null;
  bus: BusNormalized | null;
  stubs: TransferEdge[];
}> {
  const root = requireRoot();
  const { receipts } = await readReceipts();
  const versionOf = (id: string): FeedVersion => {
    const receipt = receipts.find((item) => item.id === id);
    if (!receipt) throw new Error(`no receipt for ${id} (run receipts first)`);
    return {
      id,
      version: receipt.feedVersion,
      startDate: receipt.feedStartDate,
      endDate: receipt.feedEndDate,
      sha256: receipt.sha256,
    };
  };
  const subwaySource = FEED_SOURCES.find((item) => item.id === "subway");
  if (!subwaySource) throw new Error("subway source missing");
  const busSources = FEED_SOURCES.filter((item) => item.kind === "bus");

  const subway =
    !options?.only || options.only === "subway"
      ? await normalizeSubway(root, subwaySource.workDir, versionOf("subway"))
      : null;
  const bus =
    !options?.only || options.only === "bus"
      ? await normalizeBus(
          root,
          busSources.map((source) => ({ feedId: source.id, dir: source.workDir })),
          busSources.map((source) => versionOf(source.id)),
        )
      : null;

  // Baselines pin the validated real-world counts; a new pick that genuinely
  // changes them must pass --update-baseline consciously.
  if (subway && subway.stops.length !== CURRENT_BASELINE.subwayParents && !options?.updateBaseline) {
    throw new Error(`subway parent count ${subway.stops.length} != baseline ${CURRENT_BASELINE.subwayParents} (new pick? re-run with --update-baseline)`);
  }
  if (bus && bus.stops.length !== CURRENT_BASELINE.busUniqueStops && !options?.updateBaseline) {
    throw new Error(`bus stop count ${bus.stops.length} != baseline ${CURRENT_BASELINE.busUniqueStops} (new pick? re-run with --update-baseline)`);
  }

  const stubs =
    subway && bus ? buildSpatialStubs(subway.stops, bus.stops) : [];
  return { subway, bus, stubs };
}

export async function buildGeneration(options?: NormalizeOptions): Promise<{
  generation: string;
  manifest: GenerationManifest;
  directory: string;
}> {
  const root = requireRoot();
  const { subway, bus, stubs } = await normalizeAll(options);
  const { receipts } = await readReceipts();

  const objects: { key: string; value: unknown }[] = [];
  if (subway) {
    // All spatial stubs touch a subway node by construction; they ship with
    // the subway shard, along with the bus stops they reference, so the
    // shard stays self-contained (and strictly verifiable) on its own.
    const subwayStops = new Map(subway.stops.map((stop) => [stop.id, stop]));
    if (bus) {
      const referenced = new Set<string>();
      for (const stub of stubs) {
        referenced.add(stub.from);
        referenced.add(stub.to);
      }
      for (const stop of bus.stops) {
        if (!subwayStops.has(stop.id) && referenced.has(stop.id)) {
          subwayStops.set(stop.id, stop);
        }
      }
    }
    const allSubwayStops = [...subwayStops.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    objects.push({ key: "subway.json", value: { ...subway, stops: allSubwayStops, transfers: [...subway.transfers, ...stubs] } });
  }
  if (bus) {
    const busSources = FEED_SOURCES.filter((item) => item.kind === "bus");
    const stopById = new Map(bus.stops.map((stop) => [stop.id, stop]));
    const feedsOf = (id: string): string[] => stopById.get(id)?.feeds ?? [];
    for (const source of busSources) {
      const shardStops = new Map<string, StopNode>();
      for (const edge of bus.edges) {
        // Keep an edge in a borough shard when either endpoint stop was
        // listed by that borough feed (boundary stops appear in both).
        const fromFeeds = feedsOf(edge.from);
        const toFeeds = feedsOf(edge.to);
        if (fromFeeds.includes(source.id) || toFeeds.includes(source.id)) {
          const from = stopById.get(edge.from);
          const to = stopById.get(edge.to);
          if (from) shardStops.set(from.id, from);
          if (to) shardStops.set(to.id, to);
        }
      }
      const shardEdges = bus.edges.filter((edge) => {
        const fromFeeds = feedsOf(edge.from);
        const toFeeds = feedsOf(edge.to);
        return fromFeeds.includes(source.id) || toFeeds.includes(source.id);
      });
      objects.push({
        key: source.shard,
        value: {
          kind: "bus-shard" as const,
          feed: source.id,
          feeds: bus.feeds,
          stops: [...shardStops.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
          edges: shardEdges,
          routes: bus.routes,
          shapes: bus.shapes,
          headways: bus.headways.filter((row) =>
            shardEdges.some((edge) => edge.route === row.route),
          ),
          stats: bus.stats,
        },
      });
    }
  }

  // Encode and budget-check every shard before anything is written: the
  // generation id hashes the shard bytes, so the directory it names is not
  // known until they all exist.
  const shards: ShardRecord[] = [];
  const encoded: { key: string; bytes: Uint8Array }[] = [];
  let totalBytes = 0;
  for (const { key, value } of objects) {
    const bytes = encode(value);
    if (bytes.length > SHARD_BUDGET_BYTES) {
      throw new Error(`${key}: ${bytes.length} bytes exceeds ${SHARD_BUDGET_BYTES} budget`);
    }
    totalBytes += bytes.length;
    encoded.push({ key, bytes });
    const recordValue = value as { stops: unknown[]; edges: unknown[]; routes: unknown[] };
    shards.push({
      key,
      bytes: bytes.length,
      sha256: sha256(bytes),
      stops: recordValue.stops.length,
      edges: recordValue.edges.length,
      routes: recordValue.routes.length,
    });
  }
  if (totalBytes > TOTAL_BUDGET_BYTES) {
    throw new Error(`total ${totalBytes} bytes exceeds ${TOTAL_BUDGET_BYTES} budget`);
  }

  const feeds: FeedVersion[] = receipts.map((receipt) => ({
    id: receipt.id,
    version: receipt.feedVersion,
    startDate: receipt.feedStartDate,
    endDate: receipt.feedEndDate,
    sha256: receipt.sha256,
  }));
  const generation = generationId(feeds, shards, new Date());
  const directory = join(root, "normalized", generation);
  await mkdir(directory, { recursive: true });
  for (const { key, bytes } of encoded) await writeFile(join(directory, key), bytes);

  const schedulesAsOf: GenerationManifest["schedulesAsOf"] = {};
  for (const receipt of receipts) {
    schedulesAsOf[receipt.id] = {
      version: receipt.feedVersion,
      startDate: receipt.feedStartDate,
      endDate: receipt.feedEndDate,
    };
  }
  const manifest: GenerationManifest = {
    generation,
    createdAt: new Date().toISOString(),
    schedulesAsOf,
    feeds,
    shards,
    budgets: { shardBytes: SHARD_BUDGET_BYTES, totalBytes: TOTAL_BUDGET_BYTES },
    constants: {
      spatialTransferRadiusM: SPATIAL_TRANSFER_RADIUS_M,
      spatialTransferCapPerStation: SPATIAL_TRANSFER_CAP_PER_STATION,
      spatialWalkMps: SPATIAL_WALK_MPS,
      subwayMaxKmh: 80,
      busMaxKmh: 60,
    },
    notes: [
      "Headways are typical-week tables from calendar day columns; calendar_dates holiday exceptions are not modeled.",
      "Bus travel times are scheduled, not traffic-aware; no realtime data is used.",
      "Bus stop wait exposure assumes unsheltered stops (GTFS carries no shelter geometry).",
    ],
  };
  await writeJson(join(directory, "manifest.json"), manifest);
  return { generation, manifest, directory };
}

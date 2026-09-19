import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_BUILDING_SHARD_BYTES,
  MAX_STREET_SHARD_BYTES,
  MAX_TOTAL_BYTES,
  type NavigationBuildingShardRef,
  type NavigationManifest,
  type NavigationNotices,
  type NavigationPointer,
  type NavigationSourceReceipt,
  type NavigationStreetShardRef,
} from "../../../app/lib/navigationData/shardContract";
import { PREP_BOUNDS, type GridZoom } from "./boundary";
import { buildingsFromNdjson } from "./buildings";
import { canonicalJson, jsonBytes, sha256Hex } from "./canonical";
import { readReceipts } from "./acquire";
import { shardBuildings, shardStreets } from "./sharding";
import { rootPath } from "./util";

/**
 * Builds one immutable generation directory from the normalized
 * intermediates. Byte layout, ordering, and the generation id are functions
 * of the inputs only, so identical inputs rebuild to identical bytes:
 *
 * - shard members are sorted (streets: nodes/edges by id; buildings: by
 *   DOITT_ID; refs: by key);
 * - every document serializes via canonical JSON with a trailing newline;
 * - the generation id hashes the source receipts, the grid, the recipe
 *   identity, and every shard's content digest (computed on the
 *   generation-label-free phase-A object, because the label contains the id);
 * - createdAt derives from the OSM snapshot, not the build clock.
 */

export const RECIPE_ID = "nyc-navigation-producer/recipe-v1";

export interface BuildOptions {
  grid: GridZoom;
  dryRun?: boolean;
  /** Measurement mode: report budget violations instead of throwing. */
  reportOnly?: boolean;
}

export interface BuildResult {
  generation: string;
  dryRun: boolean;
  streetShards: number;
  buildingShards: number;
  budgets: {
    streetShardBytes: number;
    buildingShardBytes: number;
    totalBytes: number;
  };
  budgetsEnforced: {
    maxStreetShardBytes: number;
    maxBuildingShardBytes: number;
    maxTotalBytes: number;
  };
  budgetViolations: string[];
  largestStreetShard: { key: string; bytes: number };
  largestBuildingShard: { key: string; bytes: number };
  sharding: { streets: object; buildings: object };
  written: string[];
}

function receiptById(receipts: NavigationSourceReceipt[], id: string): NavigationSourceReceipt {
  const receipt = receipts.find((item) => item.id === id);
  if (!receipt) throw new Error(`receipt ${id} is missing; run acquire`);
  return receipt;
}

function datePart(receipt: NavigationSourceReceipt, snapshotTimestamp: number | null): string {
  if (snapshotTimestamp) {
    return new Date(snapshotTimestamp * 1000).toISOString().slice(0, 10);
  }
  const asDate = new Date(receipt.timestamp);
  if (!Number.isNaN(asDate.getTime())) return asDate.toISOString().slice(0, 10);
  const fallback = /(\d{4}-\d{2}-\d{2})/.exec(receipt.release);
  if (fallback) return fallback[1];
  throw new Error(`no date in OSM receipt (${receipt.timestamp})`);
}

interface WorkStreets {
  streets: {
    nodes: Array<{ id: number; lat: number; lon: number; isIntersection: boolean }>;
    edges: Array<{
      id: string;
      from: number;
      to: number;
      distanceM: number;
      tags: Record<string, string | undefined>;
    }>;
  };
  recipe: string;
  osmSnapshotTimestamp: number | null;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const { receipts } = await readReceipts();
  const osmReceipt = receiptById(receipts, "osm-new-york");
  const buildingsReceipt = receiptById(receipts, "nyc-building-footprints");

  const streetsDoc = JSON.parse(
    await readFile(rootPath("work", "streets.json"), "utf8"),
  ) as WorkStreets;
  const buildings = buildingsFromNdjson(
    await readFile(rootPath("work", "buildings.ndjson"), "utf8"),
  );

  const graph = {
    nodes: new Map(
      streetsDoc.streets.nodes.map((node) => [
        node.id,
        { id: node.id, lat: node.lat, lon: node.lon, isIntersection: node.isIntersection },
      ]),
    ),
    edges: streetsDoc.streets.edges,
    stats: {
      closedPedestrianWaysSkipped: 0,
      segmentsMissingCoords: 0,
      zeroLengthSegments: 0,
      danglingEdges: 0,
    },
  };

  const streets = shardStreets(graph, options.grid);
  const buildingsShards = shardBuildings(buildings, options.grid);

  // Phase A: content digests without the generation label.
  const labelFree = new Map<string, string>();
  const setGenerations = <T extends { generation: string }>(
    shards: Map<string, T>,
    generation: string,
  ) => {
    for (const shard of shards.values()) shard.generation = generation;
  };
  setGenerations(streets.shards, "");
  setGenerations(buildingsShards.shards, "");
  for (const [key, shard] of [...streets.shards, ...buildingsShards.shards]) {
    // JSON.stringify drops undefined properties, so this is the same shape the
    // verifier recovers by deleting `generation` from the final bytes.
    labelFree.set(key, sha256Hex(jsonBytes({ ...shard, generation: undefined })));
  }
  const sortedKeys = [...labelFree.keys()].sort();
  const generationHash = sha256Hex(
    canonicalJson({
      recipe: RECIPE_ID,
      grid: { z: options.grid },
      receipts: receipts.map(({ id, release, url, bytes, timestamp, sha256 }) => ({
        id,
        release,
        url,
        bytes,
        timestamp,
        sha256,
      })),
      labelFreeShards: Object.fromEntries(sortedKeys.map((key) => [key, labelFree.get(key)])),
    }),
  );
  const generationId = `nyc-${datePart(osmReceipt, streetsDoc.osmSnapshotTimestamp)}-${generationHash.slice(0, 12)}`;

  setGenerations(streets.shards, generationId);
  setGenerations(buildingsShards.shards, generationId);

  const bytesMap = new Map<string, Uint8Array>();
  const streetRefs: NavigationStreetShardRef[] = [];
  for (const key of [...streets.shards.keys()].sort()) {
    const shard = streets.shards.get(key)!;
    const bytes = jsonBytes(shard);
    bytesMap.set(key, bytes);
    streetRefs.push({
      key,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      geometryBounds: shard.geometryBounds,
      supportBounds: shard.supportBounds,
      nodes: shard.nodes.length,
      edges: shard.edges.length,
    });
  }
  const buildingRefs: NavigationBuildingShardRef[] = [];
  for (const key of [...buildingsShards.shards.keys()].sort()) {
    const shard = buildingsShards.shards.get(key)!;
    const bytes = jsonBytes(shard);
    bytesMap.set(key, bytes);
    buildingRefs.push({
      key,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      geometryBounds: shard.geometryBounds,
      supportBounds: shard.supportBounds,
      buildings: shard.buildings.length,
      rings: shard.buildings.reduce((sum, building) => sum + building.rings.length, 0),
      missingHeights: shard.buildings.filter((building) => building.heightM === null).length,
      maxHeightM: shard.buildings.reduce(
        (max, building) => Math.max(max, building.heightM ?? 0),
        0,
      ),
    });
  }

  const notices: NavigationNotices = {
    version: 1,
    dataset: "nyc-navigation",
    generation: generationId,
    attribution: [
      "© OpenStreetMap contributors",
      "NYC Office of Technology and Innovation (OTI) — Building Footprints",
    ],
    licenses: [
      "OpenStreetMap data: Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright",
      "NYC Building Footprints: NYC Open Data terms of use — https://opendata.cityofnewyork.us/overview/#termsofuse",
    ],
    sourceNotes: [
      `Streets derive from ${osmReceipt.url} (${osmReceipt.release}, ${osmReceipt.bytes} bytes, last-modified ${osmReceipt.timestamp}).`,
      `Buildings derive from ${buildingsReceipt.url} pinned as "${buildingsReceipt.release}", ${buildingsReceipt.bytes} bytes.`,
      "Vehicles/pedestrian policy is the current routing behavior: one set of walkable highway values, area=yes excluded, bidirectional edges, per-way tags as published.",
      "Buildings: placeholders, Demolition/Marked For Demolition records, missing DOITT_ID, degenerate or self-intersecting rings are rejected; included casters are Building, Building Under Construction, Garage, Parking, Gas Station Canopy, Storage Tank, Auxiliary, Temporary, Cantilevered Building, Skybridge.",
      "HEIGHT_ROOF is feet above ground and is converted to metres once in the producer; zero/null/implausible heights take the versioned typed fallback (median known height of the feature code, else the citywide median) as heightSource=fallback, and stay heightM:null only when no fallback could be derived.",
      "This is a derived OSM database; the current snapshot identity and this entire generation are offered exactly as published.",
    ],
  };

  const manifest = assembleManifest(
    generationId,
    osmReceipt,
    buildingsReceipt,
    notices,
    jsonBytes(notices).length,
    streetRefs,
    buildingRefs,
  );
  const pointer: NavigationPointer = {
    version: 1,
    dataset: "nyc-navigation",
    generation: generationId,
    manifestPath: `navigation/nyc/${generationId}/manifest.json`,
    manifestSha256: sha256Hex(jsonBytes(manifest)),
  };

  const budgetViolations = enforceBudgets(
    streetRefs,
    buildingRefs,
    manifest.budgets.totalBytes,
    Boolean(options.reportOnly),
  );
  if (budgetViolations.length > 0 && !options.reportOnly) {
    throw new Error(`budget enforcement failed:\n${budgetViolations.join("\n")}`);
  }

  const directory = rootPath("normalized", generationId);
  const written: string[] = [];
  if (!options.dryRun) {
    const nested = join(directory, "navigation", "nyc", generationId);
    await mkdir(join(nested, "streets"), { recursive: true });
    await mkdir(join(nested, "buildings"), { recursive: true });
    await writeFile(join(nested, "manifest.json"), Buffer.from(jsonBytes(manifest)));
    await writeFile(join(nested, "notices.json"), Buffer.from(jsonBytes(notices)));
    for (const key of [...bytesMap.keys()].sort()) {
      await writeFile(join(nested, key), Buffer.from(bytesMap.get(key)!));
    }
    const pointerPath = join(directory, "pointer-candidate.json");
    await writeFile(pointerPath, `${canonicalJson(pointer)}\n`);
    for (const key of [...bytesMap.keys()].sort()) {
      written.push(join(nested, key));
    }
    written.push(join(nested, "manifest.json"), join(nested, "notices.json"));
    written.push(pointerPath);
  }

  const largestStreet = streetRefs.reduce((max, ref) => (ref.bytes > max.bytes ? ref : max));
  const largestBuilding = buildingRefs.reduce((max, ref) => (ref.bytes > max.bytes ? ref : max));

  return {
    generation: generationId,
    dryRun: Boolean(options.dryRun),
    streetShards: streetRefs.length,
    buildingShards: buildingRefs.length,
    budgets: manifest.budgets,
    budgetsEnforced: {
      maxStreetShardBytes: MAX_STREET_SHARD_BYTES,
      maxBuildingShardBytes: MAX_BUILDING_SHARD_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
    budgetViolations,
    largestStreetShard: { key: largestStreet.key, bytes: largestStreet.bytes },
    largestBuildingShard: { key: largestBuilding.key, bytes: largestBuilding.bytes },
    sharding: {
      streets: {
        seaming: {
          cellsPublished: streets.stats.cellsPublished,
          ghostNodeRecords: streets.stats.ghostNodeRecords,
          seamEdges: streets.stats.seamEdges,
          edgesDroppedOutsideSupport: streets.stats.edgesDroppedOutsideSupport,
        },
      },
      buildings: {
        ...buildingsShards.stats,
      },
    },
    written,
  };
}

function assembleManifest(
  generation: string,
  osmReceipt: NavigationSourceReceipt,
  buildingsReceipt: NavigationSourceReceipt,
  notices: NavigationNotices,
  noticesBytes: number,
  streetRefs: NavigationStreetShardRef[],
  buildingRefs: NavigationBuildingShardRef[],
): NavigationManifest {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation,
    createdAt: `${generation.slice(4, 14)}T00:00:00.000Z`,
    supportBounds: PREP_BOUNDS,
    recipe: RECIPE_ID,
    sources: [osmReceipt, buildingsReceipt].map((receipt) => ({
      id: receipt.id,
      release: receipt.release,
      url: receipt.url,
      bytes: receipt.bytes,
      timestamp: receipt.timestamp,
      sha256: receipt.sha256,
    })),
    noticesPath: `navigation/nyc/${generation}/notices.json`,
    noticesSha256: sha256Hex(jsonBytes(notices)),
    streetShards: streetRefs,
    buildingShards: buildingRefs,
    budgets: {
      streetShardBytes: streetRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      buildingShardBytes: buildingRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      totalBytes:
        streetRefs.reduce((sum, ref) => sum + ref.bytes, 0) +
        buildingRefs.reduce((sum, ref) => sum + ref.bytes, 0) +
        noticesBytes,
    },
  };
}

function enforceBudgets(
  streetRefs: NavigationStreetShardRef[],
  buildingRefs: NavigationBuildingShardRef[],
  totalBytes: number,
  reportOnly: boolean,
): string[] {
  const violations: string[] = [];
  const overStreet = streetRefs.filter((ref) => ref.bytes > MAX_STREET_SHARD_BYTES);
  const overBuilding = buildingRefs.filter((ref) => ref.bytes > MAX_BUILDING_SHARD_BYTES);
  if (overStreet.length > 0) {
    violations.push(
      `street shard budget: ${overStreet.map((ref) => `${ref.key}=${ref.bytes}`).join(", ")}`,
    );
  }
  if (overBuilding.length > 0) {
    violations.push(
      `building shard budget: ${overBuilding.map((ref) => `${ref.key}=${ref.bytes}`).join(", ")}`,
    );
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    violations.push(
      `total budget: ${totalBytes} > ${MAX_TOTAL_BYTES} (measured adjustment needed — see decision record)`,
    );
  }
  return reportOnly ? violations : violations;
}

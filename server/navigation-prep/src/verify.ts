import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_BUILDING_SHARD_BYTES,
  MAX_STREET_SHARD_BYTES,
  MAX_TOTAL_BYTES,
  parseNavigationBuildingShard,
  parseNavigationManifest,
  parseNavigationNotices,
  parseNavigationPointer,
  parseNavigationStreetShard,
  type GeoBounds,
  type NavigationBuildingShard,
  type NavigationBuildingShardRef,
  type NavigationManifest,
  type NavigationPointer,
  type NavigationStreetShard,
  type NavigationStreetShardRef,
} from "../../../app/lib/navigationData/shardContract";
import {
  BOROUGH_SAMPLES,
  CASTER_REACH_M,
  LOW_SUN_ALTITUDE_RAD,
  type BoroughSample,
} from "./boundary";
import { canonicalJson, jsonBytes, sha256Hex } from "./canonical";
import { readReceipts } from "./acquire";
import { RECIPE_ID } from "./build";
import { percentileSummary } from "./stats";

/**
 * The independent verifier. It re-reads the final serialized bytes of a built
 * generation and re-derives every published fact from those bytes plus the
 * on-disk receipts — nothing from builder memory. `verify` is the gate that
 * names a generation buildable; `publish` (a later step) may only follow it.
 *
 * It also enforces the hard budgets: per-shard (contract constants), total
 * (contract constant), and per-request (maximum over the documented borough
 * and cross-borough sample requests, each selected with the client's exact
 * semantics: streets by geometry intersection, buildings by geometry
 * intersection with the bbox padded by CASTER_REACH_M).
 */

/**
 * A request's selected shards may not exceed this many bytes. Measured on the
 * first citywide generation: borough-block samples select 4.3–7.1 MB, and the
 * retained Downtown-Brooklyn→Midtown corridor (the widest documented sample)
 * selects 86.8 MB, so 100 MB is the measured envelope with ~15% headroom.
 */
export const MAX_REQUEST_BYTES = 100_000_000;

async function latestGeneration(normalized: string): Promise<string | null> {
  let best: { name: string; createdAt: string } | null = null;
  for (const name of await readdir(normalized)) {
    if (name.startsWith(".")) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(normalized, name, "navigation", "nyc", name, "manifest.json"), "utf8"),
      ) as { createdAt?: string };
      const createdAt = typeof manifest.createdAt === "string" ? manifest.createdAt : "";
      if (
        !best ||
        createdAt > best.createdAt ||
        (createdAt === best.createdAt && name > best.name)
      ) {
        best = { name, createdAt };
      }
    } catch {
      // Not a generation directory (no manifest through the canonical path).
    }
  }
  return best?.name ?? null;
}

function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function boundsContain(outer: GeoBounds, inner: GeoBounds): boolean {
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  );
}

function padBounds(bounds: GeoBounds, meters: number): GeoBounds {
  const midLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.max(Math.cos(midLat), 0.2));
  return {
    south: bounds.south - dLat,
    west: bounds.west - dLon,
    north: bounds.north + dLat,
    east: bounds.east + dLon,
  };
}

/** The bytes-sans-generation digest the builder hashes into the generation id. */
function labelFreeDigest(bytes: Uint8Array): string {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  delete parsed.generation;
  return sha256Hex(jsonBytes(parsed));
}

export interface VerifyResult {
  generation: string;
  objects: number;
  streetShards: number;
  buildingShards: number;
  budgets: {
    enforced: { maxStreetShard: number; maxBuildingShard: number; maxTotal: number };
    actual: { streetBytes: number; buildingBytes: number; totalBytes: number };
  };
  requests: Array<{
    borough: string;
    streets: number;
    buildings: number;
    bytes: number;
    nodesInBbox: number;
    buildingsTouchingBbox: number;
    ok: boolean;
  }>;
  graph: {
    nodes: number;
    directedEdges: number;
    undirectedEdges: number;
    connectedComponents: number;
    largestComponent: number;
    ghostNodeRecords: number;
    /** Ghosts whose endpoint cell has no own-side copy (dead-end seam tips). */
    ghostNodesLocalOnly: number;
    seamEdges: number;
  };
  streets: {
    highwayHistogram: Record<string, number>;
    tagFieldCoverage: Record<string, number>;
  };
  buildings: {
    byFeatureCode: Record<string, number>;
    byStatus: Record<string, number>;
    heightSource: Record<string, number>;
    rings: number;
    maxHeightM: number;
    maxCasterReachM: number;
    sizePercentiles: Record<string, number>;
    streetSizePercentiles: Record<string, number>;
  };
  shardSummaries: {
    key: string;
    bytes: number;
    nodes?: number;
    edges?: number;
    buildings?: number;
  }[];
}

async function readArtifacts(
  directory: string,
  generation: string,
): Promise<{
  pointer: NavigationPointer;
  manifest: NavigationManifest;
  notices: unknown;
  streetRefs: Map<string, NavigationStreetShardRef>;
  buildingRefs: Map<string, NavigationBuildingShardRef>;
  streetShards: Map<string, NavigationStreetShard>;
  buildingShards: Map<string, NavigationBuildingShard>;
  bytes: Map<string, Uint8Array>;
}> {
  const nested = join(directory, "navigation", "nyc", generation);
  const pointer = parseNavigationPointer(
    JSON.parse(await readFile(join(directory, "pointer-candidate.json"), "utf8")),
  );
  const manifestBytes = await readFile(join(nested, "manifest.json"));
  if (pointer.manifestPath !== `navigation/nyc/${generation}/manifest.json`)
    throw new Error("pointer does not name this generation's manifest");
  if (sha256Hex(manifestBytes) !== pointer.manifestSha256)
    throw new Error("manifest bytes disagree with the pointer digest");
  const manifest = parseNavigationManifest(JSON.parse(manifestBytes.toString("utf8")), generation);
  const noticesBytes = await readFile(join(nested, "notices.json"));
  if (sha256Hex(noticesBytes) !== manifest.noticesSha256)
    throw new Error("notices bytes disagree with the manifest digest");
  parseNavigationNotices(JSON.parse(noticesBytes.toString("utf8")), generation);

  const streetRefs = new Map<string, NavigationStreetShardRef>();
  const buildingRefs = new Map<string, NavigationBuildingShardRef>();
  for (const ref of manifest.streetShards) streetRefs.set(ref.key, ref);
  for (const ref of manifest.buildingShards) buildingRefs.set(ref.key, ref);

  const streetShards = new Map<string, NavigationStreetShard>();
  const buildingShards = new Map<string, NavigationBuildingShard>();
  const bytes = new Map<string, Uint8Array>();

  for (const [key, ref] of streetRefs) {
    const raw = await readFile(join(nested, key));
    if (raw.byteLength !== ref.bytes) throw new Error(`${key}: byte count drifted`);
    if (sha256Hex(raw) !== ref.sha256) throw new Error(`${key}: digest drifted`);
    streetShards.set(
      key,
      parseNavigationStreetShard(JSON.parse(raw.toString("utf8")), ref, generation),
    );
    bytes.set(key, raw);
  }
  for (const [key, ref] of buildingRefs) {
    const raw = await readFile(join(nested, key));
    if (raw.byteLength !== ref.bytes) throw new Error(`${key}: byte count drifted`);
    if (sha256Hex(raw) !== ref.sha256) throw new Error(`${key}: digest drifted`);
    buildingShards.set(
      key,
      parseNavigationBuildingShard(JSON.parse(raw.toString("utf8")), ref, generation),
    );
    bytes.set(key, raw);
  }
  return {
    pointer,
    manifest,
    notices: JSON.parse(noticesBytes.toString("utf8")),
    streetRefs,
    buildingRefs,
    streetShards,
    buildingShards,
    bytes,
  };
}

export async function verifyGeneration(generation?: string): Promise<VerifyResult> {
  const root = process.env.NAVIGATION_PREP_ROOT;
  if (!root) throw new Error("NAVIGATION_PREP_ROOT is required");
  const normalized = join(root, "normalized");
  const name = generation ?? (await latestGeneration(normalized));
  if (!name) throw new Error("no generations to verify");
  const directory = join(normalized, name);
  const artifacts = await readArtifacts(directory, name);
  const { manifest, streetRefs, buildingRefs, streetShards, buildingShards } = artifacts;

  // ── Generation id must be the hash of receipts + grid + shard content ─────
  const { receipts } = await readReceipts();
  const labelFree = new Map<string, string>();
  for (const [key, raw] of artifacts.bytes) labelFree.set(key, labelFreeDigest(raw));
  // Grid is derivable from the published shard keys ("streets/z13-/z14-" prefixes).
  const gridZooms = new Set<number>(
    [...streetRefs.keys()].map((key) => Number(/\/z(13|14)-/.exec(key)?.[1] ?? Number.NaN)),
  );
  if (gridZooms.size !== 1) throw new Error("generation mixes grids; corrupt build");
  const gridZoom = [...gridZooms][0];
  const receiptsObject = receipts.map(({ id, release, url, bytes, timestamp, sha256 }) => ({
    id,
    release,
    url,
    bytes,
    timestamp,
    sha256,
  }));
  const labelFreeObject = Object.fromEntries(
    [...labelFree.keys()].sort().map((key) => [key, labelFree.get(key)]),
  );
  const generationHash = sha256Hex(
    canonicalJson({
      recipe: RECIPE_ID,
      grid: { z: gridZoom },
      receipts: receiptsObject,
      labelFreeShards: labelFreeObject,
    }),
  );

  if (!name.endsWith(`-${generationHash.slice(0, 12)}`)) {
    const detail = JSON.stringify({
      expected: generationHash.slice(0, 12),
      got: name.slice(-12),
      keys: [...labelFree.keys()].sort(),
      recipe: RECIPE_ID,
    });
    throw new Error(`generation id does not reproduce from final bytes: ${name}; ${detail}`);
  }

  // ── Hard budgets ──────────────────────────────────────────────────────────
  const budgets = {
    streetBytes: [...streetRefs.values()].reduce((sum, ref) => sum + ref.bytes, 0),
    buildingBytes: [...buildingRefs.values()].reduce((sum, ref) => sum + ref.bytes, 0),
  };
  const totalBytes =
    budgets.streetBytes +
    budgets.buildingBytes +
    (await stat(join(directory, "navigation", "nyc", name, "notices.json"))).size;
  if (budgets.streetBytes !== manifest.budgets.streetShardBytes)
    throw new Error("street budget does not match the manifest");
  if (budgets.buildingBytes !== manifest.budgets.buildingShardBytes)
    throw new Error("building budget does not match the manifest");
  if (totalBytes !== manifest.budgets.totalBytes)
    throw new Error("total budget does not match the manifest");
  if (manifest.budgets.totalBytes > MAX_TOTAL_BYTES)
    throw new Error(`total budget exceeded: ${manifest.budgets.totalBytes}`);

  // ── Per-request budgets over retained samples in every borough ────────────
  const requests = BOROUGH_SAMPLES.map((sample) =>
    selectAndPrice(manifest, sample, streetShards, buildingShards),
  );

  // ── Merged street graph facts ─────────────────────────────────────────────
  const graph = verifyStreetMerge(streetShards);
  const buildingFacts = verifyBuildings(buildingShards, buildingRefs, streetRefs);
  const shardSummaries = [...artifacts.bytes.keys()].sort().map((key) => {
    const raw = artifacts.bytes.get(key)!;
    const ref = streetRefs.get(key);
    const bref = buildingRefs.get(key);
    return {
      key,
      bytes: raw.byteLength,
      ...(ref ? { nodes: ref.nodes ?? 0, edges: ref.edges ?? 0 } : {}),
      ...(bref ? { buildings: bref.buildings ?? 0 } : {}),
    };
  });

  return {
    generation: name,
    objects: artifacts.bytes.size + 3,
    streetShards: streetRefs.size,
    buildingShards: buildingRefs.size,
    budgets: {
      enforced: {
        maxStreetShard: MAX_STREET_SHARD_BYTES,
        maxBuildingShard: MAX_BUILDING_SHARD_BYTES,
        maxTotal: MAX_TOTAL_BYTES,
      },
      actual: {
        streetBytes: budgets.streetBytes,
        buildingBytes: budgets.buildingBytes,
        totalBytes,
      },
    },
    requests,
    graph,
    streets: graph.streets,
    buildings: buildingFacts,
    shardSummaries,
  };
}

function selectAndPrice(
  manifest: NavigationManifest,
  sample: BoroughSample,
  streetShards: Map<string, NavigationStreetShard>,
  buildingShards: Map<string, NavigationBuildingShard>,
): RequestFacts {
  const bbox = sample.bbox;
  if (!boundsContain(manifest.supportBounds, bbox)) {
    return {
      borough: sample.borough,
      streets: 0,
      buildings: 0,
      bytes: 0,
      nodesInBbox: 0,
      buildingsTouchingBbox: 0,
      ok: false,
    };
  }
  const padded = padBounds(bbox, CASTER_REACH_M);
  let bytes = 0;
  const streetRefs = manifest.streetShards.filter((ref) =>
    boundsIntersect(ref.geometryBounds, bbox),
  );
  const buildingRefs = manifest.buildingShards.filter((ref) =>
    boundsIntersect(ref.geometryBounds, padded),
  );
  for (const ref of [...streetRefs, ...buildingRefs]) bytes += ref.bytes;

  let nodesInBbox = 0;
  for (const ref of streetRefs) {
    const shard = streetShards.get(ref.key);
    if (!shard) throw new Error(`verified street shard missing: ${ref.key}`);
    for (const node of shard.nodes) {
      if (
        node.lat >= bbox.south &&
        node.lat <= bbox.north &&
        node.lon >= bbox.west &&
        node.lon <= bbox.east
      ) {
        nodesInBbox += 1;
      }
    }
  }

  let buildingsTouchingBbox = 0;
  for (const ref of buildingRefs) {
    const shard = buildingShards.get(ref.key);
    if (!shard) throw new Error(`verified building shard missing: ${ref.key}`);
    for (const building of shard.buildings) {
      let touches = false;
      for (const ring of building.rings) {
        for (const [lng, lat] of ring) {
          if (
            lat >= padded.south &&
            lat <= padded.north &&
            lng >= padded.west &&
            lng <= padded.east
          ) {
            touches = true;
            break;
          }
        }
        if (touches) break;
      }
      if (touches) buildingsTouchingBbox += 1;
    }
  }

  return {
    borough: sample.borough,
    streets: streetRefs.length,
    buildings: buildingRefs.length,
    bytes,
    nodesInBbox,
    buildingsTouchingBbox,
    ok:
      bytes <= MAX_REQUEST_BYTES &&
      streetRefs.length > 0 &&
      buildingRefs.length > 0 &&
      nodesInBbox > 0,
  };
}

type RequestFacts = {
  borough: string;
  streets: number;
  buildings: number;
  bytes: number;
  nodesInBbox: number;
  buildingsTouchingBbox: number;
  ok: boolean;
};

interface StreetFacts {
  nodes: number;
  directedEdges: number;
  undirectedEdges: number;
  connectedComponents: number;
  largestComponent: number;
  ghostNodeRecords: number;
  /** Ghosts whose endpoint cell has no own-side copy (dead-end seam tips). */
  ghostNodesLocalOnly: number;
  seamEdges: number;
  streets: {
    highwayHistogram: Record<string, number>;
    tagFieldCoverage: Record<string, number>;
  };
}

function verifyStreetMerge(shards: Map<string, NavigationStreetShard>): StreetFacts {
  const coords = new Map<number, { lat: number; lon: number; isIntersection: boolean }>();
  let ghostNodeRecords = 0;
  let directedEdges = 0;
  const edgeSet = new Set<string>();
  let seamEdges = 0;
  let ghostsUnreconciled = 0;
  const tagFields = ["highway", "surface", "smoothness", "cycleway", "bicycle", "foot", "access"];
  const tagPresence = new Map<string, number>(tagFields.map((field) => [field, 0]));
  const highwayHistogram = new Map<string, number>();

  for (const shard of shards.values()) {
    for (const node of shard.nodes) {
      const point = { lat: node.lat, lon: node.lon, isIntersection: node.isIntersection };
      if (
        !boundsContain(shard.supportBounds, {
          south: node.lat,
          west: node.lon,
          north: node.lat,
          east: node.lon,
        })
      ) {
        ghostNodeRecords += 1;
      }
      const prior = coords.get(node.id);
      if (prior) {
        if (prior.lat !== node.lat || prior.lon !== node.lon) {
          throw new Error(`node ${node.id} coordinates conflict across shards`);
        }
        /* OR-merge, same as the client adapter */
        prior.isIntersection = prior.isIntersection || node.isIntersection;
      } else {
        coords.set(node.id, point);
      }
    }
    for (const edge of shard.edges) {
      directedEdges += 1;
      edgeSet.add(`${edge.from}>${edge.to}`);
      if (edge.tags.highway) {
        highwayHistogram.set(edge.tags.highway, (highwayHistogram.get(edge.tags.highway) ?? 0) + 1);
      }
      for (const field of tagFields) {
        if ((edge.tags as Record<string, unknown>)[field] !== undefined) {
          tagPresence.set(field, (tagPresence.get(field) ?? 0) + 1);
        }
      }
      const from = coords.get(edge.from);
      const to = coords.get(edge.to);
      if (from && to) {
        const fromInside = boundsContain(shard.supportBounds, {
          south: from.lat,
          west: from.lon,
          north: from.lat,
          east: from.lon,
        });
        const toInside = boundsContain(shard.supportBounds, {
          south: to.lat,
          west: to.lon,
          north: to.lat,
          east: to.lon,
        });
        if (!fromInside || !toInside) seamEdges += 1;
      }
    }
  }

  // Ghost reconciliation: every out-of-cell node record must also exist as a
  // regular node in the cell that owns that position — a ghost with no owner
  // side would leave the merged graph unable to seam there.
  const locations = new Map<number, Array<{ lat: number; lon: number }>>();
  for (const shard of shards.values()) {
    for (const node of shard.nodes) {
      const inBounds = boundsContain(shard.supportBounds, {
        south: node.lat,
        west: node.lon,
        north: node.lat,
        east: node.lon,
      });
      if (!inBounds) continue;
      const bucket = locations.get(node.id) ?? [];
      bucket.push({ lat: node.lat, lon: node.lon });
      locations.set(node.id, bucket);
    }
  }
  for (const shard of shards.values()) {
    for (const node of shard.nodes) {
      const inBounds = boundsContain(shard.supportBounds, {
        south: node.lat,
        west: node.lon,
        north: node.lat,
        east: node.lon,
      });
      if (inBounds) continue;
      const owners = locations.get(node.id) ?? [];
      if (!owners.some((owner) => owner.lat === node.lat && owner.lon === node.lon)) {
        ghostsUnreconciled += 1;
      }
    }
  }

  // Connected components over the union graph.
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const shard of shards.values()) {
    for (const node of shard.nodes) {
      if (!parent.has(node.id)) parent.set(node.id, node.id);
    }
    for (const edge of shard.edges) union(edge.from, edge.to);
  }
  const componentSizes = new Map<number, number>();
  for (const id of parent.keys()) {
    const root = find(id);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }
  let largest = 0;
  for (const size of componentSizes.values()) largest = Math.max(largest, size);

  return {
    nodes: coords.size,
    directedEdges,
    undirectedEdges: edgeSet.size,
    connectedComponents: componentSizes.size,
    largestComponent: largest,
    ghostNodeRecords,
    ghostNodesLocalOnly: ghostsUnreconciled,
    seamEdges,
    streets: {
      highwayHistogram: Object.fromEntries(
        [...highwayHistogram.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      tagFieldCoverage: Object.fromEntries(tagPresence.entries()),
    },
  };
}

/** Per-shard byte sizes, read-only over the digest-checked refs. */

function verifyBuildings(
  shards: Map<string, NavigationBuildingShard>,
  refs: Map<string, NavigationBuildingShardRef>,
  streetRefs: Map<string, NavigationStreetShardRef>,
): VerifyResult["buildings"] {
  let rings = 0;
  let maxHeightM = 0;
  const byFeatureCode = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const heightSource = new Map<string, number>();
  for (const shard of shards.values()) {
    for (const building of shard.buildings) {
      rings += building.rings.length;
      maxHeightM = Math.max(maxHeightM, building.heightM ?? 0);
      byFeatureCode.set(
        String(building.featureCode),
        (byFeatureCode.get(String(building.featureCode)) ?? 0) + 1,
      );
      byStatus.set(building.status, (byStatus.get(building.status) ?? 0) + 1);
      heightSource.set(building.heightSource, (heightSource.get(building.heightSource) ?? 0) + 1);
    }
  }
  return {
    byFeatureCode: Object.fromEntries(
      [...byFeatureCode.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    byStatus: Object.fromEntries(byStatus.entries()),
    heightSource: Object.fromEntries(heightSource.entries()),
    rings,
    maxHeightM,
    maxCasterReachM: maxHeightM / Math.tan(LOW_SUN_ALTITUDE_RAD),
    sizePercentiles: percentileSummary([...refs.values()].map((ref) => ref.bytes)),
    streetSizePercentiles: percentileSummary([...streetRefs.values()].map((ref) => ref.bytes)),
  };
}

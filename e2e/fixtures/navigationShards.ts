/**
 * A synthetic published NYC navigation dataset: pointer → manifest → street +
 * building shards, in the exact shape `app/lib/navigationData/shardContract.ts`
 * parses. It is what the latency-attribution bench (session A4) serves behind
 * `VITE_NAVIGATION_BASE` so the real static path — cloud fetch, digest
 * verification, decode, adapter build — is measured instead of the
 * stubbed-Overpass homologue the keyless bench would otherwise time.
 *
 * The client verifies every hop against the digest the previous one published,
 * so the digests here are **computed from the exact bytes served**. Hand-written
 * hashes would fail the byte-contract check, which is the point of it.
 *
 * The street graph is a seeded rectangular grid over the same midtown scene the
 * bench already pins (G1's fixed conditions), sliced into z14-style shards:
 * 16,800 nodes in four cells, the same city-scale node count the Node
 * scale matrix prices, kept under `MAX_STREET_SHARD_BYTES` per shard. Both
 * bench waypoint pairs sit inside the grid, so a configured route finds a
 * connected graph and never falls back to Overpass.
 */

import { createHash } from "node:crypto";

const GENERATION = "nyc-2026-09-19-abcdef123456";

const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/** mulberry32: tiny, deterministic, and good enough to shape a synthetic city. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Degrees per metre near the bench grid (lat 40.75); local, not global. */
const DEG_PER_M_LAT = 1 / 110_900;
const DEG_PER_M_LNG = 1 / 84_400;

const haversineM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Pinned by `app/lib/navigationData/__tests__/navigationShardFixture.test.ts`.
 * `streetNodes` matches the Node scale matrix's city-size row so the browser
 * "NYC-scale" selection and the Node 16.8k case describe the same magnitude.
 */
export interface NavigationShardFixtureCounts {
  streetRows: number;
  streetCols: number;
  streetNodes: number;
  streetShards: number;
  streetEdges: number;
  buildings: number;
  buildingRings: number;
}

export const NAV_STATIC_COUNTS: NavigationShardFixtureCounts = {
  streetRows: 140,
  streetCols: 120,
  streetNodes: 140 * 120,
  streetShards: 4,
  streetEdges: 140 * (120 - 1) * 2 + (140 - 1) * 120 * 2,
  buildings: 1_000,
  buildingRings: 1_000,
};

export interface NavigationShardFixtureOptions {
  /** Default 445 — the same seed the transit generator uses. */
  seed?: number;
}

/**
 * Everything the `stubNetwork` navigation route serves, in the three-hop shape
 * `app/lib/navigationData/remoteNavigation.ts` fetches — pointer → manifest →
 * shards, every hop's digest computed from the exact bytes served.
 */
export interface NavigationShardFixtureArtifacts {
  pointer: string;
  manifest: string;
  /** Shard key (`streets/cell-00.json`, `buildings/midtown.json`) → JSON bytes. */
  streetShards: Map<string, string>;
  buildingShards: Map<string, string>;
  notices: string;
}

interface GridNode {
  id: number;
  lat: number;
  lon: number;
}

const SOUTH = 40.74;
const WEST = -73.995;
/** ~45 m per row/col — the Node scale matrix's lattice, kept for comparability. */
const LAT_STEP = DEG_PER_M_LAT * 45;
const LNG_STEP = DEG_PER_M_LNG * 45;

/** 2×2 shard cells, z14-style: ~3.1 km tall × ~2.7 km wide each. */
const CELL_ROWS = 70;
const CELL_COLS = 60;

const lat = (row: number) => Number((SOUTH + row * LAT_STEP).toFixed(6));
const lon = (col: number) => Number((WEST + col * LNG_STEP).toFixed(6));
const nodeId = (row: number, col: number) => row * NAV_STATIC_COUNTS.streetCols + col + 1;
const cellRowOf = (row: number) =>
  Math.min(Math.floor(row / CELL_ROWS), NAV_STATIC_COUNTS.streetRows / CELL_ROWS - 1);
const cellColOf = (col: number) =>
  Math.min(Math.floor(col / CELL_COLS), NAV_STATIC_COUNTS.streetCols / CELL_COLS - 1);

interface GridBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Cell (CR, CC) → geometry bounds (the rect it owns). */
const cellGeometry = (cr: number, cc: number): GridBounds => ({
  south: lat(cr * CELL_ROWS),
  west: lon(cc * CELL_COLS),
  north: lat(cr * CELL_ROWS + CELL_ROWS - 1),
  east: lon(cc * CELL_COLS + CELL_COLS - 1),
});

/**
 * Support bounds pad the owned rect by one lattice step: seam connectivity
 * across cells rides on the producer publishing each crossing edge exactly
 * once, and the pad states which neighbourhood the shard draws on.
 */
const cellSupport = (cr: number, cc: number): GridBounds => {
  const geom = cellGeometry(cr, cc);
  return {
    south: Number((geom.south - LAT_STEP).toFixed(6)),
    west: Number((geom.west - LNG_STEP).toFixed(6)),
    north: Number((geom.north + LAT_STEP).toFixed(6)),
    east: Number((geom.east + LNG_STEP).toFixed(6)),
  };
};

/**
 * One directed edge per grid adjacency direction, owned by the cell of its
 * source node. Every node appears in the rect that contains it; a crossing
 * edge's target is duplicated as a ghost node in the owning shard, exactly as
 * the producer contract describes, so an edge published by one cell never
 * references a node that cell does not publish.
 */
function buildStreetShard(cr: number, cc: number) {
  const rows = [cr * CELL_ROWS, (cr + 1) * CELL_ROWS - 1];
  const cols = [cc * CELL_COLS, (cc + 1) * CELL_COLS - 1];

  const owned: GridNode[] = [];
  const name = (r: number, c: number) => ({ id: nodeId(r, c), lat: lat(r), lon: lon(c) });
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) owned.push(name(r, c));
  }

  interface DirectedEdge {
    id: string;
    from: number;
    to: number;
    distanceM: number;
    tags: { highway: string };
  }
  const edges: DirectedEdge[] = [];
  const link = (from: GridNode, to: GridNode, highway: string) => {
    edges.push({
      id: `d${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      distanceM: haversineM(from, to),
      tags: { highway },
    });
  };

  // Horizontal pairs. The forward edge belongs to the left node's cell, the
  // reverse to the right node's — a seam edge is published exactly once per
  // direction, never by both cells.
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      if (c + 1 < NAV_STATIC_COUNTS.streetCols && cellColOf(c) === cc) {
        link(name(r, c), name(r, c + 1), "residential");
      }
      if (c - 1 >= 0 && cellColOf(c) === cc) {
        link(name(r, c), name(r, c - 1), "residential");
      }
    }
  }
  // Vertical pairs, same ownership rule.
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      if (r + 1 < NAV_STATIC_COUNTS.streetRows && cellRowOf(r) === cr) {
        link(name(r, c), name(r + 1, c), "footway");
      }
      if (r - 1 >= 0 && cellRowOf(r) === cr) {
        link(name(r, c), name(r - 1, c), "footway");
      }
    }
  }

  // Ghost nodes: every edge target this shard publishes must appear in its own
  // node list too, even when it lies across a seam.
  const ids = new Set(owned.map((node) => node.id));
  for (const edge of edges) {
    if (!ids.has(edge.to)) {
      const r = Math.floor((edge.to - 1) / NAV_STATIC_COUNTS.streetCols);
      const c = (edge.to - 1) % NAV_STATIC_COUNTS.streetCols;
      owned.push(name(r, c));
      ids.add(edge.to);
    }
  }

  const geometryBounds = cellGeometry(cr, cc);
  return {
    geometryBounds,
    supportBounds: cellSupport(cr, cc),
    value: {
      version: 1,
      dataset: "nyc-navigation",
      generation: GENERATION,
      kind: "streets",
      geometryBounds,
      supportBounds: cellSupport(cr, cc),
      nodes: owned.map((node) => ({
        id: node.id,
        lat: node.lat,
        lon: node.lon,
        isIntersection: true,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        distanceM: Number(edge.distanceM.toFixed(2)),
        tags: edge.tags,
      })),
    },
  };
}

/**
 * One seeded building shard covering the whole street grid: ~1,000 footprints
 * with deterministic heights, one unknown height in eight, so the
 * static prism provider has real casters to convert and the missing-height
 * path stays exercised. Footprints are small rectangles near the lattice, the
 * shape a city block's parcels would have.
 */
function buildBuildingShard(rnd: () => number) {
  const buildings: unknown[] = [];
  for (let i = 0; i < NAV_STATIC_COUNTS.buildings; i++) {
    const row = 1 + Math.floor(rnd() * (NAV_STATIC_COUNTS.streetRows - 2));
    const col = 1 + Math.floor(rnd() * (NAV_STATIC_COUNTS.streetCols - 2));
    const halfLng = (4 + rnd() * 8) * DEG_PER_M_LNG;
    const halfLat = (6 + rnd() * 10) * DEG_PER_M_LAT;
    const cLon = lon(col) + (rnd() - 0.5) * LNG_STEP * 0.8;
    const cLat = lat(row) + (rnd() - 0.5) * LAT_STEP * 0.8;
    const heightM = Number((10 + rnd() * 300).toFixed(1));
    const unknown = i % 8 === 0;
    buildings.push({
      id: `b${1000 + i}`,
      // [lon, lat] tuples, closed — the contract's ring shape.
      rings: [
        [
          [cLon - halfLng, cLat - halfLat],
          [cLon + halfLng, cLat - halfLat],
          [cLon + halfLng, cLat + halfLat],
          [cLon - halfLng, cLat + halfLat],
          [cLon - halfLng, cLat - halfLat],
        ],
      ],
      heightM: unknown ? null : heightM,
      heightSource: unknown ? "unknown" : i % 17 === 3 ? "fallback" : "source",
      featureCode: 1_000,
      status: i % 17 === 3 && !unknown ? "under-construction" : i % 13 === 5 ? "other" : "active",
    });
  }

  const lats = buildings.flatMap((building) =>
    (building as { rings: Array<Array<[number, number]>> }).rings[0].map((point) => point[1]),
  );
  const lons = buildings.flatMap((building) =>
    (building as { rings: Array<Array<[number, number]>> }).rings[0].map((point) => point[0]),
  );

  const geometryBounds: GridBounds = {
    south: Math.min(...lats),
    west: Math.min(...lons),
    north: Math.max(...lats),
    east: Math.max(...lons),
  };
  const supportBounds: GridBounds = {
    south: Number((lat(0) - LAT_STEP).toFixed(6)),
    west: Number((lon(0) - LNG_STEP).toFixed(6)),
    north: Number((lat(NAV_STATIC_COUNTS.streetRows - 1) + LAT_STEP).toFixed(6)),
    east: Number((lon(NAV_STATIC_COUNTS.streetCols - 1) + LNG_STEP).toFixed(6)),
  };

  return {
    geometryBounds,
    supportBounds,
    value: {
      version: 1,
      dataset: "nyc-navigation",
      generation: GENERATION,
      kind: "buildings",
      geometryBounds,
      supportBounds,
      buildings,
    },
  };
}

/**
 * Builds a deterministic pointer → manifest → street/building shard fixture in
 * the published contract shape, with every digest computed from the exact
 * bytes served. The byte stream is pinned by seed: one seed, one dataset, so a
 * before/after comparison cannot drift because a fixture rewrote itself.
 */
export function buildNavigationShardFixture(
  options: NavigationShardFixtureOptions = {},
): NavigationShardFixtureArtifacts {
  const { seed = 445 } = options;
  const rnd = seededRandom(seed);

  const streetShards = new Map<string, unknown>();
  for (let cr = 0; cr < NAV_STATIC_COUNTS.streetRows / CELL_ROWS; cr++) {
    for (let cc = 0; cc < NAV_STATIC_COUNTS.streetCols / CELL_COLS; cc++) {
      streetShards.set(`streets/cell-${cr}${cc}.json`, buildStreetShard(cr, cc).value);
    }
  }
  const buildingShards = new Map<string, unknown>();
  buildingShards.set("buildings/midtown.json", buildBuildingShard(rnd).value);

  const bodies = new Map<string, string>();
  for (const [key, shard] of [...streetShards, ...buildingShards]) {
    bodies.set(key, JSON.stringify(shard));
  }

  const refFor = (key: string) => {
    const shard = bodies.get(key);
    if (!shard) throw new Error(`fixture is missing shard ${key}`);
    const parsed = JSON.parse(shard) as {
      nodes?: { id: number }[];
      edges?: { from: number; to: number }[];
      buildings?: { rings: unknown[]; heightM: number | null }[];
      geometryBounds: GridBounds;
      supportBounds: GridBounds;
    };
    if (key.startsWith("streets/")) {
      return {
        key,
        bytes: Buffer.byteLength(shard, "utf8"),
        sha256: sha256(shard),
        geometryBounds: parsed.geometryBounds,
        supportBounds: parsed.supportBounds,
        nodes: parsed.nodes!.length,
        edges: parsed.edges!.length,
      };
    }
    const buildings = parsed.buildings!;
    const rings = buildings.reduce((sum, building) => sum + building.rings.length, 0);
    const missingHeights = buildings.filter((building) => building.heightM === null).length;
    const maxHeightM = buildings.reduce((max, building) => Math.max(max, building.heightM ?? 0), 0);
    return {
      key,
      bytes: Buffer.byteLength(shard, "utf8"),
      sha256: sha256(shard),
      geometryBounds: parsed.geometryBounds,
      supportBounds: parsed.supportBounds,
      buildings: buildings.length,
      rings,
      missingHeights,
      maxHeightM,
    };
  };

  const streetRefs = [...streetShards.keys()].map(refFor);
  const buildingRefs = [...buildingShards.keys()].map(refFor);

  const notices = {
    version: 1,
    dataset: "nyc-navigation",
    generation: GENERATION,
    attribution: ["OpenStreetMap contributors (synthetic fixture)"],
    licenses: ["ODbL 1.0"],
    sourceNotes: [
      "Synthetic scale fixture for the latency-attribution experiments. Deterministic; not a published NYC generation.",
    ],
  };
  const noticesBody = JSON.stringify(notices);

  const manifest = {
    version: 1,
    dataset: "nyc-navigation",
    generation: GENERATION,
    createdAt: "2026-09-19T00:00:00.000Z",
    supportBounds: {
      south: Number((lat(0) - 2 * LAT_STEP).toFixed(6)),
      west: Number((lon(0) - 2 * LNG_STEP).toFixed(6)),
      north: Number((lat(NAV_STATIC_COUNTS.streetRows - 1) + 2 * LAT_STEP).toFixed(6)),
      east: Number((lon(NAV_STATIC_COUNTS.streetCols - 1) + 2 * LNG_STEP).toFixed(6)),
    },
    recipe: "seeded-synthetic-grid-v1 (latency-attribution A4)",
    sources: [
      {
        id: "nyc-streets-synthetic",
        release: "e2e-fixture",
        url: "https://download.geofabrik.de/north-america/us/new-york-260101.osm.pbf",
        bytes: streetRefs.reduce((sum, ref) => sum + ref.bytes, 0),
        timestamp: "2026-09-19T00:00:00.000Z",
        sha256: "0".repeat(64),
      },
    ],
    noticesPath: `navigation/nyc/${GENERATION}/notices.json`,
    noticesSha256: sha256(noticesBody),
    streetShards: streetRefs,
    buildingShards: buildingRefs,
    budgets: {
      streetShardBytes: streetRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      buildingShardBytes: buildingRefs.reduce((sum, ref) => sum + ref.bytes, 0),
      totalBytes: bodies.values().reduce((sum, body) => sum + Buffer.byteLength(body, "utf8"), 0),
    },
  };

  const manifestBody = JSON.stringify(manifest);
  const pointer = JSON.stringify({
    version: 1,
    dataset: "nyc-navigation",
    generation: GENERATION,
    manifestPath: `navigation/nyc/${GENERATION}/manifest.json`,
    manifestSha256: sha256(manifestBody),
  });

  return {
    pointer,
    manifest: manifestBody,
    streetShards: new Map([...streetShards.keys()].map((key) => [key, bodies.get(key)!])),
    buildingShards: new Map([...buildingShards.keys()].map((key) => [key, bodies.get(key)!])),
    notices: noticesBody,
  };
}

/** Which dataset the benchmark's navigation stub serves. `off` is the keyless default. */
export type NavigationFixtureKind = "off" | "scale";

/**
 * The three-hop artifacts for a fixture kind, ready for `stubNetwork` to
 * serve. `off` returns `null`: the stub aborts the navigation origin instead,
 * so scenarios that do not opt in stay on the unconfigured-build path.
 */
export function navigationFixtureArtifacts(
  kind: NavigationFixtureKind,
): NavigationShardFixtureArtifacts | null {
  return kind === "scale" ? buildNavigationShardFixture({}) : null;
}

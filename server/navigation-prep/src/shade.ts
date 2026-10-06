/**
 * The precomputed per-edge shade table (Track L, L2a).
 *
 * A route used to pay H1's time-aware `ShadowField.sweep` on every request:
 * ~3.7M point queries for one 6 km route, 23.5 s of synchronous geometry that
 * froze the map. Shade is a static function of (edge, clock slot), so it is
 * computed once here and read back as a lookup.
 *
 * Nothing about the shadow model is reimplemented. The build calls the same
 * `createGeometryShadowField(...).sweep(...)` the app calls, over the same
 * building shards, the same OSM canopy, and the same Meta/WRI height raster the
 * live field resolves — so agreement between the table and the live field is
 * true by construction, and any disagreement is the slot model, not a second
 * implementation.
 *
 * Layout, per z14 cell, is **slot-major**: all segments for slot 0, then slot
 * 1, … so a route can HTTP-range the ~8 time blocks it needs instead of the
 * whole table. Each segment carries two bytes, `[left, right]`, a 0–255 shadow
 * fraction. See `app/lib/navigationData/shadeSlots.ts` for the shared slot
 * model.
 *
 * The work is CPU-bound and one-time. One cell is one child process; the
 * orchestrator runs `concurrency` of them, tracks progress, and resumes past
 * cells already written. A failed cell never fails the run silently: the
 * progress file lists it and the command exits non-zero.
 *
 * Frozen inputs (no map, no Overpass, no network at build time):
 * - the generation's own buildings (`work/buildings.ndjson`);
 * - OSM tagged canopy, acquired once as an Overpass snapshot;
 * - the Meta/WRI CHMv2 height COGs, acquired once by `server/shadow-prep`.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createGeometryShadowField,
  QUERY_PAD_M,
  type BBox,
  type CanopyProvider,
  type CanopyRasterProvider,
  type EdgeRef,
  type PrismProvider,
  type ShadowField,
} from "../../../app/lib/shadowField/ShadowField";
import { prismsFromFootprints, type PrismSet } from "../../../app/lib/shadowField/geometry";
import { prismsFromCanopy } from "../../../app/lib/shadowField/canopy";
import {
  createCanopyHeightField,
  type CanopyHeightField,
} from "../../../app/lib/shadowField/canopyRasterField";
import type { CanopyFeature } from "../../../app/lib/overpass";
import {
  createCanopyTileStore,
  type CanopyPatch,
  type CanopyTileStore,
} from "../../../app/lib/canopyRaster/canopyTileStore";
import { createCogTileSource } from "../../../app/lib/canopyRaster/cogTileSource";
import {
  SHADE_BYTES_PER_SEGMENT,
  SHADE_DAY_SLOTS,
  SHADE_MONTHS,
  SHADE_REPRESENTATIVE_DAY,
  SHADE_REPRESENTATIVE_YEAR,
  SHADE_SLOT_COUNT,
  SHADE_ZONE,
  shadeFractionToByte,
  shadeSlotForLocalMinutes,
  shadeSlotIndex,
} from "../../../app/lib/navigationData/shadeSlots";
import type {
  GeoBounds,
  NavigationBuildingShard,
  NavigationShadeShard,
  NavigationShadeShardRef,
} from "../../../app/lib/navigationData/shardContract";
import { fromZonedParts, toMapLocal, utcOffsetMinAt } from "../../../app/lib/timezone";
import { makeGrid, type Grid, type GridZoom } from "./boundary";
import { buildingsFromNdjson } from "./buildings";
import { canonicalJson, jsonBytes, sha256Hex } from "./canonical";
import { shardBuildings, shardStreets } from "./sharding";
import { rootPath } from "./util";

// ─── Frozen inputs ────────────────────────────────────────────────────────────

/**
 * Where the frozen canopy inputs live. `server/shadow-prep` acquires them into
 * its own root, and the L2a build reads the same bytes rather than re-acquiring:
 * the CHMv2 COGs are `{quadkey}.tif` (the exact files `source.coop` republishes
 * for the browser), and the OSM vegetation snapshot is one Overpass response.
 */
export interface ShadeCanopyInputs {
  /** Directory of `{quadkey}.tif` CHMv2 height COGs. */
  chmv2Dir: string;
  /** Path to the acquired OSM vegetation Overpass JSON. */
  osmVegetationPath: string;
}

export function defaultCanopyInputs(): ShadeCanopyInputs {
  const root = process.env.SHADE_CANOPY_ROOT ?? join(process.env.HOME ?? "", "shade-prep-data");
  return {
    chmv2Dir: join(root, "raw", "chmv2-height"),
    osmVegetationPath: join(root, "raw", "osm-fallback", "osm-vegetation-nyc-support-overpass.json"),
  };
}

// ─── Slot instants ────────────────────────────────────────────────────────────

/**
 * The 768 representative instants, month-major then slot-in-day.
 *
 * Every slot is a NY-zone clock reading on the 15th of its month, so the table
 * is the same for every year and the client can snap a query by clock alone.
 * A slot whose sun is below the horizon at a cell is answered 255 by the sweep
 * itself, so nothing here decides night.
 */
export function shadeSlotInstants(): Date[] {
  const instants: Date[] = [];
  for (let month = 0; month < SHADE_MONTHS; month++) {
    for (let slot = 0; slot < SHADE_DAY_SLOTS; slot++) {
      const minutes = 5 * 60 + slot * 15;
      instants.push(
        fromZonedParts(
          SHADE_ZONE,
          SHADE_REPRESENTATIVE_YEAR,
          month,
          SHADE_REPRESENTATIVE_DAY,
          Math.floor(minutes / 60),
          minutes % 60,
        ),
      );
    }
  }
  return instants;
}

// ─── Providers over frozen data ───────────────────────────────────────────────

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= inner.south &&
    outer.north >= inner.north
  );
}

/**
 * A `PrismProvider` over one cell's already-selected building footprints.
 *
 * Mirrors `createNycStaticPrismProvider`'s conversion (whole footprints, one
 * prism per ring) but answers synchronously from memory: the build pre-slices
 * every building within caster reach of the cell's edges, so there is no
 * snapshot to bind and no network to reach.
 *
 * It answers every query. The slice already decides what can reach the cell,
 * and the field's query box spans every edge endpoint in a 2 km sun cell plus
 * its pad — a seam edge's far end lies outside the cell, so a coverage gate
 * declined whole cells and the build wrote "no geometry" as 0 shade (#294).
 */
function frozenBuildingProvider(buildings: FrozenBuilding[]): PrismProvider {
  const set: PrismSet = prismsFromFootprints(
    buildings.map((building) => ({ heightM: building.heightM, rings: building.rings })),
  );
  return {
    source: "nyc-static",
    prismsFor() {
      return set;
    },
  };
}

/**
 * A `CanopyProvider` over the frozen OSM vegetation features near the cell.
 *
 * Same shape as `createOverpassCanopyProvider`: a fixed feature list, prisms
 * memoized per leaf state (month), and the same array handed back for the same
 * month so the field's prepared-caster cache hits.
 */
function frozenCanopyProvider(features: CanopyFeature[]): CanopyProvider {
  const byMonth = new Map<number, PrismSet>();
  return {
    source: "canopy",
    prismsFor(_bbox, when) {
      const key = when.getUTCMonth();
      const hit = byMonth.get(key);
      if (hit) return hit;
      const set = prismsFromCanopy(features, when);
      byMonth.set(key, set);
      return set;
    },
  };
}

/**
 * The CHMv2 height raster, read from the acquired local COGs through the app's
 * own `CanopyTileStore` — the same stitching, overview selection, mask pairing
 * and caching the browser uses, with only the transport swapped for local
 * files. The provider wrapper mirrors `createRasterCanopyProvider` (synchronous
 * cache lookup, `load` is the only path to the store) without importing that
 * module, which pulls in the Overpass provider and its `import.meta.env`.
 */
function frozenRasterProvider(chmv2Dir: string): CanopyRasterProvider {
  const store: CanopyTileStore = createCanopyTileStore({
    source: createCogTileSource({
      baseUrl: chmv2Dir,
      openTiff: async (url) => {
        const { fromFile } = await import("geotiff");
        return fromFile(url);
      },
    }),
  });
  const cache: Array<{ coverage: BBox; field: CanopyHeightField }> = [];

  function lookup(bbox: BBox): CanopyHeightField | null {
    for (let i = 0; i < cache.length; i++) {
      if (bboxContains(cache[i].coverage, bbox)) {
        const [entry] = cache.splice(i, 1);
        cache.unshift(entry);
        return entry.field;
      }
    }
    return null;
  }

  return {
    source: "canopy-raster",
    fieldFor(bbox) {
      return lookup(bbox);
    },
    async load(bbox) {
      if (lookup(bbox)) return;
      let patch: CanopyPatch;
      try {
        patch = await store.read([bbox.west, bbox.south, bbox.east, bbox.north], {
          priority: "route",
        });
      } catch {
        // A tile the local store cannot read (absent, or outside the acquired
        // coverage) leaves the raster unresolved, exactly as a failed live read
        // does: `fieldFor` keeps returning null and the field answers from
        // buildings and OSM canopy alone. Never invent bare ground.
        return;
      }
      cache.unshift({
        coverage: {
          west: patch.bbox[0],
          south: patch.bbox[1],
          east: patch.bbox[2],
          north: patch.bbox[3],
        },
        field: createCanopyHeightField(patch),
      });
      if (cache.length > 4) cache.length = 4;
    },
  };
}

// ─── Per-cell inputs ──────────────────────────────────────────────────────────

interface FrozenBuilding {
  rings: Array<Array<[number, number]>>;
  heightM: number;
}

/** One cell's frozen slice: its segments, their edges, and everything that shades them. */
export interface ShadeCellInput {
  key: string;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
  /** Canonical undirected segments, ascending — the payload's column order. */
  segments: Array<[number, number]>;
  /** One canonical edge per segment, `lo → hi`. */
  edges: Array<{ from: [number, number]; to: [number, number] }>;
  buildings: FrozenBuilding[];
  canopy: CanopyFeature[];
}

const NYC_UNKNOWN_HEIGHT_M = 10;

function expandBounds(bounds: GeoBounds, meters: number): GeoBounds {
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

/**
 * Everything a cell's samples can query: its bounds widened to every edge
 * endpoint (a seam edge's far end lies outside the cell), plus the field's
 * query pad and a margin. The field asks about the bbox of all endpoints in a
 * sun cell padded by `QUERY_PAD_M`, so the inputs and the raster must reach at
 * least this far or the far end of a seam edge reads as no geometry (#294).
 */
export function cellQueryBounds(bounds: GeoBounds, edges: ShadeCellInput["edges"]): GeoBounds {
  const span = { ...bounds };
  for (const edge of edges) {
    for (const [lng, lat] of [edge.from, edge.to]) {
      span.west = Math.min(span.west, lng);
      span.east = Math.max(span.east, lng);
      span.south = Math.min(span.south, lat);
      span.north = Math.max(span.north, lat);
    }
  }
  return expandBounds(span, QUERY_PAD_M + 50);
}

/** Parse the acquired OSM vegetation snapshot the way `fetchCanopyAround` parses Overpass. */
export function parseOsmVegetation(document: unknown): CanopyFeature[] {
  const elements = (document as { elements?: unknown[] }).elements ?? [];
  const features: CanopyFeature[] = [];
  for (const raw of elements) {
    const el = raw as {
      id?: number;
      type?: string;
      lat?: number;
      lon?: number;
      tags?: Record<string, string>;
      geometry?: Array<{ lat?: number; lon?: number }>;
    };
    if (el.type === "node" && el.lat != null && el.lon != null) {
      features.push({
        id: Number(el.id ?? 0),
        kind: "tree",
        points: [[el.lon, el.lat]],
        tags: canopyTags(el.tags),
      });
      continue;
    }
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const points = el.geometry
      .map((point) => [point.lon, point.lat] as [number, number])
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (el.tags?.natural === "tree_row") {
      if (points.length >= 2) {
        features.push({ id: Number(el.id ?? 0), kind: "tree_row", points, tags: canopyTags(el.tags) });
      }
      continue;
    }
    if (el.tags?.natural === "wood" || el.tags?.landuse === "forest") {
      const ring = closeRing(points);
      if (ring.length >= 4) {
        features.push({ id: Number(el.id ?? 0), kind: "wood", points: ring, tags: canopyTags(el.tags) });
      }
    }
  }
  return features;
}

function canopyTags(tags: Record<string, string> | undefined): CanopyFeature["tags"] {
  const read = (key: string): string | undefined => {
    const value = tags?.[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    height: read("height"),
    diameter_crown: read("diameter_crown"),
    leaf_type: read("leaf_type"),
    leaf_cycle: read("leaf_cycle"),
  };
}

function closeRing(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return points;
  return [...points, [first[0], first[1]]];
}

function pointsIntersect(points: Array<[number, number]>, bounds: GeoBounds): boolean {
  for (const [lng, lat] of points) {
    if (lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north)
      return true;
  }
  return false;
}

/**
 * Builds every cell's frozen input slice once, so a worker reads one small file
 * instead of the whole 528 MB street document and 424 MB building stream.
 */
export async function prepareShadeInputs(
  grid: Grid,
  canopyInputs: ShadeCanopyInputs,
): Promise<{ cells: string[]; directory: string }> {
  const directory = rootPath("work", "shade", "inputs");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const streetsDoc = JSON.parse(await readFile(rootPath("work", "streets.json"), "utf8")) as {
    streets: {
      nodes: Array<{ id: number; lat: number; lon: number; isIntersection: boolean }>;
      edges: Array<{ id: string; from: number; to: number; distanceM: number; tags: Record<string, string | undefined> }>;
    };
  };
  const buildings = buildingsFromNdjson(await readFile(rootPath("work", "buildings.ndjson"), "utf8"));
  const graph = {
    nodes: new Map(streetsDoc.streets.nodes.map((node) => [node.id, { id: node.id, lat: node.lat, lon: node.lon, isIntersection: node.isIntersection }])),
    edges: streetsDoc.streets.edges,
    stats: { closedPedestrianWaysSkipped: 0, segmentsMissingCoords: 0, zeroLengthSegments: 0, danglingEdges: 0 },
  };
  const { shards } = shardStreets(graph, grid.z);
  // Shard once so a cell's caster set can be sliced without re-scanning the city.
  // Indexed by (x,y) so a cell reads only its own and its neighbours' buildings —
  // a caster more than a couple of z14 cells away cannot reach the query.
  const { shards: buildingShards } = shardBuildings(buildings, grid.z);
  const buildingsByCell = new Map<string, NavigationBuildingShard>();
  for (const [shardKey, shard] of buildingShards) {
    const match = /^buildings\/z\d+-(\d+)-(\d+)\.json$/.exec(shardKey);
    if (match) buildingsByCell.set(`${match[1]},${match[2]}`, shard);
  }

  const osm = parseOsmVegetation(JSON.parse(await readFile(canopyInputs.osmVegetationPath, "utf8")));

  const cells: string[] = [];
  for (const [shardKey, shard] of shards) {
    const key = shardKey.replace(/^streets\//, "").replace(/\.json$/, "");
    const match = /^z\d+-(\d+)-(\d+)$/.exec(key);
    const cellX = Number(match?.[1] ?? 0);
    const cellY = Number(match?.[2] ?? 0);
    const bounds = shard.supportBounds;
    const nodeOf = new Map(shard.nodes.map((node) => [node.id, node]));

    const segmentSet = new Map<string, [number, number]>();
    for (const edge of shard.edges) {
      const lo = Math.min(edge.from, edge.to);
      const hi = Math.max(edge.from, edge.to);
      segmentSet.set(`${lo},${hi}`, [lo, hi]);
    }
    const segments = [...segmentSet.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const edges: ShadeCellInput["edges"] = [];
    for (const [lo, hi] of segments) {
      const from = nodeOf.get(lo);
      const to = nodeOf.get(hi);
      if (!from || !to) throw new Error(`${key}: segment ${lo},${hi} has a missing endpoint`);
      edges.push({ from: [from.lon, from.lat], to: [to.lon, to.lat] });
    }
    // Casters are sliced against what the edges actually span, not the cell:
    // a seam edge's far endpoint lies outside `supportBounds`, and its samples
    // need the casters around it too (#294).
    const coverage = cellQueryBounds(bounds, edges);

    // Two cells of margin (~600 m at z14) covers the ~450 m query pad and the
    // caster reach beyond it; a seam edge reaching further widens the scan.
    const cellW = bounds.east - bounds.west;
    const cellH = bounds.north - bounds.south;
    const reach = Math.max(
      2,
      Math.ceil((bounds.west - coverage.west) / cellW),
      Math.ceil((coverage.east - bounds.east) / cellW),
      Math.ceil((bounds.south - coverage.south) / cellH),
      Math.ceil((coverage.north - bounds.north) / cellH),
    );
    const cellBuildings: FrozenBuilding[] = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const neighbour = buildingsByCell.get(`${cellX + dx},${cellY + dy}`);
        if (!neighbour) continue;
        for (const candidate of neighbour.buildings) {
          const rings = candidate.rings;
          if (!rings.some((ring) => pointsIntersect(ring, coverage))) continue;
          cellBuildings.push({ rings, heightM: candidate.heightM ?? NYC_UNKNOWN_HEIGHT_M });
        }
      }
    }
    const canopy = osm.filter((feature) => pointsIntersect(feature.points, coverage));

    const input: ShadeCellInput = {
      key,
      geometryBounds: shard.geometryBounds,
      supportBounds: bounds,
      segments,
      edges,
      buildings: cellBuildings,
      canopy,
    };
    await writeFile(join(directory, `${key}.json`), canonicalJson(input));
    cells.push(key);
  }
  return { cells, directory };
}

// ─── One cell ─────────────────────────────────────────────────────────────────

/** The payload for one cell, plus the counts the descriptor records. */
export interface ShadeCellResult {
  key: string;
  bytes: Uint8Array;
  segments: number;
  slots: number;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
}

/**
 * Sweep one cell's segments across all 768 slots and encode the payload.
 *
 * Month at a time so peak memory is 64 slots of edge results, not 768.
 */
export async function computeShadeCell(
  input: ShadeCellInput,
  canopyInputs: ShadeCanopyInputs,
): Promise<ShadeCellResult> {
  // The raster answers only inside the patch it loaded, so load the whole box
  // the field will query — the same box the input slice was filtered against
  // in `prepareShadeInputs`.
  const providerBBox: BBox = cellQueryBounds(input.supportBounds, input.edges);
  const buildingProvider = frozenBuildingProvider(input.buildings);
  const canopyProvider = frozenCanopyProvider(input.canopy);
  const rasterProvider = frozenRasterProvider(canopyInputs.chmv2Dir);
  const field: ShadowField = createGeometryShadowField(
    [buildingProvider],
    [canopyProvider],
    [rasterProvider],
    [],
  );

  // The field's `sweep` resolves the raster synchronously; load it first over
  // the same padded box every query will fall inside.
  await rasterProvider.load?.(providerBBox);

  const edges: EdgeRef[] = input.edges;
  const segments = input.segments.length;
  const instants = shadeSlotInstants();
  const payload = new Uint8Array(segments * SHADE_SLOT_COUNT * SHADE_BYTES_PER_SEGMENT);

  for (let month = 0; month < SHADE_MONTHS; month++) {
    const times = instants.slice(month * SHADE_DAY_SLOTS, (month + 1) * SHADE_DAY_SLOTS);
    const swept = field.sweep(edges, times);
    for (let slot = 0; slot < SHADE_DAY_SLOTS; slot++) {
      const slotIndex = month * SHADE_DAY_SLOTS + slot;
      const row = swept[slot];
      let offset = slotIndex * segments * SHADE_BYTES_PER_SEGMENT;
      for (let e = 0; e < segments; e++) {
        const shadow = row[e];
        // "none" at zero confidence means no provider resolved the query — the
        // field's 0 is a placeholder, not a measurement. Writing it would
        // publish a sunny street that nothing measured (#294), so the cell
        // fails instead. (Night is also "none", but certain: confidence 1.)
        if (shadow?.source === "none" && shadow.confidence === 0)
          throw new Error(`${input.key}: segment ${e} unresolved at slot ${slotIndex}`);
        payload[offset++] = shadeFractionToByte(shadow ? shadow.left : 1);
        payload[offset++] = shadeFractionToByte(shadow ? shadow.right : 1);
      }
    }
  }

  return {
    key: input.key,
    bytes: payload,
    segments,
    slots: SHADE_SLOT_COUNT,
    geometryBounds: input.geometryBounds,
    supportBounds: input.supportBounds,
  };
}

// ─── Agreement harness (L2 acceptance) ────────────────────────────────────────

export interface AgreementSummary {
  cell: string;
  segments: number;
  sampledSegments: number;
  samples: number;
  /** Absolute difference between the table byte and the live sweep, 0–1. */
  mean: number;
  p90: number;
  worst: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

/**
 * Table vs live `field.sweep`, the L2 acceptance number.
 *
 * The table stores each segment's shadow at a *representative day's* clock
 * slot; the live sweep answers the *actual* query instant. So this is not a
 * tautology — it measures exactly the approximation the slot model makes:
 * mid-month representative days and 15-minute clock alignment. It sweeps the
 * sampled edges at each instant (one index build per instant, not per edge) and
 * compares against the table byte the client would read.
 */
export async function shadeAgreement(
  key: string,
  canopyInputs: ShadeCanopyInputs,
  options: { maxSegments?: number; months?: number[]; days?: number[]; hours?: number[] } = {},
): Promise<AgreementSummary> {
  const input = JSON.parse(
    await readFile(join(rootPath("work", "shade", "inputs"), `${key}.json`), "utf8"),
  ) as ShadeCellInput;
  const payload = new Uint8Array(await readFile(join(shadeOutputDirectory(), `${key}.bin`)));

  const providerBBox: BBox = cellQueryBounds(input.supportBounds, input.edges);
  const rasterProvider = frozenRasterProvider(canopyInputs.chmv2Dir);
  const field = createGeometryShadowField(
    [frozenBuildingProvider(input.buildings)],
    [frozenCanopyProvider(input.canopy)],
    [rasterProvider],
    [],
  );
  await rasterProvider.load?.(providerBBox);

  const segments = input.segments.length;
  const sampleCount = Math.min(options.maxSegments ?? 100, segments);
  const sampleIndex = Array.from({ length: sampleCount }, (_, i) =>
    Math.floor((i * segments) / sampleCount),
  );
  const edges: EdgeRef[] = sampleIndex.map((index) => input.edges[index]);

  const months = options.months ?? [0, 2, 5, 7, 10];
  const days = options.days ?? [1, 28];
  const hours = options.hours ?? [9, 12, 15];
  const errors: number[] = [];

  for (const month of months) {
    for (const day of days) {
      for (const hour of hours) {
        const instant = fromZonedParts(SHADE_ZONE, SHADE_REPRESENTATIVE_YEAR, month, day, hour, 0);
        const live = field.sweep(edges, [instant])[0];
        const local = toMapLocal(instant, utcOffsetMinAt(SHADE_ZONE, instant));
        const slotInDay = shadeSlotForLocalMinutes(local.hours * 60 + local.minutes);
        const slot = shadeSlotIndex(local.month, slotInDay);
        const blockOffset = slot * segments * SHADE_BYTES_PER_SEGMENT;
        for (let s = 0; s < sampleIndex.length; s++) {
          const index = sampleIndex[s];
          const tableLeft = payload[blockOffset + index * SHADE_BYTES_PER_SEGMENT] / 255;
          const tableRight = payload[blockOffset + index * SHADE_BYTES_PER_SEGMENT + 1] / 255;
          const shadow = live[s];
          if (!shadow) continue;
          errors.push(Math.abs(tableLeft - shadow.left), Math.abs(tableRight - shadow.right));
        }
      }
    }
  }

  errors.sort((a, b) => a - b);
  const mean = errors.reduce((sum, value) => sum + value, 0) / (errors.length || 1);
  return {
    cell: key,
    segments,
    sampledSegments: sampleCount,
    samples: errors.length,
    mean,
    p90: percentile(errors, 0.9),
    worst: errors[errors.length - 1] ?? 0,
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface ShadeOptions {
  grid: GridZoom;
  concurrency: number;
  dryRun?: boolean;
  /** Restrict to these cell keys (measurement / smoke). */
  only?: string[];
}

export interface ShadeProgress {
  total: number;
  done: number;
  failed: string[];
  elapsedMs: number;
  startedAt: string;
}

async function writeProgress(progress: ShadeProgress): Promise<void> {
  await writeFile(rootPath("work", "shade-progress.json"), `${JSON.stringify(progress, null, 2)}\n`);
}

async function appendLog(line: string): Promise<void> {
  await writeFile(rootPath("work", "shade-build.log"), line, { flag: "a" });
}

/** Descriptor written beside a payload once its bytes are on disk. */
export interface ShadeCellDescriptor {
  key: string;
  segments: number;
  slots: number;
  bytes: number;
  sha256: string;
  geometryBounds: GeoBounds;
  supportBounds: GeoBounds;
}

export function shadeOutputDirectory(): string {
  return rootPath("work", "shade");
}

/** The descriptor for one written payload, or null if it is not on disk. */
export async function readShadeDescriptor(key: string): Promise<ShadeCellDescriptor | null> {
  try {
    const raw = await readFile(join(shadeOutputDirectory(), `${key}.json`), "utf8");
    return JSON.parse(raw) as ShadeCellDescriptor;
  } catch {
    return null;
  }
}

/** Writes one cell's payload and descriptor. */
export async function writeShadeCell(result: ShadeCellResult): Promise<ShadeCellDescriptor> {
  const directory = shadeOutputDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${result.key}.bin`), result.bytes);
  const descriptor: ShadeCellDescriptor = {
    key: result.key,
    segments: result.segments,
    slots: result.slots,
    bytes: result.bytes.byteLength,
    sha256: sha256Hex(result.bytes),
    geometryBounds: result.geometryBounds,
    supportBounds: result.supportBounds,
  };
  await writeFile(join(directory, `${result.key}.json`), `${canonicalJson(descriptor)}\n`);
  return descriptor;
}

/** One built cell, ready for `build` to fold into a generation. */
export interface BuiltShadeShard {
  cellKey: string;
  indexKey: string;
  payloadKey: string;
  /** The index object, `generation` left empty for the label-free digest. */
  index: NavigationShadeShard;
  indexBytes: Uint8Array;
  payloadBytes: Uint8Array;
  ref: NavigationShadeShardRef;
}

/**
 * Reads every payload the shade build wrote and shapes it for the generation:
 * the JSON index, the binary payload, and the manifest ref that names both.
 * A generation with no shade build present returns an empty list, so `build`
 * stays usable before the table ships.
 */
export async function loadBuiltShadeShards(): Promise<BuiltShadeShard[]> {
  const directory = shadeOutputDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const built: BuiltShadeShard[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const descriptor = JSON.parse(
      await readFile(join(directory, entry), "utf8"),
    ) as ShadeCellDescriptor;
    const payloadBytes = new Uint8Array(await readFile(join(directory, `${descriptor.key}.bin`)));
    if (payloadBytes.byteLength !== descriptor.bytes || sha256Hex(payloadBytes) !== descriptor.sha256)
      throw new Error(`shade payload ${descriptor.key} disagrees with its descriptor`);
    const indexKey = `shades/${descriptor.key}.json`;
    const payloadKey = `shades/${descriptor.key}.bin`;
    const index: NavigationShadeShard = {
      version: 1,
      dataset: "nyc-navigation",
      generation: "",
      kind: "shade",
      geometryBounds: descriptor.geometryBounds,
      supportBounds: descriptor.supportBounds,
      slots: descriptor.slots,
      segments: [],
      payload: {
        key: payloadKey,
        bytes: descriptor.bytes,
        sha256: descriptor.sha256,
      },
    };
    // The index carries the segment columns, which the payload build wrote to
    // the cell's input file — read it back rather than trust a second copy.
    const input = JSON.parse(
      await readFile(join(directory, "inputs", `${descriptor.key}.json`), "utf8"),
    ) as ShadeCellInput;
    index.segments = input.segments;
    const indexBytes = jsonBytes(index);
    const ref: NavigationShadeShardRef = {
      key: indexKey,
      bytes: indexBytes.byteLength,
      sha256: sha256Hex(indexBytes),
      geometryBounds: descriptor.geometryBounds,
      supportBounds: descriptor.supportBounds,
      segments: descriptor.segments,
      slots: descriptor.slots,
      payloadKey,
      payloadBytes: descriptor.bytes,
      payloadSha256: descriptor.sha256,
    };
    built.push({ cellKey: descriptor.key, indexKey, payloadKey, index, indexBytes, payloadBytes, ref });
  }
  return built;
}

/** Runs one cell end to end — the body of a worker child. */
export async function shadeCellMain(key: string, canopyInputs: ShadeCanopyInputs): Promise<void> {
  const input = JSON.parse(
    await readFile(join(rootPath("work", "shade", "inputs"), `${key}.json`), "utf8"),
  ) as ShadeCellInput;
  const result = await computeShadeCell(input, canopyInputs);
  const descriptor = await writeShadeCell(result);
  process.stdout.write(`${key} ${result.segments} ${descriptor.sha256.slice(0, 12)}\n`);
}

function spawnWorker(key: string, grid: GridZoom): Promise<{ key: string; ok: boolean }> {
  return new Promise((resolve) => {
    const cli = join(import.meta.dirname, "cli.ts");
    const child = spawn(
      process.execPath,
      [...process.execArgv, cli, "shade", "--cell", key, "--grid", `z${grid}`],
      { stdio: ["ignore", "ignore", "pipe"], env: process.env },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0 && stderr.trim()) process.stderr.write(`[${key}] ${stderr.trim()}\n`);
      resolve({ key, ok: code === 0 });
    });
  });
}

/**
 * The build. Prepares per-cell inputs (once), then runs cells through child
 * processes at `concurrency`, skipping any already written, and returns the
 * progress record so the CLI can exit non-zero on failures.
 */
export async function shadeExecute(options: ShadeOptions): Promise<ShadeProgress> {
  const startedAt = Date.now();
  const canopyInputs = defaultCanopyInputs();
  const grid = makeGrid(options.grid);

  const { cells } = await prepareShadeInputs(grid, canopyInputs);
  const selected = options.only ? cells.filter((key) => options.only?.includes(key)) : cells;

  if (options.dryRun) {
    return {
      total: selected.length,
      done: 0,
      failed: [],
      elapsedMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  const pending: string[] = [];
  for (const key of selected) {
    if (await readShadeDescriptor(key)) continue;
    pending.push(key);
  }

  const progress: ShadeProgress = {
    total: selected.length,
    done: selected.length - pending.length,
    failed: [],
    elapsedMs: 0,
    startedAt: new Date(startedAt).toISOString(),
  };
  await writeProgress(progress);

  let next = 0;
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= pending.length) return;
      const key = pending[index];
      const outcome = await spawnWorker(key, options.grid);
      if (outcome.ok) {
        progress.done += 1;
        await appendLog(`${new Date().toISOString()} ${key} ok\n`);
      } else {
        progress.failed.push(key);
        await appendLog(`${new Date().toISOString()} ${key} FAILED\n`);
      }
      progress.elapsedMs = Date.now() - startedAt;
      await writeProgress(progress);
    }
  });
  await Promise.all(workers);

  progress.elapsedMs = Date.now() - startedAt;
  await writeProgress(progress);
  return progress;
}

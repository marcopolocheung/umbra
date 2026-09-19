/**
 * The shadow field (Track A, checkpoint A2).
 *
 * Shadow in this app has always been whatever the renderer painted: `useNavigation`
 * draws the map canvas into a 2D context and classifies blue pixels. That answer is
 * viewport-scoped, zoom-dependent, costs a re-render per hour, and can never count a
 * shadow source the renderer doesn't draw.
 *
 * `ShadowField` is the replacement: given a coordinate or an edge and a time, compute
 * a shadow fraction from geometry — no camera, no canvas, no main thread required.
 * Every answer carries where it came from and how much to trust it, because callers
 * need both (A4 falls back to the pixel path on low confidence, and the UI is only
 * allowed to show numbers it can explain).
 *
 * Nobody else implements shadow math. Other tracks import this.
 */

import SunCalc from "suncalc";
import {
  type BuildingPrism,
  type PrismSet,
  metersPerDegree,
} from "./geometry";
import type { CanopyHeightField, CanopyShade } from "./canopyRasterField";
import {
  type IndexRegion,
  type ShadowCasters,
  type ShadowIndex,
  buildShadowIndexFor,
  prepareShadowCasters,
} from "./shadowIndex";

import { rainOpacityForLightOpacity, RAIN_TILT_DOCK_ALTITUDE_DEG, RAIN_TILT_WALL_DOCK } from "../rain/opacity";
import type { RainDirection } from "../rain/direction";

// ─── The published contract ───────────────────────────────────────────────────

/**
 * Where a shadow answer came from.
 *
 * `"none"` means no geometry backed the answer, and `confidence` says which kind:
 * 1 for a sun below the horizon (astronomically certain, no geometry needed) and
 * 0 for "no source covered this point", which is a request to fall back rather
 * than a claim of full sun. `"canvas"` is the pixel sampler, wired in by A4 as the
 * fallback. A7 filled in the last two: `"canopy"` means a canopy source answered and
 * no building source could, `"mixed"` that a building source answered *and* canopy
 * was present in the area to be blended with it. `"nyc-static"` is the verified
 * NYC building snapshot: like `"tiles"` and `"overpass"` it names the exact
 * building provider behind an answer (see `EdgeShadow.buildingSource`), and
 * the user-facing label stays "from building geometry".
 *
 * A8d's height raster is deliberately *not* a sixth member. It is canopy, it reports
 * the same fraction, and `describeShadowProvenance` already says "from tree canopy"
 * for it truthfully. Which canopy source a number came from is a different question,
 * and the place it is owed an answer is #277 — where `EdgeShadow` learns to carry the
 * canopy *share* so the cost model can weight it — not in a label the UI would have
 * to explain.
 */
export type ShadowSource =
  | "tiles"
  | "overpass"
  | "nyc-static"
  | "canopy"
  | "mixed"
  | "canvas"
  | "none";

export interface ShadowSample {
  /** 0 = full sun, 1 = fully shadowed. */
  shadow: number;
  source: ShadowSource;
  /** 0–1. Below `LOW_CONFIDENCE` a caller should prefer another source. */
  confidence: number;
}

/** An edge in the routing graph, in its canonical (low→high node id) direction. */
export interface EdgeRef {
  from: [number, number];
  to: [number, number];
}

/**
 * Shadow for both sidewalks of an edge. The left/right split is what lets Dijkstra
 * pick the shadowed side of a street and what Track B's "cross now" cue reads.
 */
export interface EdgeShadow {
  left: number;
  right: number;
  source: ShadowSource;
  confidence: number;
  /** Exact building provider used for this edge, independent of blended UI provenance. */
  buildingSource?: PrismProvider["source"] | null;
  /** Exact canopy evidence that survived footprint masking for this edge. */
  canopySources?: { osm: boolean; raster: boolean };
}

/**
 * Rain shelter for both sidewalks of an edge — the rain twin of `EdgeShadow`,
 * with the identical polarity: 0 = fully exposed (wet), 1 = fully sheltered (dry).
 *
 * `source` and `confidence` keep the shadow vocabulary so a caller can reuse the
 * exact provenance and floor machinery; only the numbers' meaning changed, and the
 * UI says so when it shows them.
 */
export interface RainGrid {
  /** Row-major shelter fractions, row 0 = north edge. 0 = exposed, 1 = sheltered. */
  values: Float32Array;
  cols: number;
  rows: number;
  /** Source and confidence of the geometry that answered, same vocabulary as edges. */
  source: ShadowSource;
  confidence: number;
}

export interface EdgeShelter {
  left: number;
  right: number;
  source: ShadowSource;
  confidence: number;
  /** Exact building provider used for this edge. */
  buildingSource?: PrismProvider["source"] | null;
  /** Canopy evidence. `raster` is always false: the raster march is a light model. */
  canopySources?: { osm: boolean; raster: boolean };
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Whether any source can speak for an area — asked *before* sampling it.
 *
 * `sampleEdges` already reports a source and a confidence per edge, but only after
 * doing the work. A caller that must decide something up front — A4b decides whether
 * to read the map canvas at all, which costs a camera move and a full-canvas
 * readback — needs the same answer in advance, and this is the cheap half of
 * `sampleEdges`: resolve a provider, score it, do no geometry.
 */
export interface Coverage {
  source: ShadowSource;
  confidence: number;
}

/** Cancellation and one absolute budget shared by every preload for a caller. */
export interface ShadowReadyOptions {
  signal?: AbortSignal;
  /** Unix time in milliseconds after which optional readiness work must stop. */
  deadlineAt?: number;
}

export interface ShadowField {
  shadowAt(lng: number, lat: number, when: Date): ShadowSample;
  sampleEdges(edges: EdgeRef[], when: Date): EdgeShadow[];
  /**
   * Rain shelter for each edge's two sidewalks, from the same providers.
   *
   * The only directional input is `direction` — no sun, no time. `when` selects
   * the canopy's leaf state exactly as `sampleEdges` does; omit it for now.
   */
  sampleRainEdges(edges: EdgeRef[], direction: RainDirection, when?: Date): EdgeShelter[];
  /**
   * Rain shelter rasterized over a rectangle for map painting.
   *
   * One direction per call, one resolution pass, one index build each for the
   * building and canopy caster sets — the map layer's replacement for the
   * renderer-based painter, which knows nothing about rain.
   */
  sampleRainGrid(
    bounds: BBox,
    cols: number,
    rows: number,
    direction: RainDirection,
    when?: Date
  ): RainGrid;
  
  /** Preload the exact 2 km cells that `sampleEdges` will resolve. */
  readyEdges(edges: EdgeRef[], options?: ShadowReadyOptions): Promise<void>;
  /** Weakest provider coverage across the exact cells `sampleEdges` will use. */
  coverageEdges(edges: EdgeRef[], when: Date): Coverage;
  /** Which source, if any, could answer for this whole bbox. No geometry is built. */
  coverage(bbox: BBox, when: Date): Coverage;
  /** N times in one pass. Naive today; A6 makes it cheaper than N× `sampleEdges`. */
  sweep(edges: EdgeRef[], times: Date[]): EdgeShadow[][];
  /** Preload geometry so subsequent synchronous queries can answer. */
  ready(bbox: BBox, options?: ShadowReadyOptions): Promise<void>;
}

/**
 * A source of building prisms for an area.
 *
 * Two exist today — MapTiler vector tiles (what the renderer draws, synchronous,
 * viewport-scoped) and Overpass (slower, async, works anywhere) — plus the
 * static NYC snapshot provider (`nyc-static`, verified shards, route-scoped),
 * which goes first inside its coverage. `prismsFor` must
 * return `null` rather than an empty set when the provider cannot speak for a bbox,
 * because "no buildings here" and "I haven't loaded this area" produce the same
 * shadow number and very different confidence.
 */
export interface PrismProvider {
  source: "tiles" | "overpass" | "nyc-static";
  prismsFor(bbox: BBox): PrismSet | null;
  load?(bbox: BBox, signal?: AbortSignal): Promise<void>;
  /**
   * How complete this source's geometry is *right now*, as a 0–1 multiplier on its
   * base confidence. Absent means 1.
   *
   * `prismsFor` answers a yes/no question — can I speak for this area at all — and
   * that binary is too coarse for a source whose coverage degrades continuously.
   * MapTiler thins its building layer as you zoom out: still non-empty, so
   * `dataFactor` sees buildings and says nothing, while half the block is missing
   * and the field reports a sunlit street under a tower it never received.
   */
  completeness?(): number;
}

/**
 * A source of canopy prisms — tagged tree crowns, rows and woodland (A7).
 *
 * Separate from `PrismProvider` rather than another entry in the same list, because
 * canopy is **additive**: buildings resolve first-one-wins, and a canopy source does
 * not compete with them, it is blended on top. Folding the two into one list would
 * mean either a canopy source shadowing a building source or the field guessing at
 * which of them it was holding.
 *
 * The date is the other difference. A crown's geometry is fixed but its opacity is
 * seasonal, so `prismsFor` needs the moment. It must still return the *same array*
 * for the same area and leaf state — `ShadowField` keys its prepared casters on that
 * array's identity — and `null`, never an empty set, when it cannot speak for an
 * area. "No trees here" and "I have not fetched this" are the difference between
 * reporting a bare street honestly and reporting one that is lined with planes.
 */
export interface CanopyProvider {
  source: "canopy";
  prismsFor(bbox: BBox, when: Date): PrismSet | null;
  load?(bbox: BBox, signal?: AbortSignal): Promise<void>;
}

/**
 * A canopy source that is a **height field** rather than a set of crowns (A8d).
 *
 * The Meta/WRI raster answers "vegetation this tall, here" over ~800k pixels for a
 * route-sized area. Turning that into `BuildingPrism`s the way A7 turns a tagged tree
 * into one would hand `buildShadowIndex` a caster set two orders of magnitude past
 * what it was built for, to tessellate something that was already a heightfield. So
 * this provider hands back the field itself and `canopyRasterField.ts` marches it.
 *
 * Third list rather than a second entry in `canopyProviders` because the two answer
 * different shapes and are blended, not ranked: see `pointShadow`. Same two rules as
 * every other provider — `null` for "I cannot speak for this area", never an empty
 * answer, and `fieldFor` never reaches the network.
 */
export interface CanopyRasterProvider {
  source: "canopy-raster";
  fieldFor(bbox: BBox): CanopyHeightField | null;
  load?(bbox: BBox, signal?: AbortSignal): Promise<void>;
}

// ─── Tunables, all of them documented ─────────────────────────────────────────

/** Below this, `shadowAt`'s answer is a hint; callers should consult another source. */
export const LOW_CONFIDENCE = 0.5;

/**
 * Width of the batch partition that fixes one sun position per shadow index.
 *
 * One index is built per (sun, projection), but `SunCalc.getPosition` varies across
 * a route graph, so a batch has to be cut into cells that each get their own. 2 km
 * bounds the error by construction: the sun's altitude changes by ~0.018° across a
 * cell, which at 45° altitude is ~5 cm of shadow length and ~0.8 m at 10°. Both sit
 * under the pixel sampler's own ~1.2 m quantization, so the cut is invisible in the
 * agreement number while keeping the index count small.
 */
const SUN_CELL_M = 2000;

/** Maximum wall time a route waits for all missing cell providers together. */
const READY_EDGES_BUDGET_MS = 2500;

/** Sidewalk offset, matching `shadowSampling.sampleBothSidewalks` so A3 compares like with like. */
const SIDEWALK_OFFSET_M = 4.0;

/** Metres per degree used for the sidewalk offset — the same constant the pixel sampler uses. */
const SIDEWALK_M_PER_DEG = 111195;

/**
 * Sample count for one edge, matching what the pixel path actually asks for.
 *
 * `useNavigation` calls `sampleBothSidewalks(..., Math.max(3, ceil(distanceM / 25)))`, i.e. a
 * sample roughly every 25 m with a floor of 3 — not the function's default of 5. The sampler
 * then walks `i = 0..N` inclusive, so N+1 points land on each sidewalk. Mirroring the count
 * matters: a long edge sampled 6 times by one path and 40 times by the other disagrees for
 * reasons that have nothing to do with the shadow model, which is exactly what A3 must not
 * measure.
 */
export function edgeSampleCount(distanceM: number): number {
  return Math.max(3, Math.ceil(distanceM / 25));
}

/** Planar edge length in metres — good enough at street scale. */
function edgeLengthM(edge: EdgeRef): number {
  const { mPerLat, mPerLng } = metersPerDegree((edge.from[1] + edge.to[1]) / 2);
  const dx = (edge.to[0] - edge.from[0]) * mPerLng;
  const dy = (edge.to[1] - edge.from[1]) * mPerLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The 5-point probe `queryPointShadow` and `computeBuildingShadowFraction` both already run. */
const POINT_OFFSETS_M: Array<[number, number]> = [
  [0, 0],
  [-4, 0],
  [4, 0],
  [0, -4],
  [0, 4],
];

/**
 * How far outside the query a provider must have geometry loaded, in metres.
 *
 * Shadow length is `height / tan(altitude)`, which diverges as the sun touches the
 * horizon — a 20 m building at 0.5° altitude "casts" 2.3 km. Asking a provider to
 * cover that is not practical, and past a couple of hundred metres the answer is
 * dominated by terrain and haze this model does not have, so the request is capped
 * and `confidenceFor` docks the answer near the horizon instead.
 *
 * Exported because a caller that preloads with `ready()` has to pad its bbox by the
 * same amount `sampleEdges` will: load one area and resolve another and the provider
 * declines an area it actually holds.
 */
export const QUERY_PAD_M = 400;

/** Below this sun altitude, shadow geometry stops being trustworthy. See `confidenceFor`. */
const LOW_SUN_ALTITUDE_RAD = (10 * Math.PI) / 180;

/**
 * Base trust per source.
 *
 * Tiles score higher because MapTiler resolves a `render_height` for every building
 * it serves; Overpass hands back raw OSM, where an untagged way falls through to a
 * flat default (see issue #120). Neither is measured ground truth — these are
 * priors, and A3's agreement harness is what turns them into calibrated numbers.
 */
type SourceKey = PrismProvider["source"] | "canopy" | "canopy-raster";

const SOURCE_BASE_CONFIDENCE: Record<SourceKey, number> = {
  tiles: 0.8,
  overpass: 0.7,
  /**
   * The static NYC snapshot: below tiles, above Overpass, and deliberately
   * neither by accident.
   *
   * Above Overpass (0.7) because every byte is digest-verified against the
   * published generation and heights come from the pinned NYC Building
   * Footprints release rather than whoever tagged the way. Below tiles (0.8)
   * because MapTiler resolves a `render_height` per served building while the
   * static set carries an explicit unknown-height fraction
   * (`missingHeights` per shard ref) through a flat fallback — and the
   * agreement harness cannot calibrate any of this, since it compares the
   * field against a pixel sampler over identical prisms. A prior, like every
   * other number in this block, and one a retained-sample comparison should
   * replace.
   */
  "nyc-static": 0.75,
  /**
   * Canopy alone, with no building source behind it, is deliberately below
   * `LOW_CONFIDENCE`: a tree layer cannot tell you anything about the tower across
   * the street, so an answer resting on it alone is a request to fall back, not a
   * routing input. It only ever surfaces where no building source could speak.
   */
  canopy: 0.35,
  /**
   * The raster scores above OSM's tagged crowns and still below `LOW_CONFIDENCE`.
   *
   * Above, because it is a *presence* layer and OSM is not: the 2026-09-09 census
   * found OSM holding ~23% of Madrid's inventoried street trees and ~1% of
   * Singapore's, while the raster covers every pixel of both — and A8c measured that
   * it is separable from buildings rather than reproducing them
   * (`docs/notes/canopy-urban-confusion-2026-09-10.md`). Below, for the same reason
   * `canopy` is: whatever it knows about trees, it knows nothing about the tower
   * across the street, so canopy alone remains a request to consult another source.
   *
   * A prior, like every other number in this block, and one no corpus in this repo
   * can yet calibrate — the agreement harness compares the field against a pixel
   * sampler that cannot see a tree at all.
   */
  "canopy-raster": 0.45,
};

/** Applied when the covering source holds no buildings at all for the area. */
const NO_GEOMETRY_FACTOR = 0.4;

/**
 * What blending canopy into a building answer does to its confidence.
 *
 * It goes **down**, which reads backwards until you separate bias from uncertainty.
 * Adding canopy removes a known bias — buildings-only shadow under-reports tree-lined
 * streets, which is the whole point of A7. It also makes the number rest on a crown
 * model that is crude and on tags that are sparse in a way nothing here can measure
 * per-area: the 2026-09-09 census found OSM holding on the order of one in four of
 * Madrid's inventoried street trees and one in a hundred of Singapore's
 * (`docs/notes/canopy-coverage-2026-09-09.md`). Less bias, more uncertainty.
 *
 * Like `SOURCE_BASE_CONFIDENCE` and `DECIMATED_COMPLETENESS`, the size of the dock is
 * a policy prior, not a measurement — chosen to keep a tile-backed answer above
 * `LOW_CONFIDENCE` (0.8 × 0.9 = 0.72) while saying out loud that the answer is now
 * partly a model. A3's harness cannot calibrate it: it compares the field and the
 * pixel sampler over *identical* prisms, and the pixel sampler cannot see a tree at
 * all. That needs ground truth this repo does not have.
 */
const CANOPY_MIX_FACTOR = 0.9;

// ─── Confidence ───────────────────────────────────────────────────────────────

/**
 * How much to trust one geometric shadow answer.
 *
 * Three independent doubts, multiplied:
 *
 * 1. **The source.** See `SOURCE_BASE_CONFIDENCE`.
 * 2. **The sun's altitude.** Shadow length goes as `1/tan(altitude)`, so near sunrise
 *    and sunset a 10% height error becomes a 10% error on a shadow several hundred
 *    metres long — the shadow *edge* lands in the wrong block. Ramps from 1 at 10°
 *    down to 0.3 at the horizon.
 * 3. **Whether the covering source actually holds any buildings.** A source that
 *    claims an area and returns nothing reads as full sun whether that area is an
 *    empty plaza or one whose buildings never loaded. The field cannot tell those
 *    apart, so it says so.
 *
 * 4. **How complete the source's geometry is right now.** Reported by the provider —
 *    see `PrismProvider.completeness`. A tile source zoomed out far enough to be
 *    served a decimated building layer is not the same source it is at street zoom.
 *
 * 5. **Whether canopy was blended in.** Applied by the caller rather than here, via
 *    `CANOPY_MIX_FACTOR` — see that constant for why more information can mean less
 *    confidence.
 *
 * Note what this deliberately does *not* dock: a point that simply sits outside every
 * shadow. Once buildings are loaded, "the sun reaches here" is a confident answer, and
 * treating it as a doubt would send almost every sunlit sample to the fallback path.
 */
export function confidenceFor(
  source: SourceKey,
  sunAltitudeRad: number,
  prismsAvailable: number,
  completeness = 1
): number {
  const base = SOURCE_BASE_CONFIDENCE[source];

  const horizonFactor =
    sunAltitudeRad >= LOW_SUN_ALTITUDE_RAD
      ? 1
      : 0.3 + 0.7 * Math.max(0, sunAltitudeRad / LOW_SUN_ALTITUDE_RAD);

  const dataFactor = prismsAvailable > 0 ? 1 : NO_GEOMETRY_FACTOR;

  return base * horizonFactor * dataFactor * Math.max(0, Math.min(1, completeness));
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** A bbox around a point, padded by `padM` metres. */
export function bboxAroundPoint(lng: number, lat: number, padM: number): BBox {
  const { mPerLat, mPerLng } = metersPerDegree(lat);
  return {
    west: lng - padM / mPerLng,
    east: lng + padM / mPerLng,
    south: lat - padM / mPerLat,
    north: lat + padM / mPerLat,
  };
}

/** A bbox covering every endpoint of every edge, padded by `padM` metres. */
export function bboxAroundEdges(edges: EdgeRef[], padM: number): BBox | null {
  if (edges.length === 0) return null;

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const edge of edges) {
    for (const [lng, lat] of [edge.from, edge.to]) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }

  const { mPerLat, mPerLng } = metersPerDegree((south + north) / 2);
  return {
    west: west - padM / mPerLng,
    east: east + padM / mPerLng,
    south: south - padM / mPerLat,
    north: north + padM / mPerLat,
  };
}

// ─── The geometry-backed implementation ───────────────────────────────────────

interface Resolved {
  set: PrismSet;
  source: PrismProvider["source"];
  /** The provider's own completeness at the moment it answered. */
  completeness: number;
}

/** The sun, and the shadows it casts, shared by every edge in one `SUN_CELL_M` cell. */
interface SunCell {
  sun: { azimuth: number; altitude: number };
  /** `null` when no geometry resolved, or the sun is down for this cell. */
  index: ShadowIndex | null;
  /**
   * Canopy shadow for the same cell, indexed separately (A7).
   *
   * Two indexes rather than one over the concatenation, for two reasons. The building
   * path stays provably the geometry it always was — same casters, same grid, same
   * order — which is what lets A3's agreement numbers and A6's sweep parity keep
   * meaning what they meant. And the prepared-caster cache is keyed on a prism
   * array's identity, so a concatenation built per call would miss it every time.
   */
  canopyIndex: ShadowIndex | null;
  /**
   * Canopy shade from the height raster for the same cell and moment (A8d).
   *
   * Not a `ShadowIndex`: nothing is triangulated or bucketed, because a heightfield
   * is marched. It is built per (sun, moment) for the same reason the two indexes
   * are — the march direction comes from the azimuth, the ray's climb from the
   * altitude, and the crown's opacity from the date.
   */
  rasterShade: CanopyShade | null;
  resolved: Resolved | null;
  canopy: PrismSet | null;
  raster: CanopyHeightField | null;
}

/**
 * One `SUN_CELL_M` cell, with everything about it that no time changes.
 *
 * The partition, each cell's centroid, its projection frame and the region its
 * samples provably stay inside are all pure functions of the edges — so a sweep
 * computes them once and reuses them at every hour (A6). Only `SunCalc.getPosition`
 * and the shadow index itself are per-time.
 */
interface SunCellPlan {
  /** Indices into the edge batch, in batch order. */
  members: number[];
  lng: number;
  lat: number;
  mPerLat: number;
  mPerLng: number;
  region: IndexRegion;
}

/** Provider query for one cell, including every caster the cell's samples can reach. */
function queryBboxForCell(cell: SunCellPlan): BBox {
  return {
    west: cell.region.west - QUERY_PAD_M / cell.mPerLng,
    east: cell.region.east + QUERY_PAD_M / cell.mPerLng,
    south: cell.region.south - QUERY_PAD_M / cell.mPerLat,
    north: cell.region.north + QUERY_PAD_M / cell.mPerLat,
  };
}

/** A batch of edges, with everything about it that no time changes (A6). */
interface BatchPlan {
  cells: SunCellPlan[];
  /** Per edge: its two sidewalk offsets and how many points to walk along each. */
  left: Array<[number, number]>;
  right: Array<[number, number]>;
  steps: number[];
}

/** The bbox of exactly these points — the region a caller may then query within. */
function regionOver(points: Array<[number, number]>): IndexRegion {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of points) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/**
 * Everything about a batch of edges that no time changes, computed once.
 *
 * Each edge's sidewalk offsets and sample count come first — they are pure functions
 * of the edge, and recomputing them per hour was `metersPerDegree` and a pair of
 * allocations per edge per hour.
 *
 * The batch is then cut into `SUN_CELL_M` cells.
 *
 * `SunCalc.getPosition` was called per edge midpoint, but an index is built for a
 * single sun and a single projection frame. Cutting the batch into `SUN_CELL_M`
 * cells bounds that substitution instead of hand-waving it, and the index's own
 * region filter means each cell only triangulates prisms that can reach it — so
 * the total earcut work stays ~P rather than P per cell.
 *
 * Nothing here depends on the time, which is the point: `sweep` computes the plan
 * once and hands it to `sunCellsAt` at every hour, and `sampleEdges` computes the
 * same plan for its one hour. That is what keeps the two paths identical.
 */
function planBatch(edges: EdgeRef[]): BatchPlan {
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  const steps: number[] = [];
  for (const edge of edges) {
    const offsets = sidewalkOffsets(edge);
    left.push(offsets.left);
    right.push(offsets.right);
    steps.push(edgeSampleCount(edgeLengthM(edge)));
  }

  if (edges.length === 0) return { cells: [], left, right, steps };

  // Cell size in degrees, from the batch's own latitude — one frame for the cut.
  const batchLat = edges.reduce((sum, e) => sum + (e.from[1] + e.to[1]) / 2, 0) / edges.length;
  const batch = metersPerDegree(batchLat);
  const cellLng = SUN_CELL_M / batch.mPerLng;
  const cellLat = SUN_CELL_M / batch.mPerLat;

  const groups = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const midLng = (edges[i].from[0] + edges[i].to[0]) / 2;
    const midLat = (edges[i].from[1] + edges[i].to[1]) / 2;
    const key = `${Math.floor(midLng / cellLng)},${Math.floor(midLat / cellLat)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [i]);
    else group.push(i);
  }

  const cells: SunCellPlan[] = [];
  for (const members of groups.values()) {
    // The cell's own centroid, not its geometric centre: tighter when a cell holds
    // only a corner of a route, and still a pure function of the edges.
    let sumLng = 0;
    let sumLat = 0;
    for (const i of members) {
      sumLng += (edges[i].from[0] + edges[i].to[0]) / 2;
      sumLat += (edges[i].from[1] + edges[i].to[1]) / 2;
    }
    const lng = sumLng / members.length;
    const lat = sumLat / members.length;
    const { mPerLat, mPerLng } = metersPerDegree(lat);

    // The region is the bbox of the four offset corners of every edge in the cell.
    // Every sample point is a convex combination of an edge's endpoints plus one of
    // its two sidewalk offsets, so it provably lands inside — which is the
    // precondition the index's region filter needs.
    const corners: Array<[number, number]> = [];
    for (const i of members) {
      for (const end of [edges[i].from, edges[i].to]) {
        for (const offset of [left[i], right[i]]) {
          corners.push([end[0] + offset[0], end[1] + offset[1]]);
        }
      }
    }

    cells.push({ members, lng, lat, mPerLat, mPerLng, region: regionOver(corners) });
  }
  return { cells, left, right, steps };
}

/**
 * One sun cell per edge at one time, from a plan computed once.
 *
 * The `sun.altitude <= 0` short-circuit is per-cell rather than per-edge, so a batch
 * straddling sunrise resolves at cell granularity.
 */
function sunCellsAt(
  plan: BatchPlan,
  edgeCount: number,
  when: Date,
  sources: Array<{
    resolved: Resolved | null;
    canopy: PrismSet | null;
    raster: CanopyHeightField | null;
  }>,
): SunCell[] {
  const out = new Array<SunCell>(edgeCount);
  for (let cellIndex = 0; cellIndex < plan.cells.length; cellIndex++) {
    const cell = plan.cells[cellIndex];
    const source = sources[cellIndex];
    const sun = SunCalc.getPosition(when, cell.lat, cell.lng);
    const build = (from: ShadowCasters | null) =>
      from && sun.altitude > 0
        ? buildShadowIndexFor(
            from, sun.azimuth, sun.altitude, cell.mPerLat, cell.mPerLng, cell.region
          )
        : null;
    const index = build(source.resolved ? preparedCastersFor(source.resolved.set.prisms) : null);
    const canopyIndex = build(source.canopy ? preparedCastersFor(source.canopy.prisms) : null);
    const rasterShade =
      source.raster && sun.altitude > 0
        ? source.raster.shadeFor(sun.azimuth, sun.altitude, when)
        : null;
    for (const i of cell.members) {
      out[i] = {
        sun,
        index,
        canopyIndex,
        rasterShade,
        resolved: source.resolved,
        canopy: source.canopy,
        raster: source.raster,
      };
    }
  }
  return out;
}

/**
 * Prepared casters, keyed by the prism array they came from (A6).
 *
 * Preparation is per prism *set*, not per query, and both live providers already
 * cache: they hand back the same array until the geometry actually changes, and
 * neither mutates one in place — a new viewport or a new fetch builds a new array.
 * Keying on that array is therefore exactly the right invalidation, and a `WeakMap`
 * means a set that falls out of a provider's cache takes its preparation with it.
 *
 * Without this, `sampleEdges` flattened every prism in the city on every call, which
 * a route calculation makes several of. Module-level rather than per field because
 * two fields over the same provider are looking at the same geometry.
 */
const PREPARED = new WeakMap<BuildingPrism[], ShadowCasters>();

function preparedCastersFor(prisms: BuildingPrism[]): ShadowCasters {
  const hit = PREPARED.get(prisms);
  if (hit) return hit;
  const prepared = prepareShadowCasters(prisms);
  PREPARED.set(prisms, prepared);
  return prepared;
}

/**
 * Rain-opacified canopy prisms, keyed by the light-opacity array they mirror.
 *
 * The canopy provider hands back one prism array per (area, leaf state), so this
 * cache makes the rain rewrite happen once per fetch, and `PREPARED` then caches
 * the prepared casters on the rain array's identity exactly as it does for light.
 */
const RAIN_CANOPY_PRISMS = new WeakMap<BuildingPrism[], BuildingPrism[]>();

function rainCanopyCastersFor(prisms: BuildingPrism[]): BuildingPrism[] {
  const hit = RAIN_CANOPY_PRISMS.get(prisms);
  if (hit) return hit;
  const rain = prisms.map((p) => ({ ...p, opacity: rainOpacityForLightOpacity(p.opacity) }));
  RAIN_CANOPY_PRISMS.set(prisms, rain);
  return rain;
}

/** Prepared casters that shelter their own footprint (rain semantics). */
const RAIN_PREPARED = new WeakMap<BuildingPrism[], ShadowCasters>();

function preparedRainCastersFor(prisms: BuildingPrism[]): ShadowCasters {
  const hit = RAIN_PREPARED.get(prisms);
  if (hit) return hit;
  const prepared = prepareShadowCasters(prisms, { ownFootprintOccluded: false });
  RAIN_PREPARED.set(prisms, prepared);
  return prepared;
}

/**
 * A `ShadowField` over building prisms.
 *
 * Providers are consulted in order and the first one that can speak for the area
 * answers, so a caller can put the fast synchronous tile provider ahead of the
 * Overpass one and get the network path only where the renderer has nothing loaded.
 */
/** Options for `createGeometryShadowField` beyond the three provider lists. */
export interface GeometryShadowFieldOptions {
  /**
   * The current dataset generation, read at the moment a `ready`/`readyEdges`
   * call enters. Resolved readiness is cached per (generation, bbox) so that a
   * new generation never reuses another generation's answer; omit the hook and
   * every cache entry is keyed on `null` (the whole lifetime of the field).
   */
  generationOf?: () => string | null;
}

export function createGeometryShadowField(
  providers: PrismProvider[],
  canopyProviders: CanopyProvider[] = [],
  rasterProviders: CanopyRasterProvider[] = [],
  options: GeometryShadowFieldOptions = {}
): ShadowField {
  let overpassTail = Promise.resolve();
  const generationOf = options.generationOf ?? (() => null);

  /**
   * Resolved readiness, MRU, keyed by generation + the exact bbox.
   *
   * `ready()` and `readyEdges()` repeatedly re-attempted provider loads for
   * areas that had already resolved, and those attempts — failed raster reads
   * with their retry backoff, Overpass lookups, shard selection — are what kept
   * warm `fieldReady` in the hundreds of milliseconds. Providers already cache
   * their own decoded geometry (MRU arrays, four to eight entries); this list is
   * the same shape on top: readiness per (generation, exact bbox/cell key),
   * bounded, most recently used first. The exact key is deliberate — a caller
   * must ask for the same area `sampleEdges` will resolve, not merely an area
   * contained in something else that happened to load.
   *
   * Entries record only when a pass **completes** (no deadline/abort cut it
   * short): a bbox whose loads were interrupted still re-attempts next time.
   */
  const READINESS_CACHE_ENTRIES = 8;
  interface ReadinessEntry {
    /** Generation the provider data belonged to when this area was resolved. */
    generation: string | null;
    key: string;
    coverage: BBox;
  }
  const readyAreas: ReadinessEntry[] = [];

  function readinessKey(bbox: BBox): string {
    return [bbox.west, bbox.south, bbox.east, bbox.north]
      .map((value) => value.toFixed(5))
      .join(",");
  }

  function readinessHit(bbox: BBox, generation: string | null): boolean {
    const key = readinessKey(bbox);
    for (let i = 0; i < readyAreas.length; i++) {
      if (readyAreas[i].generation === generation && readyAreas[i].key === key) {
        // Most-recently-used to the front, exactly like the provider caches.
        const [entry] = readyAreas.splice(i, 1);
        readyAreas.unshift(entry);
        return true;
      }
    }
    return false;
  }

  function recordReadiness(bbox: BBox, generation: string | null): void {
    const key = readinessKey(bbox);
    for (let i = readyAreas.length - 1; i >= 0; i--) {
      if (readyAreas[i].generation === generation && readyAreas[i].key === key) {
        readyAreas.splice(i, 1);
      }
    }
    readyAreas.unshift({ generation, key, coverage: { ...bbox } });
    if (readyAreas.length > READINESS_CACHE_ENTRIES) readyAreas.length = READINESS_CACHE_ENTRIES;
  }

  function serializeOverpass(task: () => Promise<void>): Promise<void> {
    const run = overpassTail.then(task, task);
    overpassTail = run.catch(() => {});
    return run;
  }

  function resolve(bbox: BBox): Resolved | null {
    for (const provider of providers) {
      const set = provider.prismsFor(bbox);
      if (set) {
        return { set, source: provider.source, completeness: provider.completeness?.() ?? 1 };
      }
    }
    return null;
  }

  /** Canopy for an area at a moment, or `null` if no canopy source can speak for it. */
  function resolveCanopy(bbox: BBox, when: Date): PrismSet | null {
    for (const provider of canopyProviders) {
      const set = provider.prismsFor(bbox, when);
      if (set) return set;
    }
    return null;
  }

  /** The canopy height field for an area, unmasked. No date: a raster is not seasonal. */
  function resolveRaster(bbox: BBox): CanopyHeightField | null {
    for (const provider of rasterProviders) {
      const field = provider.fieldFor(bbox);
      if (field) return field;
    }
    return null;
  }

  /**
   * The height field with the ground the buildings occupy subtracted (A8c, A8d).
   *
   * This is where footprint subtraction happens, and the reason it happens *here* is
   * that this is the only place both sources are in hand: `CanopyTileStore` has no
   * map, no Overpass and no camera, which is exactly what lets it be tested against a
   * fake with no network, and a store that fetched buildings to answer a raster
   * question would have re-acquired the coupling it exists to remove.
   *
   * A8c priced it: at most 17.4% of apparent canopy in Madrid and 0.0-4.5% elsewhere,
   * so the mask cleans up rather than deletes. `masked` memoises on the prism array's
   * identity — the same invalidation `PREPARED` uses, and for the same reason.
   *
   * With no building source, nothing is subtracted. That is the honest answer, and it
   * only under-reports: unmasked canopy over a building shades ground the building
   * already occupies, and the building's own shadow is not there to win the point.
   */
  function maskedRaster(raster: CanopyHeightField | null, resolved: Resolved | null) {
    if (!raster || !resolved) return raster;
    return raster.masked(resolved.set.prisms);
  }

  /**
   * Is this exact point in shadow? One test, no neighbourhood.
   *
   * This is the unit both public queries are built from, and keeping it a single
   * point matters: `sampleEdges` has already displaced its samples ±4 m onto the
   * sidewalks, so averaging a further ±4 m neighbourhood around each one would
   * smear a sidewalk across the street it belongs to.
   *
   * A building wins outright: it is opaque, so nothing a crown adds can make the
   * point darker than 1, and the canopy index is only consulted where the buildings
   * answered sun. That ordering is what keeps A7 off the hot path in the cities where
   * it has nothing to say.
   */
  function pointShadow(
    index: ShadowIndex | null,
    canopyIndex: ShadowIndex | null,
    rasterShade: CanopyShade | null,
    lng: number,
    lat: number
  ): number {
    if (index?.isShadowed(lng, lat)) return 1;

    // Two canopy sources combine by **maximum**, which is the rule `opacityAt`
    // already applies between two overlapping crowns inside one index: the beam is
    // either through a canopy or it is not, and compounding a tagged plane tree with
    // the raster pixel that is the same plane tree would count it twice. Which source
    // wins where — the raster as the presence layer, OSM and municipal inventories
    // refining individual crowns — is A8e's fusion, and this is the placeholder it
    // replaces.
    let opacity = canopyIndex ? canopyIndex.opacityAt(lng, lat) : 0;
    if (opacity < 1 && rasterShade) {
      const fromRaster = rasterShade.opacityAt(lng, lat);
      if (fromRaster > opacity) opacity = fromRaster;
    }
    return opacity;
  }

  /**
   * Where an answer over these two sources came from, and what it is worth.
   *
   * "Canopy contributed" means the canopy source *had geometry for this area*, not
   * that a particular sample landed under a crown. That is deliberate: it makes the
   * label describe the evidence the number was computed from rather than the answer
   * it happened to give, and it lets `coverage()` report the same thing without
   * building any geometry — which is the one guarantee `coverage()` makes.
   */
  /**
   * What the canopy layer is worth on its own, or 0 when it contributed nothing.
   *
   * The better of the two canopy sources, not their product: they are alternative
   * evidence about the same trees, so believing both a little less than either is
   * backwards. The raster's own share of doubt is `validFraction` — a patch that is
   * half nodata answered from half the evidence, and reading an unpopulated pixel as
   * bare ground is the failure mode `CanopyPatch.valid` exists to prevent.
   *
   * **The raster handed in here must be the masked one wherever a masked one exists.**
   * Canopy standing on a roof is subtracted before the march, so scoring the unmasked
   * field would label an answer `"mixed"` and dock it `CANOPY_MIX_FACTOR` for evidence
   * that was then removed — and `describeShadowProvenance` would tell the user "and
   * tree canopy" over a corridor whose trees all sit on rooftops.
   *
   * The granularity is the **fetched patch**, not the query bbox: `maxHeightM` is a
   * property of everything the provider cached for the area it was asked to load,
   * which is a route corridor plus `QUERY_PAD_M`. That is the same coarseness A7's
   * cached fetch areas already have, and it is deliberate — narrowing it would mean
   * scanning a sub-window per query, which is exactly the work `coverage()` promises
   * not to do.
   */
  function canopyConfidence(
    canopy: PrismSet | null,
    raster: CanopyHeightField | null,
    sunAltitude: number
  ): number {
    let best = 0;
    const canopyPrisms = canopy?.prisms.length ?? 0;
    if (canopyPrisms > 0) best = confidenceFor("canopy", sunAltitude, canopyPrisms);
    if (raster && raster.maxHeightM > 0) {
      const fromRaster = confidenceFor("canopy-raster", sunAltitude, 1, raster.validFraction);
      if (fromRaster > best) best = fromRaster;
    }
    return best;
  }

  function scoreFor(
    resolved: Resolved | null,
    canopy: PrismSet | null,
    raster: CanopyHeightField | null,
    sunAltitude: number
  ): { source: ShadowSource; confidence: number } {
    const fromCanopy = canopyConfidence(canopy, raster, sunAltitude);

    if (!resolved) {
      if (fromCanopy === 0) return { source: "none", confidence: 0 };
      return { source: "canopy", confidence: fromCanopy };
    }

    const base = confidenceFor(
      resolved.source, sunAltitude, resolved.set.prisms.length, resolved.completeness,
    );
    if (fromCanopy === 0) return { source: resolved.source, confidence: base };
    return { source: "mixed", confidence: base * CANOPY_MIX_FACTOR };
  }

  function sampleFor(
    resolved: Resolved | null,
    canopy: PrismSet | null,
    raster: CanopyHeightField | null,
    shadow: number,
    sunAltitude: number
  ): ShadowSample {
    return { shadow, ...scoreFor(resolved, canopy, raster, sunAltitude) };
  }

  /**
   * A point query, softened over a small neighbourhood.
   *
   * `queryPointShadow` and `computeBuildingShadowFraction` have both averaged a
   * 5-offset ±4 m probe for a while, and the softening is right for a *place* —
   * "is this terrace shadowed?" is a question about a few square metres, not about
   * one infinitely small point that a metre of geometry error could move in or out
   * of shadow. Edge sampling deliberately does not do this; see `pointShadow`.
   */
  function probe(
    resolved: Resolved | null,
    canopy: PrismSet | null,
    raster: CanopyHeightField | null,
    lng: number,
    lat: number,
    when: Date,
    sunAzimuth: number,
    sunAltitude: number
  ): ShadowSample {
    if (!resolved && !canopy && !raster) return { shadow: 0, source: "none", confidence: 0 };

    const { mPerLat, mPerLng } = metersPerDegree(lat);
    const offsets = POINT_OFFSETS_M.map(
      ([dxM, dyM]) => [lng + dxM / mPerLng, lat + dyM / mPerLat] as [number, number]
    );
    const region = regionOver(offsets);
    const build = (prisms: BuildingPrism[]) =>
      buildShadowIndexFor(
        preparedCastersFor(prisms), sunAzimuth, sunAltitude, mPerLat, mPerLng, region
      );
    const index = resolved ? build(resolved.set.prisms) : null;
    const canopyIndex = canopy ? build(canopy.prisms) : null;
    const masked = maskedRaster(raster, resolved);
    const rasterShade = masked?.shadeFor(sunAzimuth, sunAltitude, when) ?? null;

    let shadowed = 0;
    for (const [sampleLng, sampleLat] of offsets) {
      shadowed += pointShadow(index, canopyIndex, rasterShade, sampleLng, sampleLat);
    }

    return sampleFor(resolved, canopy, masked, shadowed / POINT_OFFSETS_M.length, sunAltitude);
  }

  function shadowAt(lng: number, lat: number, when: Date): ShadowSample {
    const sun = SunCalc.getPosition(when, lat, lng);
    if (sun.altitude <= 0) return nightSample();

    const bbox = bboxAroundPoint(lng, lat, QUERY_PAD_M);
    return probe(
      resolve(bbox), resolveCanopy(bbox, when), resolveRaster(bbox),
      lng, lat, when, sun.azimuth, sun.altitude
    );
  }

  function sampleEdgesWithSun(
    edges: EdgeRef[],
    plan: BatchPlan,
    cells: SunCell[]
  ): EdgeShadow[] {
    return edges.map((edge, edgeIndex) => {
      const cell = cells[edgeIndex];
      const sun = cell.sun;

      if (sun.altitude <= 0) {
        const night = nightSample();
        return { left: 1, right: 1, source: night.source, confidence: night.confidence };
      }

      // Both sidewalks resolve the same providers over the same bbox, so the source
      // and the confidence are properties of the edge, not of a side of it.
      const score = scoreFor(cell.resolved, cell.canopy, cell.raster, sun.altitude);
      const provenance = {
        buildingSource: cell.resolved?.source ?? null,
        canopySources: {
          osm: (cell.canopy?.prisms.length ?? 0) > 0,
          raster: (cell.raster?.maxHeightM ?? 0) > 0,
        },
      };
      if (score.source === "none") {
        return {
          left: 0,
          right: 0,
          source: score.source,
          confidence: score.confidence,
          ...provenance,
        };
      }

      const leftOffset = plan.left[edgeIndex];
      const rightOffset = plan.right[edgeIndex];
      const steps = plan.steps[edgeIndex];

      // One point per sample, exactly where `sampleBothSidewalks` reads its pixel.
      const walk = (offset: [number, number]) => {
        let sum = 0;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          sum += pointShadow(
            cell.index,
            cell.canopyIndex,
            cell.rasterShade,
            edge.from[0] + t * (edge.to[0] - edge.from[0]) + offset[0],
            edge.from[1] + t * (edge.to[1] - edge.from[1]) + offset[1]
          );
        }
        return sum / (steps + 1);
      };

      return {
        left: walk(leftOffset),
        right: walk(rightOffset),
        source: score.source,
        confidence: score.confidence,
        ...provenance,
      };
    });
  }

  function sampleEdges(edges: EdgeRef[], when: Date): EdgeShadow[] {
    const plan = planBatch(edges);
    const sources = plan.cells.map((cell) => {
      const bbox = queryBboxForCell(cell);
      const resolved = resolve(bbox);
      const canopy = resolveCanopy(bbox, when);
      return { resolved, canopy, raster: maskedRaster(resolveRaster(bbox), resolved) };
    });
    return sampleEdgesWithSun(
      edges, plan, sunCellsAt(plan, edges.length, when, sources)
    );
  }

  /**
   * Rain shelter for each edge's two sidewalks (v0 vertical, v1 wind-tilted).
   *
   * Same hostage rules as `sampleEdges`: one resolution per 2 km cell, samples at
   * the pixel sampler's ±4 m sidewalk offsets, mean over the edge's steps.
   * Deliberate differences, each pinned by a test:
   * - No night: rain falls at any hour, so every cell resolves.
   * - The canopy raster is excluded — its march opacity is a light figure, and
   *   folding it in would claim a dryness this model has not established.
   * - Canopy prisms are re-opacified for rain (see `rainCanopyCastersFor`).
   * - Building-backed answers below `RAIN_TILT_DOCK_ALTITUDE_DEG` pay
   *   `RAIN_TILT_WALL_DOCK`: a wall only shelters at low rays, and low rays are
   *   exactly where the reported wind has stopped describing canyon-level wind.
   */
  function sampleRainEdges(
    edges: EdgeRef[],
    direction: RainDirection,
    when: Date = new Date()
  ): EdgeShelter[] {
    const plan = planBatch(edges);
    if (plan.cells.length === 0) return [];
    const altitudeRad = (direction.altitudeDeg * Math.PI) / 180;
    const results: EdgeShelter[] = new Array(edges.length);

    for (const cell of plan.cells) {
      const bbox = queryBboxForCell(cell);
      const resolved = resolve(bbox);
      const canopy = resolveCanopy(bbox, when);
      const score = scoreFor(resolved, canopy, null, altitudeRad);

      // The index speaks in **radians** (SunCalc's convention for the sun path),
      // and its azimuth points the direction shadows FALL. A rain ray arrives FROM
      // the wind bearing, so the casters' "shadow" — the sheltered lee — must land
      // opposite it: +180°. This rotation is locked by `shelter.test.ts` fixtures,
      // which fail on either convention's mistake.
      const rayAzimuth = ((direction.fromDeg + 180) * Math.PI) / 180;
      const buildingIndex = resolved
        ? buildShadowIndexFor(
            preparedRainCastersFor(resolved.set.prisms),
            rayAzimuth,
            altitudeRad,
            cell.mPerLat,
            cell.mPerLng,
            cell.region
          )
        : null;
      const canopyIndex = canopy
        ? buildShadowIndexFor(
            preparedRainCastersFor(rainCanopyCastersFor(canopy.prisms)),
            rayAzimuth,
            altitudeRad,
            cell.mPerLat,
            cell.mPerLng,
            cell.region
          )
        : null;


      const wallDocked =
        resolved !== null && direction.altitudeDeg < RAIN_TILT_DOCK_ALTITUDE_DEG;
      const confidence = wallDocked
        ? score.confidence * RAIN_TILT_WALL_DOCK
        : score.confidence;

      for (const i of cell.members) {
        const edge = edges[i];
        const leftOffset = plan.left[i];
        const rightOffset = plan.right[i];
        const steps = plan.steps[i];
        const walk = (offset: [number, number]) => {
          let sum = 0;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            sum += pointShadow(
              buildingIndex,
              canopyIndex,
              null,
              edge.from[0] + t * (edge.to[0] - edge.from[0]) + offset[0],
              edge.from[1] + t * (edge.to[1] - edge.from[1]) + offset[1]
            );
          }
          return sum / (steps + 1);
        };
        results[i] = {
          left: walk(leftOffset),
          right: walk(rightOffset),
          source: score.source,
          confidence,
          buildingSource: resolved?.source ?? null,
          canopySources: {
            osm: (canopy?.prisms.length ?? 0) > 0,
            raster: false,
          },
        };
      }
    }
    return results;
  }

  function sampleRainGrid(
    bounds: BBox,
    cols: number,
    rows: number,
    direction: RainDirection,
    when: Date = new Date()
  ): RainGrid {
    const values = new Float32Array(cols * rows);
    if (cols <= 0 || rows <= 0) {
      return { values, cols, rows, source: "none", confidence: 0 };
    }

    // Resolve the whole painted area once, with the provider's own pad, so the
    // index holds every caster that can reach a cell (mirrors `sampleEdges`).
    const midLat = (bounds.south + bounds.north) / 2;
    const { mPerLat, mPerLng } = metersPerDegree(midLat);
    const padLng = QUERY_PAD_M / mPerLng;
    const padLat = QUERY_PAD_M / mPerLat;
    const padded: BBox = {
      west: bounds.west - padLng,
      east: bounds.east + padLng,
      south: bounds.south - padLat,
      north: bounds.north + padLat,
    };
    const resolved = resolve(padded);
    const canopy = resolveCanopy(padded, when);
    const altitudeRad = (direction.altitudeDeg * Math.PI) / 180;
    const score = scoreFor(resolved, canopy, null, altitudeRad);
    const rayAzimuth = ((direction.fromDeg + 180) * Math.PI) / 180;

    const region: IndexRegion = { ...padded };
    const buildingIndex = resolved
      ? buildShadowIndexFor(
          preparedRainCastersFor(resolved.set.prisms),
          rayAzimuth,
          altitudeRad,
          mPerLat,
          mPerLng,
          region
        )
      : null;
    const canopyIndex = canopy
      ? buildShadowIndexFor(
          preparedRainCastersFor(rainCanopyCastersFor(canopy.prisms)),
          rayAzimuth,
          altitudeRad,
          mPerLat,
          mPerLng,
          region
        )
      : null;

    const wallDocked = resolved !== null && direction.altitudeDeg < RAIN_TILT_DOCK_ALTITUDE_DEG;
    const confidence = wallDocked ? score.confidence * RAIN_TILT_WALL_DOCK : score.confidence;

    const latStep = (bounds.north - bounds.south) / rows;
    const lngStep = (bounds.east - bounds.west) / cols;
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const lat = bounds.north - (r + 0.5) * latStep;
      for (let c = 0; c < cols; c++) {
        const lng = bounds.west + (c + 0.5) * lngStep;
        // A building pass wins opaque (1); canopy adds its rain-opacity fraction.
        values[k++] = pointShadow(buildingIndex, canopyIndex, null, lng, lat);
      }
    }
    return { values, cols, rows, source: score.source, confidence };
  }

  function coverageEdges(edges: EdgeRef[], when: Date): Coverage {
    const plan = planBatch(edges);
    if (plan.cells.length === 0) return { source: "none", confidence: 1 };

    let weakest: Coverage = { source: "none", confidence: 1 };
    for (const cell of plan.cells) {
      const sun = SunCalc.getPosition(when, cell.lat, cell.lng);
      const score = sun.altitude <= 0
        ? { source: nightSample().source, confidence: 1 }
        : (() => {
            const bbox = queryBboxForCell(cell);
            const resolved = resolve(bbox);
            const raster = maskedRaster(resolveRaster(bbox), resolved);
            return scoreFor(resolved, resolveCanopy(bbox, when), raster, sun.altitude);
          })();
      if (score.confidence < weakest.confidence) weakest = score;
    }
    return weakest;
  }

  async function readyEdges(
    edges: EdgeRef[],
    options: ShadowReadyOptions = {},
  ): Promise<void> {
    const window = readinessWindow(options);
    if (window.signal.aborted) {
      window.cleanup();
      return;
    }
    const cells = planBatch(edges).cells;
    if (cells.length === 0) {
      window.cleanup();
      return;
    }
    const generation = generationOf();
    const bboxes = cells.map(queryBboxForCell);
    // Load only the cells this generation has not already resolved. A repeated
    // calculation over the same edges finds every cell cached and pays nothing;
    // the `fieldReady` metric keeps measuring whatever remains.
    const missing = bboxes.filter((bbox) => !readinessHit(bbox, generation));
    if (missing.length === 0) {
      window.cleanup();
      return;
    }

    // Raster cells use the store's scheduler and may run together. The two OSM
    // provider families stay on one serial chain so a route never bursts the
    // volunteer Overpass service. Provider caches make these missing-only loads.
    const raster = Promise.all(missing.map(async (bbox) => {
      for (const provider of rasterProviders) {
        if (provider.fieldFor(bbox)) break;
        await provider.load?.(bbox, options.signal);
        if (provider.fieldFor(bbox)) break;
      }
    }));
    const overpass = serializeOverpass(async () => {
      for (const bbox of missing) {
        if (window.signal.aborted) return;
        if (!resolve(bbox)) {
          for (const provider of providers) {
            if (provider.prismsFor(bbox)) break;
            await provider.load?.(bbox, window.signal);
            if (window.signal.aborted) return;
          }
        }
        if (!resolveCanopy(bbox, new Date())) {
          for (const provider of canopyProviders) {
            if (provider.prismsFor(bbox, new Date())) break;
            await provider.load?.(bbox, window.signal);
            if (window.signal.aborted) return;
          }
        }
      }
    });

    // Overpass waiters are cancelled at the absolute deadline. Raster waiters use
    // only the caller signal: their shared scheduler may finish for later reuse.
    const completed = await settleReadiness(
      Promise.all([raster, overpass]).then(() => undefined),
      window.signal,
    );
    if (completed) {
      for (const bbox of missing) recordReadiness(bbox, generation);
    }
    window.cleanup();
  }

  return {
    shadowAt,
    sampleEdges,
    sampleRainEdges,
    sampleRainGrid,
    readyEdges,
    coverageEdges,

    coverage(bbox, when) {
      const lng = (bbox.west + bbox.east) / 2;
      const lat = (bbox.south + bbox.north) / 2;

      // Below the horizon there is nothing to resolve and nothing to doubt: the
      // whole area is shadowed, and `sampleEdges` will say so without consulting a
      // provider. Reporting full confidence here is what lets a caller skip a
      // fallback path it would never have used.
      const sun = SunCalc.getPosition(when, lat, lng);
      if (sun.altitude <= 0) {
        const night = nightSample();
        return { source: night.source, confidence: night.confidence };
      }

      // `resolveRaster` rather than `maskedRaster`: masking rasterises footprints, and
      // building no geometry is the one guarantee `coverage()` makes.
      //
      // So this is an **upper bound** on what `sampleEdges` will report, and the one
      // case the two differ is a corridor whose canopy stands entirely on rooftops:
      // here it reads "mixed", and sampling — which has the mask in hand — will drop
      // back to the building source. Erring high is the right direction for the
      // question this answers, which is whether the caller may skip a fallback path:
      // a `"mixed"` that resolves to `"tiles"` costs nothing, and both are well above
      // `LOW_CONFIDENCE` whenever the building source is.
      return scoreFor(resolve(bbox), resolveCanopy(bbox, when), resolveRaster(bbox), sun.altitude);
    },

    sweep(edges, times) {
      // A6. Everything that does not depend on the hour is computed once: the
      // provider is resolved once, the sun-cell partition and each cell's region
      // once, and each prism's ring bounds and footprint bucket once. What remains
      // per hour is the sun position, the shadow shift, and the point queries —
      // which is why N hours cost far less than N samples. The results are the same
      // floats N separate `sampleEdges` calls produce, and a test pins that.
      const plan = planBatch(edges);
      const stable = plan.cells.map((cell) => {
        const bbox = queryBboxForCell(cell);
        const resolved = resolve(bbox);
        return { bbox, resolved, raster: maskedRaster(resolveRaster(bbox), resolved) };
      });
      return times.map((when) => {
        // Canopy is resolved per time because its opacity is seasonal, and prepared
        // per resolution — but the provider hands back the same array for every time
        // in one leaf state, so both caches hit and a day's sweep prepares once.
        const sources = stable.map(({ bbox, resolved, raster }) => ({
          resolved,
          raster,
          canopy: resolveCanopy(bbox, when),
        }));
        return sampleEdgesWithSun(
          edges, plan, sunCellsAt(plan, edges.length, when, sources)
        );
      });
    },

    async ready(bbox, options = {}) {
      const window = readinessWindow(options);
      if (window.signal.aborted) {
        window.cleanup();
        return;
      }
      const generation = generationOf();
      if (readinessHit(bbox, generation)) {
        window.cleanup();
        return;
      }
      // Buildings first, canopy after — not one `Promise.all` over both. Every load
      // on that chain is a request to the same volunteer-run Overpass instance, and
      // the caller is already fetching the routing graph from it in parallel; firing
      // canopy alongside would take a route calculation from two concurrent requests
      // to three. Serialising costs nothing in the common case, where the building
      // provider declines the area on its radius cap and canopy starts immediately.
      //
      // The raster runs beside that chain rather than in it: it is byte-range reads
      // against `source.coop`, which shares neither a host nor a rate limit with
      // Overpass, so queueing it behind two Overpass calls would only make a route
      // wait for nothing.
      const completed = await settleReadiness(Promise.all([
        Promise.all(
          rasterProviders.map((provider) => provider.load?.(bbox, options.signal)),
        ),
        serializeOverpass(async () => {
          if (window.signal.aborted) return;
          await Promise.all(
            providers.map((provider) => provider.load?.(bbox, window.signal)),
          );
          if (window.signal.aborted) return;
          await Promise.all(
            canopyProviders.map((provider) => provider.load?.(bbox, window.signal)),
          );
        }),
      ]).then(() => undefined), window.signal);
      if (completed) recordReadiness(bbox, generation);
      window.cleanup();
    },
  };
}

function readinessWindow(options: ShadowReadyOptions): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const deadlineAt = options.deadlineAt ?? Date.now() + READY_EDGES_BUDGET_MS;
  const deadline = new AbortController();
  const remainingMs = deadlineAt - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) deadline.abort();
  else timer = setTimeout(() => deadline.abort(), remainingMs);
  return {
    signal: options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Resolves whether the readiness chain finished before the deadline did. */
function settleReadiness(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    if (signal.aborted) {
      finish(false);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

/** No geometry is consulted when the sun is down, and none is needed. */
function nightSample(): ShadowSample {
  return { shadow: 1, source: "none", confidence: 1 };
}

/**
 * Perpendicular ±4 m offsets for an edge's left and right sidewalks.
 *
 * Deliberately mirrors `shadowSampling.sampleBothSidewalks` — the same offset, the
 * same 111195 m/deg constant, the same sign convention — so that the field and the
 * pixel sampler are looking at the same two lines and A3's disagreement number
 * measures the shadow model rather than a difference in where each one stood.
 */
export function sidewalkOffsets(edge: EdgeRef): {
  left: [number, number];
  right: [number, number];
} {
  const latMid = (edge.from[1] + edge.to[1]) / 2;
  const cosLat = Math.max(1e-10, Math.cos((latMid * Math.PI) / 180));
  const dx = (edge.to[0] - edge.from[0]) * cosLat;
  const dy = edge.to[1] - edge.from[1];
  const len = Math.sqrt(dx * dx + dy * dy);

  if (len <= 1e-10) {
    return { left: [0, 0], right: [0, 0] };
  }

  const perpLng = (-dy / len) * (SIDEWALK_OFFSET_M / (SIDEWALK_M_PER_DEG * cosLat));
  const perpLat = (dx / len) * (SIDEWALK_OFFSET_M / SIDEWALK_M_PER_DEG);

  return { left: [perpLng, perpLat], right: [-perpLng, -perpLat] };
}

// ─── Providers ────────────────────────────────────────────────────────────────

/**
 * A provider over a fixed prism set covering a fixed area.
 *
 * Used by tests and by callers that already hold geometry (the agent's `check_shadow`
 * has the Overpass footprints in hand). The live tile and Overpass providers, with
 * their caches, land with A4 when routing switches over.
 */
export function staticPrismProvider(
  set: PrismSet,
  coverage: BBox,
  source: PrismProvider["source"]
): PrismProvider {
  return {
    source,
    prismsFor(bbox) {
      return bboxContains(coverage, bbox) ? set : null;
    },
  };
}

/**
 * A canopy provider over a fixed prism set covering a fixed area.
 *
 * The canopy twin of `staticPrismProvider`, and it ignores the date: a caller that
 * already holds crowns has already decided what season they are in. The live provider
 * — `createOverpassCanopyProvider` — is the one that has to care.
 */
export function staticCanopyProvider(set: PrismSet, coverage: BBox): CanopyProvider {
  return {
    source: "canopy",
    prismsFor(bbox) {
      return bboxContains(coverage, bbox) ? set : null;
    },
  };
}

/** True when `outer` fully contains `inner`. */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= inner.south &&
    outer.north >= inner.north
  );
}

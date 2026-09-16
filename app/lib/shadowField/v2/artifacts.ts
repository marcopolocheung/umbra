import type { ComposedTile } from "./compose";
import { composeCrown } from "./treeModel";
import { COMPONENT_FLAGS, type Component, type ComponentKind } from "./types";
import { SUPPORT_UNKNOWN } from "./support";

/**
 * Compact, browser-consumable generation artifacts (PR2). The ~47 MB detailed
 * manifest stays the audit root; these small immutable files answer startup
 * questions — which tiles exist, what they bound, under which licences —
 * without downloading it.
 */

// ---------------------------------------------------------------------------
// Budgets (decoded bytes). Enforced by producers and browser parsers alike.
// ---------------------------------------------------------------------------

/** 61,442 tiles as row runs measure in the low hundreds of kilobytes. */
export const MAX_COVERAGE_BYTES = 2 * 1024 * 1024;
/** Parallel-array leaf bounds plus z17..z10 reduction levels (see size note). */
export const MAX_BOUNDS_BYTES = 6 * 1024 * 1024;
/** Licence/source notices are small structured text. */
export const MAX_NOTICES_BYTES = 256 * 1024;
/** The generation root names four artifacts plus shared identity. */
export const MAX_GENERATION_ROOT_BYTES = 256 * 1024;

/** Canonical artifact bytes: JSON plus trailing newline, as written to R2. */
export function artifactBytes(body: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(body)}\n`);
}

export function assertArtifactBudget(name: string, bytes: number, max: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > max)
    throw new Error(`${name} is ${bytes} bytes, outside the 1..${max} budget`);
}

// ---------------------------------------------------------------------------
// z18 tile keys
// ---------------------------------------------------------------------------

export function parseZ18Tile(tile: string): { x: number; y: number } {
  const match = /^18\/(\d+)\/(\d+)$/.exec(tile);
  if (!match) throw new Error(`invalid z18 tile ${tile}`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error(`invalid z18 tile ${tile}`);
  return { x, y };
}

/** Canonical leaf order for bounds arrays: row-major (y, then x). */
export function sortTilesYX(tiles: readonly string[]): string[] {
  return [...tiles].sort((a, b) => {
    const left = parseZ18Tile(a);
    const right = parseZ18Tile(b);
    return left.y - right.y || left.x - right.x;
  });
}

// ---------------------------------------------------------------------------
// Coverage: exact tile membership as per-row x runs
// ---------------------------------------------------------------------------

export interface CoverageRow {
  y: number;
  /** Inclusive, sorted, non-overlapping x runs. */
  runs: Array<readonly [number, number]>;
}
export interface CoverageSet {
  rows: CoverageRow[];
  count: number;
}

export function tilesToCoverageSet(tiles: readonly string[]): CoverageSet {
  const byRow = new Map<number, number[]>();
  for (const tile of tiles) {
    const { x, y } = parseZ18Tile(tile);
    const row = byRow.get(y) ?? [];
    row.push(x);
    byRow.set(y, row);
  }
  const rows: CoverageRow[] = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, xs]) => {
      const ordered = [...new Set(xs)].sort((a, b) => a - b);
      if (ordered.length !== xs.length) throw new Error(`coverage set has a duplicate tile in row ${y}`);
      const runs: Array<[number, number]> = [];
      for (const x of ordered) {
        const last = runs.at(-1);
        if (last && x === last[1] + 1) last[1] = x;
        else runs.push([x, x]);
      }
      return { y, runs };
    });
  return { rows, count: tiles.length };
}

export function coverageSetToTiles(set: CoverageSet): string[] {
  const tiles: string[] = [];
  for (const row of set.rows) {
    for (const [start, end] of row.runs) {
      for (let x = start; x <= end; x++) tiles.push(`18/${x}/${row.y}`);
    }
  }
  return tiles;
}

export function coverageSetHas(set: CoverageSet, x: number, y: number): boolean {
  const row = set.rows.find((item) => item.y === y);
  if (!row) return false;
  return row.runs.some(([start, end]) => x >= start && x <= end);
}

export function coverageSetIsSubset(sub: CoverageSet, sup: CoverageSet): boolean {
  return coverageSetToTiles(sub).every((tile) => {
    const { x, y } = parseZ18Tile(tile);
    return coverageSetHas(sup, x, y);
  });
}

export interface CoverageIndex {
  version: 1;
  generation: string;
  /** Data availability: the exact packed tile set. */
  available: CoverageSet;
  /**
   * Five-borough activation footprint. A subset of availability derived by the
   * recorded rule — never silently equated with it.
   */
  activation: CoverageSet;
  activationRule: string;
  activationBoundary: { filename: string; sha256: string } | null;
  availableTileCount: number;
  activationTileCount: number;
}

export function buildCoverageIndex(args: {
  generation: string;
  availableTiles: readonly string[];
  activationTiles: readonly string[];
  activationRule: string;
  activationBoundary: { filename: string; sha256: string } | null;
}): CoverageIndex {
  const available = tilesToCoverageSet(args.availableTiles);
  const activation = tilesToCoverageSet(args.activationTiles);
  if (!coverageSetIsSubset(activation, available))
    throw new Error("activation footprint must be a subset of available tiles");
  if (available.count !== args.availableTiles.length || activation.count !== args.activationTiles.length)
    throw new Error("coverage index tile counts do not match their tile sets");
  return {
    version: 1,
    generation: args.generation,
    available,
    activation,
    activationRule: args.activationRule,
    activationBoundary: args.activationBoundary,
    availableTileCount: available.count,
    activationTileCount: activation.count,
  };
}

export type ArtifactBinding = string | { generation: string; bytesLength?: number };

function resolveBinding(
  binding: ArtifactBinding,
  bytesLength?: number,
): { generation: string; bytesLength?: number } {
  if (typeof binding === "string") return { generation: binding, bytesLength };
  if (!binding || typeof binding !== "object" || typeof (binding as { generation?: unknown }).generation !== "string")
    throw new Error("invalid artifact generation binding");
  const record = binding as { generation: string; bytesLength?: number };
  return { generation: record.generation, bytesLength: record.bytesLength ?? bytesLength };
}

function assertDecodedBudget(name: string, value: unknown, max: number, bytesLength?: number): void {
  if (bytesLength !== undefined) assertArtifactBudget(name, bytesLength, max);
  assertArtifactBudget(name, artifactBytes(value).byteLength, max);
}

function parseCoverageSet(field: string, value: unknown): CoverageSet {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid coverage ${field}`);
  const set = value as Record<string, unknown>;
  const rowsValue = set.rows;
  const countValue = set.count;
  if (!Array.isArray(rowsValue)) throw new Error(`invalid coverage ${field} rows`);
  if (typeof countValue !== "number" || !Number.isSafeInteger(countValue) || countValue < 0)
    throw new Error(`invalid coverage ${field} count`);
  let total = 0;
  let prevY = -1;
  const rows: CoverageRow[] = [];
  for (const entry of rowsValue) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`invalid coverage ${field} row`);
    const row = entry as Record<string, unknown>;
    if (typeof row.y !== "number" || !Number.isSafeInteger(row.y) || row.y < 0 || row.y >= 262144)
      throw new Error(`invalid coverage ${field} row y`);
    if (row.y <= prevY) throw new Error(`invalid coverage ${field} row order`);
    prevY = row.y;
    if (!Array.isArray(row.runs) || row.runs.length === 0) throw new Error(`invalid coverage ${field} runs`);
    const runs: Array<[number, number]> = [];
    let prevEnd = -2;
    for (const run of row.runs) {
      if (!Array.isArray(run) || run.length !== 2) throw new Error(`invalid coverage ${field} run`);
      const start = (run as unknown[])[0];
      const end = (run as unknown[])[1];
      if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end))
        throw new Error(`invalid coverage ${field} run bounds`);
      if (start < 0 || end < 0 || start >= 262144 || end >= 262144 || start > end)
        throw new Error(`invalid coverage ${field} run range`);
      if (start <= prevEnd + 1) throw new Error(`invalid coverage ${field} run order`);
      prevEnd = end;
      total += end - start + 1;
      runs.push([start, end]);
    }
    rows.push({ y: row.y, runs });
  }
  if (total !== countValue) throw new Error(`invalid coverage ${field} count mismatch`);
  return { rows, count: countValue };
}

export function parseCoverageIndex(
  value: unknown,
  binding: ArtifactBinding,
  bytesLength?: number,
): CoverageIndex {
  const resolved = resolveBinding(binding, bytesLength);
  assertDecodedBudget("coverage.json", value, MAX_COVERAGE_BYTES, resolved.bytesLength);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid coverage index");
  const index = value as Record<string, unknown>;
  if (index.version !== 1) throw new Error("invalid coverage index version");
  if (typeof index.generation !== "string" || index.generation !== resolved.generation)
    throw new Error("coverage generation mismatch");
  const available = parseCoverageSet("available", index.available);
  const activation = parseCoverageSet("activation", index.activation);
  if (
    typeof index.activationRule !== "string" ||
    index.activationRule.length === 0 ||
    index.activationRule.length > 1024
  )
    throw new Error("invalid coverage activationRule");
  let activationBoundary: CoverageIndex["activationBoundary"];
  if (index.activationBoundary === null) {
    activationBoundary = null;
  } else {
    if (!index.activationBoundary || typeof index.activationBoundary !== "object" || Array.isArray(index.activationBoundary))
      throw new Error("invalid coverage activationBoundary");
    const boundary = index.activationBoundary as Record<string, unknown>;
    if (typeof boundary.filename !== "string" || boundary.filename.length === 0)
      throw new Error("invalid coverage activationBoundary filename");
    if (typeof boundary.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(boundary.sha256))
      throw new Error("invalid coverage activationBoundary sha256");
    activationBoundary = { filename: boundary.filename, sha256: boundary.sha256 };
  }
  if (
    typeof index.availableTileCount !== "number" ||
    !Number.isSafeInteger(index.availableTileCount) ||
    index.availableTileCount <= 0
  )
    throw new Error("invalid coverage availableTileCount");
  if (
    typeof index.activationTileCount !== "number" ||
    !Number.isSafeInteger(index.activationTileCount) ||
    index.activationTileCount < 0
  )
    throw new Error("invalid coverage activationTileCount");
  const availableTileCount = index.availableTileCount as number;
  const activationTileCount = index.activationTileCount as number;
  if (available.count !== availableTileCount) throw new Error("coverage availableTileCount mismatch");
  if (activation.count !== activationTileCount) throw new Error("coverage activationTileCount mismatch");
  if (coverageSetToTiles(available).length !== availableTileCount)
    throw new Error("coverage availableTileCount mismatch");
  if (coverageSetToTiles(activation).length !== activationTileCount)
    throw new Error("coverage activationTileCount mismatch");
  if (activationTileCount > availableTileCount)
    throw new Error("coverage activationTileCount exceeds availableTileCount");
  if (!coverageSetIsSubset(activation, available))
    throw new Error("coverage activation footprint must be a subset of available tiles");
  const canonical = buildCoverageIndex({
    generation: resolved.generation,
    availableTiles: coverageSetToTiles(available),
    activationTiles: coverageSetToTiles(activation),
    activationRule: index.activationRule as string,
    activationBoundary,
  });
  if (JSON.stringify(canonical.available) !== JSON.stringify(available))
    throw new Error("coverage available is not canonical");
  if (JSON.stringify(canonical.activation) !== JSON.stringify(activation))
    throw new Error("coverage activation is not canonical");
  return canonical;
}

// ---------------------------------------------------------------------------
// Bounds: per-component leaf bounds plus a reduced hierarchy (PR4 input)
// ---------------------------------------------------------------------------

/**
 * Leaf coverage class: 0 is fully known, 1 is partially unknown, 2 is fully
 * unknown. Outside the coverage index is unknown by definition.
 */
export type CoverageClass = 0 | 1 | 2;

export interface ReducedBounds {
  minG: number;
  maxG: number;
  maxTopQ: number;
  maxCrownQ: number;
  coverage: CoverageClass;
}

export interface LeafBoundsArrays {
  minG: number[];
  maxG: number[];
  maxTopQ: number[];
  maxCrownQ: number[];
  coverage: CoverageClass[];
}

export interface BoundsLevel {
  z: number;
  x: number[];
  y: number[];
  minG: number[];
  maxG: number[];
  maxTopQ: number[];
  maxCrownQ: number[];
  coverage: CoverageClass[];
}

export interface TileBoundsArtifact {
  version: 1;
  generation: string;
  /** Leaf arrays align with coverage-available tiles in (y, x) order. */
  tileOrder: "y-x";
  tileCount: number;
  leaf: LeafBoundsArrays;
  /** Reduced from z17 down to z10; min of mins, max of maxs (exact Q64 ints). */
  levels: BoundsLevel[];
  /** Tiles deliberately withheld from composition pending the PR4 buried-roof policy. */
  anomalies: Array<{ tile: string; reason: string }>;
}

/** Validate the compact bounds payload before it is used for acquisition
 * planning.  Its parallel arrays are intentionally checked as arrays (rather
 * than coerced typed arrays) because this is a browser JSON boundary. */
export function parseTileBoundsArtifact(
  value: unknown,
  binding: ArtifactBinding,
  expectedTileCount?: number,
  bytesLength?: number,
): TileBoundsArtifact {
  const resolved = resolveBinding(binding, bytesLength);
  assertDecodedBudget("bounds.json", value, MAX_BOUNDS_BYTES, resolved.bytesLength);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid bounds artifact");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.generation !== resolved.generation || item.tileOrder !== "y-x")
    throw new Error("invalid bounds artifact identity");
  if (!Number.isSafeInteger(item.tileCount) || (item.tileCount as number) <= 0 ||
      (expectedTileCount !== undefined && item.tileCount !== expectedTileCount))
    throw new Error("invalid bounds artifact tileCount");
  const parseArrays = (candidate: unknown, label: string, count?: number): LeafBoundsArrays & { x?: number[]; y?: number[]; z?: number } => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`invalid bounds ${label}`);
    const entry = candidate as Record<string, unknown>;
    const numeric = (name: string, predicate: (n: number) => boolean = Number.isSafeInteger) => {
      const values = entry[name];
      if (!Array.isArray(values) || (count !== undefined && values.length !== count) || !values.every((n) => typeof n === "number" && predicate(n)))
        throw new Error(`invalid bounds ${label}.${name}`);
      return values as number[];
    };
    const minG = numeric("minG"); const maxG = numeric("maxG");
    const maxTopQ = numeric("maxTopQ", (n) => Number.isSafeInteger(n) && n >= 0);
    const maxCrownQ = numeric("maxCrownQ", (n) => Number.isSafeInteger(n) && n >= 0);
    const coverage = numeric("coverage", (n) => n === 0 || n === 1 || n === 2) as CoverageClass[];
    const length = minG.length;
    if (!maxG.every((n, i) => n >= minG[i]) || [maxTopQ, maxCrownQ, coverage].some((array) => array.length !== length))
      throw new Error(`invalid bounds ${label} ranges`);
    return { minG, maxG, maxTopQ, maxCrownQ, coverage };
  };
  const leaf = parseArrays(item.leaf, "leaf", item.tileCount as number);
  if (!Array.isArray(item.levels) || item.levels.length !== 8) throw new Error("invalid bounds levels");
  const levels: BoundsLevel[] = item.levels.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid bounds level");
    const raw = candidate as Record<string, unknown>;
    const z = 17 - index;
    if (raw.z !== z || !Array.isArray(raw.x) || !Array.isArray(raw.y) || raw.x.length !== raw.y.length || raw.x.length === 0 ||
      !raw.x.every(Number.isSafeInteger) || !raw.y.every(Number.isSafeInteger)) throw new Error("invalid bounds level coordinates");
    const arrays = parseArrays(raw, `level-${z}`, raw.x.length);
    const x = raw.x as number[]; const y = raw.y as number[];
    for (let i = 0; i < x.length; i++) if (x[i] < 0 || y[i] < 0 || (i && (y[i] < y[i - 1] || (y[i] === y[i - 1] && x[i] <= x[i - 1]))))
      throw new Error("invalid bounds level order");
    return { z, x, y, ...arrays };
  });
  const anomaliesRaw = item.anomalies ?? [];
  if (!Array.isArray(anomaliesRaw)) throw new Error("invalid bounds anomalies");
  const anomalies = anomaliesRaw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid bounds anomaly");
    const anomaly = entry as Record<string, unknown>;
    if (typeof anomaly.tile !== "string" || !/^18\/\d+\/\d+$/.test(anomaly.tile) || anomaly.reason !== ROOF_BELOW_TERRAIN_ANOMALY)
      throw new Error("invalid bounds anomaly");
    return { tile: anomaly.tile, reason: anomaly.reason as string };
  });
  if (anomalies.some((entry, index) => index && entry.tile <= anomalies[index - 1].tile) || anomalies.some((entry) => !Number.isSafeInteger(parseZ18Tile(entry.tile).x)))
    throw new Error("invalid bounds anomaly order");
  return { version: 1, generation: resolved.generation, tileOrder: "y-x", tileCount: item.tileCount as number, leaf, levels, anomalies };
}

/**
 * Reduce one repaired, composed tile. Bounds derive from the composed tile —
 * never from pre-composition planes — so they cannot drift from composition
 * semantics. maxTopQ/maxCrownQ gate on presence flags; absent features read 0.
 */
export function reduceComposedTile(composed: ComposedTile): ReducedBounds {
  const cells = composed.groundQ.length;
  let minG = Infinity;
  let maxG = -Infinity;
  let maxTopQ = 0;
  let maxCrownQ = 0;
  let unknownCells = 0;
  for (let index = 0; index < cells; index++) {
    const ground = composed.groundQ[index];
    if (ground < minG) minG = ground;
    if (ground > maxG) maxG = ground;
    if (composed.flagsAndMaterial[index] & COMPONENT_FLAGS.buildingPresent) {
      if (composed.buildingTopQ[index] > maxTopQ) maxTopQ = composed.buildingTopQ[index];
    }
    if (composed.flagsAndMaterial[index] & COMPONENT_FLAGS.canopyPresent) {
      if (composed.crownTopQ[index] > maxCrownQ) maxCrownQ = composed.crownTopQ[index];
    }
    if (
      composed.flagsAndMaterial[index] &
      (COMPONENT_FLAGS.buildingUnknown | COMPONENT_FLAGS.canopyUnknown)
    ) {
      unknownCells++;
    }
  }
  if (!Number.isFinite(minG) || !Number.isFinite(maxG)) throw new Error("composed tile has no ground cells");
  return {
    minG,
    maxG,
    maxTopQ,
    maxCrownQ,
    coverage: unknownCells === 0 ? 0 : unknownCells >= cells ? 2 : 1,
  };
}

function signedPlane(words: Uint32Array | undefined, index: number): number {
  return words?.[index] === undefined ? 0 : words[index] | 0;
}

/**
 * Conservative bounds fallback for tiles the shared composer rejects —
 * currently whole-feature foundations on steep real terrain, where a stored
 * roof can sit up to ~1 m below the local ground cell (observed in staged v1
 * tiles 18/77196/98516 and 18/77196/98517). Decisions mirror `composeTile`
 * exactly (same foundation base rule, same presence flags, same crown model)
 * except the roof-below-terrain throw: the raw stored roof still bounds the
 * stored geometry from above, so maxTopQ stays conservative for acquisition
 * planning. Callers must record `ROOF_BELOW_TERRAIN_ANOMALY` operationally;
 * the anomaly list is what tells PR4 which tiles need a buried-roof policy.
 */
export const ROOF_BELOW_TERRAIN_ANOMALY = "roof-below-terrain";

export function reduceConservativeBounds(
  terrain: Component | undefined,
  buildings: Component | undefined,
  canopy: Component | undefined,
): ReducedBounds {
  const cells = STORED_CELLS * STORED_CELLS;
  const plane = (component: Component | undefined, name: string): Uint32Array | undefined =>
    component?.planes.find((item) => item.name === name)?.words;
  const ground = plane(terrain, "groundQ");
  if (!ground) throw new Error("bounds fallback needs the terrain ground plane");
  const foundation = plane(terrain, "foundationQ");
  const foundationPresent = plane(terrain, "foundationPresent");
  const buildingAgl = plane(buildings, "buildingAglQ");
  const buildingMask = plane(buildings, "buildingMask");
  const buildingSupport = plane(buildings, "buildingSupport");
  const canopySupport = plane(canopy, "canopySupport");
  let minG = Infinity;
  let maxG = -Infinity;
  let maxTopQ = 0;
  let maxCrownQ = 0;
  let unknownCells = 0;
  for (let index = 0; index < cells; index++) {
    const groundQ = ground[index] | 0;
    if (groundQ < minG) minG = groundQ;
    if (groundQ > maxG) maxG = groundQ;
    if (buildingSupport?.[index] === SUPPORT_UNKNOWN || canopySupport?.[index] === SUPPORT_UNKNOWN)
      unknownCells++;
    const hasBuilding = buildingMask ? buildingMask[index] !== 0 : signedPlane(buildingAgl, index) !== 0;
    let roofQ = 0;
    if (hasBuilding) {
      const base = foundationPresent
        ? foundationPresent[index]
          ? signedPlane(foundation, index)
          : groundQ
        : foundation
          ? signedPlane(foundation, index)
          : groundQ;
      roofQ = base + signedPlane(buildingAgl, index);
      if (roofQ > maxTopQ) maxTopQ = roofQ;
    }
    const crown = composeCrown(index, canopy, groundQ, roofQ);
    if (crown && crown.topQ > maxCrownQ) maxCrownQ = crown.topQ;
  }
  if (!Number.isFinite(minG) || !Number.isFinite(maxG)) throw new Error("bounds fallback found no ground cells");
  return {
    minG,
    maxG,
    maxTopQ,
    maxCrownQ,
    coverage: unknownCells === 0 ? 0 : unknownCells >= cells ? 2 : 1,
  };
}

interface LevelChild extends ReducedBounds {
  x: number;
  y: number;
}

/**
 * Reduce one hierarchy level from its children. A missing child (outside
 * availability) counts as unknown; min/max range over available children and
 * coverage flags the gap, so a reduced parent can never certify more than its
 * children prove.
 */
export function reduceBoundsLevel(
  z: number,
  children: ReadonlyMap<string, LevelChild>,
  parents: ReadonlyArray<{ x: number; y: number }>,
): BoundsLevel {
  const level: BoundsLevel = { z, x: [], y: [], minG: [], maxG: [], maxTopQ: [], maxCrownQ: [], coverage: [] };
  for (const parent of parents) {
    let minG = Infinity;
    let maxG = -Infinity;
    let maxTopQ = 0;
    let maxCrownQ = 0;
    let coverage: CoverageClass = 0;
    let present = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const child = children.get(`${parent.x * 2 + dx}/${parent.y * 2 + dy}`);
        if (!child) {
          coverage = 2;
          continue;
        }
        present++;
        if (child.minG < minG) minG = child.minG;
        if (child.maxG > maxG) maxG = child.maxG;
        if (child.maxTopQ > maxTopQ) maxTopQ = child.maxTopQ;
        if (child.maxCrownQ > maxCrownQ) maxCrownQ = child.maxCrownQ;
        if (child.coverage === 2) coverage = 2;
        else if (child.coverage === 1 && coverage === 0) coverage = 1;
      }
    }
    // A parent with no available child carries no range; it stays fully unknown.
    if (present === 0) {
      minG = 0;
      maxG = 0;
      coverage = 2;
    }
    level.x.push(parent.x);
    level.y.push(parent.y);
    level.minG.push(minG);
    level.maxG.push(maxG);
    level.maxTopQ.push(maxTopQ);
    level.maxCrownQ.push(maxCrownQ);
    level.coverage.push(coverage);
  }
  return level;
}

/** Lowest hierarchy zoom retained for PR4 broad acquisition planning. */
export const BOUNDS_MIN_ZOOM = 10;

/** Assemble the full pyramid from leaf bounds keyed by tile. */
export function assembleTileBounds(
  generation: string,
  leafByTile: ReadonlyMap<string, ReducedBounds>,
  anomalies: ReadonlyArray<{ tile: string; reason: string }> = [],
): TileBoundsArtifact {
  const ordered = sortTilesYX([...leafByTile.keys()]);
  if (ordered.length !== leafByTile.size) throw new Error("bounds leaf tiles are not unique");
  const count = ordered.length;
  if (count === 0) throw new Error("bounds assembly needs at least one leaf tile");
  const leaf: LeafBoundsArrays = { minG: [], maxG: [], maxTopQ: [], maxCrownQ: [], coverage: [] };
  const levels: BoundsLevel[] = [];
  let children = new Map<string, LevelChild>();
  for (const tile of ordered) {
    const entry = leafByTile.get(tile);
    if (!entry) throw new Error(`bounds assembly lacks tile ${tile}`);
    const { x, y } = parseZ18Tile(tile);
    leaf.minG.push(entry.minG);
    leaf.maxG.push(entry.maxG);
    leaf.maxTopQ.push(entry.maxTopQ);
    leaf.maxCrownQ.push(entry.maxCrownQ);
    leaf.coverage.push(entry.coverage);
    children.set(`${x}/${y}`, { x, y, ...entry });
  }
  for (let z = 17; z >= BOUNDS_MIN_ZOOM; z--) {
    const parents = sortTilesYX(
      [...new Set([...children.keys()].map((key) => {
        const [x, y] = key.split("/").map(Number);
        return `18/${Math.floor(x / 2)}/${Math.floor(y / 2)}`;
      }))],
    ).map((tile) => {
      const { x, y } = parseZ18Tile(tile);
      return { x, y };
    });
    const level = reduceBoundsLevel(z, children, parents);
    levels.push(level);
    children = new Map<string, LevelChild>();
    level.x.forEach((x, index) => {
      children.set(`${x}/${level.y[index]}`, {
        x,
        y: level.y[index],
        minG: level.minG[index],
        maxG: level.maxG[index],
        maxTopQ: level.maxTopQ[index],
        maxCrownQ: level.maxCrownQ[index],
        coverage: level.coverage[index],
      });
    });
  }
  const canonicalAnomalies = [...anomalies].sort((a, b) => a.tile.localeCompare(b.tile));
  if (canonicalAnomalies.some((entry, index) => !leafByTile.has(entry.tile) || entry.reason !== ROOF_BELOW_TERRAIN_ANOMALY || (index && entry.tile === canonicalAnomalies[index - 1].tile)))
    throw new Error("bounds anomalies must be unique available buried-roof tiles");
  return { version: 1, generation, tileOrder: "y-x", tileCount: count, leaf, levels, anomalies: canonicalAnomalies };
}

// ---------------------------------------------------------------------------
// Notices: attribution and licence bindings
// ---------------------------------------------------------------------------

export interface RegionLicenceSource {
  id: string;
  kind: string;
  licence: string;
  url: string;
  /** Rights URL copied from the admitted receipt; never substituted from region defaults. */
  rights?: string;
  role?: string;
  assets?: Array<{ filename: string; sha256: string; publisherUrl: string; release: string }>;
}

export interface RegionLicenceInput {
  boundaryLicence: string;
  boundaryUrl: string;
  boundaryRelease: string;
  sources: RegionLicenceSource[];
  regionFileSha256: string;
  /** Hash of the admitted source-receipts/acquisition manifest that supplied sources. */
  receiptManifestSha256?: string;
  /** Installed grids from the admitted datum manifest, with their pinned bytes. */
  datumGrids?: Array<{ name: string; sha256: string }>;
}

export interface NoticesLicence {
  id: string;
  notice: string;
  url?: string;
  appliesTo: ComponentKind[];
}

/**
 * Canonical licence records per component kind, derived from the pinned
 * region file. Both the packer (licenceHash) and the notices builder consume
 * this one function, so the hash and the published notice cannot diverge.
 */
export function licenceRecordsFor(kind: ComponentKind, input: RegionLicenceInput): NoticesLicence[] {
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const record = (id: string, aliases: string[], appliesTo: ComponentKind[], notice: string): NoticesLicence => {
    const source = byId.get(id) ?? aliases.map((alias) => byId.get(alias)).find(Boolean);
    if (!source) throw new Error(`region file lacks source ${id}`);
    return { id: source.id, notice, url: (source.rights ?? source.url) || undefined, appliesTo };
  };
  switch (kind) {
    case "terrain":
      return [
        record("fabdem-v1.2", [],
          ["terrain"],
          "FABDEM V1.2-derived terrain (FABDEM contributors), CC BY-NC-SA 4.0. Modified by EGM2008-to-EGM96 datum conversion using the admitted NGA grids, resampling to the shadow lattice, Q64 quantization, and z18 tile/gutter packaging. Attribution, modification notice, ShareAlike and non-commercial terms apply; commercial use requires separate permission.",
        ),
        ...(input.datumGrids ?? []).map((grid) => ({
          id: `nga-grid-${grid.name}`,
          notice: `NGA geoid grid ${grid.name} (SHA-256 ${grid.sha256}) was installed and used for the admitted EGM2008-to-EGM96 datum conversion; retain the grid provenance with terrain derivatives.`,
          appliesTo: ["terrain"] as ComponentKind[],
        })),
      ];
    case "buildings":
      return [
        record("overture-buildings", [],
          ["buildings"],
          "Building footprints and heights derived from admitted Overture Maps building records, ODbL 1.0; derivative-database attribution and share-alike duties apply.",
        ),
        ...(byId.has("overture-building-parts") ? [record("overture-building-parts", [], ["buildings"], "Building-part footprints and heights derived from admitted Overture Maps building_part records, ODbL 1.0; derivative-database attribution and share-alike duties apply.")] : []),
      ];
    case "canopy":
      return [
        record("chmv2-height", ["chmv2-native"],
          ["canopy"],
          "Canopy heights derived from the admitted Meta/WRI Canopy Height Model v2 under CC BY 4.0. Contains modified Copernicus Sentinel-2 data © European Union and Vantor imagery © Vantor; retain this CHMv2 imagery attribution with the derivative.",
        ),
        ...(byId.has("chmv2-validity-mask") ? [record("chmv2-validity-mask", [], ["canopy"], "CHMv2 authoritative availability/validity mask admitted with the native height assets; valid numeric zero is retained and unavailable/nodata cells alone may use fallback.")] : []),
        record("osm-tree-fallback", [], ["canopy"],
          "Fallback tree heights from admitted OpenStreetMap contributors data, ODbL 1.0, used only where CHMv2 is unavailable or nodata.",
        ),
      ];
  }
}

/** Stable binding string a packer hashes into the component licenceHash. */
export function canonicalLicenceBinding(kind: ComponentKind, input: RegionLicenceInput): string {
  return JSON.stringify({ kind, licences: licenceRecordsFor(kind, input) });
}

export interface GenerationNotices {
  version: 1;
  generation: string;
  /** Personal, non-commercial project framing carried with the generation. */
  projectUse: string;
  boundary: { licence: string; url: string; release: string };
  sources: RegionLicenceSource[];
  licences: NoticesLicence[];
  licenceBindings: Record<ComponentKind, string>;
  licenceHashes: Record<ComponentKind, string>;
  regionFileSha256: string;
  receiptManifestSha256?: string;
  datumGrids?: Array<{ name: string; sha256: string }>;
}

export const PROJECT_USE_NOTICE =
  "Umbra is a personal, non-commercial open-source project. FABDEM-derived terrain in this generation may be shared for noncommercial purposes under CC BY-NC-SA 4.0, with required attribution, modification notices, and ShareAlike terms. Commercial use (including ads, paid access, or distribution to customers) requires separate permission from the FABDEM rights holders.";

export function buildNotices(args: {
  generation: string;
  input: RegionLicenceInput;
  licenceHashes: Record<ComponentKind, string>;
}): GenerationNotices {
  const kinds: ComponentKind[] = ["terrain", "buildings", "canopy"];
  const licences = kinds.flatMap((kind) => licenceRecordsFor(kind, args.input));
  if (new Set(licences.map((entry) => entry.id)).size !== licences.length)
    throw new Error("duplicate licence record");
  return {
    version: 1,
    generation: args.generation,
    projectUse: PROJECT_USE_NOTICE,
    boundary: {
      licence: args.input.boundaryLicence,
      url: args.input.boundaryUrl,
      release: args.input.boundaryRelease,
    },
    sources: args.input.sources,
    licences,
    licenceBindings: {
      terrain: canonicalLicenceBinding("terrain", args.input),
      buildings: canonicalLicenceBinding("buildings", args.input),
      canopy: canonicalLicenceBinding("canopy", args.input),
    },
    licenceHashes: args.licenceHashes,
    regionFileSha256: args.input.regionFileSha256,
    ...(args.input.receiptManifestSha256 ? { receiptManifestSha256: args.input.receiptManifestSha256 } : {}),
    ...(args.input.datumGrids ? { datumGrids: args.input.datumGrids } : {}),
  };
}

/** Strict parser for the notice payload fetched by the browser.  Notice text is
 * data, but its source identifiers, rights URLs, receipt pins, and component
 * bindings are security-relevant because they are what the component hashes
 * claim to bind. */
export function parseGenerationNotices(
  value: unknown,
  binding: ArtifactBinding,
  bytesLength?: number,
): GenerationNotices {
  const resolved = resolveBinding(binding, bytesLength);
  assertDecodedBudget("notices.json", value, MAX_NOTICES_BYTES, resolved.bytesLength);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid generation notices");
  const notices = value as Record<string, unknown>;
  const text = (field: string, max = 16_384) => {
    const result = notices[field];
    if (typeof result !== "string" || result.length === 0 || result.length > max) throw new Error(`invalid notices ${field}`);
    return result;
  };
  if (notices.version !== 1 || notices.generation !== resolved.generation) throw new Error("invalid notices identity");
  const boundaryRaw = notices.boundary as Record<string, unknown>;
  if (!boundaryRaw || typeof boundaryRaw !== "object" || Array.isArray(boundaryRaw) ||
      ![boundaryRaw.licence, boundaryRaw.url, boundaryRaw.release].every((v) => typeof v === "string" && v.length > 0))
    throw new Error("invalid notices boundary");
  const parseSource = (source: unknown): RegionLicenceSource => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid notices source");
    const item = source as Record<string, unknown>;
    if (![item.id, item.kind, item.licence, item.url].every((v) => typeof v === "string" && v.length > 0)) throw new Error("invalid notices source");
    if (item.rights !== undefined && (typeof item.rights !== "string" || item.rights.length === 0)) throw new Error("invalid notices source rights");
    if (item.role !== undefined && (typeof item.role !== "string" || item.role.length === 0)) throw new Error("invalid notices source role");
    const assets = item.assets === undefined ? undefined : (() => {
      if (!Array.isArray(item.assets) || !item.assets.length) throw new Error("invalid notices source assets");
      return item.assets.map((asset) => {
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw new Error("invalid notices asset");
        const a = asset as Record<string, unknown>;
        if (![a.filename, a.sha256, a.publisherUrl, a.release].every((v) => typeof v === "string" && v.length > 0) || !sha256Pattern.test(a.sha256 as string)) throw new Error("invalid notices asset");
        return { filename: a.filename as string, sha256: a.sha256 as string, publisherUrl: a.publisherUrl as string, release: a.release as string };
      });
    })();
    return { id: item.id as string, kind: item.kind as string, licence: item.licence as string, url: item.url as string, ...(item.rights ? { rights: item.rights as string } : {}), ...(item.role ? { role: item.role as string } : {}), ...(assets ? { assets } : {}) };
  };
  if (!Array.isArray(notices.sources) || !notices.sources.length) throw new Error("invalid notices sources");
  const sources = notices.sources.map(parseSource);
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("duplicate notices source");
  const hashes = notices.licenceHashes as Record<string, unknown>;
  const bindings = notices.licenceBindings as Record<string, unknown>;
  const kinds: ComponentKind[] = ["terrain", "buildings", "canopy"];
  for (const kind of kinds) if (!sha256Pattern.test(hashes?.[kind] as string) || typeof bindings?.[kind] !== "string" || !(bindings[kind] as string).length)
    throw new Error("invalid notices licence bindings");
  if (typeof notices.regionFileSha256 !== "string" || !sha256Pattern.test(notices.regionFileSha256)) throw new Error("invalid notices region pin");
  if (notices.receiptManifestSha256 !== undefined && (typeof notices.receiptManifestSha256 !== "string" || !sha256Pattern.test(notices.receiptManifestSha256))) throw new Error("invalid notices receipt pin");
  const datumGrids = notices.datumGrids === undefined ? undefined : (() => {
    if (!Array.isArray(notices.datumGrids) || !notices.datumGrids.length) throw new Error("invalid notices datum grids");
    return notices.datumGrids.map((grid) => {
      if (!grid || typeof grid !== "object" || Array.isArray(grid)) throw new Error("invalid notices datum grid");
      const item = grid as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name || typeof item.sha256 !== "string" || !sha256Pattern.test(item.sha256)) throw new Error("invalid notices datum grid");
      return { name: item.name, sha256: item.sha256 };
    });
  })();
  const licences = notices.licences;
  if (!Array.isArray(licences) || !licences.length) throw new Error("invalid notices licences");
  for (const licence of licences) {
    if (!licence || typeof licence !== "object" || Array.isArray(licence)) throw new Error("invalid notice licence");
    const item = licence as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || typeof item.notice !== "string" || !item.notice || !Array.isArray(item.appliesTo) || !item.appliesTo.length || !item.appliesTo.every((kind) => kinds.includes(kind as ComponentKind))) throw new Error("invalid notice licence");
  }
  return { version: 1, generation: resolved.generation, projectUse: text("projectUse"), boundary: { licence: boundaryRaw.licence as string, url: boundaryRaw.url as string, release: boundaryRaw.release as string }, sources, licences: licences as NoticesLicence[], licenceBindings: bindings as Record<ComponentKind, string>, licenceHashes: hashes as Record<ComponentKind, string>, regionFileSha256: notices.regionFileSha256, ...(notices.receiptManifestSha256 ? { receiptManifestSha256: notices.receiptManifestSha256 as string } : {}), ...(datumGrids ? { datumGrids } : {}) };
}

// ---------------------------------------------------------------------------
// Generation root: the one immutable document the pointer names
// ---------------------------------------------------------------------------

export interface ArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface GenerationIdentity {
  recipeHash: string;
  datumHash: string;
  hierarchyHash: string;
  normalizerHash: string;
  compositorHash: string;
  treeModelHash: string;
  receiverHash: string;
}

export interface GenerationRoot {
  version: 1;
  generation: string;
  identity: GenerationIdentity;
  artifacts: {
    manifest: ArtifactRef;
    coverage: ArtifactRef;
    bounds: ArtifactRef;
    notices: ArtifactRef;
  };
  tilePathTemplate: string;
  tileCount: number;
  availableTileCount: number;
  activationTileCount: number;
  maxDecodedBytes: {
    coverage: number;
    bounds: number;
    notices: number;
  };
}

const generationPattern = /^nyc-[a-f0-9]{32}(?:-[a-z0-9-]{1,48})?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function artifactRef(generation: string, value: unknown, filename: string, maxBytes: number): ArtifactRef {
  const ref = (value ?? {}) as Partial<ArtifactRef>;
  if (
    ref.path !== `/_shadow/generations/${generation}/${filename}` ||
    typeof ref.sha256 !== "string" ||
    !sha256Pattern.test(ref.sha256) ||
    typeof ref.bytes !== "number" ||
    !Number.isInteger(ref.bytes) ||
    ref.bytes <= 0 ||
    ref.bytes > maxBytes
  )
    throw new Error(`invalid generation root ${filename} reference`);
  return { path: ref.path, sha256: ref.sha256, bytes: ref.bytes };
}

/** Strict generation-root parser: exact paths, hashes, budgets, one identity. */
export function parseGenerationRoot(value: unknown): GenerationRoot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid NYC shadow generation root");
  const root = value as Record<string, unknown>;
  const generation = root.generation;
  if (root.version !== 1 || typeof generation !== "string" || !generationPattern.test(generation))
    throw new Error("invalid NYC shadow generation root");
  const identity = (root.identity ?? {}) as Partial<GenerationIdentity>;
  for (const field of [
    "recipeHash",
    "datumHash",
    "hierarchyHash",
    "normalizerHash",
    "compositorHash",
    "treeModelHash",
    "receiverHash",
  ] as const) {
    if (typeof identity[field] !== "string" || !sha256Pattern.test(identity[field]!))
      throw new Error(`invalid generation root ${field}`);
  }
  const artifacts = (root.artifacts ?? {}) as Record<string, unknown>;
  const manifest = artifactRef(generation, artifacts.manifest, "manifest.json", 256 * 1024 * 1024);
  const coverage = artifactRef(generation, artifacts.coverage, "coverage.json", MAX_COVERAGE_BYTES);
  const bounds = artifactRef(generation, artifacts.bounds, "bounds.json", MAX_BOUNDS_BYTES);
  const notices = artifactRef(generation, artifacts.notices, "notices.json", MAX_NOTICES_BYTES);
  if (
    typeof root.tilePathTemplate !== "string" ||
    root.tilePathTemplate !== `/_shadow/generations/${generation}/tiles/{z}-{x}-{y}.smb`
  )
    throw new Error("invalid generation root tile template");
  for (const field of ["tileCount", "availableTileCount", "activationTileCount"] as const) {
    if (typeof root[field] !== "number" || !Number.isInteger(root[field]) || (root[field] as number) < 0 ||
      (field !== "activationTileCount" && (root[field] as number) === 0))
      throw new Error(`invalid generation root ${field}`);
  }
  if (root.availableTileCount !== root.tileCount || (root.activationTileCount as number) > (root.availableTileCount as number))
    throw new Error("invalid generation root tile-count relationships");
  const budgets = (root.maxDecodedBytes ?? {}) as Record<string, unknown>;
  for (const [field, max] of [
    ["coverage", MAX_COVERAGE_BYTES],
    ["bounds", MAX_BOUNDS_BYTES],
    ["notices", MAX_NOTICES_BYTES],
  ] as const) {
    if (budgets[field] !== max) throw new Error(`invalid generation root ${field} budget`);
  }
  return {
    version: 1,
    generation,
    identity: identity as GenerationIdentity,
    artifacts: { manifest, coverage, bounds, notices },
    tilePathTemplate: root.tilePathTemplate as string,
    tileCount: root.tileCount as number,
    availableTileCount: root.availableTileCount as number,
    activationTileCount: root.activationTileCount as number,
    maxDecodedBytes: { coverage: MAX_COVERAGE_BYTES, bounds: MAX_BOUNDS_BYTES, notices: MAX_NOTICES_BYTES },
  };
}

// ---------------------------------------------------------------------------
// Coverage geometry: point-in-polygon and tile classification in lon/lat
// ---------------------------------------------------------------------------

/**
 * Structural lon/lat polygon coverage. Server `PolygonalCoverage` is
 * assignable; this module stays free of node-only imports.
 */
export interface CoverageGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

export interface LonLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const Z18_N = 1 << 18;
function latitudeOf(mercatorY: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180) / Math.PI;
}

/**
 * Logical z18 tile bounds in lon/lat. Canonical projection duplicated from
 * `server/shadow-prep/src/tiles.ts` (gutter cells included on request).
 */
export function tileBoundsLonLat(x: number, y: number, gutterCells = 0): LonLatBounds {
  return {
    west: ((x - gutterCells / 256) / Z18_N) * 360 - 180,
    east: ((x + 1 + gutterCells / 256) / Z18_N) * 360 - 180,
    north: latitudeOf((y - gutterCells / 256) / Z18_N),
    south: latitudeOf((y + 1 + gutterCells / 256) / Z18_N),
  };
}

/** Stored-cell center lon/lat, gutter-aware like the canonical tile lattice. */
export function tileCellLonLatZ18(
  x: number,
  y: number,
  storedX: number,
  storedY: number,
): readonly [number, number] {
  return [
    (((x + (storedX - 0.5) / 256) / Z18_N) * 360 - 180) as number,
    latitudeOf((y + (storedY - 0.5) / 256) / Z18_N),
  ];
}

function coverageRings(geometry: CoverageGeometry): number[][][] {
  const rings =
    geometry.type === "Polygon"
      ? (geometry.coordinates as number[][][])
      : (geometry.coordinates as number[][][][]).flat();
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("coverage geometry has a degenerate ring");
    for (const point of ring) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
        throw new Error("coverage geometry has a non-finite coordinate");
    }
  }
  return rings;
}

/**
 * Closed-coverage point test: a point on an edge counts as covered, matching
 * the admission-time vertex proof. Even-odd fill over all rings handles holes.
 */
export function coverageContainsPoint(geometry: CoverageGeometry, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of coverageRings(geometry)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const cross = (lon - a[0]) * dy - (lat - a[1]) * dx;
      const dot = (lon - a[0]) * (lon - b[0]) + (lat - a[1]) * (lat - b[1]);
      if (Math.abs(cross) <= 1e-12 && dot <= 1e-18) return true;
      if (a[1] > lat !== b[1] > lat && lon < (dx * (lat - a[1])) / dy + a[0]) inside = !inside;
    }
  }
  return inside;
}

function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bounds: LonLatBounds,
): boolean {
  if (x1 >= bounds.west && x1 <= bounds.east && y1 >= bounds.south && y1 <= bounds.north) return true;
  if (x2 >= bounds.west && x2 <= bounds.east && y2 >= bounds.south && y2 <= bounds.north) return true;
  const orientation = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  const corners: Array<readonly [number, number, number, number]> = [
    [bounds.west, bounds.south, bounds.east, bounds.south],
    [bounds.east, bounds.south, bounds.east, bounds.north],
    [bounds.east, bounds.north, bounds.west, bounds.north],
    [bounds.west, bounds.north, bounds.west, bounds.south],
  ];
  return corners.some(([cx1, cy1, cx2, cy2]) => {
    const d1 = orientation(cx1, cy1, cx2, cy2, x1, y1);
    const d2 = orientation(cx1, cy1, cx2, cy2, x2, y2);
    const d3 = orientation(x1, y1, x2, y2, cx1, cy1);
    const d4 = orientation(x1, y1, x2, y2, cx2, cy2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  });
}

/**
 * Logical tile area intersects the coverage polygon: any corner covered, or
 * any polygon edge crossing the tile rect. Used for the borough activation
 * clip. Gutter cells are excluded — activation is about tile area, while
 * per-cell support (below) includes the gutter.
 */
export function tileIntersectsCoverage(geometry: CoverageGeometry, x: number, y: number): boolean {
  const bounds = tileBoundsLonLat(x, y, 0);
  const corners: Array<readonly [number, number]> = [
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
  ];
  if (corners.some(([lon, lat]) => coverageContainsPoint(geometry, lon, lat))) return true;
  for (const ring of coverageRings(geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      if (segmentIntersectsRect(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], bounds))
        return true;
    }
  }
  return false;
}

export const STORED_CELLS = 258;
const SUPPORT_KNOWN_VALUE = 1;
const SUPPORT_UNKNOWN_VALUE = 2;

/**
 * Per-cell building support for one z18 tile (gutter included): 1 where the
 * cell center is covered by the admitted source geometry, 2 outside it.
 * Tiles with no overlapping polygon edge take a single center test; boundary
 * tiles test every cell. Pure and deterministic for pinned geometry + tile.
 */
export function classifyTileSupport(
  geometry: CoverageGeometry,
  x: number,
  y: number,
): Uint8Array {
  const bounds = tileBoundsLonLat(x, y, 1);
  const rings = coverageRings(geometry);
  let overlapping = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const west = Math.min(a[0], b[0]);
      const east = Math.max(a[0], b[0]);
      const south = Math.min(a[1], b[1]);
      const north = Math.max(a[1], b[1]);
      if (west <= bounds.east && east >= bounds.west && south <= bounds.north && north >= bounds.south) {
        overlapping = true;
        break;
      }
    }
    if (overlapping) break;
  }
  const support = new Uint8Array(STORED_CELLS * STORED_CELLS);
  if (!overlapping) {
    const center = tileCellLonLatZ18(x, y, STORED_CELLS / 2, STORED_CELLS / 2);
    support.fill(
      coverageContainsPoint(geometry, center[0], center[1])
        ? SUPPORT_KNOWN_VALUE
        : SUPPORT_UNKNOWN_VALUE,
    );
    return support;
  }
  for (let storedY = 0; storedY < STORED_CELLS; storedY++) {
    for (let storedX = 0; storedX < STORED_CELLS; storedX++) {
      const [lon, lat] = tileCellLonLatZ18(x, y, storedX, storedY);
      support[storedY * STORED_CELLS + storedX] = coverageContainsPoint(geometry, lon, lat)
        ? SUPPORT_KNOWN_VALUE
        : SUPPORT_UNKNOWN_VALUE;
    }
  }
  return support;
}

export function buildGenerationRoot(args: {
  generation: string;
  identity: GenerationIdentity;
  manifest: ArtifactRef;
  coverage: ArtifactRef;
  bounds: ArtifactRef;
  notices: ArtifactRef;
  tileCount: number;
  availableTileCount: number;
  activationTileCount: number;
}): GenerationRoot {
  const root: GenerationRoot = {
    version: 1,
    generation: args.generation,
    identity: args.identity,
    artifacts: { manifest: args.manifest, coverage: args.coverage, bounds: args.bounds, notices: args.notices },
    tilePathTemplate: `/_shadow/generations/${args.generation}/tiles/{z}-{x}-{y}.smb`,
    tileCount: args.tileCount,
    availableTileCount: args.availableTileCount,
    activationTileCount: args.activationTileCount,
    maxDecodedBytes: { coverage: MAX_COVERAGE_BYTES, bounds: MAX_BOUNDS_BYTES, notices: MAX_NOTICES_BYTES },
  };
  // The builder's own output must survive the strict parser.
  return parseGenerationRoot(JSON.parse(JSON.stringify(root)));
}

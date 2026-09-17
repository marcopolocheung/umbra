import {
  coverageSetHas,
  coverageSetToTiles,
  parseZ18Tile,
  type CoverageIndex,
  type ReducedBounds,
  type TileBoundsArtifact,
} from "./artifacts";
import { metresPerTile, tileCentreMercator } from "./coordinates";
import { type SolarPosition, sunwardDirection } from "./solar";

export type ReceiverDomain =
  | { kind: "viewport-ground"; tiles: readonly string[] }
  | { kind: "route-sidewalk"; tiles: readonly string[] };

export interface AcquisitionPlan {
  generation: string;
  receiverPages: string[];
  casterPages: string[];
  pages: string[];
  /** Planning failures are explicit; callers must return incomplete answers. */
  incompleteReason?: "unknown-exterior" | "corrupt-hierarchy" | "budget";
}

export interface AcquisitionOptions {
  /** A lower bound makes planning conservative across a time window. */
  lowerSolarAltitude?: number;
  /** Hard page cap, including receiver pages. */
  maxPages?: number;
}

export interface BoundsIndex {
  generation: string;
  leaves: ReadonlyMap<string, ReducedBounds>;
}

function boundAt(level: TileBoundsArtifact["levels"][number], x: number, y: number): ReducedBounds | undefined {
  const index = level.x.findIndex((candidate, i) => candidate === x && level.y[i] === y);
  return index < 0 ? undefined : { minG: level.minG[index], maxG: level.maxG[index], maxTopQ: level.maxTopQ[index], maxCrownQ: level.maxCrownQ[index], coverage: level.coverage[index] };
}

/**
 * Materialize leaf bounds once and reject a hierarchy that cannot conservatively
 * enclose each available leaf.  The hierarchy is an acquisition aid, never an
 * authority to clear a ray.
 */
export function indexBounds(coverage: CoverageIndex, bounds: TileBoundsArtifact): BoundsIndex {
  if (coverage.generation !== bounds.generation || coverage.availableTileCount !== bounds.tileCount)
    throw new Error("coverage/bounds generation mismatch");
  const ordered = coverageSetToTiles(coverage.available);
  if (ordered.length !== bounds.leaf.minG.length) throw new Error("bounds leaf count mismatch");
  const leaves = new Map<string, ReducedBounds>();
  for (let i = 0; i < ordered.length; i++) {
    leaves.set(ordered[i], { minG: bounds.leaf.minG[i], maxG: bounds.leaf.maxG[i], maxTopQ: bounds.leaf.maxTopQ[i], maxCrownQ: bounds.leaf.maxCrownQ[i], coverage: bounds.leaf.coverage[i] });
    const leaf = leaves.get(ordered[i])!;
    const { x: leafX, y: leafY } = parseZ18Tile(ordered[i]);
    for (const level of bounds.levels) {
      const shift = 18 - level.z;
      const parent = boundAt(level, Math.floor(leafX / 2 ** shift), Math.floor(leafY / 2 ** shift));
      if (!parent || parent.minG > leaf.minG || parent.maxG < leaf.maxG || parent.maxTopQ < leaf.maxTopQ || parent.maxCrownQ < leaf.maxCrownQ || parent.coverage < leaf.coverage)
        throw new Error("bounds hierarchy is not conservative");
    }
  }
  return { generation: bounds.generation, leaves };
}

function orderedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => {
    const a = parseZ18Tile(left); const b = parseZ18Tile(right);
    return a.y - b.y || a.x - b.x;
  });
}

/**
 * Conservative leaf refinement after the compact hierarchy is validated.  It
 * intentionally over-fetches rather than treating an omitted/unknown page as
 * clear. This prevents low sun and offscreen towers/canopies from being missed.
 */
export function planAcquisition(
  coverage: CoverageIndex,
  index: BoundsIndex,
  domains: readonly ReceiverDomain[],
  sun: SolarPosition,
  options: AcquisitionOptions = {},
): AcquisitionPlan {
  const receiverPages = orderedUnique(domains.flatMap((domain) => domain.tiles));
  if (index.generation !== coverage.generation) return { generation: coverage.generation, receiverPages, casterPages: [], pages: receiverPages, incompleteReason: "corrupt-hierarchy" };
  if (receiverPages.some((tile) => { const { x, y } = parseZ18Tile(tile); return !coverageSetHas(coverage.available, x, y); }))
    return { generation: coverage.generation, receiverPages, casterPages: [], pages: receiverPages, incompleteReason: "unknown-exterior" };
  const lowerAltitude = options.lowerSolarAltitude ?? sun.altitude;
  if (!Number.isFinite(lowerAltitude) || lowerAltitude <= 0)
    return { generation: coverage.generation, receiverPages, casterPages: [], pages: receiverPages };
  const tan = Math.tan(Math.min(lowerAltitude, Math.PI / 2 - 1e-9));
  const direction = sunwardDirection(sun);
  const receivers = receiverPages.map((tile) => ({ tile, bounds: index.leaves.get(tile), ...parseZ18Tile(tile) }));
  if (receivers.some((receiver) => !receiver.bounds)) return { generation: coverage.generation, receiverPages, casterPages: [], pages: receiverPages, incompleteReason: "corrupt-hierarchy" };
  const tileSize = metresPerTile();
  const radius = Math.SQRT2 * tileSize / 2;
  const casterPages: string[] = [];
  for (const [tile, candidate] of index.leaves) {
    if (receiverPages.includes(tile) || candidate.coverage === 2) { if (receiverPages.includes(tile)) casterPages.push(tile); continue; }
    const source = parseZ18Tile(tile); const sourceCentre = tileCentreMercator(source.x, source.y);
    for (const receiver of receivers) {
      const receiverCentre = tileCentreMercator(receiver.x, receiver.y);
      const east = sourceCentre.east - receiverCentre.east;
      const north = sourceCentre.north - receiverCentre.north;
      const along = east * direction.east + north * direction.north;
      // A page can overlap the forward half-plane even when its centre is just behind it.
      if (along < -2 * radius) continue;
      const receiverGround = receiver.bounds!.minG / 64;
      const rayFloor = receiverGround + Math.max(0, along - 2 * radius) * tan;
      const candidateTop = Math.max(candidate.maxTopQ, candidate.maxCrownQ) / 64;
      if (candidateTop >= rayFloor) { casterPages.push(tile); break; }
    }
  }
  const pages = orderedUnique([...receiverPages, ...casterPages]);
  if (options.maxPages !== undefined && pages.length > options.maxPages)
    return { generation: coverage.generation, receiverPages, casterPages: orderedUnique(casterPages), pages, incompleteReason: "budget" };
  return { generation: coverage.generation, receiverPages, casterPages: orderedUnique(casterPages), pages };
}

import { COMPONENT_FLAGS, QUANTIZATION, STORED_SIZE } from "./types";
import type { ComposedTile } from "./compose";
import type { SolarPosition } from "./solar";
import { isNight, sunwardDirection } from "./solar";
import { TreeModelV2 } from "./treeModel";

const CELLS = STORED_SIZE - 2;
export type NumericOutcome = "complete" | "missing-page" | "unknown-exterior" | "unknown-support" | "deadline" | "cancelled" | "night" | "unsupported" | "budget" | "stale-generation" | "corrupt-hierarchy";

export interface NumericMarchResult {
  /** Direct-light transmission: 1 sun, 0 opaque shade, fractional through canopy. */
  value: number | null;
  /** Same receiver/ray with canopy excluded; null follows unresolved evidence. */
  buildingOnly: number | null;
  complete: boolean;
  outcome: NumericOutcome;
  steps: number;
}

export interface NumericPageField {
  cellSizeM: number;
  tiles: ReadonlyMap<string, ComposedTile>;
  /** Only test fixtures may certify their exterior as empty. Regional production data is unknown. */
  knownEmptyExterior?: boolean;
  canopyTransmission?: number;
}

interface LocatedCell { tile?: ComposedTile; index: number; tileX: number; tileY: number; }
function key(x: number, y: number): string { return `${x}/${y}`; }
function locate(field: NumericPageField, east: number, north: number): LocatedCell {
  const x = Math.floor(east / field.cellSizeM); const y = Math.floor(north / field.cellSizeM);
  const tileX = Math.floor(x / CELLS); const tileY = Math.floor(y / CELLS);
  const localX = ((x % CELLS) + CELLS) % CELLS; const localY = ((y % CELLS) + CELLS) % CELLS;
  return { tile: field.tiles.get(key(tileX, tileY)), index: (localY + 1) * STORED_SIZE + localX + 1, tileX, tileY };
}
function terminal(outcome: NumericOutcome, steps: number): NumericMarchResult {
  return { value: null, buildingOnly: null, complete: outcome === "night", outcome, steps };
}

/**
 * Resumable Amanatides/Woo traversal.  It owns only scalar continuation state,
 * so a worker can yield between chunks without changing the answer or retaining
 * per-sample network work.  Gutters are deliberately never read here.
 */
export class MarchContinuation {
  private readonly direction: { east: number; north: number };
  private readonly tan: number;
  private readonly receiverGroundQ: number;
  private gridX: number;
  private gridY: number;
  private tMaxX: number;
  private tMaxY: number;
  private readonly tDeltaX: number;
  private readonly tDeltaY: number;
  private enteredAt = 0;
  private steps = 0;
  private transmission = 1;
  private buildingOnly = 1;
  private priorCanopy?: string;
  private done?: NumericMarchResult;

  constructor(
    private readonly field: NumericPageField,
    east: number,
    north: number,
    sun: SolarPosition,
    private readonly deadlineAt = Number.POSITIVE_INFINITY,
    private readonly cancelled: () => boolean = () => false,
  ) {
    this.direction = sunwardDirection(sun);
    this.tan = Math.tan(sun.altitude);
    const initial = locate(field, east, north);
    if (isNight(sun)) { this.receiverGroundQ = 0; this.gridX = 0; this.gridY = 0; this.tMaxX = 0; this.tMaxY = 0; this.tDeltaX = 0; this.tDeltaY = 0; this.done = terminal("night", 0); return; }
    if (!(this.tan > 0) || !Number.isFinite(this.tan)) { this.receiverGroundQ = 0; this.gridX = 0; this.gridY = 0; this.tMaxX = 0; this.tMaxY = 0; this.tDeltaX = 0; this.tDeltaY = 0; this.done = terminal("unsupported", 0); return; }
    if (!initial.tile) { this.receiverGroundQ = 0; this.gridX = 0; this.gridY = 0; this.tMaxX = 0; this.tMaxY = 0; this.tDeltaX = 0; this.tDeltaY = 0; this.done = terminal(field.knownEmptyExterior ? "unsupported" : "unknown-exterior", 0); return; }
    if (initial.tile.flagsAndMaterial[initial.index] & (COMPONENT_FLAGS.buildingUnknown | COMPONENT_FLAGS.canopyUnknown | COMPONENT_FLAGS.terrainUnknown)) { this.receiverGroundQ = 0; this.gridX = 0; this.gridY = 0; this.tMaxX = 0; this.tMaxY = 0; this.tDeltaX = 0; this.tDeltaY = 0; this.done = terminal("unknown-support", 0); return; }
    if (initial.tile.buildingTopQ[initial.index] > initial.tile.groundQ[initial.index]) { this.receiverGroundQ = 0; this.gridX = 0; this.gridY = 0; this.tMaxX = 0; this.tMaxY = 0; this.tDeltaX = 0; this.tDeltaY = 0; this.done = terminal("unsupported", 0); return; }
    this.receiverGroundQ = initial.tile.groundQ[initial.index];
    const size = field.cellSizeM;
    this.gridX = Math.floor(east / size); this.gridY = Math.floor(north / size);
    const nextX = this.direction.east > 0 ? (this.gridX + 1) * size : this.gridX * size;
    const nextY = this.direction.north > 0 ? (this.gridY + 1) * size : this.gridY * size;
    this.tMaxX = this.direction.east === 0 ? Infinity : (nextX - east) / this.direction.east;
    this.tMaxY = this.direction.north === 0 ? Infinity : (nextY - north) / this.direction.north;
    this.tDeltaX = this.direction.east === 0 ? Infinity : size / Math.abs(this.direction.east);
    this.tDeltaY = this.direction.north === 0 ? Infinity : size / Math.abs(this.direction.north);
  }

  private finish(result: NumericMarchResult): NumericMarchResult {
    this.done = result;
    return result;
  }

  resume(maxSteps = 512, now: () => number = Date.now): NumericMarchResult | undefined {
    if (this.done) return this.done;
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) throw new Error("march chunk must be positive");
    for (let work = 0; work < maxSteps; work++) {
      if (this.cancelled()) return this.finish(terminal("cancelled", this.steps));
      if (now() >= this.deadlineAt) return this.finish(terminal("deadline", this.steps));
      const leaveAt = Math.min(this.tMaxX, this.tMaxY);
      if (this.enteredAt > 0) {
        const cell = locate(this.field, (this.gridX + 0.5) * this.field.cellSizeM, (this.gridY + 0.5) * this.field.cellSizeM);
        if (!cell.tile) {
          return this.finish(this.field.knownEmptyExterior
            ? { value: this.transmission, buildingOnly: this.buildingOnly, complete: true, outcome: "complete", steps: this.steps }
            : terminal("missing-page", this.steps));
        }
        const flags = cell.tile.flagsAndMaterial[cell.index];
        if (flags & (COMPONENT_FLAGS.terrainUnknown | COMPONENT_FLAGS.buildingUnknown | COMPONENT_FLAGS.canopyUnknown)) return this.finish(terminal("unknown-support", this.steps));
        const rayStartQ = this.receiverGroundQ + 1 + this.enteredAt * this.tan * QUANTIZATION;
        const rayEndQ = this.receiverGroundQ + 1 + leaveAt * this.tan * QUANTIZATION;
        // Terrain is a surface: a rising ridge blocks even without a building mask.
        if (cell.tile.groundQ[cell.index] > Math.min(rayStartQ, rayEndQ)) return this.finish({ value: 0, buildingOnly: 0, complete: true, outcome: "complete", steps: this.steps });
        if (cell.tile.buildingTopQ[cell.index] > rayStartQ) return this.finish({ value: 0, buildingOnly: 0, complete: true, outcome: "complete", steps: this.steps });
        const base = cell.tile.crownBaseQ[cell.index]; const top = cell.tile.crownTopQ[cell.index];
        const intersectsCanopy = top > base && Math.max(rayStartQ, rayEndQ) > base && Math.min(rayStartQ, rayEndQ) < top;
        const canopyId = intersectsCanopy ? `${base}/${top}/${cell.tile.provenanceIndex[cell.index]}` : undefined;
        if (canopyId && canopyId !== this.priorCanopy) this.transmission *= this.field.canopyTransmission ?? TreeModelV2.leafOnTransmission;
        this.priorCanopy = canopyId;
      }
      if (this.tMaxX === this.tMaxY) { this.gridX += Math.sign(this.direction.east); this.gridY += Math.sign(this.direction.north); this.enteredAt = this.tMaxX; this.tMaxX += this.tDeltaX; this.tMaxY += this.tDeltaY; }
      else if (this.tMaxX < this.tMaxY) { this.gridX += Math.sign(this.direction.east); this.enteredAt = this.tMaxX; this.tMaxX += this.tDeltaX; }
      else { this.gridY += Math.sign(this.direction.north); this.enteredAt = this.tMaxY; this.tMaxY += this.tDeltaY; }
      this.steps++;
      if (this.steps >= 1_000_000) return this.finish(terminal("unsupported", this.steps));
    }
    return undefined;
  }
}

export function marchNumeric(field: NumericPageField, east: number, north: number, sun: SolarPosition, options: { deadlineAt?: number; cancelled?: () => boolean; chunk?: number; now?: () => number } = {}): NumericMarchResult {
  const continuation = new MarchContinuation(field, east, north, sun, options.deadlineAt, options.cancelled);
  for (;;) { const result = continuation.resume(options.chunk ?? 4096, options.now); if (result) return result; }
}

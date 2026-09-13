import { STORED_SIZE } from "./types";
import {
  RECEIVER_BIAS_Q,
  cellAt,
  groundReceiverValidity,
  type OpaqueFlatField,
  type ReceiverValidity,
} from "./receivers";

export interface FrozenSun {
  azimuth: number;
  altitude: number;
}

export interface PointShadow {
  shadow: number | null;
  validity: ReceiverValidity;
  complete: boolean;
}

export interface SidewalkEvidence {
  shadow: number | null;
  validCount: number;
  totalCount: number;
  unresolvedCount: number;
  invalidCount: number;
}

const CELLS = STORED_SIZE - 2;

/**
 * Marches toward the sun through half-open object cells.  Exact corner crossings
 * advance both axes, and only a positive-length interval can hit an opaque cell.
 */
export function marchOpaqueFlat(
  field: OpaqueFlatField,
  eastM: number,
  northM: number,
  sun: FrozenSun
): PointShadow {
  const validity = groundReceiverValidity(field, eastM, northM);
  if (validity.status !== "valid") return { shadow: null, validity, complete: false };
  if (sun.altitude <= 0) return { shadow: 1, validity, complete: true };

  const tanAltitude = Math.tan(sun.altitude);
  if (!(tanAltitude > 0) || !Number.isFinite(tanAltitude)) {
    return { shadow: null, validity: { status: "unsupported", reason: "unsupported solar direction" }, complete: false };
  }

  // SunCalc's azimuth is the direction of a *shadow* in the established fixture
  // convention, so a ray from receiver back to the sun is its opposite.
  const directionEast = -Math.sin(sun.azimuth);
  const directionNorth = -Math.cos(sun.azimuth);
  const cellSize = field.cellSizeM;
  let gridX = Math.floor(eastM / cellSize);
  let gridY = Math.floor(northM / cellSize);
  const stepX = Math.sign(directionEast);
  const stepY = Math.sign(directionNorth);
  const nextX = stepX > 0 ? (gridX + 1) * cellSize : gridX * cellSize;
  const nextY = stepY > 0 ? (gridY + 1) * cellSize : gridY * cellSize;
  let tMaxX = stepX === 0 ? Number.POSITIVE_INFINITY : (nextX - eastM) / directionEast;
  let tMaxY = stepY === 0 ? Number.POSITIVE_INFINITY : (nextY - northM) / directionNorth;
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(directionEast);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(directionNorth);
  let enteredAt = 0;

  // A fixture declares the exterior known empty.  We still use a deterministic
  // ceiling as an assertion guard; it never certifies a regional clear ray.
  for (let steps = 0; steps < 1_000_000; steps++) {
    const leaveAt = Math.min(tMaxX, tMaxY);
    if (enteredAt > 0) {
      const sampleEast = (gridX + 0.5) * cellSize;
      const sampleNorth = (gridY + 0.5) * cellSize;
      const cell = cellAt(field, sampleEast, sampleNorth);
      if (!cell.tile) {
        if (field.knownEmptyExterior) return { shadow: 0, validity, complete: true };
        return { shadow: null, validity: { status: "unsupported", reason: "ray left known coverage" }, complete: false };
      }
      const topQ = cell.tile.buildingTopQ[cell.index];
      if (topQ > validity.groundQ) {
        const rayAtStartQ = validity.groundQ + RECEIVER_BIAS_Q + enteredAt * tanAltitude * 64;
        // This cell's interval has positive length by construction.  A ray that
        // starts below the roof intersects the ground-solid opaque interval.
        if (rayAtStartQ < topQ) return { shadow: 1, validity, complete: true };
      }
    }

    if (tMaxX === tMaxY) {
      gridX += stepX;
      gridY += stepY;
      enteredAt = tMaxX;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      gridX += stepX;
      enteredAt = tMaxX;
      tMaxX += tDeltaX;
    } else {
      gridY += stepY;
      enteredAt = tMaxY;
      tMaxY += tDeltaY;
    }
  }
  return { shadow: null, validity: { status: "unsupported", reason: "fixture march ceiling exhausted" }, complete: false };
}

/** Ordered locations are aggregated only after each individual validity decision. */
export function aggregateSidewalk(
  locations: readonly [number, number][],
  field: OpaqueFlatField,
  sun: FrozenSun
): SidewalkEvidence {
  let sum = 0;
  let validCount = 0;
  let invalidCount = 0;
  let unresolvedCount = 0;
  for (const [eastM, northM] of locations) {
    const result = marchOpaqueFlat(field, eastM, northM, sun);
    if (result.validity.status === "invalid") {
      invalidCount++;
      continue;
    }
    if (result.validity.status !== "valid" || result.shadow === null) {
      unresolvedCount++;
      continue;
    }
    validCount++;
    sum += result.shadow;
  }
  return {
    shadow: validCount === 0 ? null : sum / validCount,
    validCount,
    totalCount: locations.length,
    invalidCount,
    unresolvedCount,
  };
}

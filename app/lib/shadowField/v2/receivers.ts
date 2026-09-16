import type { ComposedTile } from "./compose";
import { QUANTIZATION, STORED_SIZE } from "./types";

/** The deliberately narrow field accepted by item 3's opaque, flat fixture kernel. */
export interface OpaqueFlatField {
  readonly kind: "opaque-flat-v1";
  /** z18 ground spacing for the fixture city's latitude, in physical metres. */
  readonly cellSizeM: number;
  readonly tiles: ReadonlyMap<string, ComposedTile>;
  /** A fixture exterior is explicitly known empty; a regional exterior never is. */
  readonly knownEmptyExterior: boolean;
  readonly terrain: "flat";
  readonly canopy: "known-empty";
}

export interface GridCell {
  tileX: number;
  tileY: number;
  localX: number;
  localY: number;
  tile: ComposedTile | undefined;
  index: number;
}

export type ReceiverValidity =
  | { status: "valid"; cell: GridCell; groundQ: number }
  | { status: "invalid"; cell: GridCell }
  | { status: "unsupported"; reason: string };

const CELLS = STORED_SIZE - 2;

export function tileKey(tileX: number, tileY: number): string {
  return `${tileX}/${tileY}`;
}

/** Locates a point in the containing canonical half-open object cell. */
export function cellAt(field: OpaqueFlatField, eastM: number, northM: number): GridCell {
  const globalX = Math.floor(eastM / field.cellSizeM);
  const globalY = Math.floor(northM / field.cellSizeM);
  const tileX = Math.floor(globalX / CELLS);
  const tileY = Math.floor(globalY / CELLS);
  const localX = ((globalX % CELLS) + CELLS) % CELLS;
  const localY = ((globalY % CELLS) + CELLS) % CELLS;
  const tile = field.tiles.get(tileKey(tileX, tileY));
  return { tileX, tileY, localX, localY, tile, index: (localY + 1) * STORED_SIZE + localX + 1 };
}

/**
 * The ground-only receiver rule is deliberately evaluated before the sun/night
 * decision.  The flat kernel rejects every terrain/canopy mode it cannot model.
 */
export function groundReceiverValidity(
  field: OpaqueFlatField,
  eastM: number,
  northM: number
): ReceiverValidity {
  if (field.kind !== "opaque-flat-v1" || field.terrain !== "flat" || field.canopy !== "known-empty") {
    return { status: "unsupported", reason: "fixture kernel supports only flat, known-empty canopy fields" };
  }
  const cell = cellAt(field, eastM, northM);
  if (!cell.tile) {
    return field.knownEmptyExterior
      ? { status: "unsupported", reason: "receiver has no composed terrain cell" }
      : { status: "unsupported", reason: "receiver terrain is unresolved" };
  }
  const groundQ = cell.tile.groundQ[cell.index];
  // This specialization may not reinterpret a sloped/unknown field as sea level.
  if (groundQ !== 0) return { status: "unsupported", reason: "non-flat terrain is unsupported" };
  if (cell.tile.crownTopQ[cell.index] !== 0 || cell.tile.crownBaseQ[cell.index] !== 0) {
    return { status: "unsupported", reason: "canopy intervals are unsupported" };
  }
  if (cell.tile.buildingTopQ[cell.index] > groundQ) return { status: "invalid", cell };
  return { status: "valid", cell, groundQ };
}

export const RECEIVER_BIAS_Q = 1;
export const QUANTUM_METRES = 1 / QUANTIZATION;
/** Receiver-model identity pinned through v2 component identities. */
export const RECEIVER_MODEL_VERSION = "receiver-v2";

import { STORED_SIZE, type ComponentKind, type SupportState } from "./types";

/**
 * Cell-level source-support values stored in `buildingSupport`/`canopySupport`
 * planes. Occupancy always lives in the sibling mask plane; support must never
 * be inferred from occupancy.
 */
export const SUPPORT_KNOWN = 1;
export const SUPPORT_UNKNOWN = 2;
/**
 * Legacy/unset cell value. The v1 building producer emitted it on every cell
 * (the PR2 defect); the v2 recipe forbids it. Decoders grandfather v1 zeros
 * for support semantics only — never for physics or identity verification.
 */
export const SUPPORT_LEGACY_UNSET = 0;

export interface SupportCellCounts {
  known: number;
  unknown: number;
  legacy: number;
}

/** Count cell-level support values in one `buildingSupport`/`canopySupport` plane.
 *
 * Anything outside {known, unknown} buckets as `legacy`. That bucket exists
 * for the v1 readback only (the PR2 all-zero defect): the v2 path must call
 * {@link assertStrictSupportValues} first, so by the time v2 code counts,
 * `legacy` is already proven to be zero.
 */
export function countSupportCells(words: Uint32Array): SupportCellCounts {
  let known = 0;
  let unknown = 0;
  let legacy = 0;
  for (const value of words) {
    if (value === SUPPORT_UNKNOWN) unknown++;
    else if (value === SUPPORT_KNOWN) known++;
    else legacy++;
  }
  return { known, unknown, legacy };
}

export function maskHasOccupiedCell(mask: Uint32Array | undefined): boolean {
  if (!mask) return false;
  for (const value of mask) if (value !== 0) return true;
  return false;
}

/**
 * Derive coarse component support from cell counts plus mask occupancy.
 * Source support is never inferred from occupancy: a covered cell with a zero
 * mask is known absence (`known-empty`), and a present mask cell can never be
 * reported as `known-empty`.
 */
export function deriveComponentState(
  counts: Pick<SupportCellCounts, "known" | "unknown">,
  occupied: boolean,
): SupportState {
  if (counts.unknown > 0 && counts.known > 0) return "partial";
  if (counts.unknown > 0) return "unknown";
  return occupied ? "present" : "known-empty";
}

/**
 * Fail closed on contradictory support/occupancy states. A component cannot
 * declare `known-empty` when its occupancy mask contains a present cell, and
 * a fully covered component cannot claim `unknown`.
 */
export function assertSupportConsistency(
  kind: ComponentKind,
  state: SupportState | undefined,
  occupied: boolean,
  counts?: Pick<SupportCellCounts, "known" | "unknown">,
): void {
  if (state === "known-empty" && occupied)
    throw new Error(`${kind} declares known-empty but its occupancy mask is nonempty`);
  if (state === "unknown" && counts && counts.known > 0)
    throw new Error(`${kind} declares unknown but has known-covered cells`);
  if ((state === "present" || state === "known-empty") && counts && counts.unknown > 0)
    throw new Error(`${kind} declares ${state} but has unknown cells`);
}

/** v2 recipe components must not contain legacy-unset support cells.
 *
 * Kept for v1/compat callers; the v2 path uses {@link assertStrictSupportValues}
 * (which this delegates to), so both reject legacy zeros identically.
 */
export function assertNoLegacySupportCells(
  kind: ComponentKind,
  planeName: string,
  words: Uint32Array,
): void {
  assertStrictSupportValues(kind, planeName, words);
}

/**
 * Actually-strict v2 support value set: exactly {known (1), unknown (2)}.
 * Rejects legacy-unset zeros AND any out-of-range value (3+), so a corrupt
 * or future-versioned plane can never slip through as decodable support.
 */
export function assertStrictSupportValues(
  kind: ComponentKind,
  planeName: string,
  words: Uint32Array,
): void {
  for (let index = 0; index < words.length; index++) {
    const value = words[index];
    if (value === SUPPORT_LEGACY_UNSET)
      throw new Error(`${kind} ${planeName} has legacy-unset support at cell ${index}`);
    if (value !== SUPPORT_KNOWN && value !== SUPPORT_UNKNOWN)
      throw new Error(`${kind} ${planeName} has invalid support value ${value} at cell ${index}`);
  }
}

/**
 * Exact v2 support-state gate: the declared coarse state must equal
 * `deriveComponentState(counts, occupied)` — not merely avoid the two
 * contradictions {@link assertSupportConsistency} checks. A missing state or
 * any drift (partial over known-only cells, present over an empty mask,
 * known-only over unknown cells, …) fails closed. Counts must already be
 * strictly gated (see {@link assertStrictSupportValues}); `counts` is required
 * because without cell evidence there is nothing exact to compare against.
 */
export function assertExactSupportState(
  kind: ComponentKind,
  state: SupportState | undefined,
  counts: Pick<SupportCellCounts, "known" | "unknown">,
  occupied: boolean,
): void {
  const expected = deriveComponentState(counts, occupied);
  if (state === undefined)
    throw new Error(`${kind} lacks a coarse support state (expected "${expected}")`);
  if (state !== expected)
    throw new Error(`${kind} declares ${state} but exact support state is "${expected}"`);
}

/**
 * Full strict gate for one v2 support/mask pair. Both planes are required:
 * a missing mask must throw here rather than read as "unoccupied" via
 * `maskHasOccupiedCell(undefined) -> false`, and likewise for support.
 */
export function assertV2SupportStrict(
  kind: ComponentKind,
  supportWords: Uint32Array | undefined,
  maskWords: Uint32Array | undefined,
  state: SupportState | undefined,
): void {
  const supportName =
    kind === "buildings" ? "buildingSupport" : kind === "canopy" ? "canopySupport" : "support";
  const maskName =
    kind === "buildings" ? "buildingMask" : kind === "canopy" ? "canopyMask" : "mask";
  if (supportWords === undefined)
    throw new Error(`bundle v2 ${kind} component lacks ${supportName}`);
  if (maskWords === undefined)
    throw new Error(`bundle v2 ${kind} component lacks ${maskName}`);
  assertStrictSupportValues(kind, supportName, supportWords);
  assertExactSupportState(kind, state, countSupportCells(supportWords), maskHasOccupiedCell(maskWords));
}

export const SUPPORT_CELLS = STORED_SIZE * STORED_SIZE;

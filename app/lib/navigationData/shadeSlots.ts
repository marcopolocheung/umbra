/**
 * The precomputed per-edge shade table's slot model (Track L, L2a).
 *
 * A route no longer resamples shadow geometry: it reads a table that the
 * offline producer computed once. This module is the contract both sides share
 * — the producer's representative-day instants and the client's clock-slot
 * lookup have to agree exactly, or a route reads the wrong column.
 *
 * The table is one z14 cell's sidewalk segments × **768 slots**:
 *
 * - 12 months, one representative day each (the 15th);
 * - 64 fifteen-minute slots per day, 05:00–20:45 clock-local (16 h).
 *
 * Slot-major: all segments for slot 0, then slot 1, … Each segment carries two
 * bytes, `[left, right]`, each a 0–255 shadow fraction. A slot whose sun is
 * below the horizon at the cell is written 255 for both sides — the same
 * "fully shadowed" answer `ShadowField`'s night sample gives, with no geometry.
 *
 * "Local" is the map's own clock. The navigation dataset is NYC-only, so the
 * representative instants are pinned to **America/New_York** and the client
 * snaps a query using the same zone. A route is answered in the clock of the
 * city it is walked in, not the walker's device.
 *
 * Pure: no `Date`, no timezone database, no I/O. The producer builds the
 * instants; the client maps a clock reading to an index here.
 */

/** Months in the table, one representative day each. */
export const SHADE_MONTHS = 12;

/** Fifteen-minute slots per representative day. */
export const SHADE_DAY_SLOTS = 64;

/** Minutes per slot. */
export const SHADE_SLOT_MINUTES = 15;

/** First slot's clock minute-of-day: 05:00. */
export const SHADE_DAY_START_MINUTES = 5 * 60;

/** Bytes per segment per slot: one left, one right. */
export const SHADE_BYTES_PER_SEGMENT = 2;

/** Total slots per segment: 12 × 64. */
export const SHADE_SLOT_COUNT = SHADE_MONTHS * SHADE_DAY_SLOTS;

/** The zone whose clock the slots are pinned to. The dataset is NYC-only. */
export const SHADE_ZONE = "America/New_York";

/** Representative day-of-month for every month's slot column. */
export const SHADE_REPRESENTATIVE_DAY = 15;

/** Year the representative instants are built in. Fixed so builds reproduce. */
export const SHADE_REPRESENTATIVE_YEAR = 2026;

/** Byte value meaning "fully shadowed" — a night slot, or a fully shaded side. */
export const SHADE_FULL = 255;

/**
 * The clock-slot index a local time-of-day falls in, clamped to the window.
 *
 * Rounds to the nearest 15-minute slot, so a bucket the sweep ran
 * departure-aligned is never more than 7.5 minutes from the column it reads.
 * A reading outside 05:00–20:45 clamps to the nearest edge slot rather than
 * being rejected: an early-morning or late-evening query still wants a
 * daytime column, and the nearest edge is the honest one.
 */
export function shadeSlotForLocalMinutes(minutesOfDay: number): number {
  const raw = Math.round((minutesOfDay - SHADE_DAY_START_MINUTES) / SHADE_SLOT_MINUTES);
  return Math.min(SHADE_DAY_SLOTS - 1, Math.max(0, raw));
}

/** The slot column's month index for a 0-based calendar month. */
export function shadeMonthIndex(month0: number): number {
  return Math.min(SHADE_MONTHS - 1, Math.max(0, month0));
}

/** The slot index within the whole table for a month and a slot-in-day. */
export function shadeSlotIndex(month0: number, slotInDay: number): number {
  return shadeMonthIndex(month0) * SHADE_DAY_SLOTS + slotInDay;
}

/** Total payload bytes for a cell of `segments` sidewalk segments. */
export function shadePayloadBytes(segments: number): number {
  return segments * SHADE_SLOT_COUNT * SHADE_BYTES_PER_SEGMENT;
}

/** Byte offset of one slot's segment block in the payload. */
export function shadeSlotByteOffset(slotIndex: number, segments: number): number {
  return slotIndex * segments * SHADE_BYTES_PER_SEGMENT;
}

/** Bytes of one slot's segment block. */
export function shadeSlotByteLength(segments: number): number {
  return segments * SHADE_BYTES_PER_SEGMENT;
}

/** A shadow fraction 0–1 as the stored byte. */
export function shadeFractionToByte(fraction: number): number {
  return Math.min(SHADE_FULL, Math.max(0, Math.round(fraction * SHADE_FULL)));
}

/** The stored byte back to a 0–1 fraction. */
export function shadeByteToFraction(byte: number): number {
  return byte / SHADE_FULL;
}

/**
 * The canonical undirected segment key, `min(from,to),max(from,to)` — the exact
 * key `useRouting`'s `edgeShadowCache` already uses, so the table's columns line
 * up with the graph's edges without a second identity.
 */
export function shadeSegmentKey(lo: number, hi: number): string {
  return `${lo},${hi}`;
}

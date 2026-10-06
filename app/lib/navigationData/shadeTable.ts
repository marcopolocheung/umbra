/**
 * The client's read side of the precomputed shade table (Track L, L2a).
 *
 * `useRouting`'s H1 path used to call `field.sweep(edgeRefs, bucketDates)` —
 * the 23.5 s geometry block. With a table it does a lookup instead: each
 * bucket's clock time snaps to a (month, 15-minute slot) column, and the
 * edge's canonical segment picks the row.
 *
 * A `ShadeTableView` is built once per calculation from the shade shards
 * overlapping the route and the slot blocks those buckets touch. It answers
 * only for segments it holds; `useRouting` keeps `field.sweep` for any route
 * the table does not fully cover, so a missing or partial table degrades to
 * today's behaviour rather than to a wrong answer.
 *
 * Pure and synchronous once built — the fetching lives in `remoteNavigation`.
 */

import {
  SHADE_MONTHS,
  SHADE_SLOT_COUNT,
  shadeByteToFraction,
  shadeMonthIndex,
  shadeSlotForLocalMinutes,
  shadeSlotIndex,
  shadeSegmentKey,
} from "./shadeSlots";
import { toMapLocal } from "../timezone";
import type { NavigationShadeShard } from "./shardContract";

/**
 * Generations whose shade table is known bad and must not be read. A route over
 * one prices with the live sweep instead — slower, but correct.
 *
 * `nyc-2026-09-18-b94934cd765a`: the build's frozen building provider declined
 * any query box reaching past its cell's padded bounds (a seam edge's far
 * endpoint does), and the declined answer was written as 0 shade — ~half the
 * cells, most of Midtown, read fully sunny at every hour.
 */
export const QUARANTINED_SHADE_GENERATIONS: ReadonlySet<string> = new Set([
  "nyc-2026-09-18-b94934cd765a",
]);

/** One loaded shard and the slot blocks fetched for it, keyed by slot index. */
export interface ShadeTableShard {
  shard: NavigationShadeShard;
  blocks: Map<number, Uint8Array>;
}

/** A per-calculation lookup over every loaded shade shard. */
export interface ShadeTableView {
  /** True when the loaded shards hold this canonical segment. */
  covers(key: string): boolean;
  /**
   * The canonical `[left, right]` shadow fractions for a segment at a slot, or
   * null when the segment or the slot block is not held.
   */
  shadowFor(key: string, slot: number): { left: number; right: number } | null;
  /** Slots this view holds blocks for. */
  slots(): number[];
}

interface SegmentLocation {
  shardIndex: number;
  /** Column within the shard's payload. */
  index: number;
}

export function createShadeTableView(shards: ShadeTableShard[]): ShadeTableView {
  const segments = new Map<string, SegmentLocation>();
  for (let s = 0; s < shards.length; s++) {
    const list = shards[s].shard.segments;
    for (let index = 0; index < list.length; index++) {
      const [lo, hi] = list[index];
      segments.set(shadeSegmentKey(lo, hi), { shardIndex: s, index });
    }
  }

  function shadowFor(key: string, slot: number): { left: number; right: number } | null {
    const location = segments.get(key);
    if (!location) return null;
    const block = shards[location.shardIndex].blocks.get(slot);
    if (!block) return null;
    const offset = location.index * 2;
    if (offset + 1 >= block.length) return null;
    return { left: shadeByteToFraction(block[offset]), right: shadeByteToFraction(block[offset + 1]) };
  }

  return {
    covers: (key) => segments.has(key),
    shadowFor,
    slots: () => [...new Set(shards.flatMap((entry) => [...entry.blocks.keys()]))].sort((a, b) => a - b),
  };
}

/**
 * The clock slots a departure window's buckets snap to.
 *
 * The H1 buckets are departure-aligned (`start + b·15 min`); the table is
 * clock-aligned. Each bucket rounds to the nearest clock slot — at most 7.5
 * minutes away — and `perBucket[b]` is that slot index, so the caller does not
 * recompute it per edge. `slotIndices` is the distinct set to fetch.
 */
export function shadeSlotsForDeparture(
  departure: Date,
  bucketCount: number,
  utcOffsetMin: number,
): { perBucket: number[]; slotIndices: number[] } {
  const perBucket: number[] = [];
  const unique = new Set<number>();
  for (let b = 0; b < bucketCount; b++) {
    const at = new Date(departure.getTime() + b * 15 * 60 * 1000);
    const local = toMapLocal(at, utcOffsetMin);
    const slotInDay = shadeSlotForLocalMinutes(local.hours * 60 + local.minutes);
    const slot = shadeSlotIndex(local.month, slotInDay);
    perBucket.push(slot);
    unique.add(slot);
  }
  return { perBucket, slotIndices: [...unique].sort((a, b) => a - b) };
}

/** Every slot index in the table, for a caller that wants the whole year. */
export function allShadeSlots(): number[] {
  return Array.from({ length: SHADE_SLOT_COUNT }, (_, index) => index);
}

export { SHADE_MONTHS, shadeMonthIndex };

import { describe, expect, it } from "vitest";
import {
  SHADE_BYTES_PER_SEGMENT,
  SHADE_DAY_SLOTS,
  SHADE_DAY_START_MINUTES,
  SHADE_FULL,
  SHADE_MONTHS,
  SHADE_SLOT_COUNT,
  shadeByteToFraction,
  shadeFractionToByte,
  shadeMonthIndex,
  shadePayloadBytes,
  shadeSegmentKey,
  shadeSlotByteLength,
  shadeSlotByteOffset,
  shadeSlotForLocalMinutes,
  shadeSlotIndex,
} from "../shadeSlots";

describe("shade slot model", () => {
  it("is 12 months × 64 daylight slots", () => {
    expect(SHADE_MONTHS).toBe(12);
    expect(SHADE_DAY_SLOTS).toBe(64);
    expect(SHADE_SLOT_COUNT).toBe(768);
    expect(SHADE_BYTES_PER_SEGMENT).toBe(2);
    // 05:00 to 20:45 inclusive.
    expect(SHADE_DAY_START_MINUTES).toBe(300);
    expect(SHADE_DAY_START_MINUTES + (SHADE_DAY_SLOTS - 1) * 15).toBe(20 * 60 + 45);
  });

  it("rounds a clock reading to the nearest slot", () => {
    expect(shadeSlotForLocalMinutes(300)).toBe(0); // 05:00
    expect(shadeSlotForLocalMinutes(307)).toBe(0); // 05:07 → nearer 05:00
    expect(shadeSlotForLocalMinutes(308)).toBe(1); // 05:08 → nearer 05:15
    expect(shadeSlotForLocalMinutes(12 * 60)).toBe(28); // 12:00
    expect(shadeSlotForLocalMinutes(20 * 60 + 45)).toBe(63);
  });

  it("clamps readings outside the window to the edge slots", () => {
    expect(shadeSlotForLocalMinutes(0)).toBe(0);
    expect(shadeSlotForLocalMinutes(23 * 60)).toBe(SHADE_DAY_SLOTS - 1);
  });

  it("lays slots out month-major, then slot-in-day", () => {
    expect(shadeSlotIndex(0, 0)).toBe(0);
    expect(shadeSlotIndex(0, 63)).toBe(63);
    expect(shadeSlotIndex(1, 0)).toBe(64);
    expect(shadeSlotIndex(11, 63)).toBe(767);
    expect(shadeMonthIndex(13)).toBe(11);
    expect(shadeMonthIndex(-1)).toBe(0);
  });

  it("sizes the payload and addresses each slot block", () => {
    const segments = 100;
    expect(shadePayloadBytes(segments)).toBe(segments * SHADE_SLOT_COUNT * 2);
    expect(shadeSlotByteLength(segments)).toBe(segments * 2);
    expect(shadeSlotByteOffset(0, segments)).toBe(0);
    expect(shadeSlotByteOffset(1, segments)).toBe(segments * 2);
    expect(shadeSlotByteOffset(767, segments) + shadeSlotByteLength(segments)).toBe(
      shadePayloadBytes(segments),
    );
  });

  it("quantises a shadow fraction to a byte and back", () => {
    expect(shadeFractionToByte(0)).toBe(0);
    expect(shadeFractionToByte(1)).toBe(SHADE_FULL);
    expect(shadeFractionToByte(0.5)).toBe(128);
    expect(shadeFractionToByte(2)).toBe(SHADE_FULL);
    expect(shadeFractionToByte(-1)).toBe(0);
    expect(shadeByteToFraction(255)).toBe(1);
    expect(shadeByteToFraction(0)).toBe(0);
  });

  it("keys a segment canonically", () => {
    expect(shadeSegmentKey(7, 3)).toBe("7,3");
    expect(shadeSegmentKey(3, 7)).toBe("3,7");
  });
});

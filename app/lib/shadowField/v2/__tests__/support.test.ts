import { describe, expect, it } from "vitest";
import {
  assertNoLegacySupportCells,
  assertV2SupportStrict,
  assertSupportConsistency,
  countSupportCells,
  deriveComponentState,
  maskHasOccupiedCell,
  SUPPORT_KNOWN,
  SUPPORT_LEGACY_UNSET,
  SUPPORT_UNKNOWN,
} from "../support";

describe("v2 cell support values", () => {
  it("pins known, unknown, and legacy-unset semantics", () => {
    expect(SUPPORT_KNOWN).toBe(1);
    expect(SUPPORT_UNKNOWN).toBe(2);
    expect(SUPPORT_LEGACY_UNSET).toBe(0);
  });

  it("counts cells by value", () => {
    expect(countSupportCells(new Uint32Array([1, 1, 2, 0]))).toEqual({
      known: 2,
      unknown: 1,
      legacy: 1,
    });
  });

  it("detects mask occupancy", () => {
    expect(maskHasOccupiedCell(undefined)).toBe(false);
    expect(maskHasOccupiedCell(new Uint32Array(4))).toBe(false);
    const mask = new Uint32Array(4);
    mask[3] = 1;
    expect(maskHasOccupiedCell(mask)).toBe(true);
  });
});

describe("deriveComponentState", () => {
  it("derives the full state matrix without inferring support from occupancy", () => {
    // Known source coverage + zero occupancy is valid known absence.
    expect(deriveComponentState({ known: 10, unknown: 0 }, false)).toBe("known-empty");
    expect(deriveComponentState({ known: 10, unknown: 0 }, true)).toBe("present");
    // Mixed known/unknown is partial, never unknown or present.
    expect(deriveComponentState({ known: 9, unknown: 1 }, false)).toBe("partial");
    expect(deriveComponentState({ known: 1, unknown: 9 }, true)).toBe("partial");
    // Fully unknown stays unknown even with an occupied mask.
    expect(deriveComponentState({ known: 0, unknown: 10 }, true)).toBe("unknown");
    expect(deriveComponentState({ known: 0, unknown: 10 }, false)).toBe("unknown");
  });
});

describe("assertSupportConsistency", () => {
  it("rejects known-empty over a nonempty mask", () => {
    expect(() => assertSupportConsistency("buildings", "known-empty", true)).toThrow(
      /known-empty.*nonempty/,
    );
    expect(() => assertSupportConsistency("canopy", "known-empty", true)).toThrow(
      /known-empty.*nonempty/,
    );
  });

  it("rejects unknown with known cells and present/known-empty with unknown cells", () => {
    expect(() =>
      assertSupportConsistency("buildings", "unknown", false, { known: 1, unknown: 9 }),
    ).toThrow(/unknown.*known-covered/);
    expect(() =>
      assertSupportConsistency("buildings", "present", true, { known: 9, unknown: 1 }),
    ).toThrow(/present.*unknown/);
  });

  it("accepts consistent states", () => {
    expect(() =>
      assertSupportConsistency("buildings", "known-empty", false, { known: 10, unknown: 0 }),
    ).not.toThrow();
    expect(() =>
      assertSupportConsistency("buildings", "partial", true, { known: 9, unknown: 1 }),
    ).not.toThrow();
    expect(() => assertSupportConsistency("buildings", undefined, true)).not.toThrow();
  });
});

describe("assertNoLegacySupportCells", () => {
  it("rejects legacy-unset cells for the v2 recipe", () => {
    expect(() =>
      assertNoLegacySupportCells("buildings", "buildingSupport", new Uint32Array([1, 0, 1])),
    ).toThrow(/legacy-unset/);
    expect(() =>
      assertNoLegacySupportCells("buildings", "buildingSupport", new Uint32Array([1, 1, 2])),
    ).not.toThrow();
  });
});

describe("v2 exact support gate", () => {
  it("rejects out-of-range cells, missing planes, missing states, and every non-derived state", () => {
    const known = new Uint32Array([1, 1]);
    const unknown = new Uint32Array([2, 2]);
    const mixed = new Uint32Array([1, 2]);
    const occupied = new Uint32Array([1, 0]);
    expect(() => assertV2SupportStrict("buildings", new Uint32Array([1, 3]), occupied, "present")).toThrow(/invalid support value 3/);
    expect(() => assertV2SupportStrict("buildings", undefined, occupied, "present")).toThrow(/lacks buildingSupport/);
    expect(() => assertV2SupportStrict("buildings", known, undefined, "present")).toThrow(/lacks buildingMask/);
    expect(() => assertV2SupportStrict("buildings", known, occupied, undefined)).toThrow(/lacks a coarse support state/);
    expect(() => assertV2SupportStrict("buildings", mixed, occupied, "present")).toThrow(/exact support state is "partial"/);
    expect(() => assertV2SupportStrict("buildings", known, new Uint32Array(2), "present")).toThrow(/known-empty/);
    expect(() => assertV2SupportStrict("buildings", unknown, occupied, "partial")).toThrow(/exact support state is "unknown"/);
  });
});

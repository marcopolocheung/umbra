import { describe, expect, it } from "vitest";
import { createShadeTableView, departureFromShadeTable, shadeSlotsForDeparture } from "../shadeTable";
import { SHADE_FULL, shadeSlotIndex } from "../shadeSlots";
import type { NavigationShadeShard } from "../shardContract";

const bounds = { south: 40.75, west: -74.0, north: 40.76, east: -73.99 };

function shard(segments: Array<[number, number]>, payloadKey: string): NavigationShadeShard {
  return {
    version: 1,
    dataset: "nyc-navigation",
    generation: "nyc-2026-09-18-000000000000",
    kind: "shade",
    geometryBounds: bounds,
    supportBounds: bounds,
    slots: 768,
    segments,
    payload: { key: payloadKey, bytes: segments.length * 768 * 2, sha256: "a".repeat(64) },
  };
}

function block(segments: Array<[number, number]>, left: number, right: number): Uint8Array {
  const bytes = new Uint8Array(segments.length * 2);
  for (let i = 0; i < segments.length; i++) {
    bytes[i * 2] = left;
    bytes[i * 2 + 1] = right;
  }
  return bytes;
}

describe("createShadeTableView", () => {
  it("looks a canonical segment up by key and slot", () => {
    const segments: Array<[number, number]> = [
      [3, 9],
      [10, 14],
    ];
    const view = createShadeTableView([
      { shard: shard(segments, "shades/a.bin"), blocks: new Map([[5, block(segments, 51, 204)]]) },
    ]);

    expect(view.covers("3,9")).toBe(true);
    expect(view.covers("4,9")).toBe(false);
    expect(view.shadowFor("3,9", 5)).toEqual({ left: 51 / 255, right: 204 / 255 });
    expect(view.shadowFor("10,14", 5)).toEqual({ left: 51 / 255, right: 204 / 255 });
  });

  it("returns null for a missing slot block rather than inventing one", () => {
    const segments: Array<[number, number]> = [[1, 2]];
    const view = createShadeTableView([
      { shard: shard(segments, "shades/a.bin"), blocks: new Map([[5, block(segments, 0, 255)]]) },
    ]);
    expect(view.shadowFor("1,2", 6)).toBeNull();
    expect(view.shadowFor("1,2", 5)).toEqual({ left: 0, right: 1 });
  });

  it("merges segments across shards", () => {
    const view = createShadeTableView([
      { shard: shard([[1, 2]], "shades/a.bin"), blocks: new Map([[0, block([[1, 2]], 255, 0)]]) },
      { shard: shard([[3, 4]], "shades/b.bin"), blocks: new Map([[0, block([[3, 4]], 10, 20)]]) },
    ]);
    expect(view.covers("1,2")).toBe(true);
    expect(view.covers("3,4")).toBe(true);
    expect(view.shadowFor("3,4", 0)).toEqual({ left: 10 / 255, right: 20 / 255 });
  });
});

describe("shadeSlotsForDeparture", () => {
  it("snaps each bucket to the nearest clock slot and dedupes them", () => {
    // 12:00 local (UTC-5) → slot 28 of the current month.
    const departure = new Date(Date.UTC(2026, 6, 15, 17, 0));
    const { perBucket, slotIndices } = shadeSlotsForDeparture(departure, 4, -300);
    const expected = shadeSlotIndex(6, 28);
    expect(perBucket[0]).toBe(expected);
    expect(perBucket[1]).toBe(expected + 1);
    expect(perBucket[2]).toBe(expected + 2);
    expect(perBucket[3]).toBe(expected + 3);
    expect(slotIndices).toEqual([expected, expected + 1, expected + 2, expected + 3]);
  });

  it("keeps a sub-slot departure on the same column", () => {
    const departure = new Date(Date.UTC(2026, 6, 15, 17, 5));
    const { perBucket } = shadeSlotsForDeparture(departure, 1, -300);
    expect(perBucket[0]).toBe(shadeSlotIndex(6, 28));
  });
});

describe("departureFromShadeTable", () => {
  const segments: Array<[number, number]> = [
    [3, 9],
    [10, 14],
  ];
  // 2026-07-15 16:00 EDT → July (month 6), slot (960 − 300) / 15 = 44.
  const afternoon = new Date("2026-07-15T20:00:00Z");
  const view = createShadeTableView([
    {
      shard: shard(segments, "shades/a.bin"),
      blocks: new Map([[shadeSlotIndex(6, 44), block(segments, 51, 204)]]),
    },
  ]);

  it("reads the departure slot, as a confident static-building sample", () => {
    const [first, second] = departureFromShadeTable(view, ["3,9", "10,14"], afternoon, 40.755, -73.995);
    expect(first.left).toBeCloseTo(0.2, 10);
    expect(first.right).toBeCloseTo(0.8, 10);
    expect(second.left).toBeCloseTo(0.2, 10);
    expect(first.source).toBe("nyc-static");
    expect(first.buildingSource).toBe("nyc-static");
    // Above LOW_CONFIDENCE, so the route never falls back to the canvas.
    expect(first.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("reads night as fully shaded and certain", () => {
    const night = new Date("2026-07-15T06:00:00Z"); // 02:00 EDT
    const [edge] = departureFromShadeTable(view, ["3,9"], night, 40.755, -73.995);
    expect(edge.source).toBe("none");
    expect(edge.confidence).toBe(1);
    expect(edge.left).toBe(1);
  });
});

describe("shade byte round-trip", () => {
  it("reads a full-shadow byte as 1", () => {
    const segments: Array<[number, number]> = [[1, 2]];
    const bytes = new Uint8Array([SHADE_FULL, SHADE_FULL]);
    const view = createShadeTableView([
      { shard: shard(segments, "shades/a.bin"), blocks: new Map([[0, bytes]]) },
    ]);
    expect(view.shadowFor("1,2", 0)).toEqual({ left: 1, right: 1 });
  });
});

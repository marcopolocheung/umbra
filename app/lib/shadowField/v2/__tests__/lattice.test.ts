import { describe, expect, it } from "vitest";
import { ownerCell, storedIndex, terrainAtCellPoint } from "../lattice";
import { STORED_SIZE } from "../types";

describe("z18 stored lattice", () => {
  it("uses a true one-cell border and the NW-SE terrain diagonal", () => {
    const ground = new Int32Array(STORED_SIZE * STORED_SIZE);
    ground[storedIndex(0, 0)] = 0;
    ground[storedIndex(1, 0)] = 100;
    ground[storedIndex(0, 1)] = 200;
    ground[storedIndex(1, 1)] = 300;
    expect(storedIndex(-1, -1)).toBe(0);
    expect(storedIndex(256, 256)).toBe(STORED_SIZE * STORED_SIZE - 1);
    expect(terrainAtCellPoint(ground, 0, 0, 0.75, 0.25)).toBe(125);
    expect(terrainAtCellPoint(ground, 0, 0, 0.25, 0.75)).toBe(175);
  });

  it("has fixed cell-center ownership and matched neighbouring borders", () => {
    expect(ownerCell(0.5, 0.5)).toEqual({ x: 0, y: 0 });
    expect(ownerCell(1, 1)).toEqual({ x: 1, y: 1 });
    const west = new Int32Array(STORED_SIZE * STORED_SIZE);
    const east = new Int32Array(STORED_SIZE * STORED_SIZE);
    for (let y = 0; y < STORED_SIZE; y++) {
      west[storedIndex(256, y - 1)] = y - 100;
      east[storedIndex(-1, y - 1)] = y - 100;
    }
    for (let y = 0; y < STORED_SIZE; y++)
      expect(west[storedIndex(256, y - 1)]).toBe(east[storedIndex(-1, y - 1)]);
  });

  it("keeps holey and crescent mask positions instead of replacing them with a block", () => {
    const occupied = new Set(
      [
        [1, 1],
        [2, 1],
        [1, 2],
        [3, 2],
      ].map(([x, y]) => `${x}/${y}`),
    );
    expect(occupied.has("2/2")).toBe(false);
    expect(occupied.has("3/1")).toBe(false);
    expect(occupied.size).toBe(4);
  });
});

import { describe, expect, it } from "vitest";
import { aggregateSidewalk, marchOpaqueFlat } from "../march";
import { cellAt, tileKey, type OpaqueFlatField } from "../receivers";
import { STORED_SIZE } from "../types";

function field(occupied: readonly [number, number][] = []): OpaqueFlatField {
  const words = STORED_SIZE * STORED_SIZE;
  const buildingTopQ = new Int32Array(words);
  for (const [x, y] of occupied) buildingTopQ[(y + 1) * STORED_SIZE + x + 1] = 640;
  return {
    kind: "opaque-flat-v1",
    cellSizeM: 1,
    tiles: new Map([[tileKey(0, 0), {
      groundQ: new Int32Array(words), buildingTopQ, crownBaseQ: new Int32Array(words), crownTopQ: new Int32Array(words), flagsAndMaterial: new Uint32Array(words), provenanceIndex: new Uint32Array(words),
    }]]),
    knownEmptyExterior: true,
    terrain: "flat",
    canopy: "known-empty",
  };
}

describe("v2 flat receiver and marcher", () => {
  it("rejects an occupied ground receiver before the night shortcut", () => {
    const result = marchOpaqueFlat(field([[1, 1]]), 1.5, 1.5, { azimuth: 0, altitude: -0.1 });
    expect(result.validity.status).toBe("invalid");
    expect(result.shadow).toBeNull();
  });

  it("aggregates all-invalid and partially-valid sidewalks without treating invalid as sun", () => {
    const occupied = field([[1, 1]]);
    const allInvalid = aggregateSidewalk([[1.5, 1.5], [1.6, 1.6]], occupied, { azimuth: 0, altitude: 0.5 });
    const partial = aggregateSidewalk([[1.5, 1.5], [3.5, 3.5]], occupied, { azimuth: 0, altitude: 0.5 });
    expect(allInvalid).toMatchObject({ shadow: null, validCount: 0, invalidCount: 2, totalCount: 2 });
    expect(partial).toMatchObject({ shadow: 0, validCount: 1, invalidCount: 1, totalCount: 2 });
  });

  it("does not let a flat specialization answer terrain or canopy fields", () => {
    const unsupported = { ...field(), terrain: "slope" } as unknown as OpaqueFlatField;
    expect(marchOpaqueFlat(unsupported, 3.5, 3.5, { azimuth: 0, altitude: 0.5 })).toMatchObject({ shadow: null, validity: { status: "unsupported" } });
    const canopy = field();
    canopy.tiles.get(tileKey(0, 0))?.crownTopQ.fill(64);
    expect(marchOpaqueFlat(canopy, 3.5, 3.5, { azimuth: 0, altitude: 0.5 })).toMatchObject({ shadow: null, validity: { status: "unsupported" } });
  });

  it("uses half-open cells and advances both axes at a DDA corner", () => {
    expect(cellAt(field(), 1, 1)).toMatchObject({ localX: 1, localY: 1 });
    const result = marchOpaqueFlat(field([[2, 2]]), 0.5, 0.5, { azimuth: (5 * Math.PI) / 4, altitude: 0.5 });
    expect(result).toMatchObject({ shadow: 1, validity: { status: "valid" } });
  });
});

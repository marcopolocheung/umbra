import { describe, expect, it } from "vitest";
import type { ComposedTile } from "../compose";
import { MarchContinuation, marchNumeric, type NumericMarchResult } from "../numericMarch";
import { STORED_SIZE } from "../types";

function page(): ComposedTile {
  const size = STORED_SIZE * STORED_SIZE;
  const buildingTopQ = new Int32Array(size);
  buildingTopQ[(0 + 1) * STORED_SIZE + 2 + 1] = 640;
  return { groundQ: new Int32Array(size), buildingTopQ, crownBaseQ: new Int32Array(size), crownTopQ: new Int32Array(size), flagsAndMaterial: new Uint32Array(size), provenanceIndex: new Uint32Array(size) };
}
function emptyPage(): ComposedTile {
  const size = STORED_SIZE * STORED_SIZE;
  return { groundQ: new Int32Array(size), buildingTopQ: new Int32Array(size), crownBaseQ: new Int32Array(size), crownTopQ: new Int32Array(size), flagsAndMaterial: new Uint32Array(size), provenanceIndex: new Uint32Array(size) };
}
function index(x: number, y = 0): number { return (y + 1) * STORED_SIZE + x + 1; }

describe("resumable numeric marching", () => {
  it("matches resident execution exactly across chunks and sees an offscreen building", () => {
    const field = { cellSizeM: 1, tiles: new Map([["0/0", page()]]), knownEmptyExterior: true };
    const sun = { azimuth: -Math.PI / 2, altitude: 0.4 };
    const resident = marchNumeric(field, 0.5, 0.5, sun);
    const continuation = new MarchContinuation(field, 0.5, 0.5, sun);
    let streamed: NumericMarchResult | undefined = continuation.resume(1);
    while (!streamed) streamed = continuation.resume(1);
    expect(streamed).toEqual(resident);
    expect(resident).toMatchObject({ value: 0, buildingOnly: 0, complete: true });
  });

  it("returns null for missing pages, cancellation, and night rather than sun or shade", () => {
    const empty = emptyPage();
    const missing = marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", empty]]) }, 0.5, 0.5, { azimuth: -Math.PI / 2, altitude: 0.4 });
    expect(missing).toMatchObject({ value: null, outcome: "missing-page", complete: false });
    expect(marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", page()]]) }, 0.5, 0.5, { azimuth: 0, altitude: -0.1 })).toMatchObject({ value: null, outcome: "night", complete: true });
  });

  it("handles terrain ridges, canopy air gaps, vertical sun, and page seams", () => {
    const ridge = emptyPage(); ridge.groundQ[index(2)] = 100;
    expect(marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", ridge]]), knownEmptyExterior: true }, .5, .5, { azimuth: -Math.PI / 2, altitude: .4 })).toMatchObject({ value: 0, buildingOnly: 0 });
    const canopy = emptyPage(); canopy.crownBaseQ[index(2)] = 10; canopy.crownTopQ[index(2)] = 640;
    expect(marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", canopy]]), knownEmptyExterior: true }, .5, .5, { azimuth: -Math.PI / 2, altitude: .4 })).toMatchObject({ value: .1, buildingOnly: 1 });
    expect(marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", page()]]), knownEmptyExterior: true }, .5, .5, { azimuth: -Math.PI / 2, altitude: Math.PI / 2 - 1e-6 })).toMatchObject({ value: 1, buildingOnly: 1 });
    const east = emptyPage(); east.buildingTopQ[index(0)] = 640;
    expect(marchNumeric({ cellSizeM: 1, tiles: new Map([["0/0", emptyPage()], ["1/0", east]]), knownEmptyExterior: true }, 255.5, .5, { azimuth: -Math.PI / 2, altitude: .4 })).toMatchObject({ value: 0, buildingOnly: 0 });
  });
});

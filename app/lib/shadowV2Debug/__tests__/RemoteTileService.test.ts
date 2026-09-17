import { afterEach, describe, expect, it, vi } from "vitest";
import { coverageSetHas, tilesToCoverageSet } from "../../shadowField/v2/artifacts";
import { debugTileNeighborhood, debugTilesForViewport, isShadowV2DebugEnabled } from "../RemoteTileService";

describe("v2 debug viewport selection", () => {
  it("is off unless the flag is exactly true", () => {
    expect(isShadowV2DebugEnabled(undefined)).toBe(false);
    expect(isShadowV2DebugEnabled("TRUE")).toBe(false);
    expect(isShadowV2DebugEnabled("1")).toBe(false);
    expect(isShadowV2DebugEnabled("true")).toBe(true);
  });

  it("selects the centered, bounded 3×3 z18 neighbourhood", () => {
    const tiles = debugTileNeighborhood(-73.9855, 40.758);
    expect(tiles).toHaveLength(9);
    expect(new Set(tiles).size).toBe(9);
    expect(tiles.every((tile) => tile.startsWith("18/"))).toBe(true);
  });

  it("allows acquisition only from coverage.available, never activation", () => {
    const candidates = debugTileNeighborhood(-73.9855, 40.758);
    const available = tilesToCoverageSet([candidates[0], candidates[4], candidates[8]]);
    const acquired = candidates.filter((tile) => {
      const [, x, y] = tile.split("/").map(Number);
      return coverageSetHas(available, x, y);
    });
    expect(acquired).toEqual([candidates[0], candidates[4], candidates[8]]);
  });

  it("requests nothing below zoom 20 and never more than the packed 3×3 set", () => {
    const candidates = debugTileNeighborhood(-73.9855, 40.758);
    const coverage = { available: tilesToCoverageSet(candidates) } as Parameters<typeof debugTilesForViewport>[1];
    expect(debugTilesForViewport({ lng: -73.9855, lat: 40.758, zoom: 19.9 }, coverage)).toEqual([]);
    expect(debugTilesForViewport({ lng: -73.9855, lat: 40.758, zoom: 20 }, coverage)).toEqual(candidates);
  });
});

afterEach(() => vi.unstubAllEnvs());

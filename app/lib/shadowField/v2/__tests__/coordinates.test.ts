import { describe, expect, it } from "vitest";
import { lonLatToMercator, mercatorToTile, ownerTileForMercator } from "../coordinates";

describe("numeric coordinate convention", () => {
  it("uses Web Mercator and half-open z18 ownership", () => {
    const origin = lonLatToMercator(0, 0);
    expect(mercatorToTile(origin)).toEqual({ x: 131072, y: 131072 });
    expect(ownerTileForMercator(origin)).toBe("18/131072/131072");
    expect(() => lonLatToMercator(0, 90)).toThrow(/Mercator/);
  });
});

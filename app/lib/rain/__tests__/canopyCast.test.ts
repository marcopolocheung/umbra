import { describe, expect, it } from "vitest";
import { canopyShadowTriangles } from "../canopyCast";
import { pointInTriangleXY } from "../../shadowField/geometry";

const CROWN: { ring: [number, number][]; heightM: number; baseM: number; opacity: number } = {
  // 6 m crown centred at the origin, 10 m tall crown top, base 3.5 m up.
  ring: [[-0.00005, -0.00005], [0.00005, -0.00005], [0.00005, 0.00005], [-0.00005, 0.00005]],
  heightM: 10,
  baseM: 3.5,
  opacity: 0.9,
};
const m = 111195;

describe("canopyShadowTriangles", () => {
  it("lands on its own footprint for vertical rain", () => {
    const tris = canopyShadowTriangles(CROWN, Math.PI, (89.5 * Math.PI) / 180, m, m);
    const insideAll = (lng: number, lat: number, list: Array<[number, number]>) => {
      for (let i = 0; i + 2 < list.length; i += 3) {
        const [a, b, c] = [list[i], list[i + 1], list[i + 2]];
        if (pointInTriangleXY(lng, lat, a[0], a[1], b[0], b[1], c[0], c[1])) return true;
      }
      return false;
    };
    expect(insideAll(0, 0, tris)).toBe(true);
    expect(insideAll(0.0002, 0.0002, tris)).toBe(false);
  });

  it("displaces the near edge by base/tan(alt) toward the lee, not into the wind", () => {
    // Wind FROM the west (270°) drives rain east; the sheltered side is east.
    // The shadow should reach from ~3.5 m to ~10 m east of the ring centre.
    const tris = canopyShadowTriangles(CROWN, (90 * Math.PI) / 180, Math.PI / 4, m, m);
    const eastProbe = (lng: number) => {
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
        if (pointInTriangleXY(lng, 0, a[0], a[1], b[0], b[1], c[0], c[1])) return true;
      }
      return false;
    };
    expect(eastProbe(3.5 / m)).toBe(true);   // inside the swept band
    expect(eastProbe(5 / m)).toBe(true);     // mid band
    expect(eastProbe(0)).toBe(true);         // own crown footprint stays sheltered
    expect(eastProbe(18 / m)).toBe(false);   // past the 15.5 m far edge
  });
});

import { describe, expect, it } from "vitest";
import { metresToNormalizedMercator } from "../LocalShadowAdapter";
import { lonLatToMercator, mercatorToLonLat } from "../../canopyRaster/tiles";

/**
 * The coordinate-convention seam that put the first canopy overlay off-screen.
 *
 * `tiles.ts` speaks metres-of-Mercator (EARTH_RADIUS 6378137); the shadow
 * renderer's camera matrix and building mesh speak normalized [0,1] Mercator.
 * The composite quad must convert the atlas bbox through
 * `metresToNormalizedMercator` before subtracting `centerMerc` — these tests
 * pin the conversion so the two conventions can never silently diverge again.
 */
describe("metresToNormalizedMercator", () => {
  it("maps the origin to the map centre", () => {
    expect(metresToNormalizedMercator(0, 0)).toEqual([0.5, 0.5]);
  });

  it("round-trips with the tile store's own conversion", () => {
    // Madrid's Retiro, in metres, from the store's lonLatToMercator…
    const [mx, my] = lonLatToMercator(-3.7038, 40.4168);
    // …converted into the renderer's frame…
    const [nx, ny] = metresToNormalizedMercator(mx, my);
    // …must equal the renderer's own lngLatToMercator of the same point.
    const x = (-3.7038 + 180) / 360;
    const sinLat = Math.sin((40.4168 * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    expect(nx).toBeCloseTo(x, 12);
    expect(ny).toBeCloseTo(y, 12);
  });

  it("keeps the frames' shared y convention: 45°N is y < 0.5 in both", () => {
    // Normalized Mercator y runs south-growing (equator = 0.5), the same way
    // the metre frame runs north-positive — so both put 45°N at "less than
    // half". Pinning the real value: a sign flip here mirrors the world.
    const [mx, my] = lonLatToMercator(0, 45);
    const [, ny] = metresToNormalizedMercator(mx, my);
    expect(ny).toBeCloseTo(0.35972503691520497, 12);
    expect(ny).toBeLessThan(0.5);
  });

  it("keeps east positive", () => {
    const [mx] = lonLatToMercator(30, 0);
    const [nx] = metresToNormalizedMercator(mx, 0);
    expect(nx).toBeGreaterThan(0.5);
  });

  it("places a viewport-sized atlas inside NDC reach of its centre", () => {
    // The regression: an atlas bbox converted with the wrong convention
    // projected ~10⁹ units outside [-1, 1]. Two kilometres around Madrid —
    // a full atlas extent — must stay within a fraction of a normalized unit.
    const [cxM, cyM] = lonLatToMercator(-3.7038, 40.4168);
    const half = 1000; // metres
    const corners = [
      metresToNormalizedMercator(cxM - half, cyM - half),
      metresToNormalizedMercator(cxM + half, cyM + half),
    ];
    for (const [nx, ny] of corners) {
      expect(Math.abs(nx - 0.48971166666666666)).toBeLessThan(0.05); // Madrid's normalized x
      expect(Math.abs(ny - 0.3770631411512682)).toBeLessThan(0.05); // Madrid's normalized y
    }
  });

  it("is consistent with mercatorToLonLat for the converted point", () => {
    const [mx, my] = lonLatToMercator(-3.7038, 40.4168);
    const [nx, ny] = metresToNormalizedMercator(mx, my);
    // Normalized back to lon/lat through the renderer's inverse convention.
    const lon = nx * 360 - 180;
    const lat = (2 * Math.atan(Math.exp((0.5 - ny) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    expect(lon).toBeCloseTo(-3.7038, 6);
    expect(lat).toBeCloseTo(40.4168, 6);
    void mercatorToLonLat;
  });
});

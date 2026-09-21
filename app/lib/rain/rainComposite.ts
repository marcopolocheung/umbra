/**
 * Legacy raster-composite constants retained for compatibility tests.
 * Production rain surfaces use the shared blue protection palette in
 * LocalShadowAdapter and do not apply a wet/exposed inversion.
 */

export const RAIN_WET_RGB: [number, number, number] = [
  0x25 / 255,
  0x63 / 255,
  0xeb / 255,
];

/** Peak opacity the wet wash attains on a fully exposed (uncovered) spot. */
export const RAIN_WET_ALPHA = 0.35;

/**
 * Legacy colour helper; production wall/roof shading is objective agnostic.
 */
export function rainSurfaceColor(
  dry: [number, number, number],
  wet: [number, number, number],
  exposed: number,
  facing: number,
): [number, number, number] {
  const e = Math.max(0, Math.min(1, exposed));
  const dryScale = 0.82 + 0.18 * Math.max(-facing, 0);
  return [
    dry[0] * dryScale + e * (wet[0] - dry[0] * dryScale),
    dry[1] * dryScale + e * (wet[1] - dry[1] * dryScale),
    dry[2] * dryScale + e * (wet[2] - dry[2] * dryScale),
  ];
}

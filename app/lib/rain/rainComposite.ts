/**
 * The wet-paint constants the rain picture shares.
 *
 * `rainMapLayer.ts` tints the style-rendered ground wash with these, and Pass E
 * hands `RAIN_WET_RGB` to the 3D building pass so a fully exposed surface takes
 * exactly the wash colour. Peak alpha 0.5 read as solid blue in flat
 * screenshots; 0.30 was tried and read too faint next to shadow-strength
 * tinting. 0.35 keeps the basemap legible while the exposed streets stay blue.
 */

export const RAIN_WET_RGB: [number, number, number] = [
  0x25 / 255,
  0x63 / 255,
  0xeb / 255,
];

/** Peak opacity the wet wash attains on a fully exposed (uncovered) spot. */
export const RAIN_WET_ALPHA = 0.35;

/**
 * The wall/roof colour Pass E renders for the rain hazard — kept here so
 * "exposed = wet, dry = stone" is testable without a WebGL context.
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

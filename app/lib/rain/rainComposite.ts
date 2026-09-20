/**
 * The one-channel inverse the rain composite relies on.
 *
 * The coverage FBO stores alpha = wetAlpha × coverage and zero colour outside
 * the covered pixels. Taking the final RGB from the FBO therefore painted
 * transparent over every *uncovered* pixel — the whole exposed street — which
 * produced the blank canvas this module's test exists to prevent.
 *
 * Rain compositing: the tint is a constant (the wet blue), scaled by the
 * exposed share; coverage merely sets how much paint applies.
 */

export const RAIN_WET_RGB: [number, number, number] = [
  0x25 / 255,
  0x63 / 255,
  0xeb / 255,
];
/**
 * Peak opacity the wet wash attains on a fully exposed (uncovered) spot.
 * 0.5 read as solid blue in flat screenshots; 0.30 was tried and read too
 * faint next to shadow-strength tinting. 0.35 keeps the map legible while
 * the exposed streets stay blue at strength 35%.
 */
export const RAIN_WET_ALPHA = 0.35;

/**
 * Premultiplied fragment for the pass-D composite at a coverage reading.
 * Coverage 0 (open street) = full wet tint; coverage ≥ 1 (under a wall) = none.
 */
export function rainCompositeColor(coverage: number): [number, number, number, number] {
  const c = Math.max(0, Math.min(1, coverage));
  const exposed = Math.max(0, 1 - c);
  return [
    RAIN_WET_RGB[0] * RAIN_WET_ALPHA * exposed,
    RAIN_WET_RGB[1] * RAIN_WET_ALPHA * exposed,
    RAIN_WET_RGB[2] * RAIN_WET_ALPHA * exposed,
    RAIN_WET_ALPHA * exposed,
  ];
}

/**
 * The wall/roof colour Pass E renders for the rain hazard — the building-side
 * twin of `rainCompositeColor`, kept here so "exposed = wet, dry = stone" is
 * testable without a WebGL context.
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

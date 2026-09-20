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
export const RAIN_WET_ALPHA = 0.5;

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

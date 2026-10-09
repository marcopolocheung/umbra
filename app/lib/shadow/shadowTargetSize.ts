// Shadow-edge antialiasing via supersampling: the shadow FBO is rendered at
// SHADOW_SUPERSAMPLE× the canvas resolution, then box-downsampled by the LINEAR
// composite quad (Pass D). 2 = 4 samples/pixel. Cost is ~4× shadow fragment work
// and FBO memory, so the supersampled dimension is capped at SHADOW_FBO_MAX_DIM
// (per-axis) to avoid blowing past GPU limits / memory on hi-DPR displays.
export const SHADOW_SUPERSAMPLE = 2;
export const SHADOW_FBO_MAX_DIM = 4096;

/**
 * Device pixels per CSS pixel at or above which the canvas is not supersampled.
 * A 2× canvas already draws each CSS pixel with four, so a shadow edge is as smooth
 * there as a supersampled 1× one — and supersampling it again would mean ~5 million
 * pixels per pass on a phone (780×1688 canvas → 1560×3376), the device that can
 * least afford them.
 */
export const SUPERSAMPLE_BELOW_PIXEL_RATIO = 2;

/**
 * The shadow FBO size for a canvas. While the camera moves or the clock is being
 * scrubbed the passes render at 1× — a quarter of the fragment work, with aliased
 * edges for the length of the gesture — and the settled frame goes back to
 * SHADOW_SUPERSAMPLE×, antialiased. A high-density canvas (`pixelRatio`, device
 * pixels per CSS pixel, at least SUPERSAMPLE_BELOW_PIXEL_RATIO) stays at 1× always.
 */
export function shadowTargetSize(
  canvasWidth: number,
  canvasHeight: number,
  moving: boolean,
  pixelRatio = 1,
): { w: number; h: number } {
  const scale = moving || pixelRatio >= SUPERSAMPLE_BELOW_PIXEL_RATIO ? 1 : SHADOW_SUPERSAMPLE;
  return {
    w: Math.max(1, Math.min(canvasWidth * scale, SHADOW_FBO_MAX_DIM)),
    h: Math.max(1, Math.min(canvasHeight * scale, SHADOW_FBO_MAX_DIM)),
  };
}

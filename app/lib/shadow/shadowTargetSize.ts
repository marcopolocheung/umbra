// Shadow-edge antialiasing via supersampling: the shadow FBO is rendered at
// SHADOW_SUPERSAMPLE× the canvas resolution, then box-downsampled by the LINEAR
// composite quad (Pass D). 2 = 4 samples/pixel. Cost is ~4× shadow fragment work
// and FBO memory, so the supersampled dimension is capped at SHADOW_FBO_MAX_DIM
// (per-axis) to avoid blowing past GPU limits / memory on hi-DPR displays.
export const SHADOW_SUPERSAMPLE = 2;
export const SHADOW_FBO_MAX_DIM = 4096;

/**
 * The shadow FBO size for a canvas. While the camera moves the passes render at
 * 1× — a quarter of the fragment work, and edges blur in motion anyway — and the
 * settled frame goes back to SHADOW_SUPERSAMPLE×.
 */
export function shadowTargetSize(canvasWidth: number, canvasHeight: number, moving: boolean): { w: number; h: number } {
  const scale = moving ? 1 : SHADOW_SUPERSAMPLE;
  return {
    w: Math.max(1, Math.min(canvasWidth * scale, SHADOW_FBO_MAX_DIM)),
    h: Math.max(1, Math.min(canvasHeight * scale, SHADOW_FBO_MAX_DIM)),
  };
}

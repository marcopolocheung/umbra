/** Physical tolerance used when comparing a surface with the shadow ceiling. */
export const SHADOW_HEIGHT_BIAS_M = 0.05;

/**
 * Convert the fixed metre tolerance into the cached height field's [0, 1] scale.
 *
 * `maxHeightM` is the cache's `maxH`, which every producer already clamps to a
 * positive value (`prismsFromTileFeatures`, `prismsFromFootprints`, and the empty
 * cache all floor it at 1), so this does not re-check it — it runs once per frame
 * inside the custom layer's render.
 */
export function normalizedShadowHeightBias(maxHeightM: number): number {
  return SHADOW_HEIGHT_BIAS_M / maxHeightM;
}

/**
 * Height the ceiling threshold must rise by when the field is sampled
 * `sunwardOffsetM` metres toward the sun, in the field's [0, 1] scale.
 *
 * Inside any caster's shadow the ceiling is affine along the sun direction with
 * the same slope `tan(alt)`, so the relation survives the per-pixel MAX the field
 * is built with: `ceiling(P + sunHat·d) = ceiling(P) + d·tan(alt)`. Sampling `d`
 * sunward and comparing against a threshold raised by this amount is therefore
 * exactly equivalent to sampling at `P` — which is what lets the wall pass nudge
 * its sample out of its own footprint without moving where the shadow lands.
 *
 * The result is linear in the offset, so a caller combining several offsets can
 * call this once per constant and combine the results.
 *
 * No clamp on `tan(alt)` is needed at either end: as the sun reaches the horizon
 * the lift goes to zero with it, and as it reaches the zenith every wall faces
 * away from it and is shadowed by facing alone, whatever the lift says.
 */
export function normalizedCeilingLift(
  sunwardOffsetM: number,
  sunAltitudeRad: number,
  maxHeightM: number,
): number {
  return (sunwardOffsetM * Math.tan(sunAltitudeRad)) / maxHeightM;
}

/**
 * Widest the ceiling field may be zoomed out, as a multiple of the viewport's NDC
 * half-extent. The field keeps the framebuffer it already had, so every unit of
 * this costs a unit of ground resolution; past about this the terminator on a wall
 * starts to read as steps. Views that need more are clipped, exactly as they were
 * before, and `onScreen` in the building pass still catches them.
 */
export const MAX_CEILING_FIELD_SCALE = 4;

/**
 * How far past the viewport the shadow-ceiling field has to reach, in NDC.
 *
 * The field is indexed by *ground* position and rasterized in screen space, but the
 * building pass looks up a fragment that is drawn somewhere else entirely: a wall at
 * height `h` sits above its own footprint, and under a tilted camera that footprint
 * projects well below the fragment — for a near, tall building, off the bottom of the
 * viewport. The lookup then lands outside the field and the fragment renders lit,
 * whatever is actually shading it. That is what makes a shadow break where it should
 * cross from the street onto a wall.
 *
 * Rendering the field through a matrix whose clip x/y are divided by this scale
 * widens it to cover those footprints. The bound is exact rather than a guess:
 * ground → screen is a homography, and so is (ground raised to `maxHeightMerc`) →
 * screen, so composing one with the other's inverse maps a fragment's screen
 * position to its footprint's. A homography maps the viewport rectangle's corners to
 * the extremes of its image, so the four corners give the whole answer.
 *
 * `matrix` is the column-major mainMatrix the passes already share, and
 * `maxHeightMerc` is the cache's tallest building in the same mercator z the vertex
 * shaders use. Returns 1 (no widening, no resolution cost) for an untilted camera,
 * and never more than `MAX_CEILING_FIELD_SCALE` — including when the horizon crosses
 * the viewport and a corner maps to infinity.
 */
export function ceilingFieldScale(
  matrix: ArrayLike<number>,
  maxHeightMerc: number,
): number {
  // Nothing to reach back from: the viewport is its own answer.
  if (!(maxHeightMerc > 0)) return 1;

  // Rows are clip x, y, w; columns are ground X, Y, 1. Column 2 (mercator z) folds
  // into the constant column at the roofline, which is the only difference between
  // the two homographies.
  const ground = [
    matrix[0], matrix[4], matrix[12],
    matrix[1], matrix[5], matrix[13],
    matrix[3], matrix[7], matrix[15],
  ];
  const roof = [
    matrix[0], matrix[4], matrix[12] + maxHeightMerc * matrix[8],
    matrix[1], matrix[5], matrix[13] + maxHeightMerc * matrix[9],
    matrix[3], matrix[7], matrix[15] + maxHeightMerc * matrix[11],
  ];

  const roofInv = invert3(roof);
  if (!roofInv) return 1;

  let scale = 1;
  for (const [ndcX, ndcY] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const g = apply3(ground, apply3(roofInv, [ndcX, ndcY, 1]));
    // Behind the camera, or on the horizon: no finite footprint to cover.
    if (!(Math.abs(g[2]) > 1e-9)) return MAX_CEILING_FIELD_SCALE;
    const reach = Math.max(Math.abs(g[0] / g[2]), Math.abs(g[1] / g[2]));
    if (reach > scale) scale = reach;
  }
  return Math.min(scale, MAX_CEILING_FIELD_SCALE);
}

/** Row-major 3x3 inverse, or null when the matrix is singular. */
function invert3(m: number[]): number[] | null {
  const c0 = m[4] * m[8] - m[5] * m[7];
  const c1 = m[5] * m[6] - m[3] * m[8];
  const c2 = m[3] * m[7] - m[4] * m[6];
  const det = m[0] * c0 + m[1] * c1 + m[2] * c2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  return [
    c0 / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    c1 / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    c2 / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
}

/** Row-major 3x3 times a 3-vector. */
function apply3(m: number[], v: number[]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

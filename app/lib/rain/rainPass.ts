/**
 * Which painter passes make sense for the rain hazard.
 *
 * Passes B/C erase a caster's *own footprint* from the coverage FBO under the
 * assumption that a roof is lit even inside its neighbour's shadow. For rain
 * that assumption inverts: at vertical or shallow tilt the footprint itself is
 * precisely the sheltered ground, and erasing it blanks the canvas — a bug the
 * umbrella builds saw production-side before this module existed.
 */

/**
 * True when the roof-exclusion erase should run. Pure so the failure mode stays
 * pinned by a test instead of re-discovered in a screenshot.
 */
export function runRoofExclusion(rain: boolean, sunBelow: boolean, roofVertexCount: number): boolean {
  return !rain && !sunBelow && roofVertexCount > 0;
}

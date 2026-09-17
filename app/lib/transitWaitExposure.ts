/**
 * The sun a rider takes while waiting for a bus.
 *
 * Bus was worth building because of the wait. Manhattan's weekday median
 * headway is ten minutes, so the expected wait is five minutes standing still,
 * against four on a subway platform that is usually underground; at a bus's
 * ~9.7 km/h that is a quarter to a third of the journey, and none of it is
 * attenuated by a vehicle. Until now the card priced it from
 * `TRAIN_SUN_EXPOSURE.bus` — a constant per *mode*, which is exactly the kind
 * of claim #393 replaced for the ride itself.
 *
 * So the stop is sampled rather than assumed. A stop standing in a building's
 * shadow genuinely is shaded, and `ShadowField` can say so for a point and an
 * instant. What is *not* modelled is a shelter structure: GTFS carries no
 * shelter geometry, the producer publishes that assumption as a manifest note,
 * and `riderFacingNotes` puts it on the card in the producer's own words. It
 * stays a sentence beside the figure rather than a discount folded into it.
 */

import { LOW_CONFIDENCE, type ShadowSample } from "./shadowField/ShadowField";

export interface TransitWaitExposure {
  /** The stop the rider stands at, named as the feed names it. */
  stopName: string;
  /**
   * 0 = full sun, 1 = fully shadowed, sampled at the stop at the boarding
   * instant.
   *
   * **Absent means unknown, never shaded.** `ShadowField` reports `shadow: 0`
   * with `confidence: 0` when no source could speak for a point, and reading
   * that as shade — promising a rider shadow that was never measured — is the
   * inversion #393 was opened for.
   */
  shadow?: number;
}

/**
 * A sample, gated on confidence.
 *
 * Below `LOW_CONFIDENCE` the field is asking to be second-guessed, and there is
 * no second source for a single stationary point — the pixel sampler needs the
 * camera on it. So the honest answer is that the stop's sun is unknown, which
 * the card says in words. `null` is the same answer for a stop that was never
 * sampled at all.
 */
export function waitExposureFromSample(
  stopName: string,
  sample: ShadowSample | null,
): TransitWaitExposure {
  if (!sample || sample.confidence < LOW_CONFIDENCE) return { stopName };
  return { stopName, shadow: sample.shadow };
}

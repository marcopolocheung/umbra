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
 * So the stops are sampled rather than assumed. A stop standing in a building's
 * shadow genuinely is shaded, and `ShadowField` can say so for a point and an
 * instant. What is *not* modelled is a shelter structure: GTFS carries no
 * shelter geometry, the producer publishes that assumption as a manifest note,
 * and `riderFacingNotes` puts it on the card in the producer's own words. It
 * stays a sentence beside the figure rather than a discount folded into it.
 *
 * **Stops, plural.** A real bus answer boards more than once — a measured
 * midtown trip waits 6 min, 6 min and 3.5 min at three different stops — so one
 * stop's shadow cannot stand for the quoted wait. The seconds are what weight
 * it, for the same reason `railExposure` weights the ride by time: a rider's
 * dose is how long they stand in the sun, not how many times they stood.
 */

import { LOW_CONFIDENCE, type ShadowSample } from "./shadowField/ShadowField";

/** One boarding: how long the rider waits, and what the field said about there. */
export interface BoardingSample {
  waitSec: number;
  /** `null` when the stop was never sampled — the same answer as a refused one. */
  sample: ShadowSample | null;
}

export interface TransitWaitExposure {
  /**
   * Wait-seconds-weighted mean shadow over the boardings the field could
   * answer for. 0 = full sun, 1 = fully shadowed.
   *
   * **Absent means unknown, never shaded.** `ShadowField` reports `shadow: 0`
   * with a low confidence when no source can really speak for a point, and
   * reading that as shade — promising a rider shadow that was never measured —
   * is the inversion #393 was opened for.
   */
  shadow?: number;
  /** Rain objective equivalent: 0 exposed, 1 protected at the stop. */
  shelter?: number;
  /** Objective used for this wait measurement; absent means legacy sun data. */
  objective?: "sun" | "rain";
  /** Share of the waiting seconds that got a confident answer. */
  coverage: number;
  /** Waiting seconds with no confident geometry answer. */
  unknownSec?: number;
  /** How many times the rider boards, which is how the card words itself. */
  boardings: number;
}

/**
 * Below this, the wait is mostly unseen and the honest thing is to say so
 * rather than quote a percentage of the sliver that was measured. The same
 * floor, for the same reason, as `MIN_REPORTABLE_COVERAGE` on the ride.
 */
export const MIN_WAIT_COVERAGE = 0.6;

/**
 * How many unanswered boarding stops are worth a preload of their own.
 *
 * Each is an Overpass round trip on the route's critical path, and the waits
 * are sorted longest first, so the boardings that dominate the rider's standing
 * time are the ones that get looked up. The rest fall to `coverage`.
 */
export const MAX_STOP_PRELOADS = 3;

/**
 * The boardings, gated on confidence and weighted by their seconds.
 *
 * Below `LOW_CONFIDENCE` the field is asking to be second-guessed, and there is
 * no second source for a single stationary point — the pixel sampler would need
 * the camera on it. So such a boarding contributes no shadow and no coverage,
 * and if too little of the wait survives that, the answer is that the stops'
 * sun is unknown. `undefined` for a journey with no priced wait at all: there
 * is nothing to qualify.
 */
export function waitExposureFrom(boardings: BoardingSample[]): TransitWaitExposure | undefined {
  const totalSec = boardings.reduce((sum, b) => sum + b.waitSec, 0);
  if (totalSec <= 0) return undefined;

  let knownSec = 0;
  let shadowSec = 0;
  for (const { waitSec, sample } of boardings) {
    if (!sample || sample.confidence < LOW_CONFIDENCE) continue;
    knownSec += waitSec;
    shadowSec += waitSec * sample.shadow;
  }

  const coverage = knownSec / totalSec;
  const known = { coverage, boardings: boardings.length };
  if (coverage < MIN_WAIT_COVERAGE) return known;
  return { ...known, shadow: shadowSec / knownSec };
}

/** Rain twin of `waitExposureFrom`, preserving the same confidence gate. */
export interface ShelterBoardingSample {
  waitSec: number;
  shelter: number | null;
  confidence: number;
}

export function shelterWaitExposureFrom(
  boardings: ShelterBoardingSample[],
): TransitWaitExposure | undefined {
  const totalSec = boardings.reduce((sum, b) => sum + Math.max(0, b.waitSec), 0);
  if (totalSec <= 0) return undefined;
  let knownSec = 0;
  let shelterSec = 0;
  for (const boarding of boardings) {
    if (
      boarding.shelter == null ||
      !Number.isFinite(boarding.shelter) ||
      boarding.confidence < LOW_CONFIDENCE
    ) continue;
    const waitSec = Math.max(0, boarding.waitSec);
    knownSec += waitSec;
    shelterSec += waitSec * Math.max(0, Math.min(1, boarding.shelter));
  }
  const coverage = knownSec / totalSec;
  const result: TransitWaitExposure = {
    coverage,
    boardings: boardings.length,
    objective: "rain",
    unknownSec: totalSec - knownSec,
  };
  if (coverage >= MIN_WAIT_COVERAGE && knownSec > 0) result.shelter = shelterSec / knownSec;
  return result;
}

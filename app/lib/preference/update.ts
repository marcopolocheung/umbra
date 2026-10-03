/**
 * S2a — the browser entry point: population prior + observed picks → per-user
 * sun aversion α with an uncertainty band.
 *
 * `updatePreference` is a Laplace-mode MAP update: gradient ascent from the
 * prior mode over the user's picks, then an observed-information band. There
 * is no sampling loop, no training loop and no server round-trip — a handful
 * of deterministic iterations over a handful of picks. Cost is bounded by
 * `maxSteps` × picks and is single-digit milliseconds for realistic
 * histories, so it is safe to call on every route-card click (that call site
 * is S2b and is deliberately not in this module).
 */

import { fitAlphaMap, laplaceSigma, populationMeanAlpha } from "./model";
import { POPULATION_PRIOR } from "./prior";
import type { Pick, PopulationPrior, PreferenceFit } from "./types";

export { populationMeanAlpha } from "./model";
export { POPULATION_PRIOR } from "./prior";
export type { Pick, PopulationPrior, PreferenceFit, RouteOption } from "./types";

/**
 * Fit the user's sun aversion from their observed picks against the
 * population prior. With no picks, returns the population mean with the
 * population's own spread — the honest cold-start answer.
 */
export function updatePreference(
	picks: Pick[],
	prior: PopulationPrior = POPULATION_PRIOR,
): PreferenceFit {
	if (picks.length === 0) {
		return {
			alpha: populationMeanAlpha(prior),
			sigma: Math.sqrt(prior.alphaShape) / prior.alphaRate,
			n: 0,
		};
	}
	const alpha = fitAlphaMap(prior, picks);
	const sigma = laplaceSigma(prior, picks, alpha);
	return { alpha, sigma, n: picks.length };
}

/**
 * α rounded to two decimals — the disutility exchange rate (a metre of open
 * sun is worth α metres of distance to this user). Not the route-card's detour
 * rate: removing a sun metre saves the walking metre too, so the detour the
 * card states is `α−1` (`routeChoice.detourPerSunMinute`). Unused by the app;
 * kept as the model card's published number.
 */
export function detourPerSunM(fit: PreferenceFit): number {
	return Math.round(fit.alpha * 100) / 100;
}

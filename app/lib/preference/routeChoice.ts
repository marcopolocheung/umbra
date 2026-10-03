/**
 * S2b — turn a fitted sun aversion α into a default route and a stated trade.
 *
 * Pure and DOM-free: the wiring in `useRouting` owns storage and React state.
 * α comes from the shipped model (`updatePreference`); the stated sun-tolerance
 * slot wins over it, and the population prior is the cold start.
 */

import { populationMeanAlpha } from "./model";
import { POPULATION_PRIOR } from "./prior";
import { updatePreference } from "./update";
import type { Pick, PopulationPrior, PreferenceFit } from "./types";

/** One offered option, as the choice rule sees it. */
export interface ChoiceOption {
	distanceM: number;
	/** Share of the length in shade, 0–1. */
	shadowCoverage: number;
	/** Rain options are priced on shelter, not sun; the learned α does not apply. */
	objective?: "sun" | "rain";
	/** H2's traversal clock, when the option carries it. */
	totalTimeSec?: number;
	/** H2's sun-seconds objective, when the option carries it. */
	exposedDurationSec?: number;
}

/** Walking speed used to state the trade in minutes of sun. */
export const WALK_SPEED_MPS = 1.4;

/** The stated sun-tolerance slot's three values. High tolerance minds the sun
 * less, so a lower α; moderate is the population mean the model was fitted to. */
export function statedToleranceAlpha(tolerance: "low" | "moderate" | "high"): number {
	if (tolerance === "low") return 2.0;
	if (tolerance === "high") return 0.5;
	return populationMeanAlpha(POPULATION_PRIOR);
}

const clamp01 = (v: number): number =>
	Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

const hasClock = (option: ChoiceOption): boolean =>
	Number.isFinite(option.totalTimeSec) && Number.isFinite(option.exposedDurationSec);

/**
 * The model's cost in H2's clock: `travelSeconds + (α−1)·exposedSeconds`.
 * `α−1` is the detour rate — the extra seconds a walker accepts per second of
 * sun — because the cost is `distance + (α−1)·sun` in metres, and both scale
 * by the mode's speed.
 */
function costSeconds(option: ChoiceOption, alpha: number): number {
	return (
		(option.totalTimeSec as number) +
		(alpha - 1) * (option.exposedDurationSec as number)
	);
}

/** The model's cost in the source's metres: `α·sun + shade`. */
function costMetres(option: ChoiceOption, alpha: number): number {
	const distanceM = Number.isFinite(option.distanceM) ? Math.max(0, option.distanceM) : 0;
	const sunM = distanceM * (1 - clamp01(option.shadowCoverage));
	return alpha * sunM + (distanceM - sunM);
}

/** The model's cost for one option, lower preferred. */
export function routeChoiceCost(option: ChoiceOption, alpha: number): number {
	return hasClock(option) ? costSeconds(option, alpha) : costMetres(option, alpha);
}

/**
 * Index of the option this walker's α prefers. Rain options and options
 * without a shade reading are skipped; if none qualifies, 0 (the shortest,
 * H2's first representative) is the default.
 *
 * One unit for the whole set: the clock is used only when every considered
 * option carries it, so a mixed set can never compare seconds with metres.
 */
export function defaultRouteIndex(options: ChoiceOption[], alpha: number): number {
	const considered: number[] = [];
	for (let i = 0; i < options.length; i++) {
		const option = options[i];
		if (option.objective === "rain" || !Number.isFinite(option.shadowCoverage)) continue;
		considered.push(i);
	}
	if (considered.length === 0) return 0;
	const useClock = considered.every((i) => hasClock(options[i]));
	let best = considered[0];
	let bestCost = Number.POSITIVE_INFINITY;
	for (const i of considered) {
		const cost = useClock ? costSeconds(options[i], alpha) : costMetres(options[i], alpha);
		if (cost < bestCost) {
			bestCost = cost;
			best = i;
		}
	}
	return best;
}

export interface ResolvedPreference {
	fit: PreferenceFit;
	/** Where α came from — the stated slot wins over the learned picks. */
	source: "stated" | "learned" | "prior";
}

/** α for the current session: stated tolerance, else learned picks, else prior. */
export function resolvePreference(
	picks: Pick[],
	statedTolerance: "low" | "moderate" | "high" | null,
	prior: PopulationPrior = POPULATION_PRIOR,
): ResolvedPreference {
	if (statedTolerance) {
		return {
			fit: { alpha: statedToleranceAlpha(statedTolerance), sigma: 0, n: 0 },
			source: "stated",
		};
	}
	const fit = updatePreference(picks, prior);
	return { fit, source: picks.length > 0 ? "learned" : "prior" };
}

/**
 * Metres of detour this walker accepts to remove one minute of open sun.
 * The detour rate is `α−1` (the model prices a sun metre at α and a shade metre
 * at 1, so removing a sun metre saves the walking metre too); a minute of sun
 * at `speedMps` is `60·speedMps` sun metres.
 */
export function detourPerSunMinute(fit: PreferenceFit, speedMps = WALK_SPEED_MPS): number {
	return Math.max(0, Math.round((fit.alpha - 1) * 60 * speedMps));
}

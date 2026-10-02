/**
 * S2a — the hierarchical shade-preference logit, pure TypeScript.
 *
 * Refit of the pedestrian path-choice model of Melnikov et al., *Scientific
 * Reports* 2022 (data and analysis notebook public on OSF, aj4vk). Their
 * utility for one binary trial, in units of 100 m:
 *
 *   Δc = β_j · (Δsun) + (Δshade)     (A minus B, tree split by ρ:
 *    sun  = sun_lit + (1 − ρ)·tree
 *    shade = building + ρ·tree)
 *   P(choose A) = logit⁻¹(−Δc / τ)
 *
 * β_j (our α) is the per-walker sun aversion — how many metres of distance a
 * metre of open sun is worth — and is hierarchical across walkers:
 * α ~ Gamma(shape, rate) with the population hyperparameters the prior
 * carries. This module implements the *deterministic* analogue of their
 * PyMC fit: a MAP estimate by gradient ascent plus a Laplace band, so it can
 * run in the browser with no sampling loop and no training loop.
 *
 * Every exported quantity is cheap and bounded: a handful of gradient steps
 * over a handful of picks. `updatePreference` is the browser entry point.
 */

import type { Pick, PopulationPrior, RouteOption } from "./types";

/** Effective sun metres of an option, with tree credited at ρ of full shade. */
export function effectiveSunM(option: RouteOption, rho: number): number {
	return option.sunM + (1 - rho) * option.treeM;
}

/** Effective shade metres of an option (building shade + ρ of tree shade). */
export function effectiveShadeM(option: RouteOption, rho: number): number {
	return option.shadeM + rho * option.treeM;
}

/** Units: the model works in 100 m like the source, to keep gradients O(1). */
const SCALE = 100;

/**
 * Log-likelihood of one pick plus its gradient w.r.t. α.
 *
 * A pick of the chosen option over each rejected one is the set of implied
 * binary trials (chosen − rejected), each contributing
 *   log σ(−Δc(chosen, rejected)/τ)
 * with Δc = α·(sun_chosen − sun_rejected) + (shade_chosen − shade_rejected)
 * in 100 m units. Returns `[ll, dll/dα]`.
 */
export function pickLogLikelihood(
	pick: Pick,
	alpha: number,
	rho: number,
	tau: number,
): [number, number] {
	let ll = 0;
	let grad = 0;
	for (const rejected of pick.rejected) {
		const dSun =
			(effectiveSunM(pick.chosen, rho) - effectiveSunM(rejected, rho)) / SCALE;
		const dShade =
			(effectiveShadeM(pick.chosen, rho) - effectiveShadeM(rejected, rho)) /
			SCALE;
		// Choose-chosen logit: z = −Δc/τ with Δc = α·dSun + dShade.
		const z = -(alpha * dSun + dShade) / tau;
		// log σ(z) = −log(1 + e^{−z}), stable form.
		ll += z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z));
		// d/dα log σ(z) = σ(−z) · (−dSun/τ); σ(−z) = 1/(1+e^{z}).
		const pNotChoose = 1 / (1 + Math.exp(z)); // σ(−z) = P(rejected)
		grad -= (pNotChoose * dSun) / tau;
	}
	return [ll, grad];
}

/** log Gamma(x) — Lanczos, single precision is ample for this model. */
function logGamma(x: number): number {
	if (x < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	}
	x -= 1;
	const g = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526772013, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	let a = g[0];
	const t = x + 7.5;
	for (let i = 1; i < 9; i++) {
		a += g[i] / (x + i);
	}
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Digamma ψ(x) — series for small x, recurrence + asymptotic for large. */
function digamma(x: number): number {
	let result = 0;
	while (x < 6) {
		result -= 1 / x;
		x += 1;
	}
	const inv = 1 / x;
	const inv2 = inv * inv;
	result +=
		Math.log(x) -
		0.5 * inv -
		inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 / 204)));
	return result;
}

/** log pdf of the population Gamma prior on α, plus its derivative. */
function logGammaPrior(
	alpha: number,
	shape: number,
	rate: number,
): [number, number] {
	const lp =
		shape * Math.log(rate) - logGamma(shape) + (shape - 1) * Math.log(alpha) -
		rate * alpha;
	const dlp = (shape - 1) / alpha - rate;
	return [lp, dlp];
}

/** Second derivative of the log-likelihood of one pick w.r.t. α. */
function pickLogLikelihood2(
	pick: Pick,
	alpha: number,
	rho: number,
	tau: number,
): number {
	let h = 0;
	for (const rejected of pick.rejected) {
		const dSun =
			(effectiveSunM(pick.chosen, rho) - effectiveSunM(rejected, rho)) / SCALE;
		const dShade =
			(effectiveShadeM(pick.chosen, rho) - effectiveShadeM(rejected, rho)) /
			SCALE;
		const z = -(alpha * dSun + dShade) / tau;
		const s = 1 / (1 + Math.exp(-z)); // σ(z)
		// d²/dα² log σ(z) = −σ(z)σ(−z) (dSun/τ)²  (always ≤ 0)
		h -= (s * (1 - s) * dSun * dSun) / (tau * tau);
	}
	return h;
}

export interface MapOptions {
	/** Gradient-ascent step count. Defaults are tuned for < 20 picks. */
	maxSteps?: number;
	/** Initial α guess; defaults to the prior mode. */
	initialAlpha?: number;
}

/**
 * MAP fit of α for one user: the posterior argmax of
 *   Σᵢ log-likelihood(pickᵢ) + log Gamma prior(α)
 * by plain gradient ascent with backtracking, in log(α) space so α stays
 * positive. Deterministic, bounded (`maxSteps` iterations), no sampling —
 * this is the whole "training" and it is milliseconds.
 */
export function fitAlphaMap(
	prior: PopulationPrior,
	picks: Pick[],
	options: MapOptions = {},
): number {
	const maxSteps = options.maxSteps ?? 200;
	const mode = (prior.alphaShape - 1) / prior.alphaRate; // Gamma prior mode
	const objective = (alpha: number): [number, number] => {
		let ll = 0;
		let grad = 0;
		for (const pick of picks) {
			const [l, g] = pickLogLikelihood(pick, alpha, prior.rho, prior.tau);
			ll += l;
			grad += g;
		}
		const [lp, dlp] = logGammaPrior(alpha, prior.alphaShape, prior.alphaRate);
		return [ll + lp, grad + dlp];
	};
	// Ascend in log-space: d/d(log α) = α · d/dα
	let logAlpha = Math.log(Math.max(options.initialAlpha ?? mode, 1e-3));
	let step = 0.5;
	for (let i = 0; i < maxSteps; i++) {
		const alpha = Math.exp(logAlpha);
		const [f, df] = objective(alpha);
		const gLog = alpha * df;
		if (Math.abs(gLog) < 1e-8) break;
		// Backtracking line search on the log-α step.
		let moved = false;
		for (let t = 0; t < 20; t++) {
			const trial = Math.exp(logAlpha + step * gLog);
			const [fTrial] = objective(trial);
			if (fTrial >= f + 1e-12) {
				logAlpha += step * gLog;
				step = Math.min(step * 1.5, 0.5);
				moved = true;
				break;
			}
			step *= 0.5;
		}
		if (!moved || step < 1e-10) break;
	}
	return Math.exp(logAlpha);
}

/**
 * Laplace uncertainty: posterior σ² ≈ −1 / (d²/dα² log-posterior at the mode),
 * the observed-information shortcut. The prior curvature term is
 * −(shape−1)/α² from the log-Gamma, added to the (≤0) likelihood Hessian.
 */
export function laplaceSigma(
	prior: PopulationPrior,
	picks: Pick[],
	alphaMode: number,
): number {
	let h = 0;
	for (const pick of picks) {
		h += pickLogLikelihood2(pick, alphaMode, prior.rho, prior.tau);
	}
	h -= (prior.alphaShape - 1) / (alphaMode * alphaMode);
	if (h >= -1e-9) {
		// Flat tail: fall back to the prior variance so the band never collapses.
		return Math.sqrt(prior.alphaShape) / prior.alphaRate;
	}
	return Math.sqrt(-1 / h);
}

/**
 * Expected α under the Gamma population prior — the "population-mean α"
 * baseline this model must beat, and the no-picks answer for a new user.
 */
export function populationMeanAlpha(prior: PopulationPrior): number {
	return prior.alphaShape / prior.alphaRate;
}

/**
 * Predicted probability that `chosen` beats `rejected` under α — the
 * quantity the eval scores for accuracy and calibration.
 */
export function chooseProbability(
	chosen: RouteOption,
	rejected: RouteOption,
	alpha: number,
	rho: number,
	tau: number,
): number {
	const dSun = (effectiveSunM(chosen, rho) - effectiveSunM(rejected, rho)) / SCALE;
	const dShade =
		(effectiveShadeM(chosen, rho) - effectiveShadeM(rejected, rho)) / SCALE;
	const z = -(alpha * dSun + dShade) / tau;
	return 1 / (1 + Math.exp(-z));
}

export { digamma, logGamma };

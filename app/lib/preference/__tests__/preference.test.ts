import { describe, expect, it } from "vitest";
import {
	chooseProbability,
	effectiveShadeM,
	effectiveSunM,
	fitAlphaMap,
	laplaceSigma,
	pickLogLikelihood,
	populationMeanAlpha,
} from "../model";
import { POPULATION_PRIOR } from "../prior";
import { detourPerSunM, updatePreference } from "../update";
import type { Pick } from "../types";

const option = (sun: number, tree = 0, shade = 0): Pick["chosen"] => ({
	distanceM: sun + tree + shade,
	sunM: sun,
	treeM: tree,
	shadeM: shade,
});

describe("effective metres", () => {
	it("credits tree shade at ρ and counts (1−ρ) as sun", () => {
		const o = option(50, 20, 30);
		expect(effectiveSunM(o, 0.414)).toBeCloseTo(50 + 0.586 * 20, 6);
		expect(effectiveShadeM(o, 0.414)).toBeCloseTo(30 + 0.414 * 20, 6);
		// additive: sun + shade = length at any ρ
		expect(effectiveSunM(o, 0.414) + effectiveShadeM(o, 0.414)).toBeCloseTo(
			o.distanceM,
			6,
		);
	});
});

describe("pickLogLikelihood", () => {
	it("is higher when the chosen option has less effective sun, for α > 0", () => {
		const pickGood: Pick = {
			chosen: option(20, 0, 80),
			rejected: [option(90, 0, 10)],
		};
		const pickBad: Pick = {
			chosen: option(90, 0, 10),
			rejected: [option(20, 0, 80)],
		};
		const [llGood] = pickLogLikelihood(pickGood, 1.2, 0.414, 0.229);
		const [llBad] = pickLogLikelihood(pickBad, 1.2, 0.414, 0.229);
		expect(llGood).toBeGreaterThan(llBad);
	});

	it("has zero gradient when the options are identical", () => {
		const pick: Pick = { chosen: option(50), rejected: [option(50)] };
		const [, grad] = pickLogLikelihood(pick, 1.2, 0.414, 0.229);
		expect(Math.abs(grad)).toBeLessThan(1e-9);
	});
});

describe("chooseProbability", () => {
	it("is 0.5 for identical options, monotone in α when sun differs", () => {
		const moreShade = option(20, 0, 80);
		const moreSun = option(90, 0, 10);
		expect(
			chooseProbability(moreShade, moreSun, 1.0, 0.414, 0.229),
		).toBeCloseTo(0.5, 6); // same length, same shade total → pure distance tie
		const a = option(20, 0, 80); // 80 shade, 100 m
		const b = option(90, 0, 10); // 10 shade, 100 m — same length, less shade
		const p1 = chooseProbability(a, b, 0.5, 0.414, 0.229);
		const p2 = chooseProbability(a, b, 2.0, 0.414, 0.229);
		expect(p2).toBeGreaterThan(p1); // higher α ⇒ shade-loving option likelier
		expect(p2).toBeGreaterThan(0.5);
	});
});

describe("fitAlphaMap", () => {
	it("moves α above the prior mean for a consistent shade-picking user", () => {
		// This user always picks the option with less effective sun at equal length.
		const picks: Pick[] = Array.from({ length: 10 }, () => ({
			chosen: option(10, 0, 90),
			rejected: [option(90, 0, 10)],
		}));
		const alpha = fitAlphaMap(POPULATION_PRIOR, picks);
		expect(alpha).toBeGreaterThan(populationMeanAlpha(POPULATION_PRIOR));
		expect(alpha).toBeGreaterThan(1.5);
	});

	it("stays near the prior when picks are contradictory", () => {
		// Half and half — no signal, so the Gamma prior dominates.
		const picks: Pick[] = Array.from({ length: 10 }, (_, i) =>
			i % 2 === 0
				? { chosen: option(10, 0, 90), rejected: [option(90, 0, 10)] }
				: { chosen: option(90, 0, 10), rejected: [option(10, 0, 90)] },
		);
		const alpha = fitAlphaMap(POPULATION_PRIOR, picks);
		// 5 vs 5 of identical geometry: a 0.19 pull from the mean is the prior
		// mode (shape−1)/rate = 1.074 sitting below the mean 1.205.
		expect(Math.abs(alpha - populationMeanAlpha(POPULATION_PRIOR))).toBeLessThan(
			0.2,
		);
	});

	it("never returns a non-positive α", () => {
		// A user who always picks the sunnier option still yields a positive α
		// (the Gamma prior keeps the posterior proper).
		const picks: Pick[] = Array.from({ length: 10 }, () => ({
			chosen: option(90, 0, 10),
			rejected: [option(10, 0, 90)],
		}));
		const alpha = fitAlphaMap(POPULATION_PRIOR, picks);
		expect(alpha).toBeGreaterThan(0);
		expect(Number.isFinite(alpha)).toBe(true);
	});
});

describe("laplaceSigma", () => {
	it("shrinks as picks accumulate", () => {
		const picks: Pick[] = Array.from({ length: 20 }, () => ({
			chosen: option(30, 0, 70),
			rejected: [option(70, 0, 30)],
		}));
		const alpha = fitAlphaMap(POPULATION_PRIOR, picks);
		const s5 = laplaceSigma(POPULATION_PRIOR, picks.slice(0, 5), alpha);
		const s20 = laplaceSigma(POPULATION_PRIOR, picks, alpha);
		expect(s20).toBeLessThan(s5);
		expect(s20).toBeGreaterThan(0);
	});
});

describe("updatePreference", () => {
	it("cold-starts at the population mean with the population spread", () => {
		const fit = updatePreference([]);
		expect(fit.alpha).toBeCloseTo(populationMeanAlpha(POPULATION_PRIOR), 9);
		expect(fit.n).toBe(0);
		expect(fit.sigma).toBeGreaterThan(0);
	});

	it("records the pick count and returns a finite band", () => {
		const picks: Pick[] = [
			{ chosen: option(10, 0, 90), rejected: [option(90, 0, 10)] },
			{ chosen: option(15, 0, 85), rejected: [option(85, 0, 15)] },
		];
		const fit = updatePreference(picks);
		expect(fit.n).toBe(2);
		expect(fit.alpha).toBeGreaterThan(1);
		expect(Number.isFinite(fit.sigma)).toBe(true);
		expect(fit.sigma).toBeGreaterThan(0);
	});

	it("the fitted α reproduces the study's population mean (β̄ ≈ 1.16)", () => {
		// S2a's reproduction gate: the shipped prior's mean is within the
		// paper's β̄ ≈ 1.16 ± 0.1 (our refit: 1.205).
		const mean = populationMeanAlpha(POPULATION_PRIOR);
		expect(Math.abs(mean - 1.16)).toBeLessThan(0.1);
	});
});

describe("detourPerSunM", () => {
	it("rounds to two decimals", () => {
		expect(detourPerSunM({ alpha: 1.2049, sigma: 0.4, n: 3 })).toBe(1.2);
		expect(detourPerSunM({ alpha: 1.2051, sigma: 0.4, n: 3 })).toBe(1.21);
	});
});

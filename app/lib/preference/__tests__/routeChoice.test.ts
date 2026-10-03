import { describe, expect, it } from "vitest";
import { POPULATION_PRIOR } from "../prior";
import { populationMeanAlpha } from "../model";
import {
	type ChoiceOption,
	defaultRouteIndex,
	detourBandM,
	detourPerSunMinute,
	learnedTradeLine,
	resolvePreference,
	routeChoiceCost,
	statedToleranceAlpha,
	tradeIsDirectional,
} from "../routeChoice";
import { updatePreference } from "../update";
import type { Pick } from "../types";

const option = (sun: number, tree = 0, shade = 0): Pick["chosen"] => ({
	distanceM: sun + tree + shade,
	sunM: sun,
	treeM: tree,
	shadeM: shade,
});

/** The same request's two cards: a short open route and a shadier detour. */
const REQUEST: ChoiceOption[] = [
	{ distanceM: 1000, shadowCoverage: 0, objective: "sun" },
	{ distanceM: 1400, shadowCoverage: 0.8, objective: "sun" },
];

/** A history of choosing the shaded card over the open one, or vice versa. */
const history = (shadeLover: boolean, n = 12): Pick[] =>
	Array.from({ length: n }, () =>
		shadeLover
			? { chosen: option(10, 0, 90), rejected: [option(90, 0, 10)] }
			: { chosen: option(90, 0, 10), rejected: [option(10, 0, 90)] },
	);

describe("routeChoiceCost", () => {
	it("prefers the shorter route when its sun is not worth the detour", () => {
		// α = 1.2: 1.2·1000 = 1200 vs 1.2·280 + 1120 = 1456.
		expect(routeChoiceCost(REQUEST[0], 1.2)).toBeLessThan(routeChoiceCost(REQUEST[1], 1.2));
	});

	it("prefers the shaded detour for a sun-averse walker", () => {
		// α = 2.5: 2500 vs 700 + 1120 = 1820.
		expect(routeChoiceCost(REQUEST[1], 2.5)).toBeLessThan(routeChoiceCost(REQUEST[0], 2.5));
	});

	it("uses H2's traversal clock when the option carries it", () => {
		const withClock: ChoiceOption = {
			...REQUEST[1],
			totalTimeSec: 1000,
			exposedDurationSec: 200,
		};
		// 1000 + (α−1)·200 = 1000 + 0.2·200 = 1040.
		expect(routeChoiceCost(withClock, 1.2)).toBeCloseTo(1040, 6);
	});

	it("agrees between the clock and metres branches for a sun-loving α < 1", () => {
		const open: ChoiceOption = { distanceM: 1000, shadowCoverage: 0.5, objective: "sun" };
		const sunny: ChoiceOption = { distanceM: 1050, shadowCoverage: 0, objective: "sun" };
		const withClock = defaultRouteIndex(
			[
				{ ...open, totalTimeSec: 1000 / 1.4, exposedDurationSec: 500 / 1.4 },
				{ ...sunny, totalTimeSec: 1050 / 1.4, exposedDurationSec: 1050 / 1.4 },
			],
			0.6,
		);
		// α = 0.6: sun is cheaper than shade, so the sunnier longer route wins
		// in both units — the branches must not disagree about the direction.
		expect(withClock).toBe(1);
		expect(withClock).toBe(defaultRouteIndex([open, sunny], 0.6));
	});
});

describe("defaultRouteIndex", () => {
	it("defaults to the shortest option at the population mean", () => {
		expect(defaultRouteIndex(REQUEST, populationMeanAlpha(POPULATION_PRIOR))).toBe(0);
	});

	it("skips rain options and returns the shortest when nothing qualifies", () => {
		expect(defaultRouteIndex([{ ...REQUEST[1], objective: "rain" }], 2.5)).toBe(0);
	});

	it("uses one unit for a mixed set — never seconds against metres", () => {
		// The first option's clock (100 s) would win on the seconds branch while
		// the second (1400 m, 80% shade) wins on metres, so a per-option branch
		// would pick index 0 here; unifying on metres must pick index 1.
		const mixed: ChoiceOption[] = [
			{ ...REQUEST[0], totalTimeSec: 100, exposedDurationSec: 0 },
			REQUEST[1], // no clock
		];
		const metresOnly = mixed.map(({ totalTimeSec: _t, exposedDurationSec: _e, ...o }) => o);
		expect(defaultRouteIndex(mixed, 2.5)).toBe(1);
		expect(defaultRouteIndex(mixed, 2.5)).toBe(defaultRouteIndex(metresOnly, 2.5));
	});
});

describe("detourPerSunMinute", () => {
	it("states the trade as (α−1) metres of detour per minute of sun", () => {
		// α = 1.2 → 0.2 m/m × 60 s × 1.4 m/s ≈ 17 m.
		expect(detourPerSunMinute({ alpha: 1.2, sigma: 0, n: 0 })).toBe(17);
	});

	it("is signed — negative for a sun-loving walker, zero near indifference", () => {
		expect(detourPerSunMinute({ alpha: 0.6, sigma: 0, n: 0 })).toBe(-34);
		expect(detourPerSunMinute({ alpha: 1.001, sigma: 0, n: 0 })).toBe(0);
	});
});

describe("learnedTradeLine", () => {
	it("states the population prior as a population figure, no band", () => {
		expect(learnedTradeLine({ detourM: 17, bandM: 33, picks: 0, stated: false })).toBe(
			"Population default: about 17 m of detour per minute of sun",
		);
	});

	it("states a learned direction with its band once the band excludes zero", () => {
		expect(learnedTradeLine({ detourM: 30, bandM: 8, picks: 5, stated: false })).toBe(
			"Learned from your 5 route picks: about 30 m of detour per minute of sun (±8 m)",
		);
		expect(learnedTradeLine({ detourM: -20, bandM: 5, picks: 8, stated: false })).toBe(
			"Learned from your 8 route picks: you would rather walk in the sun",
		);
	});

	it("abstains while the band still crosses zero", () => {
		expect(learnedTradeLine({ detourM: 6, bandM: 33, picks: 1, stated: false })).toBe(
			"Learned from your 1 route pick: not enough picks yet to tell your shade preference",
		);
	});

	it("states a stated tolerance directly, with no band", () => {
		expect(learnedTradeLine({ detourM: 42, bandM: 0, picks: 0, stated: true })).toBe(
			"Your stated sun tolerance: about 42 m of detour per minute of sun",
		);
	});
});

describe("tradeIsDirectional / detourBandM", () => {
	it("is directional only when the ±1σ band sits on one side of zero", () => {
		expect(tradeIsDirectional(10, 3)).toBe(true);
		expect(tradeIsDirectional(-10, 3)).toBe(true);
		expect(tradeIsDirectional(2, 3)).toBe(false);
		expect(tradeIsDirectional(-2, 3)).toBe(false);
	});

	it("converts the fit's sigma to a band in metres per minute of sun", () => {
		expect(detourBandM({ alpha: 1.2, sigma: 0.4, n: 0 })).toBe(Math.round(0.4 * 84));
	});
});

describe("resolvePreference", () => {
	it("reports the population prior as the cold start", () => {
		const { fit, source } = resolvePreference([], null);
		expect(source).toBe("prior");
		expect(fit.n).toBe(0);
		expect(fit.alpha).toBeCloseTo(populationMeanAlpha(POPULATION_PRIOR), 6);
	});

	it("lets the stated sun-tolerance slot win over the learned picks", () => {
		const picks = history(true);
		const learned = resolvePreference(picks, null);
		expect(learned.source).toBe("learned");
		const stated = resolvePreference(picks, "low");
		expect(stated.source).toBe("stated");
		expect(stated.fit.alpha).toBe(statedToleranceAlpha("low"));
		expect(stated.fit.alpha).toBeGreaterThan(learned.fit.alpha);
	});
});

describe("S2b acceptance — two walkers, one request", () => {
	it("gives different default routes that trace to their own pick histories", () => {
		const shadeLover = updatePreference(history(true));
		const sunSeeker = updatePreference(history(false));
		// The two histories produce different α...
		expect(shadeLover.alpha).toBeGreaterThan(sunSeeker.alpha);

		const shadeIdx = defaultRouteIndex(REQUEST, shadeLover.alpha);
		const sunIdx = defaultRouteIndex(REQUEST, sunSeeker.alpha);
		// ...and that difference alone changes the default card.
		expect(shadeIdx).not.toBe(sunIdx);
		expect(shadeIdx).toBe(1); // the shaded detour
		expect(sunIdx).toBe(0); // the shortest route
	});
});

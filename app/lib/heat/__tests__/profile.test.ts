import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROFILE,
	type HeatProfile,
	PROFILE_STORAGE_KEY,
	heatScoreOffsetC,
	loadProfile,
	saveProfile,
	shadowWeight,
} from "../profile";
import { heatScore } from "../score";
import type { WeatherHour } from "../types";

const profile = (over: Partial<HeatProfile> = {}): HeatProfile => ({ ...DEFAULT_PROFILE, ...over });

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
	};
}

const hour = (over: Partial<WeatherHour> = {}): WeatherHour => ({
	time: new Date(Date.UTC(2026, 6, 15, 15)),
	uvIndex: 7,
	tempC: 30,
	humidityPct: 50,
	windMs: 2,
	windDirDeg: 180,
	windGustMs: 4,
	cloudPct: 10,
	apparentTempC: 33,
	shortwaveWm2: 700,
	...over,
});

describe("neutral defaults", () => {
	it("a fresh profile is the population default: no weight shift, no °C offset", () => {
		expect(shadowWeight(DEFAULT_PROFILE)).toBeCloseTo(0.5, 6);
		expect(heatScoreOffsetC(DEFAULT_PROFILE)).toBe(0);
	});
});

describe("persistence", () => {
	it("round-trips a saved profile", () => {
		const storage = memoryStorage();
		const p = profile({ skinType: "II", heatTolerance: "low", burnsEasily: true });
		expect(saveProfile(p, storage)).toBe(true);
		expect(loadProfile(storage)).toEqual(p);
	});

	it("falls back to the defaults with no storage or a corrupt payload", () => {
		expect(loadProfile(undefined)).toEqual(DEFAULT_PROFILE);
		const storage = memoryStorage();
		storage.setItem(PROFILE_STORAGE_KEY, "{not json");
		expect(loadProfile(storage)).toEqual(DEFAULT_PROFILE);
	});

	it("rejects an out-of-range stored value field-by-field", () => {
		const storage = memoryStorage();
		storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ skinType: "IX", heatTolerance: "extreme", burnsEasily: "yes" }));
		expect(loadProfile(storage)).toEqual(DEFAULT_PROFILE);
	});
});

describe("shadowWeight", () => {
	it("shifts with heat tolerance and the toggles, clamped to [0, 1]", () => {
		expect(shadowWeight(profile({ heatTolerance: "low" }))).toBeCloseTo(0.7, 6);
		expect(shadowWeight(profile({ heatTolerance: "high" }))).toBeCloseTo(0.3, 6);
		expect(shadowWeight(profile({ burnsEasily: true }))).toBeCloseTo(0.65, 6);
		expect(shadowWeight(profile({ overheatsEasily: true }))).toBeCloseTo(0.65, 6);
		expect(shadowWeight(profile({ heatTolerance: "low", burnsEasily: true, overheatsEasily: true }))).toBe(1);
		expect(shadowWeight(profile({ heatTolerance: "high" }))).toBeCloseTo(0.3, 6);
	});
});

describe("heatScoreOffsetC", () => {
	it("is a small signed offset: +3 low, −3 high, +2 for overheating", () => {
		expect(heatScoreOffsetC(profile({ heatTolerance: "low" }))).toBe(3);
		expect(heatScoreOffsetC(profile({ heatTolerance: "high" }))).toBe(-3);
		expect(heatScoreOffsetC(profile({ overheatsEasily: true }))).toBe(2);
		expect(heatScoreOffsetC(profile({ heatTolerance: "low", overheatsEasily: true }))).toBe(5);
	});
});

describe("heatScore with a profile", () => {
	const exposure = { sunMinutes: 20, shadowMinutes: 10 };

	it("scores a heat-sensitive walker higher than neutral, and a tolerant one lower", () => {
		const neutral = heatScore(exposure, hour(), null).score;
		const sensitive = heatScore(exposure, hour(), profile({ heatTolerance: "low", overheatsEasily: true })).score;
		const tolerant = heatScore(exposure, hour(), profile({ heatTolerance: "high" })).score;
		expect(sensitive).toBeGreaterThan(neutral);
		expect(tolerant).toBeLessThan(neutral);
	});

	it("leaves a shadow-only score unchanged — there is no felt temperature to offset", () => {
		const noWeather = hour({ apparentTempC: null, tempC: null, shortwaveWm2: null });
		const neutral = heatScore(exposure, noWeather, null).score;
		const sensitive = heatScore(exposure, noWeather, profile({ heatTolerance: "low" })).score;
		expect(neutral).toBe(sensitive);
	});
});

import { describe, expect, it } from "vitest";
import {
	MAX_STORED_PICKS,
	PICK_STORAGE_KEY,
	createPickStore,
	optionFromRoute,
	pickFromRoutes,
} from "../pickStore";
import type { Pick } from "../types";

const option = (sun: number, tree = 0, shade = 0): Pick["chosen"] => ({
	distanceM: sun + tree + shade,
	sunM: sun,
	treeM: tree,
	shadeM: shade,
});

const aPick = (n = 0): Pick => ({
	chosen: option(10 + n, 0, 90),
	rejected: [option(90, 0, 10 + n)],
});

/** In-memory Storage for tests; the store never touches real localStorage. */
function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
}

describe("optionFromRoute", () => {
	it("splits length into sun and shade, counting all shade as building shade", () => {
		const o = optionFromRoute({ distanceM: 200, shadowCoverage: 0.25 });
		expect(o.sunM).toBeCloseTo(150, 6);
		expect(o.shadeM).toBeCloseTo(50, 6);
		expect(o.treeM).toBe(0);
		expect(o.sunM + o.shadeM).toBeCloseTo(o.distanceM, 6);
	});

	it("treats a missing or out-of-range share as fully open", () => {
		expect(optionFromRoute({ distanceM: 100, shadowCoverage: Number.NaN }).sunM).toBe(100);
		expect(optionFromRoute({ distanceM: 100, shadowCoverage: 2 }).shadeM).toBe(100);
	});
});

describe("pickFromRoutes", () => {
	const sunRoutes = [
		{ distanceM: 1000, shadowCoverage: 0, objective: "sun" as const },
		{ distanceM: 1200, shadowCoverage: 0.8, objective: "sun" as const },
	];

	it("builds the chosen option against the other sun-priced options", () => {
		const pick = pickFromRoutes(sunRoutes, 1);
		expect(pick).not.toBeNull();
		expect(pick?.chosen.shadeM).toBeCloseTo(960, 6);
		expect(pick?.rejected).toHaveLength(1);
		expect(pick?.rejected[0].sunM).toBeCloseTo(1000, 6);
	});

	it("excludes rain options from the rejected set", () => {
		const pick = pickFromRoutes(
			[...sunRoutes, { distanceM: 900, shadowCoverage: 0, objective: "rain" as const }],
			0,
		);
		expect(pick?.rejected).toHaveLength(1);
	});

	it("returns null for a rain card, a single option, or a missing reading", () => {
		expect(pickFromRoutes([{ distanceM: 1, shadowCoverage: 0, objective: "rain" }], 0)).toBeNull();
		expect(pickFromRoutes([{ distanceM: 1, shadowCoverage: 0, objective: "sun" }], 0)).toBeNull();
		expect(
			pickFromRoutes([{ distanceM: 1, shadowCoverage: Number.NaN, objective: "sun" }], 0),
		).toBeNull();
	});
});

describe("createPickStore", () => {
	it("round-trips picks and appends oldest-first", () => {
		const store = createPickStore(memoryStorage());
		store.record(aPick(0));
		store.record(aPick(1));
		const loaded = store.load();
		expect(loaded).toHaveLength(2);
		expect(loaded[0].chosen.shadeM).toBe(90);
		expect(loaded[1].chosen.shadeM).toBe(90);
		expect(loaded[1].chosen.sunM).toBe(11);
	});

	it("keeps only the most recent picks past the bound", () => {
		const store = createPickStore(memoryStorage());
		for (let i = 0; i < MAX_STORED_PICKS + 5; i++) store.record(aPick(i));
		expect(store.load()).toHaveLength(MAX_STORED_PICKS);
	});

	it("tolerates a corrupt payload", () => {
		const storage = memoryStorage();
		storage.setItem(PICK_STORAGE_KEY, "{not json");
		expect(createPickStore(storage).load()).toEqual([]);
	});

	it("drops entries whose shape is not a pick", () => {
		const storage = memoryStorage();
		storage.setItem(PICK_STORAGE_KEY, JSON.stringify([aPick(), { chosen: { sunM: 1 } }]));
		expect(createPickStore(storage).load()).toHaveLength(1);
	});

	it("clears every pick on reset", () => {
		const store = createPickStore(memoryStorage());
		store.record(aPick());
		store.clear();
		expect(store.load()).toEqual([]);
	});

	it("no-ops without a storage backend", () => {
		const store = createPickStore(undefined);
		expect(() => store.record(aPick())).not.toThrow();
		expect(store.load()).toEqual([]);
	});
});

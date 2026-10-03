/**
 * S2b — the user's observed route-card picks, kept in localStorage beside
 * saved routes.
 *
 * A pick is one observed choice: the card the walker chose against the other
 * cards the same request offered, each reduced to the model's metres. The
 * store is bounded — the model needs tens of picks, not thousands — and
 * tolerant of a missing or corrupt payload, because it sits on the same
 * storage the rest of the app writes.
 */

import type { Pick, RouteOption } from "./types";

export const PICK_STORAGE_KEY = "umbra:routePicks";

/** The model needs tens of picks, not thousands; keep the most recent. */
export const MAX_STORED_PICKS = 50;

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

/**
 * Map a routed option to the model's metres.
 *
 * A `RouteOption` reports only the shaded share of its length, not the
 * tree/building split, so all shade is counted as building shade (treeM = 0).
 * Nothing is lost: the model's cost `α·sun + shade` is invariant to that split,
 * because effective sun + effective shade = length at any ρ.
 */
export function optionFromRoute(route: {
	distanceM: number;
	shadowCoverage: number;
}): RouteOption {
	const distanceM = Number.isFinite(route.distanceM) ? Math.max(0, route.distanceM) : 0;
	const share = Number.isFinite(route.shadowCoverage)
		? Math.min(1, Math.max(0, route.shadowCoverage))
		: 0;
	return {
		distanceM,
		sunM: distanceM * (1 - share),
		treeM: 0,
		shadeM: distanceM * share,
	};
}

/**
 * The pick a card selection implies: the chosen option against the other
 * sun-priced options from the same request, or null when there is no sun
 * choice to learn from (a rain card, a single option, or a missing shade
 * reading).
 */
export function pickFromRoutes(
	routes: Array<{ distanceM: number; shadowCoverage: number; objective?: "sun" | "rain" }>,
	index: number,
): Pick | null {
	const chosen = routes[index];
	if (!chosen || chosen.objective === "rain" || !Number.isFinite(chosen.shadowCoverage)) {
		return null;
	}
	const rejected = routes.filter(
		(o, i) => i !== index && o.objective !== "rain" && Number.isFinite(o.shadowCoverage),
	);
	if (rejected.length === 0) return null;
	return { chosen: optionFromRoute(chosen), rejected: rejected.map(optionFromRoute) };
}

const isRouteOption = (v: unknown): v is RouteOption => {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.distanceM === "number" &&
		typeof o.sunM === "number" &&
		typeof o.treeM === "number" &&
		typeof o.shadeM === "number"
	);
};

const isPick = (v: unknown): v is Pick => {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	return isRouteOption(p.chosen) && Array.isArray(p.rejected) && p.rejected.every(isRouteOption);
};

/** Injectable for tests. Defaults to the browser's localStorage. */
export function createPickStore(storage: StorageLike | undefined = globalThis.localStorage) {
	const read = (): Pick[] => {
		if (!storage) return [];
		try {
			const raw = storage.getItem(PICK_STORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed.filter(isPick) : [];
		} catch {
			return [];
		}
	};
	return {
		/** Every stored pick, oldest first. */
		load: read,
		/** Append one pick, dropping the oldest past the bound. */
		record(pick: Pick): void {
			if (!storage) return;
			const next = [...read(), pick].slice(-MAX_STORED_PICKS);
			try {
				storage.setItem(PICK_STORAGE_KEY, JSON.stringify(next));
			} catch {
				// full storage: refuse, keep the in-memory truth
			}
		},
		/** Forget every pick — the route card's reset. */
		clear(): void {
			if (!storage) return;
			try {
				if (storage.removeItem) storage.removeItem(PICK_STORAGE_KEY);
				else storage.setItem(PICK_STORAGE_KEY, "[]");
			} catch {
				// refused; the stored copy stands
			}
		},
	};
}

export type PickStore = ReturnType<typeof createPickStore>;

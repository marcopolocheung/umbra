/**
 * D5 — the personal profile: the same route is a different problem for
 * different people.
 *
 * Local-only, no accounts (ROADMAP "Not doing"). The profile is a small typed
 * record with neutral defaults, persisted in `localStorage` beside saved routes.
 * Nothing here is transmitted anywhere; the only reader is the browser.
 *
 * The profile feeds three things: `dose()` (skin type → the burn fraction),
 * `heatScore()` (heat tolerance → how hard the trip feels) and the routing
 * shadow weight (how much shade the default card favours). `pace` is deliberately
 * NOT here yet — overriding the mode speed is a routing-cost change (Track E's
 * profiles), filed rather than half-wired.
 */

import type { SkinType } from "./types";

/** How much a walker minds the heat, independent of skin type. */
export type HeatTolerance = "low" | "moderate" | "high";

export interface HeatProfile {
  /** Fitzpatrick phototype; feeds `dose()`. */
  skinType: SkinType;
  /** Feeds `heatScore()`. */
  heatTolerance: HeatTolerance;
  /** A stated "I burn easily" — nudges the routing shadow weight up. */
  burnsEasily: boolean;
  /** A stated "I overheat" — nudges the heat score and the shadow weight up. */
  overheatsEasily: boolean;
}

/**
 * Neutral defaults: nothing is assumed about the person until they say it. A
 * middle skin type with moderate tolerance reproduces the population-mean
 * behaviour, so a first-time user sees the same numbers as before D5.
 */
export const DEFAULT_PROFILE: HeatProfile = {
  skinType: "III",
  heatTolerance: "moderate",
  burnsEasily: false,
  overheatsEasily: false,
};

export const PROFILE_STORAGE_KEY = "umbra:heatProfile";

const SKIN_TYPES: SkinType[] = ["I", "II", "III", "IV", "V", "VI"];
const TOLERANCES: HeatTolerance[] = ["low", "moderate", "high"];

/** Validate an untrusted stored payload back into a profile, tolerating junk. */
function coerce(value: unknown): HeatProfile {
	if (typeof value !== "object" || value === null) return { ...DEFAULT_PROFILE };
	const o = value as Record<string, unknown>;
	return {
		skinType: SKIN_TYPES.includes(o.skinType as SkinType)
			? (o.skinType as SkinType)
			: DEFAULT_PROFILE.skinType,
		heatTolerance: TOLERANCES.includes(o.heatTolerance as HeatTolerance)
			? (o.heatTolerance as HeatTolerance)
			: DEFAULT_PROFILE.heatTolerance,
		burnsEasily: o.burnsEasily === true,
		overheatsEasily: o.overheatsEasily === true,
	};
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Read the profile, tolerating a missing or corrupt payload. */
export function loadProfile(storage: StorageLike | undefined = globalThis.localStorage): HeatProfile {
	if (!storage) return { ...DEFAULT_PROFILE };
	try {
		const raw = storage.getItem(PROFILE_STORAGE_KEY);
		return raw ? coerce(JSON.parse(raw)) : { ...DEFAULT_PROFILE };
	} catch {
		return { ...DEFAULT_PROFILE };
	}
}

/** Persist the profile. Returns false when storage refuses (full/blocked). */
export function saveProfile(
	profile: HeatProfile,
	storage: StorageLike | undefined = globalThis.localStorage,
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
		return true;
	} catch {
		return false;
	}
}

/**
 * The routing shadow weight the profile implies, in [0, 1]: the default card
 * favours shade more as the weight rises (it is the same scale as the manual
 * "Fastest / Balanced / Most shade" preference). Neutral defaults give 0.5, so
 * a user who never opens the profile sees the pre-D5 default.
 *
 * The contributions are small and additive: a stated low heat tolerance adds
 * 0.2, "I burn easily" 0.15, "I overheat" 0.15. These are product choices, not
 * measurements, and the manual slider always overrides them.
 */
export function shadowWeight(profile: HeatProfile): number {
	let weight = 0.5;
	if (profile.heatTolerance === "low") weight += 0.2;
	else if (profile.heatTolerance === "high") weight -= 0.2;
	if (profile.burnsEasily) weight += 0.15;
	if (profile.overheatsEasily) weight += 0.15;
	return Math.min(1, Math.max(0, weight));
}

/**
 * Felt-temperature offset (°C) the heat profile implies, added to the score's
 * modelled felt temperature. Small and bounded: a heat-sensitive walker is
 * modelled as feeling the trip a few degrees warmer, a heat-tolerant one a few
 * cooler. This is a stated product assumption, not a measurement — no dataset
 * ties a tolerance label to a °C offset — so it is deliberately coarse (±3 °C,
 * plus 2 °C for a stated "I overheat"). It only applies where the score has a
 * felt temperature; a shadow-only score has no temperature to offset.
 */
export function heatScoreOffsetC(profile: HeatProfile): number {
	let offset = 0;
	if (profile.heatTolerance === "low") offset += 3;
	else if (profile.heatTolerance === "high") offset -= 3;
	if (profile.overheatsEasily) offset += 2;
	return offset;
}

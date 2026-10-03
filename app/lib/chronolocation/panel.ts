/**
 * S4b — the pure logic behind the chronolocation panel.
 *
 * The panel is photo intake, three marks, and a result; everything that can be
 * decided without the DOM lives here so it can be tested on its own. The solver
 * itself is `./solver` (S4a) and is not duplicated.
 */

import type {
	ChronolocationResult,
	DateCandidate,
	MarksError,
	PhotoPoint,
	ShadowMarks,
} from "./solver";

/** The three marks, in the order the panel asks for them. */
export type MarkSlot = keyof ShadowMarks;
export const MARK_ORDER: readonly MarkSlot[] = ["top", "base", "shadowTip"];

export const MARK_LABELS: Record<MarkSlot, string> = {
	top: "the object's top",
	base: "the object's base",
	shadowTip: "the shadow's tip",
};

/**
 * The mark the next tap sets: the first unset one. Once all three are placed,
 * `nearestMarkSlot` decides which one a tap moves.
 */
export function nextMarkSlot(marks: Partial<ShadowMarks>): MarkSlot {
	return MARK_ORDER.find((slot) => marks[slot] === undefined) ?? "top";
}

/** Is there a complete set of marks? */
export function hasAllMarks(marks: Partial<ShadowMarks>): marks is ShadowMarks {
	return MARK_ORDER.every((slot) => marks[slot] !== undefined);
}

/** The mark a tap moves once all three are set: the one nearest the tap. */
export function nearestMarkSlot(marks: ShadowMarks, point: PhotoPoint): MarkSlot {
	let best: MarkSlot = "top";
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const slot of MARK_ORDER) {
		const mark = marks[slot];
		const distance = (mark.x - point.x) ** 2 + (mark.y - point.y) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = slot;
		}
	}
	return best;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A tap on the rendered photo → natural-pixel coordinates. The image is scaled
 * to fit the panel, so the click is mapped through its box back to the photo's
 * own width/height and clamped to the frame.
 */
export function pixelFromClick(
	rect: { left: number; top: number; width: number; height: number },
	natural: { width: number; height: number },
	clientX: number,
	clientY: number,
): PhotoPoint {
	const x = rect.width > 0 ? ((clientX - rect.left) / rect.width) * natural.width : 0;
	const y = rect.height > 0 ? ((clientY - rect.top) / rect.height) * natural.height : 0;
	return { x: clamp(x, 0, natural.width), y: clamp(y, 0, natural.height) };
}

const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "3–21 Jun" or "28 May – 14 Jun"; the year only when it differs from `year`. */
function formatDayRange(start: Date, end: Date, year: number): string {
	const d = (date: Date): string => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
	if (start.getUTCFullYear() !== end.getUTCFullYear()) {
		return `${d(start)} ${start.getUTCFullYear()} – ${d(end)} ${end.getUTCFullYear()}`;
	}
	const span = `${d(start)} – ${d(end)}`;
	return start.getUTCFullYear() === year ? span : `${span}, ${start.getUTCFullYear()}`;
}

const clock = (minutes: number): string => {
	const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** One candidate as the two honest facts: a window of days and a band of minutes. */
export function formatCandidate(candidate: DateCandidate, year: number): string {
	const range = formatDayRange(candidate.startDate, candidate.endDate, year);
	const band = `${clock(candidate.startMin)}–${clock(candidate.endMin)}`;
	const conflict = candidate.crossCheck.kind === "conflict" ? " — building shadow in frame, treat with care" : "";
	return `${range}, about ${band}${conflict}`;
}

const ABSTAIN_TEXT: Record<
	Extract<ChronolocationResult, { kind: "abstain" }>["reason"],
	string
> = {
	overcast: "Overcast or diffuse light — there is no measurable shadow to date.",
	"no-measurable-shadow": "The shadow tip sits on the object's base, so no shadow was marked.",
	"ambiguous-geometry": "The shadow does not pin the season — more than two windows match. Mark a clearer, nearer shadow.",
	"no-match": "No instant this year matches the marked shadow.",
};

const MARKS_ERROR_TEXT: Record<MarksError, string> = {
	"no-object-height": "The top mark must sit above the base on the object.",
	"no-shadow-length": "The shadow tip must sit away from the object's base.",
};

/**
 * The panel's answer as plain lines. Never a single date: the physics gives
 * windows of days and a band of minutes, and the panel says so.
 */
export function describeResult(
	result: ChronolocationResult | { error: MarksError },
	year: number,
	/** Civil offset (minutes east of UTC), for the near-miss instant's local date. */
	utcOffsetMin = 0,
): string[] {
	if ("error" in result) return [MARKS_ERROR_TEXT[result.error]];
	switch (result.kind) {
		case "solved":
			return [
				"Two windows match (every sun position recurs on two dates a year):",
				...result.candidates.map((c) => formatCandidate(c, year)),
			];
		case "single-date":
			return [
				"One window matches — the photo falls near a solstice, where the two windows merge:",
				formatCandidate(result.candidate, year),
			];
		case "abstain":
			return [ABSTAIN_TEXT[result.reason]];
		case "no-match": {
			if (!result.nearest) return ["No instant this year matches the marked shadow."];
			const local = new Date(result.nearest.date.getTime() + utcOffsetMin * 60000);
			return [
				"No instant this year matches the marked shadow.",
				`Nearest match: ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`,
			];
		}
	}
}

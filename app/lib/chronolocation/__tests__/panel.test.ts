import { describe, expect, it } from "vitest";
import {
	type MarkSlot,
	describeResult,
	formatCandidate,
	hasAllMarks,
	nearestMarkSlot,
	nextMarkSlot,
	pixelFromClick,
} from "../panel";
import type { ChronolocationResult, DateCandidate } from "../solver";

const instant = (date: Date) => ({ date, azimuthErrorDeg: 0.2, lengthErrorRel: 0.01 });

const candidate = (overrides: Partial<DateCandidate> = {}): DateCandidate => ({
	date: new Date(Date.UTC(2026, 5, 10)),
	startDate: new Date(Date.UTC(2026, 5, 3)),
	endDate: new Date(Date.UTC(2026, 5, 21)),
	startMin: 14 * 60 + 5,
	endMin: 14 * 60 + 21,
	best: instant(new Date(Date.UTC(2026, 5, 10, 14, 12))),
	crossCheck: { kind: "no-coverage" },
	...overrides,
});

describe("mark sequencing", () => {
	it("asks for the first unset mark", () => {
		expect(nextMarkSlot({})).toBe<MarkSlot>("top");
		expect(nextMarkSlot({ top: { x: 0, y: 0 } })).toBe<MarkSlot>("base");
		expect(nextMarkSlot({ top: { x: 0, y: 0 }, base: { x: 1, y: 1 } })).toBe<MarkSlot>("shadowTip");
	});

	it("knows when all three marks are placed", () => {
		expect(hasAllMarks({ top: { x: 0, y: 0 } })).toBe(false);
		expect(
			hasAllMarks({ top: { x: 0, y: 0 }, base: { x: 1, y: 1 }, shadowTip: { x: 2, y: 2 } }),
		).toBe(true);
	});

	it("moves the nearest mark once all three are set", () => {
		const full = { top: { x: 10, y: 10 }, base: { x: 100, y: 100 }, shadowTip: { x: 200, y: 40 } };
		expect(nearestMarkSlot(full, { x: 95, y: 96 })).toBe<MarkSlot>("base");
		expect(nearestMarkSlot(full, { x: 205, y: 38 })).toBe<MarkSlot>("shadowTip");
		expect(nearestMarkSlot(full, { x: 0, y: 0 })).toBe<MarkSlot>("top");
	});
});

describe("pixelFromClick", () => {
	it("maps a tap through the rendered box back to natural pixels", () => {
		// A 2000×1000 photo shown at half size in a box offset at (100, 50).
		const rect = { left: 100, top: 50, width: 1000, height: 500 };
		expect(pixelFromClick(rect, { width: 2000, height: 1000 }, 600, 300)).toEqual({
			x: 1000,
			y: 500,
		});
	});

	it("clamps a tap outside the frame to the photo edges", () => {
		const rect = { left: 0, top: 0, width: 100, height: 100 };
		expect(pixelFromClick(rect, { width: 200, height: 200 }, -50, 500)).toEqual({ x: 0, y: 200 });
	});
});

describe("formatCandidate", () => {
	it("states a window of days and a band of minutes", () => {
		expect(formatCandidate(candidate(), 2026)).toBe("3 Jun – 21 Jun, about 14:05–14:21");
	});

	it("flags a candidate with building shadow in frame", () => {
		expect(
			formatCandidate(candidate({ crossCheck: { kind: "conflict", shadowedMinutes: [14 * 60 + 10] } }), 2026),
		).toContain("building shadow in frame");
	});
});

describe("describeResult", () => {
	it("reports two windows for a solved photo, never a single date", () => {
		const solved: ChronolocationResult = {
			kind: "solved",
			candidates: [
				candidate(),
				candidate({ startDate: new Date(Date.UTC(2026, 6, 1)), endDate: new Date(Date.UTC(2026, 6, 20)) }),
			],
		};
		const lines = describeResult(solved, 2026);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("two dates a year");
	});

	it("explains an abstention rather than guessing", () => {
		expect(describeResult({ kind: "abstain", reason: "overcast" }, 2026)[0]).toContain("Overcast");
		expect(describeResult({ kind: "abstain", reason: "ambiguous-geometry" }, 2026)[0]).toContain(
			"more than two windows",
		);
	});

	it("reports a marks error in plain language", () => {
		expect(describeResult({ error: "no-shadow-length" }, 2026)[0]).toContain("shadow tip");
	});

	it("names the nearest match when nothing matches", () => {
		const lines = describeResult(
			{ kind: "no-match", nearest: instant(new Date(Date.UTC(2026, 2, 20, 9, 0))) },
			2026,
		);
		expect(lines[1]).toBe("Nearest match: 20 Mar");
	});
});

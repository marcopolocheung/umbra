import SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import {
  type ShadowMarks,
  marksShowNoShadow,
  observeShadow,
  solveChronolocation,
} from "../solver";
import {
  type BBox,
  createGeometryShadowField,
  staticPrismProvider,
} from "../../shadowField/ShadowField";
import { type PrismSet, metersPerDegree } from "../../shadowField/geometry";

// ─── A synthetic camera ──────────────────────────────────────────────────────

/** 1000 px wide, 60° hfov, facing north — the geometry is hand-checkable. */
const FRAME = {
  headingDeg: 0,
  hfovDeg: 60,
  widthPx: 1000,
};

// ─── observeShadow: marks → observation ──────────────────────────────────────

describe("observeShadow", () => {
  it("derives the shadow's travel azimuth from the marks and the camera heading", () => {
    // Object at x=600, shadow tip at x=800, camera facing north: the shadow
    // runs east, so its azimuth must be positive and under 90°.
    const obs = observeShadow(
      {
        top: { x: 600, y: 300 },
        base: { x: 600, y: 500 },
        shadowTip: { x: 800, y: 500 },
      },
      FRAME
    );
    if ("error" in obs) throw new Error(`unexpected ${obs.error}`);
    // Pinhole bearing of a pixel x, degrees off the view axis.
    const rel = (x: number) =>
      (Math.atan(((2 * x) / FRAME.widthPx - 1) * Math.tan((FRAME.hfovDeg * Math.PI) / 180 / 2)) * 180) / Math.PI;
    // The direction from base to tip, in true-north terms for a north-facing camera.
    expect(obs.azimuthDeg).toBeCloseTo(rel(800) - rel(600), 5);
    expect(obs.azimuthDeg).toBeGreaterThan(0);
    expect(obs.azimuthDeg).toBeLessThan(90);
  });

  it("rotates the azimuth by the camera heading", () => {
    const marks: ShadowMarks = {
      top: { x: 600, y: 300 },
      base: { x: 600, y: 500 },
      shadowTip: { x: 800, y: 500 },
    };
    const facing = observeShadow(marks, { ...FRAME, headingDeg: 90 });
    const north = observeShadow(marks, FRAME);
    if ("error" in facing || "error" in north) throw new Error("unexpected error");
    expect(facing.azimuthDeg - north.azimuthDeg).toBeCloseTo(90, 5);
  });

  it("gives a length-over-height ratio near 1 for a shadow as long as the object is tall", () => {
    // A straight-on view of a vertical object: the perspective corrections
    // vanish and the pixel ratio *is* the ground ratio. The local-scale
    // correction is sec²(bearing), so a shadow extending 20° off-axis reads
    // ~5% long — inside the tolerance this solver works at.
    const obs = observeShadow(
      {
        top: { x: 500, y: 300 },
        base: { x: 500, y: 500 },
        shadowTip: { x: 700, y: 500 },
      },
      FRAME
    );
    if ("error" in obs) throw new Error(`unexpected ${obs.error}`);
    expect(obs.lengthOverHeight).toBeGreaterThan(0.9);
    expect(obs.lengthOverHeight).toBeLessThan(1.2);
  });

  it("abstains from a mark set whose object has no height", () => {
    const obs = observeShadow(
      {
        top: { x: 500, y: 500 },
        base: { x: 500, y: 500 },
        shadowTip: { x: 700, y: 500 },
      },
      FRAME
    );
    expect(obs).toEqual({ error: "no-object-height" });
  });

  it("abstains from marks whose shadow has no length", () => {
    const obs = observeShadow(
      {
        top: { x: 500, y: 300 },
        base: { x: 500, y: 500 },
        shadowTip: { x: 500, y: 500 },
      },
      FRAME
    );
    expect(obs).toEqual({ error: "no-shadow-length" });
  });
});

// ─── marksShowNoShadow: the overcast guard ──────────────────────────────────

describe("marksShowNoShadow", () => {
  it("flags a shadow tip at the object's base", () => {
    expect(
      marksShowNoShadow({
        top: { x: 500, y: 300 },
        base: { x: 500, y: 500 },
        shadowTip: { x: 501, y: 500 },
      })
    ).toBe(true);
  });

  it("passes a real shadow", () => {
    expect(
      marksShowNoShadow({
        top: { x: 500, y: 300 },
        base: { x: 500, y: 500 },
        shadowTip: { x: 650, y: 520 },
      })
    ).toBe(false);
  });
});

// ─── The sweep: a round trip through the real sun model ─────────────────────

// NYC, mid-July, mid-afternoon: sun in the west (bearing ~231°), so the shadow
// travels east (~51°), ratio ≈ 0.50 — far from both the horizon's blow-up and
// noon's degeneracy, and well inside the usable band.
const LAT = 40.7;
const LNG = -74.0;
const TRUTH = new Date("2026-07-15T18:30:00Z"); // 14:30 EDT
const truthSun = SunCalc.getPosition(TRUTH, LAT, LNG);
/** suncalc azimuth: 0 = south, positive west → true bearing = deg + 180. */
const TRUTH_SUN_BEARING = (truthSun.azimuth * 180) / Math.PI + 180;
const OBSERVATION = {
  azimuthDeg: (TRUTH_SUN_BEARING + 180) % 360,
  lengthOverHeight: 1 / Math.tan(truthSun.altitude),
};

/** Local midnight of a local calendar date, as a Date (UTC underneath). */
function localMidnight(month: number, day: number): number {
  // local = utc + tz, so local midnight of local date (month, day) =
  // Date.UTC(month, day) − tz·min.
  return Date.UTC(2026, month, day) - -240 * 60000;
}

const SWEEP_OPTS = { year: 2026, tzOffsetMin: -240, lat: LAT, lng: LNG };

describe("solveChronolocation", () => {
  it("returns two date candidates, the true date inside the first window", () => {
    const result = solveChronolocation(OBSERVATION, SWEEP_OPTS);
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    expect(result.candidates).toHaveLength(2);

    // The true date sits inside one candidate's window, and that window's
    // best day is the truth's own date (the sun matched best exactly there).
    const truthStart = localMidnight(6, 15); // local July 15
    const hit = result.candidates.find(
      (c) => c.startDate.getTime() <= truthStart && c.endDate.getTime() >= truthStart
    );
    if (!hit) throw new Error("no window covers the true local date");
    expect(hit.date.getTime()).toBe(truthStart);

    // The time band on that day covers the truth minute, and the best instant
    // is within the sweep granularity of the truth.
    const trueMin = (TRUTH.getTime() - truthStart) / 60000;
    expect(hit.startMin).toBeLessThanOrEqual(trueMin);
    expect(hit.endMin).toBeGreaterThanOrEqual(trueMin);
    expect(Math.abs(hit.best.date.getTime() - TRUTH.getTime())).toBeLessThan(15 * 60000);

    // The two windows are distinct and straddle the summer solstice.
    const [a, b] = result.candidates;
    expect(a.startDate.getTime()).not.toBe(b.startDate.getTime());
    const solstice = Date.UTC(2026, 5, 21);
    expect(a.endDate.getTime()).toBeLessThan(solstice + 86400000);
    expect(b.startDate.getTime()).toBeGreaterThan(solstice - 86400000);
  });

  it("reports the window width honestly — dozens of days, not a single date", () => {
    // At the default tolerances a single shadow cannot date a photo to a
    // day; the window is the honest answer, and the note says so. This test
    // exists so a future "narrow it to one date" change has to confront it.
    const result = solveChronolocation(OBSERVATION, SWEEP_OPTS);
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    for (const c of result.candidates) {
      const widthDays = (c.endDate.getTime() - c.startDate.getTime()) / 86400000 + 1;
      expect(widthDays).toBeGreaterThan(3);
      expect(widthDays).toBeLessThan(120);
    }
  });

  it("no-match when the observation contradicts every sun position in the year", () => {
    // Keep the ratio but claim the shadow travels toward the sun's side of
    // the sky at this ratio: no instant at NYC's latitude matches both.
    const result = solveChronolocation(
      { azimuthDeg: OBSERVATION.azimuthDeg + 120, lengthOverHeight: OBSERVATION.lengthOverHeight },
      SWEEP_OPTS
    );
    if (result.kind !== "no-match") throw new Error(`unexpected ${result.kind}`);
    // The nearest miss is reported so the caller can say how far off it was.
    expect(result.nearest).not.toBeNull();
  });

  it("labels dates in the location's civil timezone, not UTC", () => {
    const result = solveChronolocation(OBSERVATION, SWEEP_OPTS);
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    // 18:30Z at UTC−4 is 14:30 local on July 15 — with the offset applied the
    // band minutes land in daylight hours, not the middle of the night.
    for (const c of result.candidates) {
      expect(c.startMin).toBeGreaterThan(5 * 60);
      expect(c.endMin).toBeLessThan(20 * 60);
    }
  });

  it("clusters the same window in spring, symmetric about the equinox-to-solstice arc", () => {
    // A March-morning shadow: sun east (~92°), ratio ≈ 2.8 (low sun). The
    // two windows must sit on opposite sides of the June solstice (March and
    // late September), proving the symmetry logic is not tuned to summer.
    const t = new Date("2026-03-10T16:30:00Z"); // 11:30 local
    const sun = SunCalc.getPosition(t, LAT, LNG);
    const result = solveChronolocation(
      {
        azimuthDeg: ((sun.azimuth * 180) / Math.PI + 180 + 180) % 360,
        lengthOverHeight: 1 / Math.tan(sun.altitude),
      },
      SWEEP_OPTS
    );
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    const [a, b] = result.candidates;
    const summerSolstice = Date.UTC(2026, 5, 21);
    expect(a.endDate.getTime()).toBeLessThan(summerSolstice);
    expect(b.startDate.getTime()).toBeGreaterThan(summerSolstice);
    // The true date, March 10, sits in the first window, and it is the best
    // day of that window (the exact observation matched best exactly there).
    const truthStart = localMidnight(2, 10);
    expect(a.startDate.getTime()).toBeLessThanOrEqual(truthStart);
    expect(a.endDate.getTime()).toBeGreaterThanOrEqual(truthStart);
    expect(a.date.getTime()).toBe(truthStart);
  });
});

// ─── The ShadowField cross-check ─────────────────────────────────────────────

const { mPerLat, mPerLng } = metersPerDegree(LAT);

/** A bbox of ±pad metres around the photo point. */
function bboxPad(pad: number): BBox {
  return {
    west: LNG - pad / mPerLng,
    east: LNG + pad / mPerLng,
    south: LAT - pad / mPerLat,
    north: LAT + pad / mPerLat,
  };
}

/** One building, `h` metres tall, whose footprint sits `d` metres east. */
function buildingEast(h: number, d: number): PrismSet {
  const ring: [number, number][] = [
    [LNG + (d - 5) / mPerLng, LAT - 5 / mPerLat],
    [LNG + (d + 5) / mPerLng, LAT - 5 / mPerLat],
    [LNG + (d + 5) / mPerLng, LAT + 5 / mPerLat],
    [LNG + (d - 5) / mPerLng, LAT + 5 / mPerLat],
  ];
  return { prisms: [{ ring, heightM: h }], maxHeightM: h };
}

/**
 * One building, `h` metres tall, whose footprint sits `d` metres from the
 * photo point *toward the sun* — where the afternoon sun's SW light throws
 * its shadow (NE, matching `shadowTravelDir`) across the photo point.
 */
function buildingTowardSun(h: number, d: number): PrismSet {
  const dx = -d * shadowTravelDir[0];
  const dy = -d * shadowTravelDir[1];
  const halfLng = 20 / mPerLng;
  const halfLat = 20 / mPerLat;
  const cx = LNG + dx / mPerLng;
  const cy = LAT + dy / mPerLat;
  const ring: [number, number][] = [
    [cx - halfLng, cy - halfLat],
    [cx + halfLng, cy - halfLat],
    [cx + halfLng, cy + halfLat],
    [cx - halfLng, cy + halfLat],
    [cx - halfLng, cy - halfLat],
  ];
  return { prisms: [{ ring, heightM: h }], maxHeightM: h };
}

/**
 * The direction the truth instant's shadow travels, as a unit vector in
 * metres (east, north) — `buildShadowIndexFor` shifts footprints by
 * `(sin az, cos az) × length`, which is where the shadow lands.
 */
const shadowTravelDir: [number, number] = [
  Math.sin(truthSun.azimuth),
  Math.cos(truthSun.azimuth),
];

describe("the ShadowField cross-check", () => {
  it("skips when no field is supplied", () => {
    const result = solveChronolocation(OBSERVATION, SWEEP_OPTS);
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    for (const c of result.candidates) {
      expect(c.crossCheck.kind).toBe("no-coverage");
    }
  });

  it("stays consistent when no building shades the photo point", () => {
    // A low building far away: its shadow never reaches the point at any
    // sampled minute of the band.
    const field = createGeometryShadowField([
      staticPrismProvider(buildingEast(10, 300), bboxPad(400), "nyc-static"),
    ]);
    const result = solveChronolocation(OBSERVATION, { ...SWEEP_OPTS, shadowField: field });
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    for (const c of result.candidates) {
      expect(c.crossCheck.kind).toBe("consistent");
    }
  });

  it("flags a conflict when geometry shadows the point during the band", () => {
    // A tall building toward the sun from the point (SW at the truth instant):
    // its 60 m shadow travels NE across the photo point during the true band.
    const field = createGeometryShadowField([
      staticPrismProvider(buildingTowardSun(60, 25), bboxPad(400), "nyc-static"),
    ]);
    const result = solveChronolocation(OBSERVATION, { ...SWEEP_OPTS, shadowField: field });
    if (result.kind !== "solved") throw new Error(`unexpected ${result.kind}`);
    const truthStart = localMidnight(6, 15);
    const hit = result.candidates.find(
      (c) => c.startDate.getTime() <= truthStart && c.endDate.getTime() >= truthStart
    );
    if (!hit) throw new Error("no window covers the true local date");
    expect(hit.crossCheck.kind).toBe("conflict");
    if (hit.crossCheck.kind === "conflict") {
      expect(hit.crossCheck.shadowedMinutes.length).toBeGreaterThan(0);
    }
  });
});

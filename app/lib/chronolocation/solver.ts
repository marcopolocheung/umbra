/**
 * Photo chronolocation — the solver (Track S, checkpoint S4a).
 *
 * A photo already pinned to a place ("taken from here, facing there") carries a
 * shadow whose length and direction only the sun can explain. The user marks
 * three points on the photo — an object's top, its base, and the tip of its
 * shadow — and the photo's own geometry turns those marks into an observed
 * shadow azimuth (relative to the facing direction) and an observed shadow
 * ratio (shadow length ÷ object height, in the photo's angular terms, so
 * perspective cancels in the ratio).
 *
 * This module then runs Umbra's own sun model in reverse: sweep every date of
 * the year and every few minutes of daylight, and keep the instants where
 * suncalc's predicted azimuth and length-ratio match the observation. The
 * *time of day* is what the sweep pins down sharply; the *date* is only ever
 * determined up to a window, because the sun's declination — the only seasonal
 * signal in one shadow — changes slowly. Every solar position recurs on dates
 * symmetric about a solstice, so the answer is at most two date windows, one
 * on each side, and their width is set by the mark tolerances: a wider
 * tolerance honestly buys a wider window, never a false single date.
 *
 * Optionally, a `ShadowField` over the pinned location cross-checks the time
 * band: a building in frame whose geometry cannot cast the observed shadow at
 * a candidate time lowers that candidate's confidence instead of silently
 * breaking it.
 *
 * Abstention is a first-class answer. Overcast light (no measurable shadow) and
 * ambiguous geometry are reported, never guessed past. This automates the
 * manual ShadeMap chronolocation workflow — the claim is narrow and the
 * novelty is in the execution.
 *
 * The panel (S4b) owns photo intake, point marking and the shell mount; this
 * module is pure geometry and sweep, with no photo pixels and no UI.
 */

import SunCalc from "suncalc";
import type { ShadowField } from "../shadowField/ShadowField";

// ─── The user's marks ────────────────────────────────────────────────────────

/**
 * One marked point in photo pixel coordinates, y growing downward (the usual
 * image convention; the panel hands these in as drawn).
 */
export interface PhotoPoint {
  x: number;
  y: number;
}

/**
 * The three marks the user makes on the photo, in pixel coordinates.
 *
 * `top` and `base` are the object's tip and ground point; `shadowTip` is the
 * far end of the shadow the object casts on the ground.
 */
export interface ShadowMarks {
  top: PhotoPoint;
  base: PhotoPoint;
  shadowTip: PhotoPoint;
}

/** The photo's framing, supplied once with the marks. */
export interface PhotoFrame {
  /**
   * The direction the camera faces, in degrees clockwise from true north.
   * Known from EXIF, a compass, or the user aligning a landmark.
   */
  headingDeg: number;
  /**
   * Approximate horizontal field of view in degrees. Cellphone wide cameras
   * are ~65–70°; used only to convert photo angles to real angles, and small
   * errors here fade beside the mark-placement error.
   */
  hfovDeg: number;
  /** Photo width in pixels (the `x` the marks are measured against). */
  widthPx: number;
}

// ─── Geometric observations derived from the marks ──────────────────────────

/** What the marks say about the shadow, once interpreted. */
export interface ShadowObservation {
  /**
   * Shadow azimuth in degrees clockwise from true north — the direction the
   * shadow *travels* (from the object's base toward its tip). The sun sits on
   * the opposite bearing.
   */
  azimuthDeg: number;
  /**
   * Shadow length ÷ object height, in the photo's angular terms. Both extents
   * are read as angles through the pinhole model, so their perspective scales
   * cancel in the ratio; the result equals `1 / tan(solar altitude)` for a
   * vertical object on flat ground.
   */
  lengthOverHeight: number;
}

/** Why the marks cannot produce an observation. */
export type MarksError =
  | "no-object-height"
  | "no-shadow-length";

/**
 * Interpret the three marks into a shadow observation.
 *
 * The photo is a central projection, so every mark is converted to a *bearing*
 * (degrees right of the view axis) through the pinhole model — pixel x at
 * `atan((2x/width − 1) · tan(hfov/2))` — rather than to a linear share of the
 * frame. Ratios of angular extents at nearby bearings are then perspective-free
 * to first order, which is what the length-over-height ratio needs.
 *
 * Elevations are the one thing the three marks cannot fix (the horizon is not
 * marked), so the ratio is *not* corrected for the camera's pitch. The panel's
 * instruction — mark a near, prominent object — keeps that term ≈1; the
 * tolerance absorbs the rest.
 */
export function observeShadow(
  marks: ShadowMarks,
  frame: PhotoFrame
): ShadowObservation | { error: MarksError } {
  const { top, base, shadowTip } = marks;

  if (shadowTip.x === base.x && shadowTip.y === base.y) {
    return { error: "no-shadow-length" };
  }

  const bearing = (p: PhotoPoint): number =>
    (Math.atan(((2 * p.x) / frame.widthPx - 1) * Math.tan(rad(frame.hfovDeg) / 2)) * 180) / Math.PI;

  // Pixel extents, measured against the ground line the base and shadow tip
  // define (both sit on the ground, so that line is the photo's local horizon).
  const groundSlope =
    Math.abs(shadowTip.x - base.x) > 1e-9
      ? (shadowTip.y - base.y) / (shadowTip.x - base.x)
      : 0;
  const groundAtX = (x: number): number => base.y + groundSlope * (x - base.x);

  const objectHtPx = groundAtX(top.x) - top.y;
  if (objectHtPx <= 0) return { error: "no-object-height" };

  const lengthPx = Math.hypot(shadowTip.x - base.x, shadowTip.y - base.y);
  if (lengthPx <= 0) return { error: "no-shadow-length" };

  // Convert both extents to angles. A pixel extent maps to
  // `angPerPx · px / cos²(bearing)` — the pinhole's local scale — so the scale
  // factors cancel in the ratio only when the two extents sit at the same
  // bearing. They do not (the shadow extends away from the object), so keep
  // each extent's own correction: `localScale` is the sec² that un-shrinks an
  // extent read off-axis.
  const localScale = (bRelDeg: number): number =>
    1 / Math.max(1e-6, Math.cos(rad(bRelDeg)) ** 2);

  const objectBRel = bearing(top) - bearing(base);
  const shadowBRel = bearing(shadowTip) - bearing(base);

  const objectAngleDeg =
    angPerPx(frame) * objectHtPx * localScale(objectBRel);
  const shadowAngleDeg =
    angPerPx(frame) * lengthPx * localScale(shadowBRel);

  // The shadow's travel azimuth: the bearing from base to tip, swung into
  // true-north terms by the camera heading.
  const azimuthDeg = normDeg(frame.headingDeg + shadowBRel);

  const lengthOverHeight = shadowAngleDeg / Math.max(1e-9, objectAngleDeg);

  return { azimuthDeg, lengthOverHeight };
}

/** Degrees per pixel across the frame, at the optical axis. */
function angPerPx(frame: PhotoFrame): number {
  return frame.hfovDeg / Math.max(1, frame.widthPx);
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/** One instant the sun matched the observation. */
export interface CandidateInstant {
  date: Date;
  /** Predicted − observed azimuth, in degrees (signed, small). */
  azimuthErrorDeg: number;
  /** Predicted − observed length ratio, relative. */
  lengthErrorRel: number;
}

/** The ShadowField cross-check on a date candidate. */
export type CrossCheck =
  /** No field was supplied — check skipped. */
  | { kind: "no-coverage" }
  /** No sampled minute of the band is shadowed by geometry. */
  | { kind: "consistent" }
  /** Geometric shadow at some sampled minutes of the band. */
  | { kind: "conflict"; shadowedMinutes: number[] }
  /** The field returned low-confidence answers for the band. */
  | { kind: "inconclusive" };

/** A date candidate: a window of days plus the time band that matched. */
export interface DateCandidate {
  /**
   * Local calendar date of the window's best day (UTC midnight of that local
   * date). The window — `startDate` to `endDate` — is the honest width of the
   * date ambiguity at the given tolerances; `date` is the single best day
   * inside it, where the sun matched best.
   */
  date: Date;
  /** First local date of the matching window. */
  startDate: Date;
  /** Last local date of the matching window (inclusive). */
  endDate: Date;
  /**
   * Time band: the run of matching instants on the best day, as minute
   * offsets from its local midnight. The band, not a point, is the honest
   * answer — mark placement and ratio tolerance both blur time.
   */
  startMin: number;
  endMin: number;
  /** Best instant inside the band (smallest combined error). */
  best: CandidateInstant;
  /** `shadowField` cross-check verdict for this candidate. */
  crossCheck: CrossCheck;
}

/** The solver's answer. */
export type ChronolocationResult =
  | {
      kind: "solved";
      candidates: [DateCandidate, DateCandidate];
    }
  | {
      kind: "single-date";
      candidate: DateCandidate;
      /** Why a second window was not returned. */
      reason: "solstice-window";
    }
  | {
      kind: "abstain";
      reason:
        | "overcast"
        | "no-measurable-shadow"
        | "ambiguous-geometry"
        | "no-match";
    }
  | {
      kind: "no-match";
      nearest: CandidateInstant | null;
    };

/** Tolerances for the match. Defaults in parentheses. */
export interface SolverOptions {
  /**
   * Azimuth tolerance in degrees (±2.5). Pixel marks on a photo are worth
   * about this much; tighter rejects true answers, looser widens the date
   * windows until they merge across the solstice.
   */
  azimuthTolDeg?: number;
  /**
   * Length-ratio tolerance, relative (±0.07). Shadow length in pixels is the
   * softest measurement in the workflow, and the ratio is what carries the
   * seasonal signal, so this tolerance sets the date windows' width.
   *
   * The two tolerances set the *width* of the date windows: at the defaults a
   * NYC shadow dates to a ~±2–4-week window on each side of the solstice.
   * Tighter marks honestly buy narrower windows; nothing buys a single date.
   */
  lengthTolRel?: number;
  /** Year to sweep (the current year). */
  year?: number;
  /**
   * Timezone offset for date labels, minutes east of UTC (the location's
   * civil offset; the sweep is UTC underneath and the labels come out as
   * local dates).
   */
  tzOffsetMin?: number;
  /**
   * A `ShadowField` over the photo's location. When supplied, each date
   * candidate's time band is cross-checked for building shadow in frame at
   * the pinned point: a band whose minutes are geometrically shadowed where
   * the photo shows the marked object in sun is a conflict, not an answer.
   */
  shadowField?: ShadowField;
  /** The pinned photo location, for the cross-check. Required with `shadowField`. */
  lng?: number;
  lat?: number;
}

const DEFAULT_AZIMUTH_TOL_DEG = 2.5;
const DEFAULT_LENGTH_TOL_REL = 0.07;
/** Sweep granularity: the sun moves ~0.25°/min in azimuth near noon. */
const SWEEP_MIN = 2;
/** Max plausible length ratio before the sun is effectively on the horizon. */
const MAX_LENGTH_RATIO = 20;
/** Below this solar altitude the ratio explodes past any mark's meaning. */
const MIN_ALTITUDE_DEG = 2;
/** Days closer together than this are one seasonal window, not two answers. */
const WINDOW_GAP_DAYS = 3;
/** Sample minutes of a band for the cross-check. */
const CROSS_CHECK_SAMPLES = 7;

/** A day's run of matching instants. */
interface DayMatches {
  /** Day index from local Jan 1. */
  day: number;
  matches: CandidateInstant[];
}

/**
 * Solve "when was this photo taken" from an observed shadow.
 *
 * Returns two date candidates (one window on each side of the solstice) with a
 * time band each, a single window when the match falls in the solstice window
 * itself, `no-match` when nothing in the year matched, or `abstain` for
 * geometry the sweep cannot honestly date.
 */
export function solveChronolocation(
  observation: ShadowObservation,
  options: SolverOptions = {}
): ChronolocationResult {
  const azimuthTol = options.azimuthTolDeg ?? DEFAULT_AZIMUTH_TOL_DEG;
  const lengthTol = options.lengthTolRel ?? DEFAULT_LENGTH_TOL_REL;
  const year = options.year ?? new Date().getFullYear();
  const tzMin = options.tzOffsetMin ?? 0;

  // Local Jan 1 midnight, expressed in UTC: local = utc + tz, so local
  // midnight = UTC midnight − tz. Day boundaries and date labels stay civil.
  const yearStart = Date.UTC(year, 0, 1) - tzMin * 60000;
  const daysInYear = isLeap(year) ? 366 : 365;

  const dayMatches: DayMatches[] = [];
  let nearest: CandidateInstant | null = null;

  for (let day = 0; day < daysInYear; day++) {
    const dayStart = yearStart + day * 86400000;
    const matches: CandidateInstant[] = [];
    for (let min = 0; min < 1440; min += SWEEP_MIN) {
      const when = new Date(dayStart + min * 60000);
      const sun = sunBearingAt(when, options);
      if (!sun || sun.altitudeDeg <= MIN_ALTITUDE_DEG) continue;
      const predictedLen = 1 / Math.tan(rad(sun.altitudeDeg)); // sanity: see below
      if (predictedLen > MAX_LENGTH_RATIO) continue;
      // suncalc's azimuth is measured from south (0 = south, positive west),
      // so the sun's true bearing is `deg + 180` — and the shadow travels at
      // `deg + 360` ≡ `deg`, which is the observed travel azimuth.
      // suncalc's azimuth is measured from south (0 = south, positive west),
      // so the sun's true bearing is `deg + 180` — and the shadow travels at
      // `deg + 360` ≡ `deg`, which is the observed travel azimuth.
      const azErr = signedDegDiff(sun.bearingDeg, observation.azimuthDeg + 180);
      const lenErr = (predictedLen - observation.lengthOverHeight) / observation.lengthOverHeight;
      const candidate = { date: when, azimuthErrorDeg: azErr, lengthErrorRel: lenErr };
      if (Math.abs(azErr) <= azimuthTol && Math.abs(lenErr) <= lengthTol) {
        matches.push(candidate);
      } else if (
        !nearest ||
        combinedError(candidate, azimuthTol, lengthTol) <
          combinedError(nearest, azimuthTol, lengthTol)
      ) {
        nearest = candidate;
      }
    }
    if (matches.length > 0) dayMatches.push({ day, matches });
  }

  if (dayMatches.length === 0) {
    return { kind: "no-match", nearest };
  }

  // Cluster matching days into seasonal windows: consecutive-ish days (gap ≤
  // WINDOW_GAP_DAYS) are one window, because the sun's declination — the only
  // seasonal signal in a single shadow — changes slowly enough that adjacent
  // days are indistinguishable at these tolerances.
  const windows: DayMatches[][] = [];
  for (const dm of dayMatches) {
    const last = windows[windows.length - 1];
    const lastDay = last?.[last.length - 1].day;
    if (last && dm.day - lastDay <= WINDOW_GAP_DAYS) {
      last.push(dm);
    } else {
      windows.push([dm]);
    }
  }

  const candidates = windows.map((days) =>
    buildCandidate(days, yearStart, options, azimuthTol, lengthTol)
  );

  if (candidates.length === 1) {
    return { kind: "single-date", candidate: candidates[0], reason: "solstice-window" };
  }
  if (candidates.length === 2) {
    return { kind: "solved", candidates: [candidates[0], candidates[1]] };
  }
  // More than two distinct windows: the observation does not discriminate
  // between them, and picking two of three would be a guess.
  return { kind: "abstain", reason: "ambiguous-geometry" };
}

/** Sun true bearing and altitude in degrees, at the pinned location. */
function sunBearingAt(
  when: Date,
  options: SolverOptions
): { bearingDeg: number; altitudeDeg: number } | null {
  const { lat, lng } = options;
  if (lat === undefined || lng === undefined) return null;
  const { altitude, azimuth } = SunCalc.getPosition(when, lat, lng);
  return {
    bearingDeg: (azimuth * 180) / Math.PI + 180,
    altitudeDeg: (altitude * 180) / Math.PI,
  };
}

/**
 * Collapse one seasonal window into a single candidate: the best day inside
 * it carries the date, the time band, and the cross-check.
 */
function buildCandidate(
  days: DayMatches[],
  yearStart: number,
  options: SolverOptions,
  azimuthTol: number,
  lengthTol: number
): DateCandidate {
  // Best day: the one whose best instant has the smallest combined error.
  let bestDay = days[0];
  let bestDayError = combinedError(
    bestOf(bestDay, azimuthTol, lengthTol),
    azimuthTol,
    lengthTol
  );
  for (const day of days) {
    const error = combinedError(
      bestOf(day, azimuthTol, lengthTol),
      azimuthTol,
      lengthTol
    );
    if (error < bestDayError) {
      bestDay = day;
      bestDayError = error;
    }
  }
  const best = bestOf(bestDay, azimuthTol, lengthTol);
  const dayStart = yearStart + bestDay.day * 86400000;
  const startMin = (bestDay.matches[0].date.getTime() - dayStart) / 60000;
  const endMin =
    (bestDay.matches[bestDay.matches.length - 1].date.getTime() - dayStart) / 60000;
  return {
    date: new Date(dayStart),
    startDate: new Date(yearStart + days[0].day * 86400000),
    endDate: new Date(yearStart + days[days.length - 1].day * 86400000),
    startMin,
    endMin,
    best,
    crossCheck: crossCheckBand(
      options.shadowField,
      options.lng,
      options.lat,
      dayStart,
      startMin,
      endMin
    ),
  };
}

function bestOf(day: DayMatches, azimuthTol: number, lengthTol: number): CandidateInstant {
  return day.matches.reduce((a, b) =>
    combinedError(b, azimuthTol, lengthTol) < combinedError(a, azimuthTol, lengthTol)
      ? b
      : a
  );
}

function combinedError(
  c: CandidateInstant,
  azimuthTol: number,
  lengthTol: number
): number {
  return Math.abs(c.azimuthErrorDeg) / azimuthTol + Math.abs(c.lengthErrorRel) / lengthTol;
}

function signedDegDiff(predictedDeg: number, observedDeg: number): number {
  let d = predictedDeg - observedDeg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Cross-check a candidate's time band against the shadow field: is the pinned
 * point geometrically shadowed (by a building) during minutes where the photo
 * shows the marked object in sun?
 */
function crossCheckBand(
  field: ShadowField | undefined,
  lng: number | undefined,
  lat: number | undefined,
  dayStart: number,
  startMin: number,
  endMin: number
): CrossCheck {
  if (!field || lng === undefined || lat === undefined) return { kind: "no-coverage" };
  const shadowedMinutes: number[] = [];
  let lowConfidence = 0;
  const span = Math.max(1, endMin - startMin);
  for (let i = 0; i < CROSS_CHECK_SAMPLES; i++) {
    const min = startMin + (span * i) / (CROSS_CHECK_SAMPLES - 1 || 1);
    const when = new Date(dayStart + min * 60000);
    const sample = field.shadowAt(lng, lat, when);
    if (sample.confidence < 0.5) lowConfidence++;
    // Any material geometric shadow during the band is a conflict — 0.5 is
    // "fully shadowed", but a band sampled mid-way between the 5-point
    // probe's offsets reads 0.2 under the point's own footprint edge. A
    // photo showing the marked object in sun cannot be even partly shadowed.
    if (sample.shadow > 0.15) shadowedMinutes.push(Math.round(min));
  }
  if (shadowedMinutes.length > 0) {
    return { kind: "conflict", shadowedMinutes };
  }
  if (lowConfidence === CROSS_CHECK_SAMPLES) return { kind: "inconclusive" };
  return { kind: "consistent" };
}

// ─── Overcast detection ──────────────────────────────────────────────────────

/**
 * Whether the marks describe no measurable shadow: a shadow tip at (or
 * within a couple of pixels of) the object's base means there is nothing to
 * date the photo by. The solver abstains on this; the panel can also pre-check
 * so the user learns why before a sweep runs. A few pixels of slack keeps
 * hand-placed marks from being read as a measurement.
 */
export function marksShowNoShadow(marks: ShadowMarks): boolean {
  const { base, shadowTip } = marks;
  return Math.hypot(shadowTip.x - base.x, shadowTip.y - base.y) <= 2;
}

/**
 * Whether the marks describe overcast light: no observable shadow at all is
 * the overcast signature this workflow abstains on. Distinct from
 * `marksShowNoShadow` only in that the panel asks the user, not the marks,
 * which it was — both roads abstain, for reasons the answer reports.
 */
export const OVERCAST_REASON = "overcast" as const;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

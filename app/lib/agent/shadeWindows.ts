/** Application-owned shade-window boundaries, identities, and display rules. */
import { toMapLocal, utcOffsetMinAt } from "../timezone";
import {
  prepareShadeSpotsWindow,
  type ShadeSpot,
  type ShadeSpotSample,
  type ShadeSpotWindow,
} from "../navigationData/shadeSpots";
import { SHADE_ZONE, shadeSlotIndex } from "../navigationData/shadeSlots";
import type {
  ShadeWindowPayload,
  ShadeUnavailableReason,
} from "../navigationData/shadeSpotsSource";

export type ShadeWindowSuccess = Extract<ShadeWindowPayload, { status: "ok" }>;
export interface ShadeCandidate {
  spot: ShadeSpot;
  requestedDate: string;
  mode: "shade" | "sun";
  requestedWindow?: ShadeSpotWindow;
}

export function nycDate(at: Date): string {
  const { year, month, day } = toMapLocal(at, utcOffsetMinAt(SHADE_ZONE, at));
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A deliberately narrower boundary than the forgiving timeline-input parser. */
export function shadeClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const twelve = /^(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*(AM|PM)$/i.exec(text);
  if (twelve)
    return (
      ((Number(twelve[1]) % 12) + (twelve[3].toUpperCase() === "PM" ? 12 : 0)) * 60 +
      Number(twelve[2] ?? 0)
    );
  const twentyFour = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  return twentyFour ? Number(twentyFour[1]) * 60 + Number(twentyFour[2]) : null;
}

export function shadeClockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${h >= 12 && h < 24 ? "PM" : "AM"}`;
}

export function shadeWindowObjectId(resultId: string, candidateId: string): string {
  return `shade-window:${resultId}:${candidateId}`;
}

export const SHADE_UNAVAILABLE_LABELS: Record<ShadeUnavailableReason, string> = {
  invalid_reference: "Choose a sidewalk from an earlier verified shade search to compare.",
  stale_reference: "The shade dataset has changed. Search again before comparing this sidewalk.",
  no_similarity_data: "Similar-sidewalk search is unavailable for the loaded dataset.",
  outside_coverage: "No shade-table data is available for this area.",
  not_configured: "Shade-window search is not available in this build.",
  no_shade_table: "The loaded dataset has no shade-window table.",
  quarantined_generation: "The shade dataset is unavailable while its data is being checked.",
  load_failed: "I couldn't load complete shade data for this search. Try again later.",
  night: "This window has no daylight samples; darkness is not ranked as shade or sun.",
  empty_window:
    "This window has no samples after quarter-hour snapping and daytime-table clipping.",
  no_candidates: "No qualifying sidewalk sides were found within the search radius.",
  invalid_query: "Choose a valid date and a same-day time window with explicit clock times.",
};

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fraction = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
const windowValue = (v: unknown): v is ShadeSpotWindow =>
  record(v) &&
  Number.isInteger(v.fromMinutes) &&
  Number.isInteger(v.toMinutes) &&
  (v.fromMinutes as number) >= 0 &&
  (v.toMinutes as number) <= 1440 &&
  (v.fromMinutes as number) < (v.toMinutes as number);
const reasons = new Set([
  "snapped",
  "table-clipped",
  "daylight-clipped",
  "empty-window",
  "night",
  "incomplete-data",
  "no-data",
  "no-candidates",
]);

/** Strong runtime boundary for evidence, replay, and the application registry. */
export function isShadeWindowPayload(v: unknown): v is ShadeWindowPayload {
  if (!record(v) || Object.hasOwn(v, "error") || !Array.isArray(v.results)) return false;
  if (v.status === "unavailable")
    return (
      v.results.length === 0 &&
      typeof v.reason === "string" &&
      Object.hasOwn(SHADE_UNAVAILABLE_LABELS, v.reason)
    );
  if (
    v.status !== "ok" ||
    v.source !== "nyc-shade-table" ||
    typeof v.generation !== "string" ||
    !v.generation ||
    v.sourceVersion !== v.generation ||
    typeof v.requestedDate !== "string" ||
    !["shade", "sun"].includes(v.mode as string) ||
    !windowValue(v.requestedWindow) ||
    !windowValue(v.effectiveWindow) ||
    !record(v.basis) ||
    !Array.isArray(v.reasons) ||
    !v.reasons.every((r) => reasons.has(r)) ||
    !Number.isInteger(v.skippedSegments) ||
    (v.skippedSegments as number) < 0 ||
    !Number.isInteger(v.missingGeometrySegments) ||
    (v.missingGeometrySegments as number) < 0 ||
    v.results.length < 1 ||
    v.results.length > 4
  )
    return false;
  let prepared: ReturnType<typeof prepareShadeSpotsWindow>;
  try {
    prepared = prepareShadeSpotsWindow({
      lat: 0,
      lng: 0,
      date: v.requestedDate,
      ...v.requestedWindow,
      radiusM: 200,
      mode: v.mode as "shade" | "sun",
    });
  } catch {
    return false;
  }
  if (
    v.basis.representativeDate !== prepared.basis.representativeDate ||
    v.basis.zone !== prepared.basis.zone ||
    v.basis.slotMinutes !== prepared.basis.slotMinutes ||
    v.effectiveWindow.fromMinutes !== prepared.effectiveWindow?.fromMinutes ||
    v.effectiveWindow.toMinutes !== prepared.effectiveWindow?.toMinutes
  )
    return false;
  if (v.similarity !== undefined) {
    const s = v.similarity;
    if (
      !record(s) ||
      s.metric !== "annual-daylight-l2" ||
      s.model !== "signatures-v1" ||
      s.sampleCount !== 581 ||
      s.approximate !== true ||
      !Number.isInteger(s.shortlistSize) ||
      (s.shortlistSize as number) < 1 ||
      (s.shortlistSize as number) > 500 ||
      s.shortlistSize !== Math.min(500, s.eligibleSides as number) ||
      !Number.isInteger(s.eligibleSides) ||
      (s.eligibleSides as number) < (s.shortlistSize as number) ||
      !record(s.squaredDistances) ||
      !record(s.reference) ||
      !isShadeWindowPayload({ ...v, similarity: undefined, results: [s.reference] }) ||
      v.results.some(
        (raw) =>
          !record(raw) ||
          raw.candidateId === (s.reference as Record<string, unknown>).candidateId ||
          raw.blockFaceId === (s.reference as Record<string, unknown>).blockFaceId ||
          !Number.isSafeInteger(
            (s.squaredDistances as Record<string, unknown>)[raw.candidateId as string],
          ) ||
          ((s.squaredDistances as Record<string, unknown>)[raw.candidateId as string] as number) <
            0 ||
          ((s.squaredDistances as Record<string, unknown>)[raw.candidateId as string] as number) >
            581 * 255 * 255,
      ) ||
      Object.keys(s.squaredDistances).length !== v.results.length
    )
      return false;
  }
  const ids = new Set<string>();
  const faces = new Set<string>();
  const month = Number(v.requestedDate.slice(5, 7)) - 1;
  const effective = v.effectiveWindow;
  const generation = v.generation;
  return v.results.every((raw) => {
    if (
      !record(raw) ||
      (raw.shadeKey !== undefined &&
        (typeof raw.shadeKey !== "string" ||
          !/^shades\/[a-z0-9-]{1,64}\.json$/.test(raw.shadeKey))) ||
      typeof raw.segmentKey !== "string" ||
      !/^\d+,\d+$/.test(raw.segmentKey) ||
      !["left", "right"].includes(raw.side as string) ||
      raw.candidateId !== `${generation}:${raw.segmentKey}:${raw.side}` ||
      typeof raw.blockFaceId !== "string" ||
      !raw.blockFaceId ||
      typeof raw.label !== "string" ||
      !raw.label.trim() ||
      raw.label.length > 160 ||
      !finite(raw.lat) ||
      Math.abs(raw.lat) > 90 ||
      !finite(raw.lng) ||
      Math.abs(raw.lng) > 180 ||
      !finite(raw.distanceM) ||
      raw.distanceM < 0 ||
      !fraction(raw.meanShade) ||
      !windowValue(raw.effectiveWindow) ||
      !Array.isArray(raw.hours) ||
      !raw.hours.length ||
      raw.hours.length > 64
    )
      return false;
    const [lo, hi] = raw.segmentKey.split(",").map(Number);
    if (
      !Number.isSafeInteger(lo) ||
      !Number.isSafeInteger(hi) ||
      lo <= 0 ||
      lo >= hi ||
      ids.has(raw.candidateId as string) ||
      faces.has(raw.blockFaceId)
    )
      return false;
    ids.add(raw.candidateId as string);
    faces.add(raw.blockFaceId);
    let bytes = 0;
    let prior = -1;
    for (const h of raw.hours) {
      if (
        !record(h) ||
        !finite(h.minutes) ||
        !Number.isInteger(h.minutes) ||
        h.minutes % 15 !== 0 ||
        h.minutes < effective.fromMinutes ||
        h.minutes >= effective.toMinutes ||
        (prior !== -1 && h.minutes !== prior + 15) ||
        h.slot !== shadeSlotIndex(month, (h.minutes - 300) / 15) ||
        !fraction(h.shade) ||
        Math.abs(h.shade * 255 - Math.round(h.shade * 255)) > 1e-8
      )
        return false;
      bytes += Math.round(h.shade * 255);
      prior = h.minutes;
    }
    return (
      raw.meanShade === bytes / (255 * raw.hours.length) &&
      raw.effectiveWindow.fromMinutes === raw.hours[0].minutes &&
      raw.effectiveWindow.toMinutes === prior + 15
    );
  });
}

/** Model fractions may be exact or rounded to the displayed whole percentage. */
export function matchesShadeFraction(proposed: unknown, actual: number): boolean {
  return fraction(proposed) && (proposed === actual || proposed === Math.round(actual * 100) / 100);
}

export function shadeRouteTimeMatches(candidate: ShadeCandidate, at: Date): boolean {
  const local = toMapLocal(at, utcOffsetMinAt(SHADE_ZONE, at));
  const minutes = local.hours * 60 + local.minutes;
  return (
    nycDate(at) === candidate.requestedDate &&
    minutes >= candidate.spot.effectiveWindow.fromMinutes &&
    minutes < candidate.spot.effectiveWindow.toMinutes
  );
}

export function shadeTimelineRows(
  hours: readonly ShadeSpotSample[],
  mode: "shade" | "sun",
): Array<{ fromMinutes: number; toMinutes: number; fraction: number }> {
  const groups: ShadeSpotSample[][] = [];
  const aggregate = hours.length > 8;
  for (const sample of hours) {
    const last = groups.at(-1);
    if (aggregate && last && Math.floor(last[0].minutes / 60) === Math.floor(sample.minutes / 60))
      last.push(sample);
    else groups.push([sample]);
  }
  return groups.map((group) => {
    const shade =
      group.reduce((sum, sample) => sum + Math.round(sample.shade * 255), 0) / (255 * group.length);
    return {
      fromMinutes: group[0].minutes,
      toMinutes: group.at(-1)!.minutes + 15,
      fraction: mode === "sun" ? 1 - shade : shade,
    };
  });
}

/** Shared clock bins; missing daylight samples remain visibly unavailable. */
export function shadeComparisonRows(
  reference: readonly ShadeSpotSample[],
  match: readonly ShadeSpotSample[],
  mode: "shade" | "sun",
) {
  const minutes = [...new Set([...reference, ...match].map((s) => s.minutes))].sort(
    (a, b) => a - b,
  );
  const hourly = minutes.length > 8;
  const bins = new Map<number, number[]>();
  for (const minute of minutes) {
    const key = hourly ? Math.floor(minute / 60) * 60 : minute;
    const bin = bins.get(key) ?? [];
    bin.push(minute);
    bins.set(key, bin);
  }
  const value = (samples: readonly ShadeSpotSample[], times: number[]) => {
    const selected = samples.filter((s) => times.includes(s.minutes));
    if (!selected.length) return null;
    const shade =
      selected.reduce((n, s) => n + Math.round(s.shade * 255), 0) / (255 * selected.length);
    return {
      fraction: mode === "sun" ? 1 - shade : shade,
      partial: selected.length < times.length,
    };
  };
  return [...bins.values()].map((times) => ({
    fromMinutes: times[0],
    toMinutes: times.at(-1)! + 15,
    reference: value(reference, times),
    match: value(match, times),
  }));
}

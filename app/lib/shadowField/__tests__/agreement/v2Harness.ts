import { sampleBothSidewalks } from "../../../shadowSampling";
import { edgeSampleCount, sidewalkOffsets } from "../../ShadowField";
import { metersPerDegree } from "../../geometry";
import { aggregateSidewalk, marchOpaqueFlat, type SidewalkEvidence } from "../../v2/march";
import type { OpaqueFlatField } from "../../v2/receivers";
import { paintShadowCanvas, type AgreementFixture } from "./harness";

export const V2_SEVERE = 0.25;
export const HISTORICAL_WORST = 1.0;
export const RETAINED_WITNESSES = ["28L", "38L", "45L", "48L", "84R", "135R", "138R", "144R"] as const;
const HISTORICAL_WITNESSES: Record<(typeof RETAINED_WITNESSES)[number], readonly [number, number, number]> = {
  "28L": [0.625, 0, 0.625], "38L": [0.625, 0, 0.625], "45L": [0, 0.5, 0.5], "48L": [0.5, 1, 0.5],
  "84R": [5 / 7, 3 / 7, 2 / 7], "135R": [0.75, 0.25, 0.5], "138R": [1, 0.5, 0.5], "144R": [1, 0, 1],
};

export interface ScheduledLocation {
  side: "left" | "right";
  lng: number;
  lat: number;
}

export interface V2Reading {
  city: string;
  fixtureIndex: number;
  side: "left" | "right";
  candidate: number | null;
  reference: number | null;
  disagreement: number | null;
  evidence: SidewalkEvidence;
}

export interface V2AgreementReport {
  cases: number;
  readings: V2Reading[];
  nonNullReadings: number;
  nullReadings: number;
  meanAbsolute: number;
  p90: number;
  worst: number;
  worstReading: V2Reading | null;
  severeShare: number;
  byCity: Record<string, { mean: number; invalidShare: number; invalid: number; scheduled: number; nulls: number }>;
  invalidScheduledShare: number;
  invalidScheduled: number;
  scheduled: number;
}

function edgeLengthM(fixture: AgreementFixture): number {
  const metres = metersPerDegree((fixture.edge.from[1] + fixture.edge.to[1]) / 2);
  return Math.hypot((fixture.edge.to[0] - fixture.edge.from[0]) * metres.mPerLng, (fixture.edge.to[1] - fixture.edge.from[1]) * metres.mPerLat);
}

/** The v2 schedule mirrors the legacy sampler's inclusive N+1 ordered locations. */
export function scheduledLocations(fixture: AgreementFixture): ScheduledLocation[] {
  const offsets = sidewalkOffsets(fixture.edge);
  const steps = edgeSampleCount(edgeLengthM(fixture));
  const locations: ScheduledLocation[] = [];
  for (const [side, offset] of [["left", offsets.left], ["right", offsets.right]] as const) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      locations.push({
        side,
        lng: fixture.edge.from[0] + t * (fixture.edge.to[0] - fixture.edge.from[0]) + offset[0],
        lat: fixture.edge.from[1] + t * (fixture.edge.to[1] - fixture.edge.from[1]) + offset[1],
      });
    }
  }
  return locations;
}

function pixelReference(
  fixture: AgreementFixture,
  locations: readonly ScheduledLocation[],
  valid: readonly boolean[],
  altitudeFraction: number,
  sun: { azimuth: number; altitude: number }
): { left: number | null; right: number | null } {
  const centre: [number, number] = [(fixture.edge.from[0] + fixture.edge.to[0]) / 2, (fixture.edge.from[1] + fixture.edge.to[1]) / 2];
  const metres = metersPerDegree(centre[1]);
  const distanceM = edgeLengthM(fixture);
  const canvas = paintShadowCanvas(fixture.prisms.prisms, centre, sun, altitudeFraction, {
    widthPx: Math.max(16, Math.ceil((Math.abs(fixture.edge.to[0] - fixture.edge.from[0]) * metres.mPerLng + 50) / 1.2)),
    heightPx: Math.max(16, Math.ceil((Math.abs(fixture.edge.to[1] - fixture.edge.from[1]) * metres.mPerLat + 50) / 1.2)),
    metresPerPixel: 1.2,
    dpr: 2,
  });
  const masked = { data: new Uint8ClampedArray(locations.length * 4), width: locations.length, height: 1 } as ImageData;
  const validCounts = { left: 0, right: 0 };
  locations.forEach((location, index) => {
    const [px, py] = canvas.project(location.lng, location.lat);
    const x = Math.round(px * canvas.dpr);
    const y = Math.round(py * canvas.dpr);
    if (!valid[index] || x < 0 || y < 0 || x >= canvas.imageData.width || y >= canvas.imageData.height) return;
    const at = (y * canvas.imageData.width + x) * 4;
    masked.data.set(canvas.imageData.data.subarray(at, at + 4), index * 4);
    validCounts[location.side]++;
  });
  // The existing sampler owns the blue predicate, inclusive schedule and sidewalk
  // offsets. This projection preserves each frozen painted pixel but maps invalid
  // scheduled locations out of bounds, applying the v2 validity adapter identically.
  const projected = (lng: number, lat: number): [number, number] => {
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < locations.length; index++) {
      const dx = locations[index].lng - lng;
      const dy = locations[index].lat - lat;
      const candidate = dx * dx + dy * dy;
      if (candidate < distance) {
        best = index;
        distance = candidate;
      }
    }
    return best >= 0 && valid[best] ? [best, 0] : [-1, -1];
  };
  const sampled = sampleBothSidewalks(projected, masked, 1, fixture.edge.from, fixture.edge.to, edgeSampleCount(distanceM));
  return {
    left: validCounts.left === 0 ? null : sampled.left,
    right: validCounts.right === 0 ? null : sampled.right,
  };
}

export function evaluateV2Fixture(
  fixture: AgreementFixture,
  fixtureIndex: number,
  field: OpaqueFlatField,
  toMetres: (lng: number, lat: number) => [number, number],
  sun: { azimuth: number; altitude: number; altitudeFraction: number }
): V2Reading[] {
  const locations = scheduledLocations(fixture);
  const sides = (["left", "right"] as const).map((side) => locations.filter((location) => location.side === side));
  const evidence = sides.map((side) => aggregateSidewalk(side.map((location) => toMetres(location.lng, location.lat)), field, sun));
  // The candidate's individual mask, not a count-derived approximation, is applied
  // to the painted reference at the identical scheduled locations.
  const valid = locations.map((location) =>
    marchOpaqueFlat(field, ...toMetres(location.lng, location.lat), sun).validity.status === "valid"
  );
  const reference = pixelReference(fixture, locations, valid, sun.altitudeFraction, sun);
  return (["left", "right"] as const).map((side, index) => ({
    city: fixture.city,
    fixtureIndex,
    side,
    candidate: evidence[index].shadow,
    reference: reference[side],
    disagreement: evidence[index].shadow === null || reference[side] === null ? null : Math.abs(evidence[index].shadow - reference[side]),
    evidence: evidence[index],
  }));
}

export function reportV2(readings: V2Reading[], cases: number): V2AgreementReport {
  const numeric = readings.flatMap((reading) => reading.disagreement === null ? [] : [reading.disagreement]);
  const sorted = [...numeric].sort((a, b) => a - b);
  const cityNames = [...new Set(readings.map((reading) => reading.city))];
  let invalidScheduled = 0;
  let scheduled = 0;
  const byCity: V2AgreementReport["byCity"] = {};
  for (const city of cityNames) {
    const cityReadings = readings.filter((reading) => reading.city === city);
    const values = cityReadings.flatMap((reading) => reading.disagreement === null ? [] : [reading.disagreement]);
    const invalid = cityReadings.reduce((sum, reading) => sum + reading.evidence.invalidCount, 0);
    const total = cityReadings.reduce((sum, reading) => sum + reading.evidence.totalCount, 0);
    invalidScheduled += invalid;
    scheduled += total;
    byCity[city] = { mean: values.reduce((sum, value) => sum + value, 0) / values.length, invalidShare: invalid / total, invalid, scheduled: total, nulls: cityReadings.filter((reading) => reading.disagreement === null).length };
  }
  return {
    cases,
    readings,
    nonNullReadings: numeric.length,
    nullReadings: readings.length - numeric.length,
    meanAbsolute: numeric.reduce((sum, value) => sum + value, 0) / numeric.length,
    p90: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)],
    worst: sorted.at(-1) ?? 0,
    worstReading: readings.find((reading) => reading.disagreement === sorted.at(-1)) ?? null,
    severeShare: numeric.filter((value) => value > V2_SEVERE).length / numeric.length,
    byCity,
    invalidScheduledShare: invalidScheduled / scheduled,
    invalidScheduled,
    scheduled,
  };
}

export function assertV2Gate(report: V2AgreementReport): void {
  if (report.cases !== 150 || report.nonNullReadings !== 300 || report.meanAbsolute > 0.04 || report.p90 > 0.05 || report.severeShare > 0.04 || report.invalidScheduledShare > 0.25) throw new Error("v2 agreement gate failed");
  for (const city of Object.values(report.byCity)) {
    if (city.mean > 0.08 || city.invalidShare > 0.25) throw new Error("v2 city agreement gate failed");
  }
}

export function formatV2Report(report: V2AgreementReport): string {
  const witness = RETAINED_WITNESSES.map((id) => {
    const fixtureIndex = Number(id.slice(0, -1)); // D3's retained fixture IDs are zero-based.
    const side = id.at(-1) === "L" ? "left" : "right";
    const reading = report.readings.find((item) => item.fixtureIndex === fixtureIndex && item.side === side);
    const historic = HISTORICAL_WITNESSES[id];
    const current = reading ? `${reading.candidate?.toFixed(3) ?? "null"}/${reading.reference?.toFixed(3) ?? "null"}/${reading.disagreement?.toFixed(3) ?? "null"}` : "missing";
    return `${id}=${current} vs ${historic.map((value) => value.toFixed(3)).join("/")}`;
  }).join(", ");
  const cities = Object.entries(report.byCity).map(([city, value]) => `${city}: mean=${value.mean.toFixed(4)} invalidShare=${value.invalidShare.toFixed(4)} exclusions=${value.invalid}/${value.scheduled} null=${value.nulls}`).join("; ");
  const worst = report.worstReading;
  const worstLabel = worst ? `${worst.fixtureIndex}${worst.side === "left" ? "L" : "R"}=${worst.candidate?.toFixed(4)}/${worst.reference?.toFixed(4)}/${worst.disagreement?.toFixed(4)}` : "none";
  return `v2 agreement: cases=${report.cases} readings=${report.nonNullReadings} null=${report.nullReadings} mean=${report.meanAbsolute.toFixed(4)} p90=${report.p90.toFixed(4)} severe=${report.severeShare.toFixed(4)} worst=${worstLabel} historicalWorst=${HISTORICAL_WORST.toFixed(1)} invalid=${report.invalidScheduled}/${report.scheduled} (${report.invalidScheduledShare.toFixed(4)}) cities=[${cities}] witnesses=[${witness}]`;
}

import type { ResolvedExposureContext, ExposureObjective } from "./exposure";

export type ExposureProvenance = "geometry" | "canvas" | "forecast" | "manual" | "mixed" | "unknown" | string;

export interface ExposureSegment {
  distanceM: number;
  /** Duration for a moving or waiting segment. Defaults to distance/speed when supplied. */
  durationSec?: number;
  /** Sun shadow or rain shelter fraction, 0–1. */
  protection?: number;
  /** Confidence of the protection measurement. Missing protection is unknown. */
  confidence?: number;
  /** Optional speed used when durationSec is not provided. */
  speedMps?: number;
  provenance?: ExposureProvenance;
}

export interface ExposureMetrics {
  objective: ExposureObjective;
  evaluatedContext?: ResolvedExposureContext;
  shelteredDistanceM: number;
  exposedDistanceM: number;
  unknownDistanceM: number;
  shelteredDurationSec: number;
  exposedDurationSec: number;
  unknownDurationSec: number;
  shelteredDistancePct: number | null;
  exposedDistancePct: number | null;
  longestContinuousShelteredM: number;
  longestContinuousExposedM: number;
  continuityTransitions: number;
  /** Legacy naming used by cards and saved records. */
  longestContinuousProtectionM: number;
  provenance: ExposureProvenance;
  updating?: boolean;
}

const THRESHOLD = 0.5;
const DEFAULT_SPEED_MPS = 1.4;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function durationFor(segment: ExposureSegment): number {
  if (segment.durationSec != null && Number.isFinite(segment.durationSec)) {
    return Math.max(0, segment.durationSec);
  }
  const speed = segment.speedMps != null && Number.isFinite(segment.speedMps) && segment.speedMps > 0
    ? segment.speedMps
    : DEFAULT_SPEED_MPS;
  return Math.max(0, segment.distanceM) / speed;
}

/**
 * Aggregate one connected path while keeping unknown measurements separate.
 * Unknown segments break continuity and contribute to neither sheltered nor
 * exposed distance; a missing readback can therefore never become a confident
 * exposed claim.
 */
export function computeExposureMetrics(
  objective: ExposureObjective,
  segments: readonly ExposureSegment[],
  evaluatedContext?: ResolvedExposureContext,
): ExposureMetrics {
  let shelteredDistanceM = 0;
  let exposedDistanceM = 0;
  let unknownDistanceM = 0;
  let shelteredDurationSec = 0;
  let exposedDurationSec = 0;
  let unknownDurationSec = 0;
  let currentSheltered = 0;
  let currentExposed = 0;
  let longestContinuousShelteredM = 0;
  let longestContinuousExposedM = 0;
  let continuityTransitions = 0;
  let previous: "sheltered" | "exposed" | null = null;
  const provenance = new Set<ExposureProvenance>();

  for (const segment of segments) {
    const distance = Math.max(0, Number.isFinite(segment.distanceM) ? segment.distanceM : 0);
    const duration = durationFor({ ...segment, distanceM: distance });
    const confidence = segment.confidence == null ? (segment.protection == null ? 0 : 1) : segment.confidence;
    const known = segment.protection != null && Number.isFinite(segment.protection) && confidence >= 0.5;
    if (!known) {
      unknownDistanceM += distance;
      unknownDurationSec += duration;
      currentSheltered = 0;
      currentExposed = 0;
      previous = null;
      provenance.add(segment.provenance ?? "unknown");
      continue;
    }

    const protection = clamp01(segment.protection!);
    const sheltered = protection > THRESHOLD;
    if (sheltered) {
      shelteredDistanceM += distance * protection;
      exposedDistanceM += distance * (1 - protection);
      shelteredDurationSec += duration * protection;
      exposedDurationSec += duration * (1 - protection);
      currentSheltered += distance;
      currentExposed = 0;
      longestContinuousShelteredM = Math.max(longestContinuousShelteredM, currentSheltered);
    } else {
      shelteredDistanceM += distance * protection;
      exposedDistanceM += distance * (1 - protection);
      shelteredDurationSec += duration * protection;
      exposedDurationSec += duration * (1 - protection);
      currentExposed += distance;
      currentSheltered = 0;
      longestContinuousExposedM = Math.max(longestContinuousExposedM, currentExposed);
    }
    if (previous !== null && previous !== (sheltered ? "sheltered" : "exposed")) continuityTransitions++;
    previous = sheltered ? "sheltered" : "exposed";
    provenance.add(segment.provenance ?? "unknown");
  }

  const measuredDistance = shelteredDistanceM + exposedDistanceM;
  const measuredDuration = shelteredDurationSec + exposedDurationSec;
  const source: ExposureProvenance = provenance.size === 0
    ? "unknown"
    : provenance.size === 1
      ? [...provenance][0]
      : "mixed";
  return {
    objective,
    evaluatedContext,
    shelteredDistanceM,
    exposedDistanceM,
    unknownDistanceM,
    shelteredDurationSec,
    exposedDurationSec,
    unknownDurationSec,
    shelteredDistancePct: measuredDistance > 0
      ? shelteredDistanceM / measuredDistance
      : measuredDuration > 0
        ? shelteredDurationSec / measuredDuration
        : null,
    exposedDistancePct: measuredDistance > 0
      ? exposedDistanceM / measuredDistance
      : measuredDuration > 0
        ? exposedDurationSec / measuredDuration
        : null,
    longestContinuousShelteredM,
    longestContinuousExposedM,
    continuityTransitions,
    longestContinuousProtectionM: longestContinuousShelteredM,
    provenance: source,
  };
}

export function protectionForObjective(
  edge: { shadowFactor: number; shelterFactor?: number; exposureConfidence?: number; shelterConfidence?: number },
  objective: ExposureObjective,
): { protection: number | undefined; confidence: number } {
  if (objective === "rain") {
    return {
      protection: edge.shelterFactor,
      confidence: edge.shelterConfidence ?? edge.exposureConfidence ?? (edge.shelterFactor == null ? 0 : 1),
    };
  }
  return {
    protection: edge.shadowFactor,
    confidence: edge.exposureConfidence ?? 1,
  };
}

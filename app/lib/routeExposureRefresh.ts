import type { ResolvedExposureContext } from "./exposure";
import { computeExposureMetrics, type ExposureSegment } from "./exposureMetrics";
import { haversineMeters, type RouteOption } from "./routing";
import type { EdgeRef, ShadowField } from "./shadowField/ShadowField";
import { getTravelModePolicy } from "./travelMode";
import { shelterWaitExposureFrom, waitExposureFrom } from "./transitWaitExposure";

/** Coordinates retained by a route search, with its chosen sidewalk if known. */
export interface RouteExposureEdge extends EdgeRef {
  side?: "left" | "right" | null;
}

function geometryEdges(route: RouteOption): RouteExposureEdge[] {
  if (route.sampledEdges?.length) return route.sampledEdges;
  const coordinates = route.geojson.geometry.coordinates as Array<[number, number]>;
  const edges: RouteExposureEdge[] = [];
  for (let i = 0; i < coordinates.length - 1; i++) {
    edges.push({ from: coordinates[i], to: coordinates[i + 1], side: null });
  }
  return edges;
}

/**
 * Re-evaluate an existing path under a new immutable context. This function never
 * searches or changes the route geometry; callers can therefore debounce it while
 * a timeline or wind control is moving without changing selection or camera.
 */
export function refreshRouteExposure(
  route: RouteOption,
  field: ShadowField,
  context: ResolvedExposureContext,
): RouteOption {
  const speedMps = getTravelModePolicy(route.travelMode ?? "walk").speedMps;
  const sample = (edges: RouteExposureEdge[]) => {
    const samples = field.sampleExposureEdges
      ? field.sampleExposureEdges(
          edges,
          context.objective,
          context.time,
          context.objective === "rain" ? context.direction : undefined,
        )
      : context.objective === "rain"
        ? field.sampleRainEdges(edges, context.direction, context.time)
        : field.sampleEdges(edges, context.time);
    const segments: ExposureSegment[] = samples.map((answer, index) => {
      const edge = edges[index];
      const distanceM = haversineMeters(edge.from, edge.to);
      const protection = edge.side === "left"
        ? answer.left
        : edge.side === "right"
          ? answer.right
          : (answer.left + answer.right) / 2;
      return {
        distanceM,
        speedMps,
        protection,
        confidence: answer.confidence,
        provenance: answer.source === "none" ? "unknown" : "geometry",
      };
    });
    return { samples, segments };
  };

  // Transit paths retain their access/egress geometry and actual stop locations,
  // so a wind refresh can update both without re-running the timetable search.
  if (route.legs?.some((leg) => leg.type === "transit")) {
    const nextLegs = route.legs.map((leg) => {
      if (leg.type === "walk") {
        const edges = leg.sampledEdges?.length
          ? leg.sampledEdges
          : geometryEdges({ ...route, geojson: leg.geojson, sampledEdges: undefined });
        const result = sample(edges);
        const exposure = computeExposureMetrics(context.objective, result.segments, context);
        return {
          ...leg,
          objective: context.objective,
          evaluatedContext: context,
          exposureSegments: result.segments,
          sampledEdges: edges,
          ...(context.objective === "rain"
            ? { shelterCoverage: exposure.shelteredDistancePct ?? undefined, exposure: { ...exposure, evaluatedContext: context } }
            : { shadowCoverage: exposure.shelteredDistancePct ?? 0, exposure: { ...exposure, evaluatedContext: context } }),
        };
      }
      if (!leg.waitLocations || leg.waitLocations.length === 0) {
        return {
          ...leg,
          objective: context.objective,
          evaluatedContext: context,
        };
      }
      const durations = leg.waitDurationsSec ?? [];
      if (context.objective === "rain") {
        const waits = leg.waitLocations.map((location, index) => {
          const answer = field.rainAt(location[0], location[1], context.direction, context.time);
          return {
            waitSec: durations[index] ?? (leg.waitSec ?? 0) / Math.max(1, leg.waitLocations!.length),
            shelter: answer.shelter,
            confidence: answer.confidence,
          };
        });
        return {
          ...leg,
          objective: context.objective,
          evaluatedContext: context,
          waitExposure: shelterWaitExposureFrom(waits),
        };
      }
      const waits = leg.waitLocations.map((location, index) => ({
        waitSec: durations[index] ?? (leg.waitSec ?? 0) / Math.max(1, leg.waitLocations!.length),
        sample: field.shadowAt(location[0], location[1], context.time),
      }));
      return {
        ...leg,
        objective: context.objective,
        evaluatedContext: context,
        waitExposure: waitExposureFrom(waits),
      };
    });
    const durationSegments: ExposureSegment[] = [];
    for (const leg of nextLegs) {
      if (leg.type === "walk") {
        const edges = leg.sampledEdges?.length
          ? leg.sampledEdges
          : geometryEdges({ ...route, geojson: leg.geojson, sampledEdges: undefined });
        const result = sample(edges);
        durationSegments.push(...result.segments);
        continue;
      }
      const waitSec = Math.max(0, leg.waitSec ?? 0);
      const rideSec = Math.max(0, (leg.travelTimeSec ?? 0) - waitSec);
      if (waitSec > 0) {
        durationSegments.push({
          distanceM: 0,
          durationSec: waitSec,
          protection: context.objective === "rain" ? leg.waitExposure?.shelter : leg.waitExposure?.shadow,
          confidence: leg.waitExposure?.coverage ?? 0,
          provenance: "geometry",
        });
      }
      durationSegments.push({
        distanceM: 0,
        durationSec: rideSec,
        protection: context.objective === "rain" && leg.vehicleSheltered === true ? 1 : undefined,
        confidence: context.objective === "rain" && leg.vehicleSheltered === true ? 1 : 0,
        provenance: context.objective === "rain" ? "vehicle-assumption" : "unknown",
      });
    }
    const exposure = computeExposureMetrics(context.objective, durationSegments, context);
    const retainedEdges = nextLegs.flatMap((leg) => leg.type === "walk" ? leg.sampledEdges ?? [] : []);
    return {
      ...route,
      legs: nextLegs,
      objective: context.objective,
      evaluatedContext: context,
      dryCoverage: context.objective === "rain" ? exposure.shelteredDistancePct ?? undefined : route.dryCoverage,
      exposure,
      exposureSegments: durationSegments,
      sampledEdges: retainedEdges,
      exposureUpdating: false,
    };
  }

  const edges = geometryEdges(route);
  if (edges.length === 0) {
    return {
      ...route,
      objective: context.objective,
      evaluatedContext: context,
      exposure: computeExposureMetrics(context.objective, [], context),
      exposureUpdating: false,
    };
  }

  const { segments } = sample(edges);
  const exposure = computeExposureMetrics(context.objective, segments, context);
  const knownProtection = exposure.shelteredDistanceM + exposure.exposedDistanceM;
  const protectedPct = knownProtection > 0 ? exposure.shelteredDistanceM / knownProtection : null;

  if (context.objective === "rain") {
    return {
      ...route,
      objective: "rain",
      evaluatedContext: context,
      dryCoverage: protectedPct ?? undefined,
      longestContinuousWetM: exposure.longestContinuousExposedM,
      wetTransitions: exposure.continuityTransitions,
      exposure,
      exposureSegments: segments,
      exposureUpdating: false,
    };
  }

  return {
    ...route,
    objective: "sun",
    evaluatedContext: context,
    shadowCoverage: protectedPct ?? 0,
    longestContinuousShadowM: exposure.longestContinuousShelteredM,
    longestContinuousSunM: exposure.longestContinuousExposedM,
    shadowTransitions: exposure.continuityTransitions,
    exposure,
    exposureSegments: segments,
    exposureUpdating: false,
  };
}

/** Mark retained alternatives while an asynchronous replacement is pending. */
export function markExposureUpdating(routes: readonly RouteOption[]): RouteOption[] {
  return routes.map((route) => ({ ...route, exposureUpdating: true }));
}

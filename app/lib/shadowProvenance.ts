/**
 * Where a route's shadow number came from (Track A, checkpoint A4b).
 *
 * `shadowCoverage` used to have one answer for that question — the map canvas — so it
 * never needed asking. Now routing samples building geometry and falls back to the
 * pixel sampler per edge, so two routes can report the same percentage on completely
 * different evidence, and the UI is only allowed to show numbers it can explain.
 *
 * ## Aggregate over the path, not the graph
 *
 * This is the decision that makes the surfacing honest rather than alarmist. A route
 * graph holds thousands of edges and a chosen route uses a few dozen. A route whose
 * own edges all came from geometry should say so even when most of the *graph* fell
 * back, because the fallback happened somewhere the user is not walking.
 *
 * So the input is a path — `nodeIds` — and the weighting is distance, matching
 * `shadowCoverage` itself (`routing.ts`: `shadowedDist / totalDist`). Same path, same
 * weights, different per-edge value.
 *
 * ## Two ways to have no source, and why they must not be confused
 *
 * Virtual snap nodes and transit connectors are never sampled, so they have no entry
 * at all. Their distance still counts, under `"none"` — dropping it would let a route
 * half-built from unsampled connectors look fully sourced — but they are **excluded
 * from the confidence statistics**. Every route begins and ends on a virtual snap
 * node, so folding a zero into `minConfidence` would stamp "low confidence" on every
 * route ever calculated, which is exactly the alarmism this module exists to avoid.
 * Confidence describes the edges that were actually sampled; `bySource` describes the
 * whole path, and `sampledFraction` is how a reader tells the two apart.
 *
 * After sunset the field reports `"none"` with full confidence for every edge — an
 * astronomical certainty, not a gap. That is why `sampledFraction` exists rather than
 * a bare `dominant === "none"` test: the sourceless-because-dark path and the
 * sourceless-because-unsampled path disagree about everything except the source name.
 */

import { LOW_CONFIDENCE, type ShadowSource } from "./shadowField/ShadowField";

/** Below this share of the path, no single source gets to speak for the whole route. */
const DOMINANT_SHARE = 0.7;

export interface ShadowProvenance {
  /** Distance-weighted share per source. Sums to 1 over a non-empty path. */
  bySource: Partial<Record<ShadowSource, number>>;
  /** The source holding the most distance. `"none"` when nothing was sampled. */
  dominant: ShadowSource;
  /** Distance-weighted share of the path that had a shadow entry at all. */
  sampledFraction: number;
  /** Lowest per-edge confidence among sampled edges; 1 when none were sampled. */
  minConfidence: number;
  /** Distance-weighted mean over sampled edges; 1 when none were sampled. */
  meanConfidence: number;
}

/** What routing recorded for one canonical edge. */
export interface EdgeShadowSource {
  source: ShadowSource;
  confidence: number;
}

const EMPTY: ShadowProvenance = {
  bySource: {},
  dominant: "none",
  sampledFraction: 0,
  minConfidence: 1,
  meanConfidence: 1,
};

/**
 * Summarise where the shadow values along one path came from.
 *
 * `edgeShadow` is keyed `"lo,hi"` on node id — the same canonicalisation routing uses
 * when it caches per-edge shadow, so a lookup here asks the identical question the
 * cost model was answered with. `distanceFor` keeps this module free of the graph;
 * the caller closes over its own adjacency.
 */
export function summarizeShadowSource(
  nodeIds: number[],
  edgeShadow: ReadonlyMap<string, EdgeShadowSource>,
  distanceFor: (a: number, b: number) => number
): ShadowProvenance {
  if (nodeIds.length < 2) return EMPTY;

  const distanceBySource = new Map<ShadowSource, number>();
  let totalDist = 0;
  let sampledDist = 0;
  let confidenceDist = 0;
  let minConfidence = Number.POSITIVE_INFINITY;

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const a = nodeIds[i];
    const b = nodeIds[i + 1];
    const distanceM = distanceFor(a, b);
    if (!(distanceM > 0)) continue;

    totalDist += distanceM;

    const entry = edgeShadow.get(`${Math.min(a, b)},${Math.max(a, b)}`);
    const source: ShadowSource = entry ? entry.source : "none";
    distanceBySource.set(source, (distanceBySource.get(source) ?? 0) + distanceM);

    if (entry) {
      sampledDist += distanceM;
      confidenceDist += entry.confidence * distanceM;
      if (entry.confidence < minConfidence) minConfidence = entry.confidence;
    }
  }

  if (totalDist === 0) return EMPTY;

  const bySource: Partial<Record<ShadowSource, number>> = {};
  let dominant: ShadowSource = "none";
  let dominantDist = -1;
  for (const [source, dist] of distanceBySource) {
    bySource[source] = dist / totalDist;
    // Ties go to a real source: "none" is the absence of an answer, not an answer.
    if (dist > dominantDist || (dist === dominantDist && dominant === "none")) {
      dominant = source;
      dominantDist = dist;
    }
  }

  return {
    bySource,
    dominant,
    sampledFraction: sampledDist / totalDist,
    minConfidence: sampledDist > 0 ? minConfidence : 1,
    meanConfidence: sampledDist > 0 ? confidenceDist / sampledDist : 1,
  };
}

/**
 * One line a route card can show beside its shadow percentage.
 *
 * Deliberately a string rather than a component: the branching is the honest part and
 * belongs where it can be unit-tested, not in JSX.
 */
export function describeShadowProvenance(p: ShadowProvenance): string {
  const label = baseLabel(p);
  return p.minConfidence < LOW_CONFIDENCE ? `${label} · low confidence` : label;
}

function baseLabel(p: ShadowProvenance): string {
  if (p.sampledFraction === 0) return "source unknown";

  // Sourceless *and* fully sampled *and* certain means the sun is down — every edge
  // is shadowed and no geometry was needed to know it.
  if (
    p.dominant === "none" &&
    p.sampledFraction >= DOMINANT_SHARE &&
    p.minConfidence >= LOW_CONFIDENCE
  ) {
    return "sun is below the horizon";
  }

  if ((p.bySource[p.dominant] ?? 0) < DOMINANT_SHARE) return "mixed sources";

  switch (p.dominant) {
    case "tiles":
    case "overpass":
    case "nyc-static":
      return "from building geometry";
    // Named rather than left to fall through to "source unknown", which is what A7
    // emitting these two would otherwise have made every tree-lined route say. The
    // map does not paint canopy yet, so a route can read "and tree canopy" over a
    // street the renderer draws in full sun — issue #275 is that contradiction, and
    // it is decided against A7's measured coverage, not hidden behind a vague label.
    case "mixed":
      return "from building geometry and tree canopy";
    case "canopy":
      return "from tree canopy";
    case "canvas":
      return "from the map view";
    default:
      return "source unknown";
  }
}

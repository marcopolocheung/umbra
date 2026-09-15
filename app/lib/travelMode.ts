export type TravelModeId = "walk" | "bike";

export interface TravelModePolicy {
  id: TravelModeId;
  label: string;
  speedMps: number;
  stepsPenaltyM: number;
  roughSurfacePenaltyM: number;
  cyclewayPreferenceM: number;
}

export const TRAVEL_MODE_POLICIES: Record<TravelModeId, TravelModePolicy> = {
  walk: {
    id: "walk",
    label: "Walk",
    speedMps: 1.4,
    stepsPenaltyM: 0,
    roughSurfacePenaltyM: 0,
    cyclewayPreferenceM: 0,
  },
  bike: {
    id: "bike",
    label: "Bike",
    speedMps: 4.5,
    stepsPenaltyM: 500,
    roughSurfacePenaltyM: 75,
    cyclewayPreferenceM: -40,
  },
};

export function getTravelModePolicy(mode: TravelModeId): TravelModePolicy {
  return TRAVEL_MODE_POLICIES[mode];
}

export function travelTimeSeconds(distanceM: number, mode: TravelModeId): number {
  return distanceM / getTravelModePolicy(mode).speedMps;
}

/** Parse a `mode` share-URL value. Unknown or missing values fall back to walk. */
export function parseTravelMode(raw: string | null): TravelModeId {
  return raw === "bike" ? "bike" : "walk";
}

/** OSM surfaces that cost extra in bike mode (E1 list — see TRACK_E.md). */
const ROUGH_SURFACES = new Set(["cobblestone", "gravel", "sand", "dirt", "ground"]);

/** The most a cycleway can discount one edge, in meters (policy magnitude). */
const CYCLEWAY_DISCOUNT_MAX_M = Math.abs(TRAVEL_MODE_POLICIES.bike.cyclewayPreferenceM);

/**
 * The most a cycleway can discount one edge, as a share of its length. Caps the
 * flat 40 m preference so short edges keep at least half their cost — which is
 * what keeps the Pareto optimistic bound admissible (see `minCostRatio`).
 */
const CYCLEWAY_DISCOUNT_MAX_SHARE = 0.5;

/** Floor for one edge's mode-adjusted cost. Dijkstra needs non-negative costs. */
const MIN_EDGE_COST_M = 1;

/** Tags the mode cost model reads. `GraphEdge` satisfies this structurally. */
export interface ModeEdgeTags {
  distanceM: number;
  highway?: string;
  surface?: string;
  cycleway?: string;
}

/**
 * One edge's length in mode-cost meters: physical distance plus penalties minus
 * the cycleway discount, floored at `MIN_EDGE_COST_M`.
 *
 * Preferences only ever *reduce* positive cost — they never go below the floor —
 * so `paretoRoutes`' optimistic-bound pruning stays sound.
 */
export function modeAdjustedDistanceM(edge: ModeEdgeTags, mode: TravelModeId): number {
  if (mode === "walk") return edge.distanceM;
  const policy = getTravelModePolicy(mode);
  let cost = edge.distanceM;
  if (edge.highway === "steps") cost += policy.stepsPenaltyM;
  if (edge.surface != null && ROUGH_SURFACES.has(edge.surface)) {
    cost += policy.roughSurfacePenaltyM;
  }
  if (edge.cycleway != null && edge.cycleway !== "" && edge.cycleway !== "no") {
    cost -= Math.min(CYCLEWAY_DISCOUNT_MAX_M, edge.distanceM * CYCLEWAY_DISCOUNT_MAX_SHARE);
  }
  return Math.max(MIN_EDGE_COST_M, cost);
}

/**
 * Lower bound on (mode-adjusted cost ÷ physical distance) over any edge. Walk is
 * exact (1); bike keeps at least half of every edge's length via the discount
 * cap above. `paretoRoutes` scales its remaining-distance heuristic by this so
 * the heuristic never overestimates the remaining mode cost.
 */
export function minCostRatio(mode: TravelModeId): number {
  return mode === "walk" ? 1 : 1 - CYCLEWAY_DISCOUNT_MAX_SHARE;
}

export type TravelModeId = "walk" | "bike";

export interface TravelModePolicy {
  id: TravelModeId;
  label: string;
  speedMps: number;
  stepsPenaltyM: number;
  roughSurfacePenaltyM: number;
  cyclewayPreferenceM: number;
  /** "walk" / "ride" — the noun user-facing sentences use for the trip. */
  journeyNoun: string;
  /** "walking" / "cycling" — the gerund those sentences use for the traveller. */
  gerund: string;
}

export const TRAVEL_MODE_POLICIES: Record<TravelModeId, TravelModePolicy> = {
  walk: {
    id: "walk",
    label: "Walk",
    speedMps: 1.4,
    stepsPenaltyM: 0,
    roughSurfacePenaltyM: 0,
    cyclewayPreferenceM: 0,
    journeyNoun: "walk",
    gerund: "walking",
  },
  bike: {
    id: "bike",
    label: "Bike",
    speedMps: 4.5,
    stepsPenaltyM: 500,
    roughSurfacePenaltyM: 75,
    cyclewayPreferenceM: -40,
    journeyNoun: "ride",
    gerund: "cycling",
  },
};

export function getTravelModePolicy(mode: TravelModeId): TravelModePolicy {
  return TRAVEL_MODE_POLICIES[mode];
}

export function travelTimeSeconds(distanceM: number, mode: TravelModeId): number {
  return distanceM / getTravelModePolicy(mode).speedMps;
}

/**
 * Mode speed relative to walking. Metre-denominated routing constants (the
 * Pareto flat allowance, the crossing penalty) are calibrated as walk-metres —
 * a time allowance expressed in metres at 1.4 m/s — so `routing.ts` scales them
 * by this ratio to keep the same *time* value per mode. Walk's ratio is exactly
 * 1, which is what keeps walk behavior byte-identical. See
 * `docs/notes/mode-shadow-weight.md`.
 */
export function speedRatioVsWalk(mode: TravelModeId): number {
  return getTravelModePolicy(mode).speedMps / TRAVEL_MODE_POLICIES.walk.speedMps;
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
  bicycle?: string;
  access?: string;
}

/**
 * `bicycle=*` values that re-allow cycling where the general `access=*` tag
 * bans it. OSM's access hierarchy resolves most-specific-first: a
 * `bicycle=yes|designated|permissive` on an `access=no` way is a legal bike
 * edge, not a prohibited one. Any other value (including absent) falls back to
 * the general tag.
 */
const BICYCLE_ACCESS_OVERRIDES = new Set(["yes", "designated", "permissive"]);

/**
 * True when bikes may not use this edge at all. A mode-specific `bicycle=no`
 * always prohibits; a general `access=no` prohibits unless a more-specific
 * bicycle tag re-allows it. Walk behavior is untouched: this predicate is only
 * consulted for non-walk modes.
 */
export function isProhibitedEdge(edge: ModeEdgeTags, mode: TravelModeId): boolean {
  if (mode === "walk") return false;
  if (edge.bicycle === "no") return true;
  if (edge.access === "no" && !BICYCLE_ACCESS_OVERRIDES.has(edge.bicycle ?? "")) return true;
  return false;
}

/** True when the edge is dedicated cycling infrastructure in bike mode. */
function isCycleInfrastructure(edge: ModeEdgeTags): boolean {
  if (edge.highway === "cycleway") return true;
  if (edge.bicycle === "designated") return true;
  return edge.cycleway != null && edge.cycleway !== "" && edge.cycleway !== "no";
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
  if (isCycleInfrastructure(edge)) {
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

export type TravelModeId = "walk" | "bike" | "scoot";

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
  scoot: {
    id: "scoot",
    label: "Scoot",
    // Assumption, stated plainly: ~11 km/h cruising for kick scooters and
    // skateboards. E-scooters are NOT claimed — legally they behave like
    // bikes in most places, so their riders should use bike mode.
    speedMps: 3.0,
    // Unused: steps are excluded by prohibition (see isProhibitedEdge), not
    // priced. Kept at 0 so a direct cost call never invents a penalty the
    // search would never charge.
    stepsPenaltyM: 0,
    // Near-disqualifying (see SCOOT_NEAR_BAR_M): a large positive penalty so
    // a route with no smooth option still routes, instead of failing.
    roughSurfacePenaltyM: 1000,
    // No cycleway discount: small hard wheels gain nothing from paint, and a
    // discount would lower minCostRatio below 1 for this mode.
    cyclewayPreferenceM: 0,
    journeyNoun: "ride",
    gerund: "riding",
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
  return raw === "bike" || raw === "scoot" ? raw : "walk";
}

/** OSM surfaces that cost extra in bike mode (E1 list — see TRACK_E.md). */
const ROUGH_SURFACES = new Set(["cobblestone", "gravel", "sand", "dirt", "ground"]);

/**
 * OSM surfaces that are near-disqualifying on small hard wheels (E4). The
 * brief's four (`cobblestone`, `gravel`, `sand`, `unpaved`) plus `sett`
 * — Madrid tags its stone setts as `sett`, and for 54 mm wheels a dressed
 * sett is a cobble — plus `dirt`/`ground`, which are loose under any wheel.
 * `smoothness=excellent|good` overrides this list where tagged (see below);
 * untagged `paving_stones` are assumed laid smooth and carry no penalty.
 */
const SCOOT_ROUGH_SURFACES = new Set([
  "cobblestone",
  "sett",
  "gravel",
  "sand",
  "unpaved",
  "dirt",
  "ground",
]);

/** Small penalty for `smoothness=intermediate` in scoot mode — passable, not nice. */
const SCOOT_INTERMEDIATE_SMOOTHNESS_M = 50;

/**
 * Near-disqualifying magnitude for scoot mode, in meters. Shared by the
 * rough-surface and bad-smoothness penalties so the two stay one decision:
 * large enough to divert around a cobbled block, small enough that an
 * isolated rough edge still routes instead of stranding the search.
 */
const SCOOT_NEAR_BAR_M = 1000;

/**
 * The most a cycleway can discount one edge, as a share of its length. Caps a
 * mode's flat cycleway preference so short edges keep at least half their
 * cost — which is what keeps the Pareto optimistic bound admissible (see
 * `minCostRatio`). Only modes with a negative `cyclewayPreferenceM` discount.
 */
const CYCLEWAY_DISCOUNT_MAX_SHARE = 0.5;

/** Floor for one edge's mode-adjusted cost. Dijkstra needs non-negative costs. */
const MIN_EDGE_COST_M = 1;

/** Tags the mode cost model reads. `GraphEdge` satisfies this structurally. */
export interface ModeEdgeTags {
  distanceM: number;
  highway?: string;
  surface?: string;
  smoothness?: string;
  cycleway?: string;
  bicycle?: string;
  foot?: string;
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
 * `foot=*` values that re-allow scooting where the general `access=*` tag
 * bans it. Same most-specific-first rule as the bicycle overrides below:
 * scooters and skateboards ride where pedestrians go, so an explicit
 * `foot=yes|designated|permissive` on an `access=no` way is a legal scoot
 * edge. OSM has no reliable scooter/skateboard access key (`inline_skates=*`
 * is vanishingly rare), so no mode-specific tag is invented or read here.
 */
const FOOT_ACCESS_OVERRIDES = new Set(["yes", "designated", "permissive"]);

/**
 * True when this mode may not use this edge at all. Walk never prohibits.
 * Bike reads `bicycle=*`/`access=*` (E1). Scoot excludes `highway=steps`
 * outright and honours `foot=no` plus `access=no` (with the foot override
 * above) — `bicycle=*` tags are about bikes and are ignored for scoot.
 */
export function isProhibitedEdge(edge: ModeEdgeTags, mode: TravelModeId): boolean {
  if (mode === "walk") return false;
  if (mode === "scoot") {
    if (edge.highway === "steps") return true;
    if (edge.access === "no" && !FOOT_ACCESS_OVERRIDES.has(edge.foot ?? "")) return true;
    // `foot=no` bans scoot — except on dedicated cycleways. Segregated
    // cycle/foot pairs are routinely tagged `foot=no` on the cycleway half,
    // and that half is exactly the smooth network kick-scooters legally ride
    // (e.g. Spain's DGT requires scooters to use cycle lanes where provided).
    // Banning it would strand scoot where it should shine.
    if (edge.foot === "no" && edge.highway !== "cycleway") return true;
    return false;
  }
  if (edge.bicycle === "no") return true;
  if (edge.access === "no" && !BICYCLE_ACCESS_OVERRIDES.has(edge.bicycle ?? "")) return true;
  return false;
}

/**
 * Scoot-mode surface penalty for one edge, in meters. `smoothness=*`
 * overrides `surface=*` where tagged (only ~31% of Madrid-centre ways carry
 * smoothness, measured 2026-09-15, so the surface fallback does the real
 * work): `excellent`/`good` ride free on any surface, `intermediate` costs a
 * little, `bad` and worse are near-disqualifying. An absent or unrecognised
 * smoothness value falls back to the surface list.
 */
export function scootSurfacePenaltyM(edge: ModeEdgeTags): number {
  const smoothness = edge.smoothness?.trim().toLowerCase();
  if (smoothness === "excellent" || smoothness === "good") return 0;
  if (smoothness === "intermediate") return SCOOT_INTERMEDIATE_SMOOTHNESS_M;
  if (
    smoothness === "bad" ||
    smoothness === "very_bad" ||
    smoothness === "horrible" ||
    smoothness === "very_horrible" ||
    smoothness === "impassable"
  ) {
    return SCOOT_NEAR_BAR_M;
  }
  if (edge.surface != null && SCOOT_ROUGH_SURFACES.has(edge.surface)) {
    return SCOOT_NEAR_BAR_M;
  }
  return 0;
}

/**
 * The mode's rough-surface set, for reporting (see `roughSurfaceLine`).
 * Walk has none — nothing is rough on foot.
 */
export function roughSurfacesFor(mode: TravelModeId): ReadonlySet<string> {
  if (mode === "scoot") return SCOOT_ROUGH_SURFACES;
  if (mode === "bike") return ROUGH_SURFACES;
  return EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * One line for the route card when the chosen route still crosses surfaces
 * this mode avoids, e.g. "includes 120 m of cobblestone". Returns null for
 * walk (no avoided surfaces) and when no rough metres were recorded.
 *
 * Honesty limits, stated here so the card never over-claims: the metres are
 * raw `surface=*` tags. A `sett` section tagged `smoothness=good` rides free
 * in the cost model but is still named (the surface IS sett); conversely a
 * bad-`smoothness` stretch on an otherwise smooth surface is penalized by the
 * search but NOT itemized here (zero occurrences in both Madrid samples, so
 * the gap is documented, not fixed). Silence is absence of data, not proof
 * of smooth.
 */
export function roughSurfaceLine(
  surfaceMetresM: Record<string, number> | undefined,
  mode: TravelModeId,
): string | null {
  if (surfaceMetresM == null || mode === "walk") return null;
  const rough = roughSurfacesFor(mode);
  const parts = [...rough]
    .map((surface) => ({ surface, metres: surfaceMetresM[surface] ?? 0 }))
    .filter((entry) => entry.metres > 0)
    .sort((a, b) => b.metres - a.metres)
    .map((entry) => `${Math.round(entry.metres)} m of ${entry.surface}`);
  if (parts.length === 0) return null;
  if (parts.length === 1) return `includes ${parts[0]}`;
  const last = parts[parts.length - 1];
  return `includes ${parts.slice(0, -1).join(", ")} and ${last}`;
}

/** True when the edge is dedicated cycling infrastructure (discounted in bike mode only). */
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
  if (mode === "scoot") {
    // Smoothness-aware, near-disqualifying — and never discounted below.
    cost += scootSurfacePenaltyM(edge);
  } else if (edge.surface != null && ROUGH_SURFACES.has(edge.surface)) {
    cost += policy.roughSurfacePenaltyM;
  }
  if (policy.cyclewayPreferenceM < 0 && isCycleInfrastructure(edge)) {
    const discountCapM = Math.abs(policy.cyclewayPreferenceM);
    cost -= Math.min(discountCapM, edge.distanceM * CYCLEWAY_DISCOUNT_MAX_SHARE);
  }
  return Math.max(MIN_EDGE_COST_M, cost);
}

/**
 * Lower bound on (mode-adjusted cost ÷ physical distance) over any edge,
 * derived from each mode's own policy: a mode with no discount (walk, scoot)
 * keeps every edge's full length, so the ratio is 1; bike's capped discount
 * keeps at least half. `paretoRoutes` scales its remaining-distance heuristic
 * by this so the heuristic never overestimates the remaining mode cost.
 */
export function minCostRatio(mode: TravelModeId): number {
  return getTravelModePolicy(mode).cyclewayPreferenceM < 0
    ? 1 - CYCLEWAY_DISCOUNT_MAX_SHARE
    : 1;
}

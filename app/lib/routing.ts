// Pure TypeScript routing utilities — no browser dependencies
import { MinHeap } from "./minHeap";
import type { PartialRouteInfo } from "./partialRoute";
import type { TrainDrawData, TransitProvenance } from "./trainGraph";
import type { ShadowProvenance } from "./shadowProvenance";
import { modeAdjustedDistanceM, minCostRatio, isProhibitedEdge, speedRatioVsWalk } from "./travelMode";
import type { TravelModeId } from "./travelMode";
import type { TransitWaitExposure } from "./transitWaitExposure";
import type { ExposureMetrics } from "./exposureMetrics";
import { computeExposureMetrics } from "./exposureMetrics";

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  isIntersection?: boolean; // true when node appears in ≥2 OSM ways
}

/**
 * Which sidewalk a directed edge represents, **relative to its own direction of
 * travel** — so "left" means the traveller's left when walking this edge, not a
 * fixed compass side. Only present on the parallel per-sidewalk edges built in
 * `useNavigation`; plain edges leave it undefined.
 */
export type SidewalkSide = "left" | "right";

export interface GraphEdge {
  toId: number;
  distanceM: number;
  shadowFactor: number;
  /**
   * Fraction of rainfall blocked over this edge, 0–1 (1 = fully sheltered).
   *
   * The rain twin of `shadowFactor`. Optional because every sun-era producer and
   * fixture predates it: absent reads as 0 (fully exposed) with unknown
   * provenance, never as dry. Set by `parallelSidewalkEdges` in rain mode.
   */
  shelterFactor?: number;
  /** Confidence for rain shelter. Missing means the shelter measurement is unknown. */
  shelterConfidence?: number;
  /** Confidence for whichever objective populated this edge. */
  exposureConfidence?: number;
  side?: SidewalkSide;
  highway?: string;
  surface?: string;
  /** OSM `smoothness=*` — read by the scoot cost model (E4); ignored by walk/bike. */
  smoothness?: string;
  cycleway?: string;
  bicycle?: string;
  foot?: string;
  access?: string;
}

export interface RoutingGraph {
  nodes: Map<number, OsmNode>;
  adj: Map<number, GraphEdge[]>; // bidirectional
}

/**
 * Which exposure the search optimises for.
 *
 * `"sun"` reads `shadowFactor` and reports shadow metrics; `"rain"` reads
 * `shelterFactor` (a static overhead-coverage or wind-tilted figure) and reports
 * dry/wet metrics. Every default keeps sun behavior bit-identical.
 */
export type ExposureObjective = "sun" | "rain";

export interface RouteResult {
  nodeIds: number[];
  /**
   * Which sidewalk the search chose for each traversed segment: `sides[i]` is the
   * side of the edge from `nodeIds[i]` to `nodeIds[i + 1]`, so this is always one
   * shorter than `nodeIds`. `null` where the graph carried no per-sidewalk edges
   * (sketch routes, transit connectors, virtual snap edges).
   *
   * Consecutive entries that differ are a street crossing — which is the signal
   * turn-by-turn guidance needs, and it comes from the edge the search actually
   * costed rather than a second opinion computed later.
   */
  sides?: Array<SidewalkSide | null>;
  distanceM: number;
  shadowCoverage: number; // 0–1
  longestContinuousShadowM: number;
  /**
   * Longest unbroken run of *sunlit* edges, in meters.
   *
   * Not derivable from `shadowCoverage`: two routes with identical coverage differ
   * entirely depending on whether the sun arrives as one long crossing or as many
   * short gaps, and it is the long unbroken stretch a walker actually feels.
   */
  longestContinuousSunM: number;
  shadowTransitions: number;
  detourRatio: number;
  turnCount: number;
  /** Where `shadowCoverage` came from. Set by the caller that sampled; see `shadowProvenance.ts`. */
  shadowSource?: ShadowProvenance;
  /** Rain objective only: share of distance blocking rain (fraction sheltered), 0–1. */
  dryCoverage?: number;
  /** Rain objective only: longest unbroken run of *wet* edges, in metres. */
  longestContinuousWetM?: number;
  /** Rain objective only: times the path crosses the wet/dry threshold. */
  wetTransitions?: number;
  /**
   * Physical metres per raw `surface=*` tag value along the chosen path
   * (untagged edges accumulate under `"unknown"`). Mode-independent data —
   * the card decides which values are rough for the active mode (E4). Set by
   * `dijkstra` and `paretoRoutes` from the exact traversed edges.
   */
  surfaceMetresM: Record<string, number>;
  /** Objective used to score this path. Added without changing legacy fields. */
  objective?: ExposureObjective;
  /** Honest objective-aware aggregate; unknown coverage is kept separate. */
  exposure?: ExposureMetrics;
  /** Exact sampled segments, retained so multi-stop refreshes preserve continuity. */
  exposureSegments?: Array<{
    distanceM: number;
    protection?: number;
    confidence?: number;
    provenance?: string;
    durationSec?: number;
  }>;
  /** Exact coordinates and sidewalk side used by the search. */
  sampledEdges?: Array<{ from: [number, number]; to: [number, number]; side?: SidewalkSide | null }>;
}

export interface TransitLeg {
  boardStop:  { id: number; lat: number; lon: number; name: string; mode: string };
  alightStop: { id: number; lat: number; lon: number; name: string; mode: string };
  transitDistM: number;
  /** 0.0 = underground (subway/rail), 0.25 = above-ground (bus/tram/ferry) */
  sunExposure: number;
  walkToBoardM: number;
  walkFromAlightM: number;
}

export interface RouteLeg {
  type: 'walk' | 'transit';
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  /** Objective and conditions that produced this leg's exposure fields. */
  objective?: ExposureObjective;
  evaluatedContext?: import("./exposure").ResolvedExposureContext;
  distanceM?: number;        // walk legs
  travelTimeSec?: number;    // transit legs — riding, changing, and waiting
  /** Transit legs: the waiting half of `travelTimeSec`, 0 where unpriced. */
  waitSec?: number;
  /** Transit stop coordinates used to refresh waiting exposure under new wind. */
  waitLocations?: Array<[number, number]>;
  /** Per-stop waiting durations aligned with `waitLocations`. */
  waitDurationsSec?: number[];
  /**
   * Transit legs whose wait is spent in the open — bus: the sun at the boarding
   * stop, sampled rather than assumed from the mode.
   *
   * Absent on a subway leg, whose wait is on a platform this app does not model
   * at all; present with no `shadow` means the field could not answer for the
   * stop. The three states read differently on the card on purpose.
   */
  waitExposure?: TransitWaitExposure;
  /** Rain objective: whether the vehicle is treated as an enclosed shelter. */
  vehicleSheltered?: boolean;
  /** Explicit assumption shown with a rain transit total. */
  vehicleShelterAssumption?: string;
  shadowCoverage?: number;    // walk legs only (0–1)
  shelterCoverage?: number;   // rain legs only (0–1)
  exposure?: ExposureMetrics;
  /** Retained samples for condition-only refresh and connected-leg continuity. */
  exposureSegments?: RouteResult["exposureSegments"];
  sampledEdges?: RouteResult["sampledEdges"];
  line?: string;             // transit legs: line ref/code
  lineColor?: string;        // transit legs: hex color
  lineName?: string;         // transit legs: display name
  /**
   * Transit legs: share of riding time open to the sky. Measured from the
   * published per-segment structure where there is any, otherwise the per-mode
   * constant — which `sunExposureCoverage` is what distinguishes.
   */
  sunExposure?: number;
  /**
   * Share of the ride the figure is actually based on. `undefined` means it is
   * assumed from the line's mode, not measured; 1 means the whole ride was
   * determined. Never read a low coverage as shade (#393).
   */
  sunExposureCoverage?: number;
  /**
   * Transit legs: share of the determined ride whose track is open to the sky.
   *
   * The measured fact, kept separate from `sunExposure`, which is this times a
   * vehicle-attenuation constant. The card states this one, because it is what
   * a passenger can verify out of the window.
   */
  aboveGroundShare?: number;
  stops?: string[];          // transit legs: ordered station names
}

export interface RouteOption {
  label: string; // "Shortest" | "Balanced" | "Most shadowed" | "Via MRT"
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  /** Per-segment sidewalk choice — see `RouteResult.sides`. Walk routes only. */
  sides?: Array<SidewalkSide | null>;
  distanceM: number;
  shadowCoverage: number; // 0–1
  longestContinuousShadowM: number;
  /**
   * Longest unbroken run of *sunlit* edges, in meters.
   *
   * Not derivable from `shadowCoverage`: two routes with identical coverage differ
   * entirely depending on whether the sun arrives as one long crossing or as many
   * short gaps, and it is the long unbroken stretch a walker actually feels.
   */
  longestContinuousSunM: number;
  shadowTransitions: number;
  detourRatio: number;
  turnCount: number;
  transitLeg?: TransitLeg; // undefined for all pure-walk routes
  legs?: RouteLeg[];       // multi-leg routes (MRT transit)
  totalTimeSec?: number;   // sum of walk time + transit travel time
  /** Travel mode this route was costed for. Absent on sketch and transit routes. */
  travelMode?: TravelModeId;
  mrtEntrances?: [[number, number], [number, number]]; // [boardEntrance, alightEntrance] in [lng, lat]
  trainDrawData?: TrainDrawData; // multi-colored polylines, stops, transfers for MapView
  /**
   * What timetable this answer came from, for the card to state (#410). Absent
   * on walk routes and on transit answered by Overpass, which publishes none.
   */
  transitProvenance?: TransitProvenance;
  partial?: PartialRouteInfo; // present when only completed legs are shown
  /** Where `shadowCoverage` came from. Absent on sketch and transit routes. */
  shadowSource?: ShadowProvenance;
  /**
   * Rain objective only — share of the route sheltered from rain, 0–1. Present on
   * walk routes computed in rain mode; absent on sketch and transit routes.
   */
  dryCoverage?: number;
  /** Rain objective only: longest unbroken wet stretch, metres (0 = tasteful placeholder). */
  longestContinuousWetM?: number;
  /** Rain objective only: wet/dry crossings along the path. */
  wetTransitions?: number;
  /**
   * Where the rain figures came from. Reuses `ShadowProvenance` because the
   * source vocabulary (building geometry, tree canopy, mixed) means the same
   * thing for shelter as it does for shade.
   */
  shelterSource?: ShadowProvenance;
  /**
   * Physical metres per `surface=*` value (see `RouteResult.surfaceMetresM`).
   * Absent on sketch and transit routes, which don't reconstruct edges;
   * present on partial routes for the completed legs only.
   */
  surfaceMetresM?: Record<string, number>;
  /** Objective used for this route and the context it was evaluated under. */
  objective?: ExposureObjective;
  evaluatedContext?: import("./exposure").ResolvedExposureContext;
  exposure?: ExposureMetrics;
  /** Retained edge measurements used for condition-only refresh and multi-stop continuity. */
  exposureSegments?: RouteResult["exposureSegments"];
  sampledEdges?: RouteResult["sampledEdges"];
  /** True while a path is retained during a conditions refresh. */
  exposureUpdating?: boolean;
}

export interface DijkstraOptions {
  crossingPenaltyM?: number;  // default 0; extra cost per intersection traversal, in
                              // walk-metres — scaled internally by the mode's speed
                              // ratio so a crossing costs the same *time* in every
                              // mode (E2; walk's ratio is 1, so walk is unchanged)
  solarIntensity?: number;    // 0–1; scales MAX_SHADOW_SAVING; default 1.0
  straightLineDistM?: number; // for detourRatio; defaults to 0 → ratio = 1.0
  maxDetourFactor?: number;   // paretoRoutes only: search budget = shortest distance
                              // × this factor + the mode-scaled flat below; default 2.0
  /**
   * paretoRoutes only: cap on the Pareto-set kept per node, default 20. The A3
   * budget-sweep harness (`navigationScale.bench.ts`) and the A3 operating-point
   * retune are the only callers that pass it — production callers never do, so
   * shipped behavior stays exactly MAX_LABELS_PER_NODE = 20.
   */
  maxLabelsPerNode?: number;
  travelMode?: TravelModeId;  // default "walk"; applies the mode cost policy (E1)
  /** "sun" (default) prices `shadowFactor`; "rain" prices `shelterFactor`. */
  objective?: ExposureObjective;
  /** Deprecated compatibility input. Rain no longer has an intensity scale. */
  precipIntensity?: number;
}

/** Haversine distance in meters. a/b are [lng, lat]. */
export function haversineMeters(
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal =
    sinDLat * sinDLat +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinDLon * sinDLon;
  return R * 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

/** Initial geographic bearing in [0, 360) degrees, clockwise from north.
 * Shared by routing turn counts and walking guidance. Coordinates are [lng, lat].
 * Longitude degrees shrink with latitude, so raw atan2(dLng, dLat) distorts turns.
 */
export function bearingDegrees(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}


/** Simple spatial grid for fast nearest-node lookups. */
export class SpatialGrid {
  private cells = new Map<string, number[]>();
  private cellSize: number;
  private nodes: Map<number, OsmNode>;

  constructor(nodes: Map<number, OsmNode>, cellSizeDeg = 0.001) {
    this.cellSize = cellSizeDeg;
    this.nodes = nodes;
    for (const [id, node] of nodes) {
      const key = `${Math.floor(node.lat / cellSizeDeg)},${Math.floor(node.lon / cellSizeDeg)}`;
      let cell = this.cells.get(key);
      if (!cell) { cell = []; this.cells.set(key, cell); }
      cell.push(id);
    }
  }

  nearest(coord: [number, number]): number {
    const lng = coord[0], lat = coord[1];
    const cs = this.cellSize;
    const cx = Math.floor(lat / cs);
    const cy = Math.floor(lng / cs);

    let bestId = -1;
    let bestDist = Infinity;

    // Check center cell + 8 neighbors
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (const id of cell) {
          const node = this.nodes.get(id)!;
          const d = haversineMeters(coord, [node.lon, node.lat]);
          if (d < bestDist) { bestDist = d; bestId = id; }
        }
      }
    }

    // Fallback: full scan if grid neighborhood was empty
    if (bestId === -1) {
      for (const [id, node] of this.nodes) {
        const d = haversineMeters(coord, [node.lon, node.lat]);
        if (d < bestDist) { bestDist = d; bestId = id; }
      }
    }

    return bestId;
  }
}

/** Returns the node ID in the graph closest to coord [lng, lat]. */
export function snapToGraph(
  coord: [number, number],
  graph: RoutingGraph,
  grid?: SpatialGrid
): number {
  if (grid) return grid.nearest(coord);

  let bestId = -1;
  let bestDist = Infinity;
  for (const [id, node] of graph.nodes) {
    const d = haversineMeters(coord, [node.lon, node.lat]);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Every node walkable from `startId`, by breadth-first search over the
 * adjacency list.
 *
 * A pedestrian graph built from OSM is not one connected piece: station
 * interiors, service stubs and mapping gaps leave small islands. Snapping to the
 * nearest node without regard for that lands on an island often enough to
 * matter — see `snapToReachable`.
 */
export function reachableFrom(graph: RoutingGraph, startId: number): Set<number> {
  const seen = new Set<number>([startId]);
  const queue: number[] = [startId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of graph.adj.get(id) ?? []) {
      if (seen.has(edge.toId)) continue;
      seen.add(edge.toId);
      queue.push(edge.toId);
    }
  }
  return seen;
}

/**
 * Snaps to the nearest node the walker can actually get to.
 *
 * `snapToGraph` answers "what is closest", which is the wrong question when the
 * closest node sits on a disconnected island: the route then fails and the whole
 * option is discarded. Returns -1 when `reachable` is empty.
 *
 * The common case costs nothing — the grid's answer is usually reachable, and
 * only a miss pays for the scan.
 */
export function snapToReachable(
  coord: [number, number],
  graph: RoutingGraph,
  reachable: Set<number>,
  grid?: SpatialGrid
): number {
  const nearest = snapToGraph(coord, graph, grid);
  if (nearest !== -1 && reachable.has(nearest)) return nearest;

  let bestId = -1;
  let bestDist = Infinity;
  for (const id of reachable) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const d = haversineMeters(coord, [node.lon, node.lat]);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Snaps coord to the nearest point on any graph edge by projecting coord onto
 * each segment (flat-earth approximation — accurate enough for sub-kilometre
 * pedestrian routing). Inserts a virtual node at the projection point using
 * virtualId (must be negative to avoid OSM id collisions) and wires it
 * bidirectionally into the adjacency list.
 *
 * Falls back to snapToGraph if the graph has no edges.
 * Returns the nearest endpoint id directly if the projection lands on one,
 * avoiding a zero-length virtual edge.
 *
 * `travelMode` filters the candidates: in bike mode prohibited edges
 * (bicycle=no, access=no without a bicycle override) are invisible to the
 * scan, so a stop never snaps onto an edge the search cannot leave. Walk
 * prohibits nothing, so walk snapping is unchanged.
 */
export function snapToEdge(
  coord: [number, number],
  graph: RoutingGraph,
  virtualId: number,
  travelMode: TravelModeId = "walk"
): number {
  let bestDist: number = Infinity;
  let bestT = 0;
  let bestFromId: number | null = null;
  let bestToId = 0;
  let bestLon = coord[0];
  let bestLat = coord[1];

  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue; // skip previously inserted virtual nodes
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;

    for (const edge of edges) {
      if (edge.toId < 0) continue; // skip virtual edges
      if (isProhibitedEdge(edge, travelMode)) continue; // unroutable in this mode
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;

      const ax = fromNode.lon, ay = fromNode.lat;
      const bx = toNode.lon,   by = toNode.lat;
      const abx = bx - ax, aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      const t =
        ab2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((coord[0] - ax) * abx + (coord[1] - ay) * aby) / ab2
              )
            );

      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      const dist = haversineMeters(coord, [projLon, projLat]);

      if (dist < bestDist) {
        bestDist   = dist;
        bestT      = t;
        bestFromId = fromId;
        bestToId   = edge.toId;
        bestLon    = projLon;
        bestLat    = projLat;
      }
    }
  }

  if (bestFromId === null) return snapToGraph(coord, graph); // empty graph

  // Projection landed exactly on an endpoint — return it directly
  if (bestT === 0) return bestFromId;
  if (bestT === 1) return bestToId;

  // Insert virtual node at the projection point
  graph.nodes.set(virtualId, { id: virtualId, lat: bestLat, lon: bestLon });

  const fromNode = graph.nodes.get(bestFromId)!;
  const toNode   = graph.nodes.get(bestToId)!;
  const totalDist = haversineMeters(
    [fromNode.lon, fromNode.lat],
    [toNode.lon,   toNode.lat]
  );
  const distToFrom = totalDist * bestT;
  const distToTo   = totalDist * (1 - bestT);

  // Inherit edge metadata from the split edge.
  const sourceEdge = (graph.adj.get(bestFromId) ?? []).find((e) => e.toId === bestToId);
  const edgeBase = sourceEdge ? { ...sourceEdge } : { shadowFactor: 0 };

  // Wire virtual node bidirectionally
  graph.adj.set(virtualId, [
    { ...edgeBase, toId: bestFromId, distanceM: distToFrom },
    { ...edgeBase, toId: bestToId,   distanceM: distToTo },
  ]);
  graph.adj.get(bestFromId)!.push({ ...edgeBase, toId: virtualId, distanceM: distToFrom });
  const toAdj = graph.adj.get(bestToId);
  if (toAdj) toAdj.push({ ...edgeBase, toId: virtualId, distanceM: distToTo });

  return virtualId;
}

/**
 * The two parallel per-sidewalk edges for one street segment, labelled by the
 * traveller's own left and right.
 *
 * `sampleBothSidewalks` reports `left`/`right` relative to the **canonical**
 * direction of a segment (lower node id → higher), because that is the only
 * direction-independent way to name the two kerbs. A directed edge needs the
 * traveller's frame instead: walking canonically, left-of-canonical is on your
 * left; walking against it you face the other way, so right-of-canonical is. This
 * resolves that once, so callers never have to reason about it again — and so the
 * flip is testable, which it is not when spelled inline at the call site.
 *
 * Both outputs are the source edge with only `shadowFactor` and `side` replaced, so
 * every OSM access tag it carries (`highway`, `surface`, `smoothness`, `foot`,
 * `bicycle`, …) survives the split. Rebuilding the edge from scratch instead
 * dropped them silently: the edge still looked well-formed, so any access
 * predicate read it as "no restriction".
 */
export function parallelSidewalkEdges(
  fromId: number,
  sourceEdge: GraphEdge,
  canonicalLeftShadow: number,
  canonicalRightShadow: number,
  objective: ExposureObjective = "sun"
): [GraphEdge, GraphEdge] {
  const isCanonical = fromId < sourceEdge.toId;
  const travellerLeft = isCanonical ? canonicalLeftShadow : canonicalRightShadow;
  const travellerRight = isCanonical ? canonicalRightShadow : canonicalLeftShadow;
  if (objective === "rain") {
    return [
      { ...sourceEdge, shelterFactor: travellerLeft, side: "left" },
      { ...sourceEdge, shelterFactor: travellerRight, side: "right" },
    ];
  }
  return [
    { ...sourceEdge, shadowFactor: travellerLeft, side: "left" },
    { ...sourceEdge, shadowFactor: travellerRight, side: "right" },
  ];
}

/** Cap shadow saving at 70% so fully-shadowed edges still cost 30% of their distance.
 *  Prevents Dijkstra from creating unbounded detours through zero-cost shadowed paths. */
const MAX_SHADOW_SAVING = 0.7;

/** The rain twin of `MAX_SHADOW_SAVING`: a fully dry edge still costs 30% of its
 *  distance, so Dijkstra cannot treat a sheltered arcade as a zero-cost wormhole. */
const MAX_RAIN_SAVING = 0.7;

/** Above this the edge counts as wet for streak metrics (mirror of `SHADOW_THRESH`). */
const WET_EXPOSURE_THRESH = 0.5;

/**
 * Dijkstra's shortest path.
 * Edge cost = modeAdjustedDistanceM(edge, travelMode)
 *               * (1 - shadowStrength * shadowFactor * MAX_SHADOW_SAVING * solarIntensity)
 *           + effectiveCrossingPenaltyM (when toNode is an intersection, except destination)
 * shadowStrength=1 → maximally prefers shadowed paths; 0 → shortest distance.
 *
 * Reported `distanceM` stays physical meters — only the search cost sees the
 * mode adjustment.
 */
export function dijkstra(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  shadowStrength: number,
  options: DijkstraOptions = {}
): RouteResult | null {
  const {
    crossingPenaltyM = 0,
    solarIntensity = 1.0,
    straightLineDistM = 0,
    travelMode = "walk",
    objective = "sun",
    precipIntensity: _precipIntensity = 1.0,
  } = options;
  // Rain uses the same fixed detour bound as sun.  The old intensity argument is
  // accepted for saved callers but deliberately has no effect on route choice.
  const rain = objective === "rain";
  const effectiveMaxShadowSaving = rain
    ? MAX_RAIN_SAVING
    : MAX_SHADOW_SAVING * solarIntensity;
  const exposureFactor = (edge: GraphEdge): number =>
    rain ? (edge.shelterFactor ?? 0) : edge.shadowFactor;
  const effectiveCrossingM = crossingPenaltyM * speedRatioVsWalk(travelMode);

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const prevEdge = new Map<number, GraphEdge>(); // tracks exact edge used to reach each node
  const heap = new MinHeap<{ id: number; cost: number }>(
    (a, b) => a.cost - b.cost
  );

  dist.set(startId, 0);
  heap.push({ id: startId, cost: 0 });

  while (heap.size > 0) {
    const { id, cost } = heap.pop()!;
    if (cost > (dist.get(id) ?? Infinity)) continue;
    if (id === endId) break;

    const edges = graph.adj.get(id) ?? [];
    for (const edge of edges) {
      // Explicitly prohibited edges (e.g. bicycle=no in bike mode) are not
      // routable at any cost. Walk never prohibits, so walk search is unchanged.
      if (isProhibitedEdge(edge, travelMode)) continue;
      const toNode = graph.nodes.get(edge.toId);
      const crossing =
        effectiveCrossingM > 0 && toNode?.isIntersection && edge.toId !== endId
          ? effectiveCrossingM
          : 0;
      const edgeCost =
        modeAdjustedDistanceM(edge, travelMode) * (1 - shadowStrength * exposureFactor(edge) * effectiveMaxShadowSaving)
        + crossing;
      const newCost = cost + edgeCost;
      if (newCost < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, newCost);
        prev.set(edge.toId, id);
        prevEdge.set(edge.toId, edge);
        heap.push({ id: edge.toId, cost: newCost });
      }
    }
  }

  if (!dist.has(endId)) return null;

  // Reconstruct path: push in reverse order then reverse once — O(n) not O(n²).
  // unshift() would be O(n) per call (array shift), making the loop O(n²).
  const nodeIds: number[] = [];
  let cur: number | undefined = endId;
  while (cur !== undefined) {
    nodeIds.push(cur);
    cur = prev.get(cur);
  }
  nodeIds.reverse();

  // Compute aggregate stats along the path
  const sides: Array<SidewalkSide | null> = [];
  const SHADOW_THRESH = 0.5;
  let totalDist = 0, shadowedDist = 0, dryDist = 0;
  let longestContinuousShadowM = 0, currentStreakM = 0, shadowTransitions = 0;
  let longestContinuousSunM = 0, currentSunStreakM = 0;
  let prevShadowed: boolean | null = null;
  let longestContinuousWetM = 0, currentWetStreakM = 0, wetTransitions = 0;
  let prevWet: boolean | null = null;
  let turnCount = 0, prevBearing: number | null = null;
  const surfaceMetresM: Record<string, number> = {};
  const exposureSegments: Array<{
    distanceM: number;
    protection?: number;
    confidence?: number;
    provenance?: string;
    speedMps?: number;
  }> = [];
  const sampledEdges: NonNullable<RouteResult["sampledEdges"]> = [];

  for (let i = 0; i < nodeIds.length - 1; i++) {
    // Use prevEdge (the exact edge Dijkstra chose) so parallel sidewalk edges
    // are resolved correctly — find() would return whichever comes first.
    const edge = prevEdge.get(nodeIds[i + 1]);
    if (!edge || edge.toId !== nodeIds[i + 1]) { sides.push(null); continue; }
    sides.push(edge.side ?? null);
    totalDist += edge.distanceM;
    const fromNode = graph.nodes.get(nodeIds[i]);
    const toNodeForSample = graph.nodes.get(nodeIds[i + 1]);
    if (fromNode && toNodeForSample) {
      sampledEdges.push({
        from: [fromNode.lon, fromNode.lat],
        to: [toNodeForSample.lon, toNodeForSample.lat],
        side: edge.side ?? null,
      });
    }
    shadowedDist += edge.distanceM * edge.shadowFactor;
    const shelterConfidence = edge.shelterFactor == null
      ? undefined
      : edge.shelterConfidence ?? edge.exposureConfidence ?? 1;
    if (shelterConfidence == null || shelterConfidence < 0.5) {
      // Unknown geometry carries no shelter credit. Legacy `dryCoverage` keeps
      // its old shape for known edges, while `exposure` carries the uncertainty.
    } else {
      dryDist += edge.distanceM * (edge.shelterFactor ?? 0);
    }
    surfaceMetresM[edge.surface ?? "unknown"] =
      (surfaceMetresM[edge.surface ?? "unknown"] ?? 0) + edge.distanceM;
    const protection = rain ? edge.shelterFactor : edge.shadowFactor;
    const exposureConfidence = rain ? shelterConfidence : edge.exposureConfidence ?? 1;
    exposureSegments.push({
      distanceM: edge.distanceM,
      protection,
      confidence: exposureConfidence,
      provenance: protection == null ? "unknown" : "geometry",
    });

    // Shadow continuity tracking
    const isShadowed = edge.shadowFactor > SHADOW_THRESH;
    if (isShadowed) {
      currentStreakM += edge.distanceM;
      longestContinuousShadowM = Math.max(longestContinuousShadowM, currentStreakM);
      currentSunStreakM = 0;
    } else {
      currentStreakM = 0;
      currentSunStreakM += edge.distanceM;
      longestContinuousSunM = Math.max(longestContinuousSunM, currentSunStreakM);
    }
    if (prevShadowed !== null && isShadowed !== prevShadowed) shadowTransitions++;
    prevShadowed = isShadowed;

    // Rain continuity tracking (absence of a shelter figure reads wet, never dry)
    const knownRain = rain && edge.shelterFactor != null && (shelterConfidence ?? 0) >= 0.5;
    const isWet = (edge.shelterFactor ?? 0) <= WET_EXPOSURE_THRESH;
    if (rain && !knownRain) {
      currentWetStreakM = 0;
      prevWet = null;
    }
    if (knownRain && isWet) {
      currentWetStreakM += edge.distanceM;
      longestContinuousWetM = Math.max(longestContinuousWetM, currentWetStreakM);
    } else {
      currentWetStreakM = 0;
    }
    if (knownRain) {
      if (prevWet !== null && isWet !== prevWet) wetTransitions++;
      prevWet = isWet;
    }

    // Turn counting
    const fn = graph.nodes.get(nodeIds[i])!;
    const tn = graph.nodes.get(nodeIds[i + 1])!;
    const bearing = bearingDegrees([fn.lon, fn.lat], [tn.lon, tn.lat]);
    if (prevBearing !== null) {
      let delta = Math.abs(bearing - prevBearing);
      if (delta > 180) delta = 360 - delta;
      if (delta > 30) turnCount++;
    }
    prevBearing = bearing;
  }

  const detourRatio = straightLineDistM > 0 ? totalDist / straightLineDistM : 1.0;

  return {
    nodeIds,
    sides,
    distanceM: totalDist,
    shadowCoverage: totalDist > 0 ? shadowedDist / totalDist : 0,
    longestContinuousShadowM,
    longestContinuousSunM,
    shadowTransitions,
    detourRatio,
    turnCount,
    surfaceMetresM,
    ...(rain
      ? {
          dryCoverage: totalDist > 0 ? dryDist / totalDist : 0,
          longestContinuousWetM,
          wetTransitions,
        }
      : {}),
    objective,
    exposure: computeExposureMetrics(objective, exposureSegments),
    exposureSegments,
    sampledEdges,
  };
}

// ─── Bi-criteria Pareto routing ──────────────────────────────────────────────

/** Flat allowance added to the Pareto detour budget so very short routes can
 *  still take a meaningfully more shadow parallel street. */
const DETOUR_FLAT_M = 250;

/**
 * Bi-criteria Pareto routing (NAMOA*-inspired label-setting).
 *
 * Finds the Pareto front of (distance, shadowed distance) between start and end.
 * Returns up to 3 RouteResult objects:
 *   - Shortest (min distM)
 *   - Most shadowed (max shadowM)
 *   - Balanced (knee of Pareto front — closest to ideal point in normalized space)
 *
 * The search is bounded — in raw (distance, shadowed-meters) space any walk that
 * adds shadowed meters is Pareto-optimal, including pacing back and forth on one
 * shadowed edge, so an unbounded search both explodes and returns degenerate
 * "routes". Three guards keep it sane:
 *   1. Detour budget: labels whose optimistic total length exceeds
 *      shortestDist × maxDetourFactor + mode-scaled DETOUR_FLAT_M are pruned (a plain
 *      distance Dijkstra runs first; also gives a fast unreachable exit).
 *   2. No U-turns: an edge straight back to the node we just came from can
 *      never extend a simple path — it only ever pumps shadow.
 *   3. Returned routes are simple paths: representatives are selected only
 *      from destination labels whose path never revisits a node (loops around
 *      a shadowed block survive guards 1–2).
 *
 * Labels use integer back-pointer IDs (not embedded path arrays) so memory is
 * O(nodes × MAX_LABELS_PER_NODE) rather than O(nodes × labels × pathLength).
 *
 * `distM` on a label is *mode-cost* meters (see `modeAdjustedDistanceM`), not
 * physical meters: a bike label that paid a stairs penalty carries it. The
 * budget baseline is the same mode's cost-shortest path, and the
 * remaining-distance heuristic is scaled by `minCostRatio(mode)` so it stays a
 * lower bound on remaining mode cost. Walk's ratio is 1, so walk behavior is
 * byte-for-byte the old behavior.
 */

/**
 * Mode-cost length of a node path: the sum `dijkstra` would have charged for it
 * at `shadowStrength = 0`. Used to baseline the Pareto detour budget in the same
 * cost space the labels accumulate. `sides` disambiguates parallel sidewalk
 * edges; a null side takes the first matching edge.
 */
function pathModeCostM(
  graph: RoutingGraph,
  nodeIds: number[],
  sides: Array<SidewalkSide | null> | undefined,
  mode: TravelModeId,
  crossingPenaltyM: number,
  endId: number,
): number {
  let cost = 0;
  for (let i = 0; i < nodeIds.length - 1; i++) {
    const from = nodeIds[i];
    const to = nodeIds[i + 1];
    const edges = graph.adj.get(from) ?? [];
    const side = sides?.[i];
    const edge =
      edges.find((e) => e.toId === to && (side == null || e.side === side)) ??
      edges.find((e) => e.toId === to);
    if (!edge) continue;
    cost += modeAdjustedDistanceM(edge, mode);
    const toNode = graph.nodes.get(to);
    if (crossingPenaltyM > 0 && toNode?.isIntersection && to !== endId) {
      cost += crossingPenaltyM;
    }
  }
  return cost;
}

export function paretoRoutes(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  options: DijkstraOptions = {}
): RouteResult[] {
  const { crossingPenaltyM = 0, straightLineDistM = 0, maxDetourFactor = 2.0, maxLabelsPerNode = 20, travelMode = "walk", objective = "sun" } = options;
  const rain = objective === "rain";
  /** The bi-criterion the labels accumulate: shadowed metres, or sheltered metres. */
  const exposureFactor = (edge: GraphEdge): number =>
    rain ? (edge.shelterFactor ?? 0) : edge.shadowFactor;

  // Distance-only Dijkstra: budget baseline + fast exit when unreachable.
  // Runs in the same mode so the baseline prices the same mode penalties, but
  // with NO other options: crossing penalties must not enter the budget. Labels
  // carry crossings while the budget comes from pure mode meters, which only
  // makes the prune marginally tighter, never looser — and for walk the budget
  // equals the old physical shortest distance exactly.
  const shortestRun = dijkstra(graph, startId, endId, 0, { travelMode });
  if (!shortestRun) return [];
  const shortestCostM = pathModeCostM(
    graph, shortestRun.nodeIds, shortestRun.sides, travelMode, 0, endId,
  );
  // The flat allowance is walk-metres (see `speedRatioVsWalk`): scaling it keeps
  // the same *time* allowance per mode. Walk's ratio is 1, so walk's budget is
  // byte-for-byte the old one.
  // The ×2 factor prices the baseline's *physical* length, not its penalties:
  // an unavoidable +1000 m surface penalty shifts the baseline without
  // doubling the allowance (doubling penalties admitted ~4× detours on
  // sett-heavy streets and slowed the search — E4 review). For walk this is
  // exactly the old formula (cost == physical, bit-for-bit); bike moves
  // modestly by (physical − cost) on the baseline path — see TRACK_E.md.
  const budgetM = shortestCostM
    + shortestRun.distanceM * (maxDetourFactor - 1)
    + DETOUR_FLAT_M * speedRatioVsWalk(travelMode);
  const effectiveCrossingM = crossingPenaltyM * speedRatioVsWalk(travelMode);
  // Admissible remaining-cost heuristic: every remaining physical meter costs at
  // least `costRatio` mode meters.
  const costRatio = minCostRatio(travelMode);

  // Each label is stored by index in allLabels; back-pointer is parent index (-1 = start).
  interface PLabel {
    id: number;
    distM: number;
    /** Shadowed metres (sun) or sheltered metres (rain) accumulated so far. */
    exposureM: number;
    nodeId: number;
    parentId: number;      // allLabels index; -1 for the start label
    prevEdge: GraphEdge | null;
    evicted: boolean;
  }

  const allLabels: PLabel[] = [];
  const mkLabel = (
    distM: number, exposureM: number, nodeId: number,
    parentId: number, prevEdge: GraphEdge | null
  ): PLabel => {
    const lbl: PLabel = { id: allLabels.length, distM, exposureM, nodeId, parentId, prevEdge, evicted: false };
    allLabels.push(lbl);
    return lbl;
  };

  // Per-node Pareto set: array of label IDs, sorted distM asc (→ shadowM necessarily
  // asc too — a later label with less shadow would be dominated by an earlier one).
  const paretoSets = new Map<number, number[]>();
  const getSet = (id: number): number[] => {
    if (!paretoSets.has(id)) paretoSets.set(id, []);
    return paretoSets.get(id)!;
  };

  /** Returns true if a dominates b (at least as short AND at least as sheltered). */
  const dom = (a: PLabel, b: PLabel) => a.distM <= b.distM && a.exposureM >= b.exposureM;

  /**
   * Try to insert `incoming` into the Pareto set for its node.
   * Rejects if dominated by any existing label.
   * Evicts any existing labels now dominated by incoming.
   * If still at cap after evictions, rejects incoming if it would be worst (highest distM).
   * Returns true if accepted.
   */
  const insertPareto = (incoming: PLabel): boolean => {
    const set = getSet(incoming.nodeId);
    for (const id of set) {
      if (dom(allLabels[id], incoming)) return false;
    }
    for (let i = set.length - 1; i >= 0; i--) {
      if (dom(incoming, allLabels[set[i]])) {
        allLabels[set[i]].evicted = true;
        set.splice(i, 1);
      }
    }
    // If at capacity, reject if incoming would be the new worst (tail)
    if (set.length >= maxLabelsPerNode) {
      const worstDistM = allLabels[set[set.length - 1]].distM;
      if (incoming.distM >= worstDistM) return false;
      allLabels[set[set.length - 1]].evicted = true;
      set.pop(); // evict current worst to make room
    }
    let pos = set.length;
    for (let i = 0; i < set.length; i++) {
      if (incoming.distM < allLabels[set[i]].distM) { pos = i; break; }
    }
    set.splice(pos, 0, incoming.id);
    return true;
  };

  // Admissible lower bound on remaining walking distance to the destination,
  // cached per node — each node is touched once per surviving label (up to the
  // cap), and haversine is trig-heavy. Used both for A* ordering and for the
  // detour-budget prune. Label distM and the budget both live in mode-cost
  // meters (mode-adjusted edges plus crossing penalties), so the prune compares
  // like with like; see `hCostRemaining` for the heuristic side.
  const destNode = graph.nodes.get(endId);
  const hCache = new Map<number, number>();
  const hRemaining = (nodeId: number): number => {
    let h = hCache.get(nodeId);
    if (h === undefined) {
      const n = graph.nodes.get(nodeId);
      h = destNode && n
        ? haversineMeters([n.lon, n.lat], [destNode.lon, destNode.lat])
        : 0;
      hCache.set(nodeId, h);
    }
    return h;
  };
  // Remaining-distance heuristic in mode-cost meters. Physical meters scaled by
  // the mode's minimum cost ratio is a lower bound on remaining mode cost, so
  // the budget prune and A* ordering stay admissible for bike discounts.
  const hCostRemaining = (nodeId: number): number => hRemaining(nodeId) * costRatio;

  const startLabel = mkLabel(0, 0, startId, -1, null);
  insertPareto(startLabel);

  const heap = new MinHeap<{ labelId: number; f: number }>((a, b) => a.f - b.f);
  heap.push({ labelId: startLabel.id, f: hCostRemaining(startId) });

  while (heap.size > 0) {
    const { labelId } = heap.pop()!;
    const label = allLabels[labelId];

    // Skip if this label was evicted from its node's Pareto set since being pushed
    if (label.evicted) continue;

    // A walk that leaves the destination is only readable again at the
    // destination — i.e. it revisits endId and gets dropped at selection.
    // Expanding destination labels is therefore pure waste.
    if (label.nodeId === endId) continue;

    // Destination-front pruning: the best this label can still become is
    // (distM + straight-line remainder, shadowM + whole remaining budget walked
    // fully shadowed). If an already-found destination label dominates even that
    // optimistic completion, the label can't contribute to the front. The shadow
    // optimism is divided by the mode's minimum cost ratio: discounted cost
    // meters buy more than one physical meter each.
    const destSet = paretoSets.get(endId);
    if (destSet && destSet.length > 0 && label.nodeId !== endId) {
      const optDistM  = label.distM + hCostRemaining(label.nodeId);
      const optExposureM = label.exposureM + (budgetM - label.distM) / costRatio;
      let prunedByDest = false;
      for (const id of destSet) {
        const d = allLabels[id];
        if (d.distM <= optDistM && d.exposureM >= optExposureM) { prunedByDest = true; break; }
      }
      if (prunedByDest) continue;
    }

    const cameFromId = label.parentId >= 0 ? allLabels[label.parentId].nodeId : Number.NaN;

    for (const edge of graph.adj.get(label.nodeId) ?? []) {
      // U-turns never extend a simple path; they only pump shadow meters.
      if (edge.toId === cameFromId) continue;
      // Prohibited edges are not routable at any cost (see dijkstra).
      if (isProhibitedEdge(edge, travelMode)) continue;

      const toNode = graph.nodes.get(edge.toId);
      const crossing =
        effectiveCrossingM > 0 && toNode?.isIntersection && edge.toId !== endId
          ? effectiveCrossingM : 0;

      const newDistM  = label.distM  + modeAdjustedDistanceM(edge, travelMode) + crossing;
      const newExposureM = label.exposureM + edge.distanceM * exposureFactor(edge);

      // Detour budget: prune anything that can no longer finish within budget
      const hTo = hCostRemaining(edge.toId);
      if (newDistM + hTo > budgetM) continue;

      // Pre-check dominance before allocating a label object
      const candidateSet = getSet(edge.toId);
      let dominated = false;
      for (const id of candidateSet) {
        const ex = allLabels[id];
        if (ex.distM <= newDistM && ex.exposureM >= newExposureM) { dominated = true; break; }
      }
      if (dominated) continue;

      const newLabel = mkLabel(newDistM, newExposureM, edge.toId, labelId, edge);
      if (insertPareto(newLabel)) {
        heap.push({ labelId: newLabel.id, f: newDistM + hTo });
      }
    }
  }

  const destFront = getSet(endId).map((id) => allLabels[id]);
  if (destFront.length === 0) return [];

  // Reconstruct path for a label by following parentId back-pointers.
  const reconstruct = (lbl: PLabel): { nodeIds: number[]; edgePath: GraphEdge[] } => {
    const nodeIds: number[] = [];
    const edgePath: GraphEdge[] = [];
    let cur: PLabel | null = lbl;
    while (cur !== null) {
      nodeIds.push(cur.nodeId);
      if (cur.prevEdge) edgePath.push(cur.prevEdge);
      cur = cur.parentId >= 0 ? allLabels[cur.parentId] : null;
    }
    nodeIds.reverse();
    edgePath.reverse();
    return { nodeIds, edgePath };
  };

  const buildResult = (lbl: PLabel): RouteResult & { _key: string } => {
    const { nodeIds, edgePath } = reconstruct(lbl);
    // edgePath[i] is the edge from nodeIds[i] to nodeIds[i + 1], so this stays
    // one shorter than nodeIds — the alignment RouteResult.sides documents.
    const sides: Array<SidewalkSide | null> = edgePath.map((e) => e.side ?? null);
    const SHADOW_THRESH = 0.5;
    let totalDist = 0, shadowedDist = 0, dryDist = 0;
    let longestContinuousShadowM = 0, currentStreakM = 0, shadowTransitions = 0;
    let longestContinuousSunM = 0, currentSunStreakM = 0;
    let prevShadowed: boolean | null = null;
    let longestContinuousWetM = 0, currentWetStreakM = 0, wetTransitions = 0;
    let prevWet: boolean | null = null;
    let turnCount = 0, prevBearing: number | null = null;
    const surfaceMetresM: Record<string, number> = {};
    const exposureSegments: Array<{
      distanceM: number;
      protection?: number;
      confidence?: number;
      provenance?: string;
    }> = [];
    const sampledEdges: NonNullable<RouteResult["sampledEdges"]> = [];

    for (let i = 0; i < edgePath.length; i++) {
      const edge = edgePath[i];
      totalDist  += edge.distanceM;
      const fromNode = graph.nodes.get(nodeIds[i]);
      const toNodeForSample = graph.nodes.get(nodeIds[i + 1]);
      if (fromNode && toNodeForSample) {
        sampledEdges.push({
          from: [fromNode.lon, fromNode.lat],
          to: [toNodeForSample.lon, toNodeForSample.lat],
          side: edge.side ?? null,
        });
      }
      shadowedDist += edge.distanceM * edge.shadowFactor;
      const shelterConfidence = edge.shelterFactor == null
        ? undefined
        : edge.shelterConfidence ?? edge.exposureConfidence ?? 1;
      if (shelterConfidence != null && shelterConfidence >= 0.5) {
        dryDist += edge.distanceM * (edge.shelterFactor ?? 0);
      }
      const protection = rain ? edge.shelterFactor : edge.shadowFactor;
      const exposureConfidence = rain ? shelterConfidence : edge.exposureConfidence ?? 1;
      exposureSegments.push({
        distanceM: edge.distanceM,
        protection,
        confidence: exposureConfidence,
        provenance: protection == null ? "unknown" : "geometry",
      });
      surfaceMetresM[edge.surface ?? "unknown"] =
        (surfaceMetresM[edge.surface ?? "unknown"] ?? 0) + edge.distanceM;
      const isShadowed = edge.shadowFactor > SHADOW_THRESH;
      if (isShadowed) {
        currentStreakM += edge.distanceM;
        longestContinuousShadowM = Math.max(longestContinuousShadowM, currentStreakM);
        currentSunStreakM = 0;
      } else {
        currentStreakM = 0;
        currentSunStreakM += edge.distanceM;
        longestContinuousSunM = Math.max(longestContinuousSunM, currentSunStreakM);
      }
      if (prevShadowed !== null && isShadowed !== prevShadowed) shadowTransitions++;
      prevShadowed = isShadowed;

      const knownRain = rain && edge.shelterFactor != null && (shelterConfidence ?? 0) >= 0.5;
      const isWet = (edge.shelterFactor ?? 0) <= WET_EXPOSURE_THRESH;
      if (rain && !knownRain) {
        currentWetStreakM = 0;
        prevWet = null;
      }
      if (knownRain && isWet) {
        currentWetStreakM += edge.distanceM;
        longestContinuousWetM = Math.max(longestContinuousWetM, currentWetStreakM);
      } else {
        currentWetStreakM = 0;
      }
      if (knownRain) {
        if (prevWet !== null && isWet !== prevWet) wetTransitions++;
        prevWet = isWet;
      }

      const fn = graph.nodes.get(nodeIds[i]);
      const tn = graph.nodes.get(nodeIds[i + 1]);
      if (fn && tn) {
        const bearing = bearingDegrees([fn.lon, fn.lat], [tn.lon, tn.lat]);
        if (prevBearing !== null) {
          let delta = Math.abs(bearing - prevBearing);
          if (delta > 180) delta = 360 - delta;
          if (delta > 30) turnCount++;
        }
        prevBearing = bearing;
      }
    }

    return {
      _key: nodeIds.join(","),
      nodeIds,
      sides,
      distanceM: totalDist,
      shadowCoverage: totalDist > 0 ? shadowedDist / totalDist : 0,
      longestContinuousShadowM,
      longestContinuousSunM,
      shadowTransitions,
      detourRatio: straightLineDistM > 0 ? totalDist / straightLineDistM : 1.0,
      turnCount,
      surfaceMetresM,
      ...(rain
        ? {
            dryCoverage: totalDist > 0 ? dryDist / totalDist : 0,
            longestContinuousWetM,
            wetTransitions,
          }
        : {}),
      objective,
      exposure: computeExposureMetrics(objective, exposureSegments),
      exposureSegments,
      sampledEdges,
    };
  };

  // Keep only labels whose path is a simple path — loops around shadowed blocks
  // survive the U-turn ban but are useless as navigation routes. The shortest
  // path is always simple and within budget, so this never empties the front.
  const candidates = destFront
    .map((lbl) => ({ lbl, res: buildResult(lbl) }))
    .filter(({ res }) => new Set(res.nodeIds).size === res.nodeIds.length);
  if (candidates.length === 0) return [];

  // Select representatives: shortest (min distM), most shadowed (max shadowM), knee.
  // candidates inherit destFront's order: distM asc → shadowM asc.
  const shortest   = candidates[0];
  const mostShadowed = candidates[candidates.length - 1];

  const minDist  = candidates[0].lbl.distM;
  const maxDist  = candidates[candidates.length - 1].lbl.distM;
  const minExposure = candidates[0].lbl.exposureM;
  const maxExposure = candidates[candidates.length - 1].lbl.exposureM;
  const distRange  = maxDist  - minDist  || 1;
  const exposureRange = maxExposure - minExposure || 1;

  let knee = candidates[0];
  let kneeScore = Infinity;
  for (const c of candidates) {
    const nd = (c.lbl.distM  - minDist)  / distRange;
    const ns = (c.lbl.exposureM - minExposure) / exposureRange;
    const score = Math.sqrt(nd * nd + (1 - ns) * (1 - ns));
    if (score < kneeScore) { kneeScore = score; knee = c; }
  }

  // Build results, deduplicating by node-path key
  const seen = new Set<string>();
  const results: RouteResult[] = [];
  const tryAdd = (c: { res: RouteResult & { _key: string } }) => {
    if (seen.has(c.res._key)) return;
    seen.add(c.res._key);
    const { _key: _unused, ...result } = c.res;
    void _unused;
    results.push(result);
  };

  tryAdd(shortest);
  tryAdd(knee);
  tryAdd(mostShadowed);

  return results;
}

/**
 * BFS from startId — returns the set of all node IDs reachable from startId
 * in the graph (including startId itself).
 *
 * `travelMode` filters traversal the same way the search does, so reachability
 * agrees with routability: a component connected only through bicycle=no edges
 * is one component on foot and two by bike.
 */
export function bfsReachable(
  graph: RoutingGraph,
  startId: number,
  travelMode: TravelModeId = "walk"
): Set<number> {
  const visited = new Set<number>();
  const queue: number[] = [startId];
  visited.add(startId);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const edge of graph.adj.get(id) ?? []) {
      if (isProhibitedEdge(edge, travelMode)) continue;
      if (!visited.has(edge.toId)) {
        visited.add(edge.toId);
        queue.push(edge.toId);
      }
    }
  }
  return visited;
}

/**
 * Like snapToEdge, but only considers edges where BOTH endpoints are in
 * reachableIds. Returns { id, distM } where id is the snapped node ID
 * (virtual or endpoint) and distM is the distance from coord to the snap
 * point. Returns null if no reachable edge exists in the graph.
 *
 * `travelMode` filters candidates like snapToEdge, so the fallback snap lands
 * on an edge the search can actually use.
 */
export function snapToReachableEdge(
  coord: [number, number],
  graph: RoutingGraph,
  reachableIds: Set<number>,
  virtualId: number,
  travelMode: TravelModeId = "walk"
): { id: number; distM: number } | null {
  let bestDist: number = Infinity;
  let bestT = 0;
  let bestFromId: number | null = null;
  let bestToId = 0;
  let bestLon = coord[0];
  let bestLat = coord[1];

  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue;
    if (!reachableIds.has(fromId)) continue;
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;

    for (const edge of edges) {
      if (edge.toId < 0) continue;
      if (!reachableIds.has(edge.toId)) continue;
      if (isProhibitedEdge(edge, travelMode)) continue;
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;

      const ax = fromNode.lon, ay = fromNode.lat;
      const bx = toNode.lon,   by = toNode.lat;
      const abx = bx - ax, aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      const t =
        ab2 === 0
          ? 0
          : Math.max(0, Math.min(1,
              ((coord[0] - ax) * abx + (coord[1] - ay) * aby) / ab2
            ));
      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      const dist = haversineMeters(coord, [projLon, projLat]);

      if (dist < bestDist) {
        bestDist   = dist;
        bestT      = t;
        bestFromId = fromId;
        bestToId   = edge.toId;
        bestLon    = projLon;
        bestLat    = projLat;
      }
    }
  }

  if (bestFromId === null) return null;

  // Projection landed exactly on an endpoint
  if (bestT === 0) {
    const n = graph.nodes.get(bestFromId)!;
    return { id: bestFromId, distM: haversineMeters(coord, [n.lon, n.lat]) };
  }
  if (bestT === 1) {
    const n = graph.nodes.get(bestToId)!;
    return { id: bestToId, distM: haversineMeters(coord, [n.lon, n.lat]) };
  }

  // Insert virtual node at projection point
  graph.nodes.set(virtualId, { id: virtualId, lat: bestLat, lon: bestLon });

  const fromNode = graph.nodes.get(bestFromId)!;
  const toNode   = graph.nodes.get(bestToId)!;
  const totalDist = haversineMeters(
    [fromNode.lon, fromNode.lat],
    [toNode.lon,   toNode.lat]
  );
  const distToFrom = totalDist * bestT;
  const distToTo   = totalDist * (1 - bestT);

  const sourceEdge = (graph.adj.get(bestFromId) ?? []).find((e) => e.toId === bestToId);
  const edgeBase = sourceEdge ? { ...sourceEdge } : { shadowFactor: 0 };

  graph.adj.set(virtualId, [
    { ...edgeBase, toId: bestFromId, distanceM: distToFrom },
    { ...edgeBase, toId: bestToId,   distanceM: distToTo },
  ]);
  graph.adj.get(bestFromId)!.push({ ...edgeBase, toId: virtualId, distanceM: distToFrom });
  const toAdj = graph.adj.get(bestToId);
  if (toAdj) toAdj.push({ ...edgeBase, toId: virtualId, distanceM: distToTo });

  return { id: virtualId, distM: bestDist };
}

/** Removes one virtual node and any edges pointing at it. */
export function removeVirtualNode(graph: RoutingGraph, virtualId: number): void {
  const vidEdges = graph.adj.get(virtualId);
  if (vidEdges) {
    for (const edge of vidEdges) {
      const ownerEdges = graph.adj.get(edge.toId);
      if (!ownerEdges) continue;
      for (let i = ownerEdges.length - 1; i >= 0; i--) {
        if (ownerEdges[i].toId === virtualId) ownerEdges.splice(i, 1);
      }
    }
  }
  graph.nodes.delete(virtualId);
  graph.adj.delete(virtualId);
}

/** Clears all synthetic route-snap nodes from a mutable graph. */
export function clearVirtualNodes(graph: RoutingGraph): void {
  const virtualIds = new Set<number>();
  for (const id of graph.nodes.keys()) {
    if (id < 0) virtualIds.add(id);
  }
  for (const id of graph.adj.keys()) {
    if (id < 0) virtualIds.add(id);
  }
  for (const id of virtualIds) removeVirtualNode(graph, id);
  for (const edges of graph.adj.values()) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].toId < 0) edges.splice(i, 1);
    }
  }
}

export interface SnapRouteStopsOptions {
  maxSnapDistanceM?: number;
  virtualIdStart?: number;
  describeStop?: (index: number, total: number) => string;
  /** Mode the snapped stops will be routed in. Defaults to walk (no filtering). */
  travelMode?: TravelModeId;
}

export interface SnapRouteStopsResult {
  ids: number[];
  snapDistancesM: number[];
}

function defaultStopLabel(index: number, total: number): string {
  if (index === 0) return "the start point";
  if (index === total - 1) return "the destination";
  return `stop ${index + 1}`;
}

/**
 * Snaps an ordered route's stops to one connected component routable in the
 * requested travel mode.
 *
 * We anchor on the destination and repair each previous stop backwards. This
 * matches the route UX: a slightly-off start/via point should snap onto the
 * component that can actually reach the requested destination, not strand the
 * route on a closer disconnected service road or path fragment — or, by bike,
 * on a closer edge bikes may not use.
 */
export function snapRouteStopsToReachableEdges(
  coords: [number, number][],
  graph: RoutingGraph,
  options: SnapRouteStopsOptions = {}
): SnapRouteStopsResult {
  if (coords.length < 2) {
    throw new Error("Need at least two route stops.");
  }

  const {
    maxSnapDistanceM = 100,
    virtualIdStart = -1,
    describeStop = defaultStopLabel,
    travelMode = "walk",
  } = options;
  if (virtualIdStart >= 0) {
    throw new Error("virtualIdStart must be negative.");
  }

  const virtualIdFor = (index: number) => virtualIdStart - index;
  const ids = coords.map((coord, index) => snapToEdge(coord, graph, virtualIdFor(index), travelMode));
  const snapDistancesM = ids.map((id, index) => {
    const n = graph.nodes.get(id);
    return n ? haversineMeters(coords[index], [n.lon, n.lat]) : Infinity;
  });

  for (let i = coords.length - 2; i >= 0; i--) {
    const reachableToDestination = bfsReachable(graph, ids[i + 1], travelMode);
    if (reachableToDestination.has(ids[i])) continue;

    if (ids[i] < 0) removeVirtualNode(graph, ids[i]);
    const fallback = snapToReachableEdge(
      coords[i],
      graph,
      reachableToDestination,
      virtualIdFor(i),
      travelMode
    );
    const label = describeStop(i, coords.length);
    if (!fallback) {
      throw new Error(
        `No connected walkable streets found near ${label}. Move it closer to a public street or footpath.`
      );
    }
    if (fallback.distM > maxSnapDistanceM) {
      throw new Error(
        `${label} is ${Math.round(fallback.distM)} m from the nearest connected walkable street. Move it closer to a public street or footpath.`
      );
    }
    ids[i] = fallback.id;
    snapDistancesM[i] = fallback.distM;
  }

  return { ids, snapDistancesM };
}

/**
 * Connects a road-network route's geometry back to the actual requested
 * endpoints. Routing snaps the start/end onto the nearest walkable road, so the
 * raw route LineString begins and ends *on the road* — not at the coordinate the
 * user actually picked. Without this, every route visibly stops short of its
 * pins ("approximates a path close enough"). Prepends `start` and appends `end`
 * (skipping when already coincident) so the rendered route reaches the points.
 */
export function connectRouteEndpoints(
  feature: GeoJSON.Feature<GeoJSON.LineString>,
  start: [number, number],
  end: [number, number]
): GeoJSON.Feature<GeoJSON.LineString> {
  const coords = (feature.geometry.coordinates as [number, number][]).slice();
  const same = (p: [number, number], q: [number, number]) =>
    p[0] === q[0] && p[1] === q[1];
  if (coords.length === 0) {
    return { ...feature, geometry: { ...feature.geometry, coordinates: [start, end] } };
  }
  if (!same(coords[0], start)) coords.unshift(start);
  if (!same(coords[coords.length - 1], end)) coords.push(end);
  return { ...feature, geometry: { ...feature.geometry, coordinates: coords } };
}

/** Converts a node ID path → GeoJSON LineString feature. */
export function graphToGeoJSON(
  path: number[],
  graph: RoutingGraph
): GeoJSON.Feature<GeoJSON.LineString> {
  const coords: [number, number][] = path
    .map((id) => graph.nodes.get(id))
    .filter((n): n is OsmNode => n !== undefined)
    .map((n) => [n.lon, n.lat]);

  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: coords,
    },
  };
}

// ─── Sketch-guided routing utilities ────────────────────────────────────────

/** [lng, lat] coordinate pair — same convention as GeoJSON and MapLibre. */
export type LatLng = [number, number];

/** Draw-mode sketch point with optional resolved address for hover tooltip. */
export interface SketchPoint {
  coord: LatLng;
  address: string | null;
}

/**
 * Perpendicular distance from a point to a great-circle segment, in metres.
 * Projects `point` onto the segment `segA→segB`, clamps to endpoints, and
 * returns the haversine distance from `point` to the closest point on the
 * segment.
 */
function pointToSegmentDistM(
  point: LatLng,
  segA: LatLng,
  segB: LatLng
): number {
  const dxAB = segB[0] - segA[0];
  const dyAB = segB[1] - segA[1];
  const len2 = dxAB * dxAB + dyAB * dyAB;
  if (len2 === 0) return haversineMeters(point, segA);
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - segA[0]) * dxAB + (point[1] - segA[1]) * dyAB) / len2)
  );
  const proj: LatLng = [segA[0] + t * dxAB, segA[1] + t * dyAB];
  return haversineMeters(point, proj);
}

/**
 * Ramer-Douglas-Peucker polyline simplification.
 * @param points  Raw lat/lng array from freehand drawing
 * @param epsilonM  Tolerance in metres — points within this distance
 *                  of the simplified line are removed.
 *                  Recommended default: 30
 * @returns Simplified array (always includes first and last point)
 */
export function simplifyPolyline(
  points: LatLng[],
  epsilonM: number = 30
): LatLng[] {
  if (points.length <= 2) return points.slice();

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDistM(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilonM) {
    const left = simplifyPolyline(points.slice(0, maxIdx + 1), epsilonM);
    const right = simplifyPolyline(points.slice(maxIdx), epsilonM);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

/**
 * Compute a bounding box around all points with a padding in degrees.
 */
export function sketchBoundingBox(
  points: LatLng[],
  paddingDeg: number = 0.005
): { south: number; north: number; west: number; east: number } {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return {
    south: minLat - paddingDeg,
    north: maxLat + paddingDeg,
    west: minLng - paddingDeg,
    east: maxLng + paddingDeg,
  };
}

/**
 * Runs Dijkstra on each consecutive pair of simplified waypoints and
 * concatenates the resulting node-ID paths, deduplicating the shared
 * boundary node between legs.
 *
 * @param waypoints   Simplified waypoints from simplifyPolyline()
 * @param graph       RoutingGraph from fetchRoutingGraph()
 * @param shadowStrength  0.0 = shortest, 1.0 = most shadowed (passed to each leg)
 * @returns           Full stitched node-ID path, or null if any leg fails
 */
export function dijkstraMultiLeg(
  waypoints: LatLng[],
  graph: RoutingGraph,
  shadowStrength: number
): number[] | null {
  if (waypoints.length < 2)
    throw new Error("Need at least 2 waypoints");

  const fullPath: number[] = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const fromId = snapToGraph(waypoints[i], graph);
    const toId = snapToGraph(waypoints[i + 1], graph);
    const result = dijkstra(graph, fromId, toId, shadowStrength);
    if (!result) return null;
    if (i === 0) {
      fullPath.push(...result.nodeIds);
    } else {
      // Drop the first node (shared boundary) to avoid duplicate
      fullPath.push(...result.nodeIds.slice(1));
    }
  }

  return fullPath;
}

/**
 * For each simplified sketch waypoint, find the nearest graph node.
 * Returns indices of waypoints where nearest node is > thresholdM away.
 */
export function findSketchGaps(
  simplified: LatLng[],
  graph: RoutingGraph,
  thresholdM: number = 200
): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const nearestId = snapToGraph(simplified[i], graph);
    const node = graph.nodes.get(nearestId);
    if (!node) { gaps.push(i); continue; }
    const dist = haversineMeters(simplified[i], [node.lon, node.lat]);
    if (dist > thresholdM) gaps.push(i);
  }
  return gaps;
}

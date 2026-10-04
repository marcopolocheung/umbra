/**
 * Frozen copy of `paretoRoutes` as it stood before L3a (#263), kept only as
 * the oracle for `paretoParity.test.ts`. L3a's contract is that the search got
 * faster without changing one route, and the cheapest proof is a differential
 * test against the code it replaced. Do not edit this to match a behavior
 * change — a deliberate change (e.g. #246's fix) updates the parity test's
 * expectations instead, or retires this file.
 */

import { MinHeap } from "../minHeap";
import {
  bearingDegrees,
  DEFAULT_MAX_DETOUR_FACTOR,
  DETOUR_FLAT_M,
  dijkstra,
  type DijkstraOptions,
  type GraphEdge,
  type RouteResult,
  type RoutingGraph,
  type SidewalkSide,
  haversineMeters,
} from "../routing";
import {
  edgeTraversalSeconds,
  isProhibitedEdge,
  minCostRatio,
  modeAdjustedDistanceM,
  speedRatioVsWalk,
  type TravelModeId,
} from "../travelMode";
import { computeExposureMetrics } from "../exposureMetrics";

const SHADOW_THRESH = 0.5;
const WET_EXPOSURE_THRESH = 0.5;

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

export function paretoRoutesReference(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  options: DijkstraOptions = {}
): RouteResult[] {
  const { crossingPenaltyM = 0, straightLineDistM = 0, maxDetourFactor = DEFAULT_MAX_DETOUR_FACTOR, maxLabelsPerNode = 20, travelMode = "walk", objective = "sun", maxContinuousExposureSec } = options;
  const rain = objective === "rain";
  // Time-aware pricing is a sun feature (rain shelter is wind/overhead cover,
  // not sun geometry), and only when the caller swept a horizon in.
  const ta = !rain && options.timeAware ? options.timeAware : undefined;
  /** Which bucket an arrival `sec` seconds after departure falls in. */
  const bucketOf = (arrivalSec: number): number =>
    Math.min(Math.floor((arrivalSec * 1000) / (ta?.bucketMs ?? 1)), (ta?.bucketCount ?? 1) - 1);
  /** The exposure factor an edge carries for the walker arriving at `arrivalSec`. */
  const exposureFactorAt = (edge: GraphEdge, arrivalSec: number): number => {
    if (!ta) return rain ? (edge.shelterFactor ?? 0) : edge.shadowFactor;
    const ts = edge.timeShadow;
    if (!ts || ts.length === 0) return edge.shadowFactor;
    return ts[Math.min(bucketOf(arrivalSec), ts.length - 1)];
  };

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
    /**
     * The exposure criterion the front optimizes (H2). Sun accumulates
     * *sun seconds* — traversal time × unshadowed fraction — and FEWER is
     * better: the walker cares about minutes in the sun, not metres of shade,
     * and maximized shade-metres could win with more absolute sun (the
     * Route-A/Route-B defect, pinned in `timeAwareRouting.test.ts`). Rain
     * keeps sheltered metres, where MORE is better.
     */
    exposureCrit: number;
    /** Seconds after departure the walker reaches this node (H1; 0 when static). */
    arrivalSec: number;
    /**
     * Current unbroken run of sunlit walking, seconds (sun only) — the
     * `maxContinuousExposureSec` hard constraint reads and resets this.
     */
    streakSec: number;
    nodeId: number;
    parentId: number;      // allLabels index; -1 for the start label
    prevEdge: GraphEdge | null;
    evicted: boolean;
  }

  const allLabels: PLabel[] = [];
  const mkLabel = (
    distM: number, exposureCrit: number, arrivalSec: number, streakSec: number,
    nodeId: number, parentId: number, prevEdge: GraphEdge | null
  ): PLabel => {
    const lbl: PLabel = { id: allLabels.length, distM, exposureCrit, arrivalSec, streakSec, nodeId, parentId, prevEdge, evicted: false };
    allLabels.push(lbl);
    return lbl;
  };

  // Per-(node, time-bucket) Pareto set: array of label IDs, sorted distM asc
  // (→ exposureCrit necessarily asc too — a later label with better exposure
  // would be dominated by an earlier one). With time-dependent exposure the state is
  // (node, arrivalTime), so labels that reach a node in *different buckets*
  // are incomparable: the later one may be the one whose remaining edges are
  // shaded, and letting the earlier prune it is exactly the H5 trap (an
  // earlier arrival is not automatically better). Dominance applies only
  // inside one bucket; the residual unsoundness — two arrivals inside the
  // same bucket whose *next* edge straddles a boundary — is bounded by the
  // bucket width and is H4's oracle's job to measure. Static runs have one
  // bucket, so this is the old per-node set exactly. Keyed node → bucket so
  // every bucket's set at one node (the destination front) is one lookup, not
  // a scan of the whole search's sets on every heap pop.
  const paretoSets = new Map<number, Map<number, number[]>>();
  const getSet = (id: number, bucket: number): number[] => {
    let byBucket = paretoSets.get(id);
    if (!byBucket) {
      byBucket = new Map();
      paretoSets.set(id, byBucket);
    }
    let set = byBucket.get(bucket);
    if (!set) {
      set = [];
      byBucket.set(bucket, set);
    }
    return set;
  };
  const labelBucket = (lbl: PLabel): number =>
    ta ? bucketOf(lbl.arrivalSec) : 0;

  /** True when a's exposure is at least as good as b's — fewer sun seconds
   * (sun), more sheltered metres (rain). Revalidated for the duration
   * objective (H2): both criteria are additive and non-negative per edge, so
   * within one time bucket the label-setting dominance argument holds with
   * the comparison direction flipped; the bucket-boundary residual is
   * unchanged from H1 and still H4's to measure. */
  const exposureBetter = (a: PLabel, b: PLabel) =>
    rain ? a.exposureCrit >= b.exposureCrit : a.exposureCrit <= b.exposureCrit;

  /** True when a's unbroken sun run is no worse than b's (sun only): a label
   * that has already walked a long sunlit stretch is the one the
   * `maxContinuousExposureSec` cap will cut, so it must not prune a
   * shade-broken-streak rival that is marginally longer. Without this, the
   * cap can eliminate every path to the destination. */
  const streakBetter = (a: PLabel, b: PLabel) =>
    rain || a.streakSec <= b.streakSec;

  /** Returns true if a dominates b: at least as short, at least as good on
   * exposure and sun-streak, and — only where exposure is time-dependent —
   * at least as early. Only ever compared within one bucket (see the
   * Pareto-set comment above). */
  const dom = (a: PLabel, b: PLabel) =>
    a.distM <= b.distM && exposureBetter(a, b) && streakBetter(a, b)
    && (!ta || a.arrivalSec <= b.arrivalSec);

  /**
   * Try to insert `incoming` into the Pareto set for its node and bucket.
   * Rejects if dominated by any existing label.
   * Evicts any existing labels now dominated by incoming.
   * If still at cap after evictions, rejects incoming if it would be worst (highest distM).
   * Returns true if accepted.
   */
  const insertPareto = (incoming: PLabel): boolean => {
    const set = getSet(incoming.nodeId, labelBucket(incoming));
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

  const startLabel = mkLabel(0, 0, 0, 0, startId, -1, null);
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
    // meters buy more than one physical meter each. The front spans every
    // bucket's set at endId — no bucket comparison happens here, because the
    // optimistic bound already assumes every remaining edge is fully shadowed,
    // which no bucket can beat.
    const destBuckets = paretoSets.get(endId);
    if (destBuckets && label.nodeId !== endId) {
      const optDistM  = label.distM + hCostRemaining(label.nodeId);
      // Optimistic completion: rain can still walk the whole remaining budget
      // fully sheltered; sun's best case is every remaining edge fully
      // shadowed, i.e. no further sun seconds at all.
      const optExposureCrit = rain
        ? label.exposureCrit + (budgetM - label.distM) / costRatio
        : label.exposureCrit;
      let prunedByDest = false;
      scan: for (const set of destBuckets.values()) {
        for (const id of set) {
          const d = allLabels[id];
          if (d.distM <= optDistM
            && (rain ? d.exposureCrit >= optExposureCrit : d.exposureCrit <= optExposureCrit)) {
            prunedByDest = true; break scan;
          }
        }
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
      // The exposure clock (H2): penalties are the mode policy's own time
      // surrogates, so steps and rough surfaces cost real minutes of sun —
      // but the clock never rides below physical time at cruise speed (see
      // `edgeTraversalSeconds`). Crossing waits stay off the clock: the
      // crossing penalty is search cost and its real wait time is not modelled
      // (H5 owns waiting).
      const edgeSec = edgeTraversalSeconds(edge, travelMode);
      const newArrivalSec = ta ? label.arrivalSec + edgeSec : 0;
      const factor = exposureFactorAt(edge, newArrivalSec);
      // H2: sun accumulates sun seconds, rain sheltered metres.
      const newExposureCrit = rain
        ? label.exposureCrit + edge.distanceM * (edge.shelterFactor ?? 0)
        : label.exposureCrit + edgeSec * (1 - factor);
      // The hard-constraint streak: an edge above SHADOW_THRESH breaks
      // the sunlit run; at or below it the run keeps growing, weighted by
      // the edge's unshadowed fraction.
      const newStreakSec = rain ? 0
        : factor > SHADOW_THRESH ? 0 : label.streakSec + edgeSec * (1 - factor);
      // maxContinuousExposureSec (sun only): a path whose longest sunlit run
      // already exceeds it can only get worse — prune the edge outright.
      if (!rain && maxContinuousExposureSec != null && newStreakSec > maxContinuousExposureSec) {
        continue;
      }

      // Detour budget: prune anything that can no longer finish within budget
      const hTo = hCostRemaining(edge.toId);
      if (newDistM + hTo > budgetM) continue;

      // Pre-check dominance before allocating a label object — against this
      // arrival's bucket only (see the Pareto-set comment above).
      const candidateSet = getSet(edge.toId, ta ? bucketOf(newArrivalSec) : 0);
      let dominated = false;
      for (const id of candidateSet) {
        const ex = allLabels[id];
        if (ex.distM <= newDistM
          && (rain ? ex.exposureCrit >= newExposureCrit : ex.exposureCrit <= newExposureCrit)
          && (rain || ex.streakSec <= newStreakSec)
          && (!ta || ex.arrivalSec <= newArrivalSec)) { dominated = true; break; }
      }
      if (dominated) continue;

      const newLabel = mkLabel(newDistM, newExposureCrit, newArrivalSec, newStreakSec, edge.toId, labelId, edge);
      if (insertPareto(newLabel)) {
        heap.push({ labelId: newLabel.id, f: newDistM + hTo });
      }
    }
  }

  // The destination front spans every bucket's Pareto set at endId.
  const destFront = [...(paretoSets.get(endId)?.values() ?? [])]
    .flat()
    .map((id) => allLabels[id]);
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
      durationSec?: number;
    }> = [];
    const sampledEdges: NonNullable<RouteResult["sampledEdges"]> = [];

    // Replay the walker's clock along the chosen path so the reported metrics
    // are priced at the same buckets the search optimized (H1). Static runs
    // read `shadowFactor` directly and are unchanged.
    let replayArrivalSec = 0;
    for (let i = 0; i < edgePath.length; i++) {
      const edge = edgePath[i];
      if (ta) replayArrivalSec += edgeTraversalSeconds(edge, travelMode);
      const factor = ta ? exposureFactorAt(edge, replayArrivalSec) : edge.shadowFactor;
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
      shadowedDist += edge.distanceM * factor;
      const shelterConfidence = edge.shelterFactor == null
        ? undefined
        : edge.shelterConfidence ?? edge.exposureConfidence ?? 1;
      if (shelterConfidence != null && shelterConfidence >= 0.5) {
        dryDist += edge.distanceM * (edge.shelterFactor ?? 0);
      }
      const protection = rain ? edge.shelterFactor : factor;
      const exposureConfidence = rain ? shelterConfidence : edge.exposureConfidence ?? 1;
      exposureSegments.push({
        distanceM: edge.distanceM,
        // H2: the exposure metrics' durations are the mode's traversal clock
        // (see `edgeTraversalSeconds`) — a bike ride's sun minutes are
        // shorter, and its steps are not.
        durationSec: edgeTraversalSeconds(edge, travelMode),
        protection,
        confidence: exposureConfidence,
        provenance: protection == null ? "unknown" : "geometry",
      });
      surfaceMetresM[edge.surface ?? "unknown"] =
        (surfaceMetresM[edge.surface ?? "unknown"] ?? 0) + edge.distanceM;
      const isShadowed = factor > SHADOW_THRESH;
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
  // destFront's order is bucket-iteration order in a time-aware run — NOT
  // distM order — so sort before anything assumes "first = shortest". The
  // representatives and the normalization ranges below both lean on that.
  candidates.sort((a, b) => a.lbl.distM - b.lbl.distM);

  // Select representatives: shortest (min distM), the exposure extreme, and
  // the knee between them. Under the H2 duration objective the extreme is the
  // *least* sun seconds (rain keeps the most sheltered metres); destFront is
  // still sorted distM asc, so scan rather than take the tail.
  const shortest = candidates[0];
  const extreme = candidates.reduce((a, b) =>
    exposureBetter(b.lbl, a.lbl) ? b : a);

  const minDist  = candidates[0].lbl.distM;
  const maxDist  = candidates[candidates.length - 1].lbl.distM;
  const crits = candidates.map((c) => c.lbl.exposureCrit);
  const minExposure = Math.min(...crits);
  const maxExposure = Math.max(...crits);
  const distRange  = maxDist  - minDist  || 1;
  const exposureRange = maxExposure - minExposure || 1;

  // The knee in the new normalized space: both axes are "smaller is better"
  // (distance, and exposure normalized so 0 is the best exposure), so the
  // balanced representative is the candidate closest to the ideal corner.
  let knee = candidates[0];
  let kneeScore = Infinity;
  for (const c of candidates) {
    const nd = (c.lbl.distM  - minDist)  / distRange;
    const ncrit = (c.lbl.exposureCrit - minExposure) / exposureRange;
    const ne = rain ? 1 - ncrit : ncrit;
    const score = Math.sqrt(nd * nd + ne * ne);
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
  tryAdd(extreme);

  return results;
}

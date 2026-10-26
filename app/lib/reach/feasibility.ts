/**
 * H6 — "is this outing possible?" as a typed certificate, so the assistant
 * answers from the search, never from prose.
 *
 * The question: from a start, walk to a target, stay `stayMin` AT the target,
 * and be home within `timeMin` (stay included) on at most `sunMin` of direct
 * sun. The target is snapped into the street graph exactly (mid-block too).
 *   - `feasible` — a real outing: a walk the search kept that arrives at the
 *     target, the stay there (on its shadiest sidewalk, bucket by bucket), and
 *     a fixed walk home (fastest or shadiest), all within both budgets.
 *   - `infeasible` — a proof, per budget: least walking time out + stay +
 *     least walking time home > T (time binds), and/or least possible sun out
 *     (every street at its shadiest bucket) + least possible stay sun + least
 *     possible sun home > S (sun binds). The bounds are in the certificate.
 *   - `unknown` — neither shown: the bounds fit but no kept walk + fixed walk
 *     home does. Never a "no". Also any "infeasible" near a clipped data edge.
 *   - `unreachable` — no path in the data from the start to the target
 *     (e.g. a park path not joined to the streets) — not a budget question.
 *   - `too-far` / `uncovered` / `cancelled` / `superseded` — no answer, and why.
 * Method: `docs/notes/sun-budget-model.md`, "H6".
 */

import { NumericMinHeap } from "../minHeap";
import { haversineMeters, type RoutingGraph, snapToEdge } from "../routing";
import { type SunReachOptions, type SunReachRun, type SunReachWalk, stayExposure, sunReachRun } from "../sunReach";
import { edgeTraversalSeconds, isProhibitedEdge } from "../travelMode";

export const FEASIBILITY_MODEL_VERSION = "sun-budget-h6-2";

export interface FeasibilityQuestion {
  start: [number, number];
  target: [number, number];
  /** What the target is, as the app resolved it (shown with the verdict). */
  targetLabel?: string;
  sunMin: number;
  timeMin: number;
  stayMin: number;
  /** ISO departure the shade is read at. */
  departure: string;
}

export type FeasibilityStatus =
  | "feasible"
  | "infeasible"
  | "unknown"
  | "unreachable"
  | "too-far"
  | "uncovered"
  | "cancelled"
  | "superseded";

export interface FeasibilityCertificate {
  status: FeasibilityStatus;
  question: FeasibilityQuestion;
  /** Monotonic per session; a newer question supersedes an older one. */
  inputVersion: number;
  modelVersion: string;
  /** The shade data generation the graph was built from, when known. */
  geometryVersion?: string;
  /** Lower bounds (proofs) on any outing, and what a found outing used. */
  ledger?: {
    sun: { budgetSec: number; lowerBoundSec: number; usedSec: number | null; binding: boolean };
    time: { budgetSec: number; lowerBoundSec: number; usedSec: number | null; binding: boolean };
  };
  /** Feasible: the outing that proves it — walk out (with waits), stay at the target, walk home. */
  witness?: SunReachWalk;
  /** Unknown: what kept the search from deciding. */
  gap?: { reason: "no-kept-walk-fits" | "data-edge"; searchOutcome: string };
  /** Why there is no answer, for the no-answer statuses. */
  reason?: string;
}

/** Least `cost` from `src` to every node (forward), or to `src` from every node (reverse). */
function leastCost(graph: RoutingGraph, src: number, cost: (fromId: number, e: GraphEdgeLike) => number, reverse: boolean) {
  const into = new Map<number, Array<{ fromId: number; e: GraphEdgeLike }>>();
  if (reverse)
    for (const [fromId, edges] of graph.adj) for (const e of edges) (into.get(e.toId) ?? into.set(e.toId, []).get(e.toId)!).push({ fromId, e });
  const d = new Map<number, number>([[src, 0]]);
  const next = new Map<number, { fromId: number; e: GraphEdgeLike }>();
  const ids = new Map<number, number>();
  const idOf = (n: number) => {
    if (!ids.has(n)) ids.set(n, ids.size);
    return ids.get(n)!;
  };
  const nodeAt: number[] = [];
  const heap = new NumericMinHeap();
  nodeAt[idOf(src)] = src;
  heap.push(idOf(src), 0);
  while (heap.size > 0) {
    const x = nodeAt[heap.pop()];
    const dx = d.get(x)!;
    const steps = reverse ? (into.get(x) ?? []).map(({ fromId, e }) => ({ y: fromId, fromId, e })) : (graph.adj.get(x) ?? []).map((e) => ({ y: e.toId, fromId: x, e }));
    for (const { y, fromId, e } of steps) {
      const c = cost(fromId, e);
      if (!Number.isFinite(c)) continue;
      if (dx + c < (d.get(y) ?? Number.POSITIVE_INFINITY)) {
        d.set(y, dx + c);
        next.set(y, { fromId, e });
        nodeAt[idOf(y)] = y;
        heap.push(idOf(y), dx + c);
      }
    }
  }
  return { d, next };
}
type GraphEdgeLike = RoutingGraph["adj"] extends Map<number, Array<infer E>> ? E : never;

/**
 * The certificate for one question on `graph` (which `snapToEdge` may extend
 * with a virtual node for the target). `edgeM`: metres from the start to the
 * data's edge when the graph was clipped there (#380), else null.
 */
export function feasibilityCertificate(
  graph: RoutingGraph,
  startId: number,
  question: FeasibilityQuestion,
  options: Pick<SunReachOptions, "timeAware" | "maxLabels" | "maxLabelsPerSlot">,
  meta: { inputVersion: number; geometryVersion?: string; edgeM?: number | null },
  run: (g: RoutingGraph, s: number, o: SunReachOptions) => SunReachRun = sunReachRun,
): FeasibilityCertificate {
  const base = { question, inputVersion: meta.inputVersion, modelVersion: FEASIBILITY_MODEL_VERSION, geometryVersion: meta.geometryVersion };
  const mode = "walk" as const;
  const S = question.sunMin * 60;
  const T = question.timeMin * 60;
  const D = question.stayMin * 60;
  const ta = options.timeAware;
  const B = ta?.bucketCount ?? 1;

  // The target, exactly: its own node if it sits on a corner, else a virtual node mid-block.
  const startNode = graph.nodes.get(startId);
  const nearM = (id: number) => {
    const n = graph.nodes.get(id)!;
    return haversineMeters(question.target, [n.lon, n.lat]);
  };
  let anyNear = false;
  for (const id of graph.nodes.keys()) if (id >= 0 && nearM(id) <= 200) anyNear = true;
  if (!anyNear) {
    const far = startNode ? haversineMeters(question.target, [startNode.lon, startNode.lat]) : Number.POSITIVE_INFINITY;
    return far > 300
      ? { ...base, status: "too-far", reason: "the target is beyond the walking range searched" }
      : { ...base, status: "uncovered", reason: "no street near the target in the shade data" };
  }
  const targetId = snapToEdge(question.target, graph, -900_001, mode);
  if (nearM(targetId) > 60) return { ...base, status: "uncovered", reason: "no street within 60 m of the target" };

  // Lower bounds — each a proof about every outing.
  const secOf = (_f: number, e: GraphEdgeLike) => (isProhibitedEdge(e, mode) ? Number.POSITIVE_INFINITY : edgeTraversalSeconds(e, mode));
  const minSunOf = (_f: number, e: GraphEdgeLike) => {
    if (isProhibitedEdge(e, mode)) return Number.POSITIVE_INFINITY;
    const ts = e.timeShadow;
    const shade = !ta || !ts || ts.length === 0 ? e.shadowFactor : Math.max(...ts.slice(0, B));
    return edgeTraversalSeconds(e, mode) * (1 - shade);
  };
  const tOut = leastCost(graph, startId, secOf, false).d.get(targetId);
  if (tOut === undefined) return { ...base, status: "unreachable", reason: "no path in the street data from the start to the target" };
  const fastHome = leastCost(graph, startId, secOf, true);
  const shadyHome = leastCost(graph, startId, minSunOf, true);
  const tHome = fastHome.d.get(targetId) ?? Number.POSITIVE_INFINITY;
  const sOut = leastCost(graph, startId, minSunOf, false).d.get(targetId) ?? Number.POSITIVE_INFINITY;
  const sHome = shadyHome.d.get(targetId) ?? Number.POSITIVE_INFINITY;
  // The stay's least sun: its seconds at the target's shadiest sidewalk in the shadiest bucket.
  const bestStayShade = Math.max(...Array.from({ length: B }, (_, b) => stayExposure(graph, targetId, ta ? b * (ta.bucketMs / 1000) : 0, 1, ta)[0]?.shade ?? 0));
  const sStay = D * (1 - bestStayShade);
  const timeLB = tOut + D + tHome;
  const sunLB = sOut + sStay + sHome;
  const timeBinds = timeLB > T + 1e-9;
  const sunBinds = sunLB > S + 1e-9;
  const ledger = (used: { sun: number; time: number } | null) => ({
    sun: { budgetSec: S, lowerBoundSec: sunLB, usedSec: used?.sun ?? null, binding: sunBinds },
    time: { budgetSec: T, lowerBoundSec: timeLB, usedSec: used?.time ?? null, binding: timeBinds },
  });
  const clipped = meta.edgeM != null;
  if (timeBinds || sunBinds) {
    // A graph cut at the data's edge can miss streets a real walk would use: no proof there.
    if (clipped) return { ...base, status: "unknown", ledger: ledger(null), gap: { reason: "data-edge", searchOutcome: "clipped" } };
    return { ...base, status: "infeasible", ledger: ledger(null) };
  }

  // Constructive: a kept walk to the target + the stay + a fixed walk home, within both budgets.
  const outbound = run(graph, startId, { ...options, sunBudgetSec: S, timeBudgetSec: T, allowWaits: Boolean(ta) });
  const homeWalk = (next: Map<number, { fromId: number; e: GraphEdgeLike }>, t0: number) => {
    let t = t0;
    let s = 0;
    const steps: Array<{ toId: number; side: "left" | "right" | null }> = [];
    for (let x = targetId; x !== startId; ) {
      const step = next.get(x);
      if (!step) return null;
      // Reverse tree: `next` at x is the edge x → toward home, stored as (fromId = x, e).
      const e = step.e;
      t += edgeTraversalSeconds(e, mode);
      const ts = e.timeShadow;
      const b = ta ? Math.min(Math.floor((t * 1000) / ta.bucketMs), B - 1) : 0;
      s += edgeTraversalSeconds(e, mode) * (1 - (!ta || !ts || ts.length === 0 ? e.shadowFactor : ts[Math.min(b, ts.length - 1)]));
      steps.push({ toId: e.toId, side: e.side ?? null });
      x = e.toId;
    }
    return { t, s, steps };
  };
  let best: { walk: SunReachWalk; sun: number; time: number } | null = null;
  for (const arrival of outbound.arrivalsAt(targetId)) {
    const t1 = arrival.arrivalSec + D;
    if (t1 > T) continue;
    const s1 = arrival.sunSec + stayExposure(graph, targetId, arrival.arrivalSec, D, ta).reduce((a, p) => a + p.durationSec * (1 - p.shade), 0);
    for (const tree of [fastHome.next, shadyHome.next]) {
      const home = homeWalk(tree, t1);
      if (!home || home.t > T + 1e-9 || s1 + home.s > S + 1e-9) continue;
      if (best && s1 + home.s >= best.sun) continue;
      const walk: SunReachWalk = {
        nodeIds: [...arrival.nodeIds, ...home.steps.map((x) => x.toId)],
        sides: [...arrival.sides, ...home.steps.map((x) => x.side)],
        waits: arrival.waits,
        dwell: { atNode: arrival.nodeIds.length - 1, seconds: D },
        sunSec: s1 + home.s,
        arrivalSec: home.t,
      };
      best = { walk, sun: s1 + home.s, time: home.t };
    }
  }
  if (best) return { ...base, status: "feasible", ledger: ledger({ sun: best.sun, time: best.time }), witness: best.walk };
  return {
    ...base,
    status: "unknown",
    ledger: ledger(null),
    gap: { reason: clipped ? "data-edge" : "no-kept-walk-fits", searchOutcome: outbound.result.outcome },
  };
}

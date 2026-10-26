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
import { haversineMeters, type RoutingGraph } from "../routing";
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

/**
 * Puts `coord` on the street graph as node `id`, keeping BOTH sidewalks.
 * `snapToEdge` copies one sidewalk of the split street and never splits a
 * virtual edge; a bound computed through it is too high (review of #398). Here
 * the nearest segment is found among all edges (virtual ones too, so a start
 * and target on one block meet directly) and every parallel edge between its
 * ends, both ways, is split at the projection. Returns `id`, an existing
 * endpoint when the projection lands on one, or null with no segment at all.
 */
export function splitStreetsAt(graph: RoutingGraph, coord: [number, number], id: number): number | null {
  const toXY = (lon: number, lat: number) => [lon * Math.cos((coord[1] * Math.PI) / 180), lat] as const;
  const [px, py] = toXY(coord[0], coord[1]);
  let best: { a: number; b: number; t: number; d: number; len2: number } | null = null;
  for (const [a, edges] of graph.adj) {
    const na = graph.nodes.get(a);
    if (!na) continue;
    for (const e of edges) {
      const nb = graph.nodes.get(e.toId);
      if (!nb) continue;
      const [ax, ay] = toXY(na.lon, na.lat);
      const [bx, by] = toXY(nb.lon, nb.lat);
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
      const d = (px - (ax + t * (bx - ax))) ** 2 + (py - (ay + t * (by - ay))) ** 2;
      // Ties (the target lies on a street and on its earlier split pieces) go to
      // the shortest segment: the finest split, so a snapped start on the same
      // block is a direct neighbour.
      if (!best || d < best.d - 1e-18 || (d <= best.d + 1e-18 && len2 < best.len2)) best = { a, b: e.toId, t, d, len2 };
    }
  }
  if (!best) return null;
  if (best.t <= 1e-9) return best.a;
  if (best.t >= 1 - 1e-9) return best.b;
  const { a, b, t } = best;
  const na = graph.nodes.get(a)!;
  const nb = graph.nodes.get(b)!;
  graph.nodes.set(id, { id, lat: na.lat + t * (nb.lat - na.lat), lon: na.lon + t * (nb.lon - na.lon) });
  const ab = (graph.adj.get(a) ?? []).filter((e) => e.toId === b);
  const ba = (graph.adj.get(b) ?? []).filter((e) => e.toId === a);
  // a→id→b along each a→b sidewalk, and b→id→a along each b→a one; each piece keeps its sidewalk.
  const out: typeof ab = [];
  for (const e of ab) {
    graph.adj.get(a)!.push({ ...e, toId: id, distanceM: e.distanceM * t });
    out.push({ ...e, toId: b, distanceM: e.distanceM * (1 - t) });
  }
  for (const e of ba) {
    graph.adj.get(b)!.push({ ...e, toId: id, distanceM: e.distanceM * (1 - t) });
    out.push({ ...e, toId: a, distanceM: e.distanceM * t });
  }
  graph.adj.set(id, out);
  return id;
}

/**
 * A virtual node from `snapToEdge` (the snapped start) carries one sidewalk of
 * the street it split. Re-wire it with every sidewalk between that street's two
 * ends, split in the same proportion, so no bound through it is too high.
 */
export function widenVirtualNode(graph: RoutingGraph, id: number): void {
  if (id >= 0) return;
  const own = graph.adj.get(id) ?? [];
  const ends = [...new Set(own.map((e) => e.toId))];
  if (ends.length !== 2) return;
  const [a, b] = ends;
  const toA = own.find((e) => e.toId === a)!.distanceM;
  const toB = own.find((e) => e.toId === b)!.distanceM;
  const t = toA + toB > 0 ? toA / (toA + toB) : 0.5;
  const ab = (graph.adj.get(a) ?? []).filter((e) => e.toId === b);
  const ba = (graph.adj.get(b) ?? []).filter((e) => e.toId === a);
  if (ab.length + ba.length === 0) return;
  // Drop the one-sidewalk wiring both ways, then wire every sidewalk.
  graph.adj.set(a, (graph.adj.get(a) ?? []).filter((e) => e.toId !== id));
  graph.adj.set(b, (graph.adj.get(b) ?? []).filter((e) => e.toId !== id));
  const out: typeof ab = [];
  for (const e of ab) {
    graph.adj.get(a)!.push({ ...e, toId: id, distanceM: e.distanceM * t });
    out.push({ ...e, toId: b, distanceM: e.distanceM * (1 - t) });
  }
  for (const e of ba) {
    graph.adj.get(b)!.push({ ...e, toId: id, distanceM: e.distanceM * (1 - t) });
    out.push({ ...e, toId: a, distanceM: e.distanceM * t });
  }
  graph.adj.set(id, out);
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
  widenVirtualNode(graph, startId);
  const targetId = splitStreetsAt(graph, question.target, -900_001);
  if (targetId === null || nearM(targetId) > 60) return { ...base, status: "uncovered", reason: "no street within 60 m of the target" };

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

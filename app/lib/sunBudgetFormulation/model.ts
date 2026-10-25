/**
 * H7 — the Sun Budget question as an integer program, a second implementation
 * independent of the label search (`sunReach.ts`) and the oracle
 * (`sunReachOracle.fixture.ts`). Offline evaluation only: nothing in the app
 * imports this, and the solver (`highs`) is a devDependency.
 *
 * Time-expanded network on whole seconds 0..T:
 *   - a node per (corner, second);
 *   - a walk arc per (street, departure second t) to (its end, t + d), d its
 *     whole-second traversal time, costing d × (1 − shade at the bucket of
 *     t + d) — arrival pricing, as the search and oracle price it;
 *   - (allowWaits) a wait arc per (corner, t) to (corner, t + 1), costing
 *     1 − the corner's shadiest-sidewalk shade in the bucket of t. The search
 *     only waits to bucket boundaries; on whole seconds a run of 1 s waits
 *     covers that and every shorter wait, so this model is never tighter than
 *     the search's — any gap between them is the search's restriction, and the
 *     comparison states it.
 * Variables x_a ∈ {0,1}: one unit leaves (start, 0), flow is conserved, and it
 * may stop at any node (a free sink arc per node). "Can street e be walked on
 * ≤ S of sun?" is: minimise total sun subject to Σ x over e's arcs ≥ 1. The
 * street is reachable iff that optimum ≤ S. Its LP relaxation (0 ≤ x ≤ 1) is a
 * lower bound; integer − LP is the integrality gap.
 *
 * That program is a min-cost flow with one forced arc set, so its LP is
 * integral: the gap is always 0, and the tests say so. The relaxation turns
 * loose once a second resource binds — `"earliest"`: least arrival time at the
 * street's end subject to sun ≤ S, the resource-constrained shortest path,
 * whose LP can mix a fast sunny walk with a slow shaded one.
 *
 * Exact equivalence with the search needs whole-second edge times (distances
 * a multiple of 1.4 m at walking pace) — `integerSecondsGraph` builds those.
 */

import type { GraphEdge, RoutingGraph } from "../routing";
import { edgeTraversalSeconds, isProhibitedEdge, type TravelModeId } from "../travelMode";

export interface FormulationOptions {
  timeBudgetSec: number;
  timeAware?: { bucketMs: number; bucketCount: number };
  allowWaits?: boolean;
  travelMode?: TravelModeId;
}

export interface Street {
  fromId: number;
  toId: number;
  side: string | null;
  /** Index into `graph.adj.get(fromId)`. */
  index: number;
}

/** Every routable street (directed edge), in adjacency order. */
export function streetsOf(graph: RoutingGraph, mode: TravelModeId = "walk"): Street[] {
  const out: Street[] = [];
  for (const [fromId, edges] of graph.adj) {
    edges.forEach((e, index) => {
      if (!isProhibitedEdge(e, mode)) out.push({ fromId, toId: e.toId, side: e.side ?? null, index });
    });
  }
  return out;
}

export const streetKey = (s: { fromId: number; toId: number; side?: string | null }) => `${s.fromId}>${s.toId}:${s.side ?? ""}`;

/**
 * The integer program for "least sun of any walk from `startId` that walks
 * `street`", in CPLEX LP format, with `General` integrality unless `relax`.
 * Returns null when no arc of the street fits in T (trivially unreachable).
 */
export function streetProgram(
  graph: RoutingGraph,
  startId: number,
  street: Street,
  o: FormulationOptions & { sunBudgetSec?: number },
  relax = false,
  objective: "least-sun" | "earliest" = "least-sun",
): string | null {
  const mode = o.travelMode ?? "walk";
  const T = Math.floor(o.timeBudgetSec);
  const W = o.timeAware ? o.timeAware.bucketMs / 1000 : Number.POSITIVE_INFINITY;
  const B = o.timeAware?.bucketCount ?? 1;
  const bucket = (t: number) => (o.timeAware ? Math.min(Math.floor(t / W), B - 1) : 0);
  const shadeOf = (e: GraphEdge, b: number) => {
    const ts = e.timeShadow;
    return !o.timeAware || !ts || ts.length === 0 ? e.shadowFactor : ts[Math.min(b, ts.length - 1)];
  };
  const nodeShade = (id: number, b: number) => Math.max(0, ...(graph.adj.get(id) ?? []).map((e) => shadeOf(e, b)));

  const node = (id: number, t: number) => `n${id}_${t}`;
  const arcs: Array<{ name: string; from: string; to: string; cost: number; target: boolean }> = [];
  let k = 0;
  for (const [fromId, edges] of graph.adj) {
    edges.forEach((e, index) => {
      if (isProhibitedEdge(e, mode)) return;
      const d = Math.round(edgeTraversalSeconds(e, mode));
      for (let t = 0; t + d <= T; t++) {
        arcs.push({
          name: `x${k++}`,
          from: node(fromId, t),
          to: node(e.toId, t + d),
          cost: d * (1 - shadeOf(e, bucket(t + d))),
          target: fromId === street.fromId && index === street.index,
        });
      }
    });
    if (o.allowWaits && o.timeAware) {
      for (let t = 0; t < T; t++) {
        arcs.push({ name: `x${k++}`, from: node(fromId, t), to: node(fromId, t + 1), cost: 1 - nodeShade(fromId, bucket(t)), target: false });
      }
    }
  }
  if (!arcs.some((a) => a.target)) return null;

  // Conservation: out − in = 1 at the source, out − in − sink = 0 elsewhere (sink ≥ 0 ends the walk).
  const touched = new Set<string>([node(startId, 0)]);
  for (const a of arcs) {
    touched.add(a.from);
    touched.add(a.to);
  }
  const outOf = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const a of arcs) {
    (outOf.get(a.from) ?? outOf.set(a.from, []).get(a.from)!).push(a.name);
    (into.get(a.to) ?? into.set(a.to, []).get(a.to)!).push(a.name);
  }
  const fmt = (n: number) => (Math.abs(n) < 1e-12 ? "0" : n.toFixed(9));
  // "earliest": arrival second at the street's end = Σ (t + d) over its arcs (exactly one is used).
  const objectiveTerms = objective === "least-sun"
    ? arcs.map((a) => `${fmt(a.cost)} ${a.name}`)
    : arcs.filter((a) => a.target).map((a) => `${fmt(Number(a.to.split("_")[1]))} ${a.name}`);
  const lines: string[] = ["Minimize", ` obj: ${objectiveTerms.join(" + ") || "0"}`, "Subject To"];
  let c = 0;
  const sinks: string[] = [];
  for (const n of touched) {
    const out = outOf.get(n) ?? [];
    const inn = into.get(n) ?? [];
    const sink = `s_${n}`;
    sinks.push(sink);
    const terms = [...out.map((x) => `+ ${x}`), ...inn.map((x) => `- ${x}`), `+ ${sink}`];
    // At the source: out − in + sink = 1 (the walk may also end where it began).
    lines.push(` c${c++}: ${terms.join(" ")} = ${n === node(startId, 0) ? 1 : 0}`.replace(": +", ":"));
  }
  // Sinks absorb the inflow: Σ sinks = 1 overall is implied; each sink ≥ 0.
  lines.push(` target: ${arcs.filter((a) => a.target).map((a) => a.name).join(" + ")} ${objective === "earliest" ? "=" : ">="} 1`);
  if (objective === "earliest") {
    if (o.sunBudgetSec === undefined) throw new Error("earliest needs sunBudgetSec");
    lines.push(` sun: ${arcs.map((a) => `${fmt(a.cost)} ${a.name}`).join(" + ")} <= ${fmt(o.sunBudgetSec)}`);
  }
  lines.push("Bounds");
  for (const a of arcs) lines.push(` 0 <= ${a.name} <= 1`);
  for (const s of sinks) lines.push(` 0 <= ${s} <= 1`);
  if (!relax) {
    lines.push("General");
    for (const a of arcs) lines.push(` ${a.name}`);
  }
  lines.push("End");
  return lines.join("\n");
}

/**
 * `graph` with every distance snapped to a whole multiple of 1.4 m (≥ 1.4), so
 * every walking edge takes whole seconds and the time-expanded model is exact.
 */
export function integerSecondsGraph(graph: RoutingGraph): RoutingGraph {
  return {
    nodes: graph.nodes,
    adj: new Map(
      [...graph.adj].map(([id, edges]) => [id, edges.map((e) => ({ ...e, distanceM: Math.max(1, Math.round(e.distanceM / 1.4)) * 1.4 }))]),
    ),
  };
}

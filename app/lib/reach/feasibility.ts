/**
 * H6 — "is this outing possible?" as a typed certificate, so the assistant
 * answers from the search, never from prose.
 *
 * The question: from a start, walk to a target street, stay `stayMin` there,
 * and be home within `timeMin` on at most `sunMin` of direct sun. It is H5b's
 * round trip, asked of one street:
 *   - `feasible` — the target is proven (a replayable outing exists);
 *   - `infeasible` — the search's outer bound rules it out, which is a proof:
 *     no outing meets both budgets; the certificate names which budget binds;
 *   - `unknown` — neither proven nor ruled out; the search was capped
 *     (`approximate`) or stopped (`budget-exhausted`). Never a "no".
 *   - `cancelled` / `superseded` / `uncovered` — no answer, and why.
 * Method: `docs/notes/sun-budget-model.md`, "H6".
 */

import { haversineMeters, type RoutingGraph } from "../routing";
import { type SunReachOptions, type SunReachResult, type SunReachRun, type SunReachWalk, sunReachRun } from "../sunReach";

export const FEASIBILITY_MODEL_VERSION = "sun-budget-h6-1";

export interface FeasibilityQuestion {
  start: [number, number];
  target: [number, number];
  sunMin: number;
  timeMin: number;
  stayMin: number;
  /** ISO departure the shade is read at. */
  departure: string;
}

export type FeasibilityStatus = "feasible" | "infeasible" | "unknown" | "cancelled" | "superseded" | "uncovered";

export interface FeasibilityCertificate {
  status: FeasibilityStatus;
  question: FeasibilityQuestion;
  /** Monotonic per session; a newer question supersedes an older one. */
  inputVersion: number;
  modelVersion: string;
  /** The shade data generation the graph was built from, when known. */
  geometryVersion?: string;
  /** The target street, as searched. */
  targetStreet?: { fromId: number; toId: number; distanceM: number };
  /** Each budget against the proof: what the outing used, or the least any outing could. */
  ledger?: {
    sun: { budgetSec: number; usedSec: number | null; binding: boolean };
    time: { budgetSec: number; usedSec: number | null; binding: boolean };
  };
  /** Feasible: the outing that proves it — walk, waits, stay, home. */
  witness?: SunReachWalk;
  /** Unknown: the search's outcome, and how many streets it left undecided. */
  gap?: { outcome: SunReachResult["outcome"]; undecidedStreets: number };
  /** Why there is no answer, for cancelled / superseded / uncovered. */
  reason?: string;
}

/** The target street: the edge whose midpoint is nearest the target, within `maxM`. */
export function nearestStreet(
  graph: RoutingGraph,
  target: [number, number],
  maxM = 60,
): { fromId: number; toId: number; distanceM: number } | null {
  let best: { fromId: number; toId: number; distanceM: number; d: number } | null = null;
  for (const [fromId, edges] of graph.adj) {
    const a = graph.nodes.get(fromId);
    if (!a) continue;
    for (const e of edges) {
      const b = graph.nodes.get(e.toId);
      if (!b) continue;
      const d = haversineMeters(target, [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2]);
      if (d <= maxM && (!best || d < best.d)) best = { fromId, toId: e.toId, distanceM: e.distanceM, d };
    }
  }
  return best ? { fromId: best.fromId, toId: best.toId, distanceM: best.distanceM } : null;
}

const onStreet = (e: { fromId: number; toId: number }, s: { fromId: number; toId: number }) =>
  (e.fromId === s.fromId && e.toId === s.toId) || (e.fromId === s.toId && e.toId === s.fromId);

/**
 * The certificate for one search of `graph` from `startId`. When the target is
 * ruled out, `relaxed` re-runs it with one budget lifted to find which binds:
 * reachable with sun unlimited → sun binds; still not → time binds (sun alone
 * cannot fix it).
 */
export function feasibilityCertificate(
  graph: RoutingGraph,
  startId: number,
  question: FeasibilityQuestion,
  options: Pick<SunReachOptions, "timeAware" | "maxLabels" | "maxLabelsPerSlot">,
  meta: { inputVersion: number; geometryVersion?: string },
  run: (g: RoutingGraph, s: number, o: SunReachOptions) => SunReachRun = sunReachRun,
): FeasibilityCertificate {
  const base = { question, inputVersion: meta.inputVersion, modelVersion: FEASIBILITY_MODEL_VERSION, geometryVersion: meta.geometryVersion };
  const street = nearestStreet(graph, question.target);
  if (!street) return { ...base, status: "uncovered", reason: "no street near the target in the shade data" };
  const S = question.sunMin * 60;
  const T = question.timeMin * 60;
  const o: SunReachOptions = { ...options, sunBudgetSec: S, timeBudgetSec: T, roundTrip: { dwellSec: question.stayMin * 60 } };
  const result = run(graph, startId, o);
  const proven = result.result.reachable.filter((e) => onStreet(e, street));
  if (proven.length > 0) {
    const best = proven.reduce((a, b) => (b.sunSec < a.sunSec ? b : a));
    const witness = result.witness(best.fromId, best.toId, best.side) ?? undefined;
    return {
      ...base,
      status: "feasible",
      targetStreet: street,
      ledger: {
        sun: { budgetSec: S, usedSec: best.sunSec, binding: false },
        time: { budgetSec: T, usedSec: best.arrivalSec, binding: false },
      },
      ...(witness ? { witness } : {}),
    };
  }
  if (result.result.undecided.some((e) => onStreet(e, street))) {
    return {
      ...base,
      status: "unknown",
      targetStreet: street,
      gap: { outcome: result.result.outcome, undecidedStreets: result.result.undecided.length },
    };
  }
  // Ruled out by the bound. Which budget binds: lift sun to the whole outing.
  // No outing spends more sun than its whole length, T (stop included).
  const sunLifted = run(graph, startId, { ...o, sunBudgetSec: T });
  const sunFixes = sunLifted.result.reachable.some((e) => onStreet(e, street));
  return {
    ...base,
    status: "infeasible",
    targetStreet: street,
    ledger: {
      sun: { budgetSec: S, usedSec: null, binding: sunFixes },
      time: { budgetSec: T, usedSec: null, binding: !sunFixes },
    },
  };
}

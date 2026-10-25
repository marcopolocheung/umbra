/**
 * H7 — solve `model.ts`'s programs with HiGHS and compare the integer region,
 * the LP bound, the exhaustive oracle and the label search on one fixture.
 * Offline only (tests and `npm run eval:h7`); `highs` is a devDependency.
 */

import highsLoader from "highs";
import type { RoutingGraph } from "../routing";
import { type SunReachOptions, sunReach } from "../sunReach";
import { streetKey, streetProgram, streetsOf } from "./model";

type Highs = Awaited<ReturnType<typeof highsLoader>>;
let solver: Promise<Highs> | null = null;
/** One WASM instance per process. */
export const loadHighs = () => (solver ??= highsLoader());

export interface StreetCertificate {
  street: string;
  /** Least sun of any walk using the street (integer program); null if infeasible within T. */
  integerSun: number | null;
  /** The LP relaxation's optimum: a lower bound on `integerSun`. */
  lpSun: number | null;
  reachableByIP: boolean;
  /** Variables in the program, for the size distribution. */
  arcs: number;
  ms: { integer: number; lp: number };
}

export interface FixtureReport {
  streets: StreetCertificate[];
  /** Streets the integer program proves reachable within S. */
  ipRegion: Set<string>;
  /** The label search's proven region and outcome. */
  searchRegion: Set<string>;
  searchOutcome: string;
}

/** Optimal means optimal within HiGHS's numerical tolerances: no relative MIP gap allowed. */
export const SOLVER_OPTIONS = { mip_rel_gap: 0 };

function solveSun(highs: Highs, lp: string): { sun: number | null; ms: number } {
  const t0 = performance.now();
  const r = highs.solve(lp, SOLVER_OPTIONS);
  const ms = performance.now() - t0;
  if (r.Status === "Optimal") return { sun: r.ObjectiveValue, ms };
  if (r.Status === "Infeasible") return { sun: null, ms };
  throw new Error(`HiGHS: ${r.Status}`);
}

/** Every street's certificate on one fixture, and both regions. */
export async function solveFixture(graph: RoutingGraph, startId: number, o: SunReachOptions): Promise<FixtureReport> {
  const highs = await loadHighs();
  const streets: StreetCertificate[] = [];
  const ipRegion = new Set<string>();
  for (const street of streetsOf(graph, o.travelMode)) {
    const ip = streetProgram(graph, startId, street, o);
    const key = streetKey(street);
    if (!ip) {
      streets.push({ street: key, integerSun: null, lpSun: null, reachableByIP: false, arcs: 0, ms: { integer: 0, lp: 0 } });
      continue;
    }
    const integer = solveSun(highs, ip);
    const lp = solveSun(highs, streetProgram(graph, startId, street, o, true)!);
    // mip_rel_gap 0 and HiGHS's 1e-6 absolute gap; the budget comparison allows the same.
    const reachable = integer.sun !== null && integer.sun <= o.sunBudgetSec + 1e-6;
    if (reachable) ipRegion.add(key);
    streets.push({
      street: key,
      integerSun: integer.sun,
      lpSun: lp.sun,
      reachableByIP: reachable,
      arcs: (ip.match(/^ 0 <= x/gm) ?? []).length,
      ms: { integer: integer.ms, lp: lp.ms },
    });
  }
  const search = sunReach(graph, startId, { ...o, maxLabelsPerSlot: 256 });
  return {
    streets,
    ipRegion,
    searchRegion: new Set(search.reachable.map((e) => streetKey({ fromId: e.fromId, toId: e.toId, side: e.side ?? null }))),
    searchOutcome: search.outcome,
  };
}

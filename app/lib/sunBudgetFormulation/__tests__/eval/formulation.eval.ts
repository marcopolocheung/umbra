/**
 * H7 report: on 24 seeded whole-second lattices, the integer program (IP),
 * its LP relaxation, the exhaustive oracle and the label search, side by side.
 * Writes `docs/notes/h7/certificates.json` (every street's IP and LP optimum)
 * and `docs/notes/h7/summary.json` (the distributions the note quotes).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { randomGraph, rng } from "../../../__tests__/paretoCases.fixture";
import { oracleReach } from "../../../__tests__/sunReachOracle.fixture";
import { sunReach, type SunReachOptions } from "../../../sunReach";
import { integerSecondsGraph, streetProgram, streetsOf } from "../../model";
import { loadHighs, solveFixture } from "../../solve";

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const dist = (xs: number[]) => ({ n: xs.length, min: pct(xs, 0), p50: pct(xs, 0.5), p90: pct(xs, 0.9), max: pct(xs, 1) });

it("H7 report", async () => {
  const r = rng(20261025);
  const fixtures: Array<Record<string, unknown>> = [];
  const certificates: Array<Record<string, unknown>> = [];
  const lpGapsLeastSun: number[] = [];
  const lpGapsEarliest: number[] = [];
  const ipMs: number[] = [];
  const lpMs: number[] = [];
  const arcs: number[] = [];
  let agreeOracle = 0;
  let agreeSearch = 0;
  let searchExact = 0;
  const highs = await loadHighs();
  for (let i = 0; i < 24; i++) {
    const seed = 900 + i;
    const rows = 3;
    const cols = 3 + (i % 2);
    const buckets = 2 + (i % 3);
    const graph = integerSecondsGraph(randomGraph(seed, rows, cols, buckets));
    const o: SunReachOptions = {
      sunBudgetSec: [20, 40, 60][Math.floor(r() * 3)],
      timeBudgetSec: [80, 100][Math.floor(r() * 2)],
      timeAware: { bucketMs: [20_000, 30_000][Math.floor(r() * 2)], bucketCount: buckets },
      ...(i % 4 === 3 ? { allowWaits: true } : {}),
    };
    const start = Math.floor(r() * rows * cols);
    const t0 = performance.now();
    const rep = await solveFixture(graph, start, o);
    const truth = oracleReach(graph, start, o);
    const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
    const okOracle = eq(rep.ipRegion, truth);
    const okSearch = eq(rep.searchRegion, rep.ipRegion);
    if (okOracle) agreeOracle++;
    if (okSearch) agreeSearch++;
    if (rep.searchOutcome === "exact") searchExact++;
    for (const s of rep.streets) {
      if (s.integerSun !== null && s.lpSun !== null) lpGapsLeastSun.push(s.integerSun - s.lpSun);
      if (s.arcs) {
        arcs.push(s.arcs);
        ipMs.push(s.ms.integer);
        lpMs.push(s.ms.lp);
      }
      certificates.push({ seed, start, options: o, ...s });
    }
    // The resource-constrained form on every reachable street: earliest arrival with sun ≤ S.
    for (const street of streetsOf(graph)) {
      const ip = streetProgram(graph, start, street, o, false, "earliest");
      if (!ip) continue;
      const a = highs.solve(ip);
      if (a.Status !== "Optimal") continue;
      const b = highs.solve(streetProgram(graph, start, street, o, true, "earliest")!);
      if (b.Status === "Optimal") lpGapsEarliest.push(a.ObjectiveValue - b.ObjectiveValue);
    }
    fixtures.push({
      seed, start, rows, cols, buckets, options: o,
      streets: rep.streets.length, ipRegion: rep.ipRegion.size, oracle: truth.size, search: rep.searchRegion.size,
      searchOutcome: rep.searchOutcome, ipEqualsOracle: okOracle, searchEqualsIp: okSearch,
      onlyIp: [...rep.ipRegion].filter((k) => !rep.searchRegion.has(k)),
      onlySearch: [...rep.searchRegion].filter((k) => !rep.ipRegion.has(k)),
      ms: Math.round(performance.now() - t0),
    });
  }
  // Discretization: the same lattices at their real (fractional) seconds, searched,
  // against the whole-second version the IP solves — what rounding to seconds moves.
  const discretization: number[] = [];
  for (let i = 0; i < 24; i++) {
    const real = randomGraph(900 + i, 3, 3 + (i % 2), 2 + (i % 3));
    const f = fixtures[i] as { start: number; options: SunReachOptions };
    const a = new Set(sunReach(real, f.start, { ...f.options, maxLabelsPerSlot: 256 }).reachable.map((e) => `${e.fromId}>${e.toId}:${e.side ?? ""}`));
    const b = new Set(sunReach(integerSecondsGraph(real), f.start, { ...f.options, maxLabelsPerSlot: 256 }).reachable.map((e) => `${e.fromId}>${e.toId}:${e.side ?? ""}`));
    discretization.push([...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length);
  }
  const summary = {
    fixtures: fixtures.length,
    ipEqualsOracle: agreeOracle,
    searchEqualsIp: agreeSearch,
    searchExact,
    integralityGapLeastSun: dist(lpGapsLeastSun),
    integralityGapEarliest: dist(lpGapsEarliest),
    looseEarliest: lpGapsEarliest.filter((g) => g > 1e-6).length,
    arcsPerProgram: dist(arcs),
    ipMs: dist(ipMs.map((x) => Math.round(x * 10) / 10)),
    lpMs: dist(lpMs.map((x) => Math.round(x * 10) / 10)),
    discretizationStreetsChanged: dist(discretization),
    fixtureReports: fixtures,
  };
  mkdirSync("docs/notes/h7", { recursive: true });
  writeFileSync("docs/notes/h7/summary.json", `${JSON.stringify(summary, null, 1)}\n`);
  writeFileSync("docs/notes/h7/certificates.json", `${JSON.stringify(certificates)}\n`);
});

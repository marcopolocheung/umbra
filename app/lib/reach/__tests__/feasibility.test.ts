import { describe, expect, it } from "vitest";
import type { RoutingGraph } from "../../routing";
import { sunReachRun } from "../../sunReach";
import { feasibilityCertificate, type FeasibilityQuestion, nearestStreet } from "../feasibility";

/** Corners 0 (home) — 1 — 2 in a line, 140 m (100 s) apart, both ways; shade per street. */
function line(shade01: number, shade12: number): RoutingGraph {
  const node = (id: number) => [id, { id, lat: 40.7 + (id * 140) / 111_320, lon: -74 }] as const;
  const e = (toId: number, s: number) => ({ toId, distanceM: 140, shadowFactor: s });
  return { nodes: new Map([node(0), node(1), node(2)]), adj: new Map([[0, [e(1, shade01)]], [1, [e(0, shade01), e(2, shade12)]], [2, [e(1, shade12)]]]) };
}
const at = (id: number): [number, number] => [-74, 40.7 + (id * 140 - 70) / 111_320]; // midpoint of street (id-1)→id
const ask = (over: Partial<FeasibilityQuestion> = {}): FeasibilityQuestion => ({
  start: [-74, 40.7], target: at(2), sunMin: 5, timeMin: 10, stayMin: 0, departure: "2026-07-01T18:00:00Z", ...over,
});
const meta = { inputVersion: 7, geometryVersion: "nyc-test" };

describe("H6 — feasibility certificates", () => {
  it("feasible: carries the outing, and walk + stay + home within both budgets", () => {
    // Out 200 s, home 200 s, all shaded; a 2-min stay at the far corner, shaded.
    const cert = feasibilityCertificate(line(1, 1), 0, ask({ stayMin: 2 }), {}, meta);
    expect(cert.status).toBe("feasible");
    expect(cert.witness!.nodeIds[0]).toBe(0);
    expect(cert.witness!.nodeIds.at(-1)).toBe(0);
    expect(cert.witness!.dwell?.seconds).toBe(120);
    expect(cert.ledger!.time.usedSec).toBeLessThanOrEqual(600);
    expect(cert.ledger!.sun.usedSec).toBeCloseTo(0, 9);
    expect(cert).toMatchObject({ inputVersion: 7, geometryVersion: "nyc-test", modelVersion: expect.any(String) });
  });

  it("infeasible, sun binding: an all-sun walk over a 5-min sun budget, time to spare", () => {
    // 400 s there and back in full sun > 300 s of sun; 10 min of time is plenty.
    const cert = feasibilityCertificate(line(0, 0), 0, ask(), {}, meta);
    expect(cert.status).toBe("infeasible");
    expect(cert.ledger!.sun.binding).toBe(true);
    expect(cert.ledger!.time.binding).toBe(false);
    expect(cert.witness).toBeUndefined();
  });

  it("infeasible, time binding: shaded, but there and back takes longer than allowed", () => {
    const cert = feasibilityCertificate(line(1, 1), 0, ask({ timeMin: 5 }), {}, meta);
    expect(cert.status).toBe("infeasible");
    expect(cert.ledger!.time.binding).toBe(true);
    expect(cert.ledger!.sun.binding).toBe(false);
  });

  it("unknown, never no: a capped search that leaves the target undecided", () => {
    // A work cap of 1 label stops the search at once: the target is not proven
    // and the bound cannot rule it out.
    const cert = feasibilityCertificate(line(1, 1), 0, ask({ stayMin: 2 }), { maxLabels: 1 }, meta);
    expect(cert.status).toBe("unknown");
    expect(cert.gap?.outcome).toBe("budget-exhausted");
    expect(cert.ledger).toBeUndefined();
  });

  it("uncovered: no street near the target", () => {
    const cert = feasibilityCertificate(line(1, 1), 0, ask({ target: [-73.9, 40.8] }), {}, meta);
    expect(cert.status).toBe("uncovered");
  });

  it("a feasible certificate's used sun re-prices from its own witness", () => {
    // Half-shaded street 1→2: re-price walk out, stay, walk home from the walk itself.
    const graph = line(1, 0.5);
    const cert = feasibilityCertificate(graph, 0, ask({ sunMin: 10, timeMin: 20, stayMin: 1 }), {}, meta);
    expect(cert.status).toBe("feasible");
    // 1→2 and 2→1 each 100 s at half shade = 100 s of sun; the stay at corner 2
    // stands on its shadiest side (0.5): 30 s more.
    expect(cert.ledger!.sun.usedSec).toBeCloseTo(130, 6);
  });

  it("matches the target to the street it is on", () => {
    expect(nearestStreet(line(1, 1), at(2))).toMatchObject({ distanceM: 140 });
    expect(nearestStreet(line(1, 1), [-73.9, 40.8])).toBeNull();
  });

  it("a different run (a later shade sky) changes the answer, not the wording: the certificate follows the search", () => {
    const sunny = feasibilityCertificate(line(0, 0), 0, ask(), {}, meta, sunReachRun);
    const shaded = feasibilityCertificate(line(1, 1), 0, ask(), {}, meta, sunReachRun);
    expect([sunny.status, shaded.status]).toEqual(["infeasible", "feasible"]);
  });
});

describe("H6 — the authority boundary and the worker command", () => {
  it("rejects an outing check whose start or target the app never produced, or out-of-range budgets", async () => {
    const { authorizeToolCall } = await import("../../agent/authority");
    const state = {
      currentUserText: "Can I walk to the cafe and be home in 45 minutes on under 8 minutes of sun?",
      candidates: [
        { id: "location:r1", lat: 40.7536, lng: -73.984 },
        { id: "candidate:r2:0", lat: 40.7547, lng: -73.9836 },
      ],
    };
    const args = { startLat: 40.7536, startLng: -73.984, startCandidateId: "location:r1", targetLat: 40.7547, targetLng: -73.9836, targetCandidateId: "candidate:r2:0", sunMin: 8, timeMin: 45, stayMin: 15 };
    const cats = ["model_generated", "current_user_intent", "application_state"] as const;
    expect(authorizeToolCall(state, "check_sun_budget", args, [...cats]).allowed).toBe(true);
    expect(authorizeToolCall(state, "check_sun_budget", { ...args, targetLat: 40.8, targetCandidateId: "invented" }, [...cats]).event.reasonCode).toBe(
      "sensitive_argument_not_application_candidate",
    );
    expect(authorizeToolCall(state, "check_sun_budget", { ...args, timeMin: 600 }, [...cats]).event.reasonCode).toBe("invalid_time_bounds");
  });

  it("the worker answers on a graph of its own and leaves the panel's kept graph searchable", async () => {
    const { createSunBudgetHandler, SUN_BUDGET_WORKER_PROTOCOL_VERSION: P } = await import("../sunBudgetWorkerProtocol");
    const kept = { status: "ok" as const, graph: line(1, 1), startId: 0, startPoint: [-74, 40.7] as [number, number], timeAware: { bucketMs: 900_000, bucketCount: 4 }, edgeM: null, generation: "nyc-test" };
    let builds = 0;
    const handle = createSunBudgetHandler(async () => {
      builds++;
      return kept;
    });
    const built = await handle({ type: "build", protocol: P, requestId: 1, center: [-74, 40.7], timeBudgetSec: 1800, departureMs: 0 });
    if (built.type !== "built" || built.built.status !== "ok") throw new Error("not built");
    const answer = await handle({ type: "feasibility", protocol: P, requestId: 2, question: ask({ stayMin: 2 }), inputVersion: 3 });
    expect(answer).toMatchObject({ type: "feasibility", certificate: { status: "feasible", inputVersion: 3, geometryVersion: "nyc-test" } });
    expect(builds).toBe(2);
    // The panel's graph is still the kept one.
    const searched = await handle({ type: "search", protocol: P, requestId: 3, graphId: built.built.graphId, options: { sunBudgetSec: 60, timeBudgetSec: 200 } });
    expect(searched.type).toBe("searched");
  });
});

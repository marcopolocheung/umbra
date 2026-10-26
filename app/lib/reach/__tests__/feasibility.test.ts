import { describe, expect, it } from "vitest";
import type { GraphEdge, RoutingGraph } from "../../routing";
import { feasibilityCertificate, type FeasibilityQuestion } from "../feasibility";

/**
 * Corners 0 (home), 1, 2, … in a line north, 140 m (100 s) apart, both ways,
 * `shade[i]` on street i–(i+1) in both directions (static unless timeShadow).
 */
function line(shade: Array<number | number[]>): RoutingGraph {
  const nodes = new Map(Array.from({ length: shade.length + 1 }, (_, id) => [id, { id, lat: 40.7 + (id * 140) / 111_320, lon: -74 }] as const));
  const adj = new Map<number, GraphEdge[]>(Array.from({ length: shade.length + 1 }, (_, id) => [id, []]));
  shade.forEach((s, i) => {
    const e = (toId: number): GraphEdge => (Array.isArray(s) ? { toId, distanceM: 140, shadowFactor: s[0], timeShadow: s } : { toId, distanceM: 140, shadowFactor: s });
    adj.get(i)!.push(e(i + 1));
    adj.get(i + 1)!.push(e(i));
  });
  return { nodes, adj };
}
/** A point `m` metres north of home, on the line. */
const at = (m: number): [number, number] => [-74, 40.7 + m / 111_320];
const ask = (over: Partial<FeasibilityQuestion> = {}): FeasibilityQuestion => ({
  start: at(0), target: at(280), sunMin: 5, timeMin: 10, stayMin: 0, departure: "2026-07-01T18:00:00Z", ...over,
});
const meta = { inputVersion: 7, geometryVersion: "nyc-test" };

describe("H6 — feasibility certificates", () => {
  it("feasible: a real outing that stops AT the target, priced walk + stay + home", () => {
    const cert = feasibilityCertificate(line([1, 1]), 0, ask({ stayMin: 2 }), {}, meta);
    expect(cert.status).toBe("feasible");
    const w = cert.witness!;
    expect(w.nodeIds[0]).toBe(0);
    expect(w.nodeIds.at(-1)).toBe(0);
    // The stay is at the target corner (2), not anywhere else on the way.
    expect(w.nodeIds[w.dwell!.atNode]).toBe(2);
    expect(w.dwell!.seconds).toBe(120);
    expect(cert.ledger!.time.usedSec).toBeCloseTo(520, 6);
    expect(cert.ledger!.sun.usedSec).toBeCloseTo(0, 9);
    expect(cert).toMatchObject({ inputVersion: 7, geometryVersion: "nyc-test", modelVersion: "sun-budget-h6-2" });
  });

  it("the stay must happen at the target: a shaded corner past it does not count (review probe)", () => {
    // Target street 0–1 in full sun; 1–2 and 2–3 shaded. Stopping 15 min at the
    // target (corner 1, whose shadiest side is the shaded 1–2) is free; but if
    // the only shade were past it, standing there would not help.
    const sunnyTarget = line([0, 0, 1]);
    // Target at corner 1. Its sidewalks (0–1, 1–2) are both sunny: a 15-min stay there is 900 s of sun.
    const cert = feasibilityCertificate(sunnyTarget, 0, ask({ target: at(140), stayMin: 15, sunMin: 6, timeMin: 30 }), {}, meta);
    expect(cert.status).toBe("infeasible");
    expect(cert.ledger!.sun.binding).toBe(true);
    expect(cert.ledger!.sun.lowerBoundSec).toBeGreaterThan(360);
  });

  it("a mid-block target is half a block, not a whole street (review probe)", () => {
    // Café 70 m into a 140 m block, shaded: 50 s there + 50 s back = 100 s < 120 s.
    const cert = feasibilityCertificate(line([1]), 0, ask({ target: at(70), timeMin: 2, sunMin: 1 }), {}, meta);
    expect(cert.status).toBe("feasible");
    // snapToEdge re-measures the split with haversine: ~99.9 s.
    expect(cert.ledger!.time.usedSec).toBeCloseTo(100, 0);
  });

  it("infeasible, time binds, by proof: least time out + stay + least time home > T", () => {
    const cert = feasibilityCertificate(line([1, 1]), 0, ask({ timeMin: 3 }), {}, meta);
    expect(cert.status).toBe("infeasible");
    expect(cert.ledger!.time).toMatchObject({ binding: true, lowerBoundSec: 400 });
    expect(cert.ledger!.sun.binding).toBe(false);
  });

  it("infeasible, sun binds, by proof — even when the search is capped (review probe)", () => {
    // 400 s there and back in full sun at every bucket > 300 s of sun; a capped search can't hide that.
    const cert = feasibilityCertificate(line([0, 0]), 0, ask({ timeMin: 30 }), { maxLabels: 2 }, meta);
    expect(cert.status).toBe("infeasible");
    expect(cert.ledger!.sun).toMatchObject({ binding: true, lowerBoundSec: 400 });
    expect(cert.ledger!.time.binding).toBe(false);
  });

  it("both budgets can bind; each flag is its own proof", () => {
    const cert = feasibilityCertificate(line([0, 0]), 0, ask({ timeMin: 3 }), {}, meta);
    expect(cert.ledger).toMatchObject({ sun: { binding: true }, time: { binding: true } });
  });

  it("unknown, never no: the bounds fit but the search kept no walk that does", () => {
    // Shade only later: street sunny before 15 min, shaded after. Bounds use
    // the shadiest bucket (fit); a work-capped search keeps no walk at all.
    const ts = [0, 1, 1, 1];
    const cert = feasibilityCertificate(line([ts, ts]), 0, ask({ timeMin: 60, sunMin: 1 }), { timeAware: { bucketMs: 900_000, bucketCount: 4 }, maxLabels: 1 }, meta);
    expect(cert.status).toBe("unknown");
    expect(cert.gap?.reason).toBe("no-kept-walk-fits");
  });

  it("unknown when the bounds fit but every real walk is too sunny (sun is checked on the walk, not only the bound)", () => {
    // Streets sunny before 15 min, shaded after; the whole outing (400 s) ends
    // in bucket 0, so every real walk has 400 s of sun > 60 s. The bound uses
    // the shadiest bucket (0 s) and can't rule it out: honest answer, unknown.
    const ts = [0, 1, 1, 1];
    const cert = feasibilityCertificate(line([ts, ts]), 0, ask({ timeMin: 10, sunMin: 1 }), { timeAware: { bucketMs: 900_000, bucketCount: 4 } }, meta);
    expect(cert.status).toBe("unknown");
    expect(cert.gap?.reason).toBe("no-kept-walk-fits");
  });

  it("a walk out that fits is not enough: the walk home's sun counts too", () => {
    // 100 s buckets, shaded until 300 s, sunny after: [1, 1, 1, 0]. Walking out
    // ends streets at 100 s and 200 s, in shade; home ends them at 300 s (bucket
    // 3: sunny) and 400 s (sunny) — 200 s of sun > 60 s. The bound (shadiest
    // bucket everywhere) is 0, so only pricing the real walk home rules it out.
    const ts = [1, 1, 1, 0];
    const cert = feasibilityCertificate(line([ts, ts]), 0, ask({ timeMin: 10, sunMin: 1 }), { timeAware: { bucketMs: 100_000, bucketCount: 4 } }, meta);
    expect(cert.status).toBe("unknown");
  });

  it("near a clipped data edge, a would-be 'infeasible' is unknown", () => {
    const cert = feasibilityCertificate(line([1, 1]), 0, ask({ timeMin: 3 }), {}, { ...meta, edgeM: 500 });
    expect(cert.status).toBe("unknown");
    expect(cert.gap?.reason).toBe("data-edge");
  });

  it("unreachable: a target on a fragment the streets don't join (review probe)", () => {
    const g = line([1]);
    // A separate path 2–3 far off the line, next to the target.
    g.nodes.set(2, { id: 2, lat: 40.7, lon: -73.9990 });
    g.nodes.set(3, { id: 3, lat: 40.7, lon: -73.9980 });
    g.adj.set(2, [{ toId: 3, distanceM: 84, shadowFactor: 1 }]);
    g.adj.set(3, [{ toId: 2, distanceM: 84, shadowFactor: 1 }]);
    const cert = feasibilityCertificate(g, 0, ask({ target: [-73.9985, 40.7], timeMin: 60, sunMin: 30 }), {}, meta);
    expect(cert.status).toBe("unreachable");
  });

  it("too far vs uncovered: a target far beyond the graph is not 'outside the data'", () => {
    expect(feasibilityCertificate(line([1]), 0, ask({ target: [-73.9, 40.8] }), {}, meta).status).toBe("too-far");
    // Near the start but not within 60 m of any street.
    expect(feasibilityCertificate(line([1]), 0, ask({ target: [-73.9988, 40.7] }), {}, meta).status).toBe("uncovered");
  });

  it("a feasible certificate's used sun re-prices from its own witness: walk + stay + home", () => {
    // 0–1 shaded, 1–2 half shaded; stay 60 s at corner 2 (shadiest side 0.5).
    const cert = feasibilityCertificate(line([1, 0.5]), 0, ask({ sunMin: 10, timeMin: 20, stayMin: 1 }), {}, meta);
    expect(cert.status).toBe("feasible");
    // 1→2 and 2→1, 100 s each at half shade = 100 s; the stay = 30 s.
    expect(cert.ledger!.sun.usedSec).toBeCloseTo(130, 6);
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

  it("the worker builds for the walk, holds shade for the whole outing, and keeps the panel's graph", async () => {
    const { createSunBudgetHandler, SUN_BUDGET_WORKER_PROTOCOL_VERSION: P } = await import("../sunBudgetWorkerProtocol");
    const builds: Array<{ timeBudgetSec: number; horizonSec?: number }> = [];
    const handle = createSunBudgetHandler(async (args) => {
      builds.push({ timeBudgetSec: args.timeBudgetSec, horizonSec: args.horizonSec });
      return { status: "ok", graph: line([1, 1]), startId: 0, startPoint: at(0), timeAware: { bucketMs: 900_000, bucketCount: 4 }, edgeM: null, generation: "nyc-test" };
    });
    const built = await handle({ type: "build", protocol: P, requestId: 1, center: at(0), timeBudgetSec: 1800, departureMs: 0 });
    if (built.type !== "built" || built.built.status !== "ok") throw new Error("not built");
    const answer = await handle({ type: "feasibility", protocol: P, requestId: 2, question: ask({ stayMin: 2, timeMin: 12 }), inputVersion: 3 });
    expect(answer).toMatchObject({ type: "feasibility", certificate: { status: "feasible", inputVersion: 3, geometryVersion: "nyc-test" } });
    // Streets reach (12 − 2) / 2 = 5 min out; shade covers all 12 min.
    expect(builds[1]).toEqual({ timeBudgetSec: 300, horizonSec: 720 });
    const searched = await handle({ type: "search", protocol: P, requestId: 3, graphId: built.built.graphId, options: { sunBudgetSec: 60, timeBudgetSec: 200 } });
    expect(searched.type).toBe("searched");
  });
});

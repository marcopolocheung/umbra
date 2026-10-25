/**
 * H6 — the assistant's "is this possible?" answers come from the certificate.
 * Each status is held out on its own; a sabotaged proposal (the model says
 * "feasible" against an infeasible certificate) must not verify.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agentLoop";
import { callModel, rolesShareConfig } from "../llmClient";
import { feasibilityLabel, type FeasibilityClaimReceipt } from "../receipts";
import { executeTool } from "../tools";
import { makeScenarioContext, runScenario, type HarnessMocks } from "./harness";
import { certificate, outingScenario } from "./scenarios/feasibility";

vi.mock("../llmClient", () => ({ callModel: vi.fn(), rolesShareConfig: vi.fn() }));
vi.mock("../tools", async (importOriginal) => ({ ...(await importOriginal<typeof import("../tools")>()), executeTool: vi.fn() }));
const mocks: HarnessMocks = { callModel: vi.mocked(callModel), rolesShareConfig: vi.mocked(rolesShareConfig), executeTool: vi.mocked(executeTool) };
beforeEach(() => vi.clearAllMocks());

const feasible = certificate("feasible", {
  ledger: { sun: { budgetSec: 480, usedSec: 190, binding: false }, time: { budgetSec: 2700, usedSec: 2280, binding: false } },
});
const infeasible = certificate("infeasible", {
  ledger: { sun: { budgetSec: 480, usedSec: null, binding: true }, time: { budgetSec: 2700, usedSec: null, binding: false } },
});
const unknown = certificate("unknown", { gap: { outcome: "budget-exhausted", undecidedStreets: 41 } });

const verified = async (answer: ReturnType<typeof certificate>, claimed: Parameters<typeof outingScenario>[3]) => {
  const trace = await runScenario(outingScenario(`h6-${answer.status}-${claimed}`, "outing check", answer, claimed), runAgent, mocks);
  expect(trace.toolCalls.map((c) => c.name)).toContain("check_sun_budget");
  return trace.verified!.receipts.filter((r) => r.kind === "feasibility") as FeasibilityClaimReceipt[];
};

describe("H6 — feasibility through the agent loop", () => {
  it("feasible: verifies, and says what the walk found from the certificate", async () => {
    const [r] = await verified(feasible, "feasible");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toBe(
      "Possible: 45 min there and back with a 15-min stop on ≤ 8 min of sun — a walk found does it in 38 min with 4 min of sun",
    );
  });

  it("proven infeasible: verifies and names the budget that rules it out", async () => {
    const [r] = await verified(infeasible, "infeasible");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toMatch(/^Not possible: .* the sun budget is what rules it out$/);
  });

  it("budget-exhausted unknown: verifies as unknown and never as a no", async () => {
    const [r] = await verified(unknown, "unknown");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toMatch(/^Not confirmed either way/);
    expect(feasibilityLabel(r.certificate)).not.toMatch(/Not possible|impossible|can't/i);
  });

  it("cancelled and superseded: verify only as what they are — no answer", async () => {
    for (const status of ["cancelled", "superseded"] as const) {
      const [r] = await verified(certificate(status, { reason: "x" }), status);
      expect(r.verification).toBe("verified");
      expect(feasibilityLabel(r.certificate)).toMatch(/^No answer/);
    }
  });

  it("sabotage: the model claims feasible against an infeasible certificate — the user sees 'not possible'", async () => {
    // The contradictory claim never verifies; the loop rebuilds the answer from
    // the certificate, so what renders is the certificate's verdict.
    const trace = await runScenario(outingScenario("h6-sabotage-yes", "sabotage", infeasible, "feasible"), runAgent, mocks);
    const shown = trace.verified!.receipts.filter((r) => r.kind === "feasibility" && r.verification === "verified") as FeasibilityClaimReceipt[];
    expect(shown.map((r) => r.value.status)).toEqual(["infeasible"]);
    expect(trace.answer).toMatch(/^Not possible/m);
    expect(trace.answer).not.toMatch(/Possible:/);
  });

  it("sabotage: the model upgrades unknown to infeasible — the user sees 'not confirmed', never a no", async () => {
    const trace = await runScenario(outingScenario("h6-sabotage-no", "sabotage", unknown, "infeasible"), runAgent, mocks);
    const shown = trace.verified!.receipts.filter((r) => r.kind === "feasibility" && r.verification === "verified") as FeasibilityClaimReceipt[];
    expect(shown.map((r) => r.value.status)).toEqual(["unknown"]);
    expect(trace.answer).not.toMatch(/Not possible/);
  });

  it("a contradictory claim on its own is rejected by the verifier", async () => {
    const { verifyAnswer } = await import("../receipts");
    const envelope = {
      resultId: "result-1", toolName: "check_sun_budget" as const, producedAt: "2026-07-01T19:00:00Z",
      provenance: { category: "application_state" as const, bounded: true as const }, fieldProvenance: {},
      payload: infeasible as unknown as Record<string, unknown>,
    };
    const answer = verifyAnswer(
      { receipts: [{ claimId: "c", kind: "feasibility", subject: "outing", value: { status: "feasible" }, supportingResultIds: ["result-1"] }] },
      { evidence: [envelope], mapObjects: [], currentPlanRevision: 0, now: "2026-07-01T19:00:00Z" },
    );
    expect(answer.receipts[0]).toMatchObject({ verification: "rejected", rejectionReason: "contradictory_feasibility" });
  });

  it("superseded: an older outing check cannot be the one answered", async () => {
    const { verifyAnswer } = await import("../receipts");
    const env = (id: string, inputVersion: number) => ({
      resultId: id, toolName: "check_sun_budget" as const, producedAt: "2026-07-01T19:00:00Z",
      provenance: { category: "application_state" as const, bounded: true as const }, fieldProvenance: {},
      payload: { ...feasible, inputVersion } as unknown as Record<string, unknown>,
    });
    const answer = verifyAnswer(
      { receipts: [{ claimId: "c", kind: "feasibility", subject: "outing", value: { status: "feasible" }, supportingResultIds: ["old"] }] },
      { evidence: [env("old", 1), env("new", 2)], mapObjects: [], currentPlanRevision: 0, now: "2026-07-01T19:00:00Z" },
    );
    expect(answer.receipts[0]).toMatchObject({ verification: "rejected", rejectionReason: "stale_evidence" });
  });

  it("partial: a target outside the shade data is 'can't check', never yes or no", async () => {
    const [r] = await verified(certificate("uncovered", { reason: "outside the shade table" }), "uncovered");
    expect(feasibilityLabel(r.certificate)).toMatch(/^Can't check/);
  });
});

describe("H6 — the tool executor", () => {
  it("passes the question through, and a newer question supersedes an older one still running", async () => {
    const real = await vi.importActual<typeof import("../tools")>("../tools");
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const seen: number[] = [];
    const ctx = {
      ...makeScenarioContext(),
      checkSunBudget: async (q: Parameters<NonNullable<import("../tools").AgentContext["checkSunBudget"]>>[0], v: number) => {
        seen.push(q.timeMin);
        if (seen.length === 1) await slow;
        return certificate("feasible", { question: q, inputVersion: v });
      },
    } as import("../tools").AgentContext;
    const args = { startLat: 40.75, startLng: -73.98, targetLat: 40.76, targetLng: -73.98, sunMin: 8, timeMin: 45, stayMin: 15 };
    const first = real.executeTool("check_sun_budget", args, ctx);
    const second = await real.executeTool("check_sun_budget", { ...args, timeMin: 60 }, ctx);
    release();
    expect((await first).status).toBe("superseded");
    expect(second.status).toBe("feasible");
    // The stop sits inside the time budget, passed through unchanged.
    expect(seen).toEqual([45, 60]);
  });
});

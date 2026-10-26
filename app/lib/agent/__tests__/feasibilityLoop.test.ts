/**
 * H6 — the assistant's "is this possible?" answers come from the certificate.
 * Each status is held out on its own; sabotaged proposals (a false "feasible",
 * a stale or missing status, a failed check) never render as a verdict.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agentLoop";
import { callModel, rolesShareConfig } from "../llmClient";
import { feasibilityLabel, type FeasibilityClaimReceipt, type ToolResultEnvelope, verifyAnswer } from "../receipts";
import { executeTool } from "../tools";
import { makeScenarioContext, runScenario, type HarnessMocks } from "./harness";
import { CAFE, certificate, outingScenario } from "./scenarios/feasibility";

vi.mock("../llmClient", () => ({ callModel: vi.fn(), rolesShareConfig: vi.fn() }));
vi.mock("../tools", async (importOriginal) => ({ ...(await importOriginal<typeof import("../tools")>()), executeTool: vi.fn() }));
const mocks: HarnessMocks = { callModel: vi.mocked(callModel), rolesShareConfig: vi.mocked(rolesShareConfig), executeTool: vi.mocked(executeTool) };
beforeEach(() => vi.clearAllMocks());

const feasible = certificate("feasible", {
  ledger: { sun: { budgetSec: 480, lowerBoundSec: 100, usedSec: 190, binding: false }, time: { budgetSec: 2700, lowerBoundSec: 1500, usedSec: 2280, binding: false } },
});
const infeasible = certificate("infeasible", {
  ledger: { sun: { budgetSec: 480, lowerBoundSec: 610, usedSec: null, binding: true }, time: { budgetSec: 2700, lowerBoundSec: 1500, usedSec: null, binding: false } },
});
const unknown = certificate("unknown", { gap: { reason: "no-kept-walk-fits", searchOutcome: "budget-exhausted" } });

const verified = async (answer: ReturnType<typeof certificate>, claimed: Parameters<typeof outingScenario>[3]) => {
  const trace = await runScenario(outingScenario(`h6-${answer.status}-${claimed}`, "outing check", answer, claimed), runAgent, mocks);
  expect(trace.toolCalls.map((c) => c.name)).toContain("check_sun_budget");
  return { trace, receipts: trace.verified!.receipts.filter((r) => r.kind === "feasibility") as FeasibilityClaimReceipt[] };
};

const env = (id: string, payload: Record<string, unknown>): ToolResultEnvelope => ({
  resultId: id, toolName: "check_sun_budget", producedAt: "2026-07-01T19:00:00Z",
  provenance: { category: "application_state", bounded: true }, fieldProvenance: {}, payload,
});
const claim = (status: unknown, cite: string) => ({
  receipts: [{ claimId: "c", kind: "feasibility", subject: "outing", value: status === undefined ? {} : { status }, supportingResultIds: [cite] }],
});
const opts = (evidence: ToolResultEnvelope[], current: string[]) => ({ evidence, mapObjects: [], currentPlanRevision: 0, now: "2026-07-01T19:00:00Z", currentFeasibilityResultIds: current });

describe("H6 — feasibility through the agent loop", () => {
  it("feasible: verifies and names the destination, the walk's time and its sun", async () => {
    const { receipts: [r] } = await verified(feasible, "feasible");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toBe(
      `Possible: ${CAFE.name} with a 15-min stop, home within 45 min on ≤ 8 min of sun — a walk found does it in 38 min with 4 min of sun`,
    );
  });

  it("proven infeasible: verifies and states the bound that rules it out", async () => {
    const { receipts: [r] } = await verified(infeasible, "infeasible");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toMatch(/^Not possible: .* any such outing gets at least 11 min of sun$/);
  });

  it("unknown: verifies as unknown and never as a no", async () => {
    const { receipts: [r] } = await verified(unknown, "unknown");
    expect(r.verification).toBe("verified");
    expect(feasibilityLabel(r.certificate)).toMatch(/^Not confirmed either way/);
    expect(feasibilityLabel(r.certificate)).not.toMatch(/Not possible|impossible/i);
  });

  it("no-answer statuses say what they are, never yes or no", async () => {
    const expected: Record<string, RegExp> = {
      cancelled: /^No answer/, superseded: /^No answer/, uncovered: /outside NYC's shade data/,
      unreachable: /isn't joined to the streets/, "too-far": /beyond the walking range/,
    };
    for (const [status, re] of Object.entries(expected)) {
      const { receipts: [r] } = await verified(certificate(status as never, { reason: "x" }), status as never);
      expect(r.verification, status).toBe("verified");
      expect(feasibilityLabel(r.certificate)).toMatch(re);
      expect(feasibilityLabel(r.certificate)).not.toMatch(/^Possible|^Not possible/);
    }
  });

  it("sabotage: a false 'feasible' on an infeasible certificate — the user sees 'Not possible'", async () => {
    const { trace, receipts } = await verified(infeasible, "feasible");
    expect(receipts.filter((r) => r.verification === "verified").map((r) => r.value.status)).toEqual(["infeasible"]);
    expect(trace.answer).toMatch(/^Not possible/m);
    expect(trace.answer).not.toMatch(/^Possible/m);
  });

  it("sabotage: unknown upgraded to infeasible — the user sees 'not confirmed', never a no", async () => {
    const { trace, receipts } = await verified(unknown, "infeasible");
    expect(receipts.filter((r) => r.verification === "verified").map((r) => r.value.status)).toEqual(["unknown"]);
    expect(trace.answer).not.toMatch(/Not possible/);
  });
});

describe("H6 — what a verdict may cite", () => {
  it("a contradictory status is rejected", () => {
    const a = verifyAnswer(claim("feasible", "r1"), opts([env("r1", infeasible as never)], ["r1"]));
    expect(a.receipts[0]).toMatchObject({ verification: "rejected", rejectionReason: "contradictory_feasibility" });
  });

  it("a missing status is rejected, not crashed on (review probe)", () => {
    const a = verifyAnswer(claim(undefined, "r1"), opts([env("r1", infeasible as never)], ["r1"]));
    expect(a.receipts[0]).toMatchObject({ verification: "rejected" });
  });

  it("a failed check is no evidence for a verdict (review probe)", () => {
    const a = verifyAnswer(claim(undefined, "r1"), opts([env("r1", { error: "The Sun Budget search failed." })], ["r1"]));
    expect(a.receipts[0].verification).toBe("rejected");
  });

  it("a malformed certificate is rejected, never rendered (no question to word it from)", () => {
    const a = verifyAnswer(claim("feasible", "r1"), opts([env("r1", { status: "feasible", inputVersion: 1 })], ["r1"]));
    expect(a.receipts[0].verification).toBe("rejected");
  });

  it("an earlier turn's certificate cannot answer this turn (review probe)", () => {
    const a = verifyAnswer(claim("feasible", "r1"), opts([env("r1", feasible as never)], []));
    expect(a.receipts[0]).toMatchObject({ verification: "rejected", rejectionReason: "stale_evidence" });
  });

  it("a newer check of the same place supersedes; a check of another place does not (review probe)", () => {
    const other = { ...feasible, inputVersion: 2, question: { ...feasible.question, target: [-73.99, 40.75] } };
    const same = { ...feasible, inputVersion: 3 };
    // Café A (v1) then café B (v2): A still answers.
    expect(verifyAnswer(claim("feasible", "r1"), opts([env("r1", feasible as never), env("r2", other as never)], ["r1", "r2"])).receipts[0].verification).toBe("verified");
    // Café A asked again (v3): the first answer is stale.
    expect(verifyAnswer(claim("feasible", "r1"), opts([env("r1", feasible as never), env("r3", same as never)], ["r1", "r3"])).receipts[0]).toMatchObject({ rejectionReason: "stale_evidence" });
  });
});

describe("H6 — the tool executor", () => {
  it("passes the question through as asked, and a newer question supersedes an older one still running", async () => {
    const real = await vi.importActual<typeof import("../tools")>("../tools");
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const seen: Array<{ timeMin: number; stayMin: number; sunMin: number; targetLabel?: string }> = [];
    const ctx = {
      ...makeScenarioContext(),
      checkSunBudget: async (q: Parameters<NonNullable<import("../tools").AgentContext["checkSunBudget"]>>[0], v: number) => {
        seen.push({ timeMin: q.timeMin, stayMin: q.stayMin, sunMin: q.sunMin, targetLabel: q.targetLabel });
        if (seen.length === 1) await slow;
        return certificate("feasible", { question: q, inputVersion: v });
      },
    } as import("../tools").AgentContext;
    const args = { startLat: 40.75, startLng: -73.98, targetLat: 40.76, targetLng: -73.98, sunMin: 8, timeMin: 45, stayMin: 15, targetLabel: CAFE.name };
    const first = real.executeTool("check_sun_budget", args, ctx);
    const second = await real.executeTool("check_sun_budget", { ...args, timeMin: 60 }, ctx);
    release();
    expect((await first).status).toBe("superseded");
    expect(second.status).toBe("feasible");
    expect(seen).toEqual([
      { timeMin: 45, stayMin: 15, sunMin: 8, targetLabel: CAFE.name },
      { timeMin: 60, stayMin: 15, sunMin: 8, targetLabel: CAFE.name },
    ]);
  });
});

/**
 * C1 — the agent eval harness.
 *
 * Replays every scenario in `scenarios/` through the real `runAgent` with the
 * model and the tool executors stubbed, and asserts on the resulting trace.
 * No network, no key, no clock: the same input always produces the same trace.
 *
 * The last describe block is the harness's own test — it sabotages the loop and
 * asserts the checks above go red. A grounding suite that cannot fail is
 * decoration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agentLoop";
import { callModel, rolesShareConfig } from "../llmClient";
import { executeTool, toolDeclarations } from "../tools";
import {
  groundingViolations,
  researchPrompt,
  runScenario,
  writePrompt,
  type HarnessMocks,
  type RunAgentFn,
  type Scenario,
  type Trace,
} from "./harness";
import { scenarios } from "./scenarios";
import {
  askedRouteIsCalculated,
  emptySearchIsReformulated,
  searchingClosesAfterFour,
  sharedModelSkipsWriteCall,
} from "./scenarios/budget";
import {
  emptySearchInventsNothing,
  followUpTurnKnowsEarlierPins,
  toolErrorStaysHonest,
} from "./scenarios/grounding";
import { fallbackPlotWhenModelForgets, happyPathShadowedAfternoon } from "./scenarios/planning";

vi.mock("../llmClient", () => ({
  callModel: vi.fn(),
  rolesShareConfig: vi.fn(),
}));

vi.mock("../tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools")>()),
  executeTool: vi.fn(),
}));

const mocks: HarnessMocks = {
  callModel: vi.mocked(callModel),
  rolesShareConfig: vi.mocked(rolesShareConfig),
  executeTool: vi.mocked(executeTool),
};

/** Mirrors `MAX_STEPS` in agentLoop.ts, which is deliberately not exported. */
const MAX_RESEARCH_STEPS = 8;

const run = (scenario: Scenario, sabotage?: Parameters<typeof runScenario>[3]) =>
  runScenario(scenario, runAgent, mocks, sabotage);

beforeEach(() => {
  vi.clearAllMocks();
});

/** Tool results in the threaded history with no preceding matching call. */
function orphanedToolResponses(trace: Trace): string[] {
  const orphans: string[] = [];
  let offered: string[] = [];
  for (const content of trace.history) {
    const calls = content.parts.flatMap((p) => (p.functionCall ? [p.functionCall.name] : []));
    const responses = content.parts.flatMap((p) =>
      p.functionResponse ? [p.functionResponse.name] : []
    );
    for (const name of responses) {
      const at = offered.indexOf(name);
      if (at === -1) orphans.push(name);
      else offered.splice(at, 1);
    }
    if (calls.length) offered = calls;
  }
  return orphans;
}


describe("agent scenarios", () => {
  it("covers at least fifteen scenarios with unique ids", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
  });

  it("only scripts tools the model is actually offered", () => {
    const declared = new Set(toolDeclarations.map((t) => t.name));
    for (const scenario of scenarios) {
      for (const turn of scenario.script) {
        if (!("calls" in turn)) continue;
        for (const call of turn.calls) {
          expect(declared, `${scenario.id} calls ${call.name}`).toContain(call.name);
        }
      }
    }
    // get_current_context is pre-injected, never offered as a tool.
    expect(declared).not.toContain("get_current_context");
  });

  describe.each(scenarios.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
    it(scenario.intent, async () => {
      const trace = await run(scenario);

      expect(trace.toolCalls.map((c) => c.name)).toEqual(scenario.expect.toolOrder);
      expect(trace.answer).toBe(scenario.expect.answer);
      expect(groundingViolations(trace, scenario)).toEqual([]);

      if (scenario.expect.pinLabels) {
        expect(trace.plottedPins.map((p) => p.label)).toEqual(scenario.expect.pinLabels);
      }
      if (scenario.expect.pinCount != null) {
        expect(trace.plottedPins).toHaveLength(scenario.expect.pinCount);
      }

      // Budgets: the free tier is 5 requests/minute, so round-trips are scarce.
      expect(trace.llmRequests.length).toBeLessThanOrEqual(scenario.maxLlmCalls);
      expect(trace.toolCalls.length).toBeLessThanOrEqual(scenario.maxToolCalls);

      const researchCalls = trace.llmRequests.filter((r) => r.tools).length;
      expect(researchCalls).toBeLessThanOrEqual(MAX_RESEARCH_STEPS);

      // The map context costs no round-trip and is read exactly once per turn.
      expect(trace.contextReads).toBe(1);
      expect(researchPrompt(trace)).toContain("Live map context");

      // Every tool the loop ran was surfaced to the UI.
      expect(trace.toolEvents).toEqual(trace.toolCalls.map((c) => c.name));

      // The write call is tool-free, so a reasoning model can't narrate calls.
      if (trace.writeIndex >= 0) {
        expect(trace.llmRequests[trace.writeIndex].tools).toBeUndefined();
      }

      // Threaded history must stay well-formed: every tool result is answering a
      // call the model actually made in the turn before it. An orphaned
      // functionResponse is rejected by the OpenAI wire format llmClient emits.
      expect(orphanedToolResponses(trace)).toEqual([]);
      // ...and the turn the next request starts from is not an unanswered call.
      expect(trace.history.at(-1)?.parts.some((p) => p.functionCall)).toBe(false);
    });
  });
});

describe("plot-before-answer guarantee", () => {
  it("tells the write call exactly which pins reached the map", async () => {
    const trace = await run(fallbackPlotWhenModelForgets);
    const prompt = writePrompt(trace);
    expect(prompt).toContain("Map state guarantee");
    expect(prompt).toContain("1. Bryant Park (40.75360, -73.98320)");
    expect(prompt).toContain("2. Grace Plaza (40.75200, -73.98500)");
  });

  it("tells the write call about pins the model plotted for itself", async () => {
    const trace = await run(happyPathShadowedAfternoon);
    expect(writePrompt(trace)).toContain("1. Bryant Park (40.75360, -73.98320)");
  });

  it("tells a follow-up turn's write call about the pins an earlier turn left", async () => {
    const trace = await run(followUpTurnKnowsEarlierPins);
    const prompt = writePrompt(trace);
    expect(prompt).toContain("1. Bryant Park (40.75360, -73.98320)");
    expect(prompt).not.toContain("Nothing is pinned");
  });

  it("skips the write call entirely on the shared-model path", async () => {
    const trace = await run(sharedModelSkipsWriteCall);
    expect(trace.writeIndex).toBe(-1);
    expect(trace.llmRequests).toHaveLength(2);
  });
});

describe("tool results reach the model", () => {
  it("feeds a tool error back rather than swallowing it", async () => {
    const trace = await run(toolErrorStaysHonest);
    const responses = trace.history
      .flatMap((c) => c.parts)
      .flatMap((p) => (p.functionResponse ? [p.functionResponse] : []));
    const shadow = responses.find((r) => r.name === "check_shadow");
    expect(shadow?.response.error).toBe("No building geometry loaded for that area.");
  });

  it("plots nothing when a search comes back empty", async () => {
    const trace = await run(emptySearchInventsNothing);
    expect(trace.toolCalls.map((c) => c.name)).not.toContain("plot_points");
    expect(trace.plottedPins).toEqual([]);
  });
});

describe("route guarantee", () => {
  it("routes from the first pin to the last, through the rest, before the write call", async () => {
    const trace = await run(askedRouteIsCalculated);
    const route = trace.toolCalls.find((c) => c.name === "plan_shadowed_route");
    expect(route?.args).toMatchObject({
      fromLabel: "Bryant Park",
      toLabel: "Paley Park",
      via: [{ label: "Grace Plaza" }],
    });
    expect(route!.afterLlmCall).toBeLessThan(trace.writeIndex);
    expect(writePrompt(trace)).toContain("route");
  });
});

describe("search budget", () => {
  const offersSearch = (trace: Trace) =>
    trace.llmRequests
      .filter((r) => r.tools)
      .map((r) => r.tools![0].functionDeclarations.some((d) => d.name === "search_places"));

  it("keeps offering search for reformulations, then closes after four", async () => {
    expect(offersSearch(await run(searchingClosesAfterFour))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("answers an empty search with a reformulation steer, not a dead end", async () => {
    const trace = await run(emptySearchIsReformulated);
    const first = trace.history
      .flatMap((c) => c.parts)
      .find((p) => p.functionResponse?.name === "search_places");
    expect(first?.functionResponse?.response.results).toEqual([]);
    expect(String(first?.functionResponse?.response.note)).toMatch(/different/);
    expect(trace.toolCalls.map((c) => c.name)).toEqual([
      "search_places",
      "search_places",
      "plot_points",
    ]);
  });
});

describe("session tool cache", () => {
  it("answers a later turn's identical geocode from the cache, not the geocoder", async () => {
    const cache = new Map<string, Record<string, unknown>>();
    const withCache: RunAgentFn = (o) => runAgent({ ...o, cache });
    const scenario: Scenario = {
      ...sharedModelSkipsWriteCall,
      id: "geocode-twice",
      tools: {
        geocode_place: { results: [{ name: "Bryant Park", lat: 40.7536, lng: -73.9832 }] },
        plot_points: { ok: true, plotted: 1 },
      },
      script: [
        { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
        { text: "Use Bryant Park first." },
      ],
    };

    const first = await runScenario(scenario, withCache, mocks);
    const second = await runScenario(scenario, withCache, mocks);

    expect(first.toolCalls.map((c) => c.name)).toEqual(["geocode_place", "plot_points"]);
    expect(second.toolCalls.map((c) => c.name)).toEqual(["plot_points"]);
    // The model still gets the result, and the place still reaches the map.
    const response = second.history
      .flatMap((c) => c.parts)
      .find((p) => p.functionResponse?.name === "geocode_place");
    expect(response?.functionResponse?.response.results).toHaveLength(1);
    expect(second.plottedPins.map((p) => p.label)).toEqual(["Bryant Park"]);
  });
});

// ---------------------------------------------------------------------------
// The harness's own teeth. Each of these breaks the loop on purpose and asserts
// the checks above catch it — otherwise the suite is green for no reason.
// ---------------------------------------------------------------------------

describe("harness teeth", () => {
  it("catches a loop whose pins never reach the map", async () => {
    const trace = await run(fallbackPlotWhenModelForgets, "plotting-fails");
    expect(trace.plottedPins).toEqual([]);
    expect(groundingViolations(trace, fallbackPlotWhenModelForgets)).toEqual([
      'answer names "Bryant Park" but it was never plotted',
      'answer names "Grace Plaza" but it was never plotted',
      "answered without plotting the itinerary first",
    ]);
    expect(writePrompt(trace)).not.toContain("Map state guarantee");
  });

  it("catches an answer that names a place no tool returned", async () => {
    const trace = await run(emptySearchInventsNothing, "answer-invents-place");
    expect(groundingViolations(trace, emptySearchInventsNothing)).toEqual([
      'answer names "Willow Court Café" but it was never plotted',
    ]);
  });

  it("catches a plotted itinerary that the sabotage left unplotted mid-plan", async () => {
    // A failed plot doesn't end research, so the model gets one more turn.
    const { script } = happyPathShadowedAfternoon;
    const scenario = {
      ...happyPathShadowedAfternoon,
      script: [...script.slice(0, -1), { text: "draft answer from the research model" }, ...script.slice(-1)],
    };
    const trace = await run(scenario, "plotting-fails");
    expect(groundingViolations(trace, scenario)).toContain(
      "answered without plotting the itinerary first"
    );
  });
});

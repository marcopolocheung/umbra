/**
 * Scenario harness for the agent loop (Track C, C1).
 *
 * A scenario is a script of model turns plus a table of tool results. The
 * harness replays them through `runAgent` and records a *trace* — which tools
 * ran, in what order, with what arguments, which pins reached the map, and what
 * the write call was told. Scenarios then assert on that trace.
 *
 * The rule that keeps this suite worth having: **assert behavior, never prose.**
 * The model's words are fixtures we wrote; only the loop's decisions are under
 * test. The one string assertion allowed is "which scripted turn came back",
 * which checks the loop returned the write answer rather than a research draft.
 *
 * No network, no key, no clock dependence — the mocks are injected by the test
 * file (vi.mock is hoisted per-file, so it cannot live here).
 */
import type { LlmContent, LlmRequest, LlmResponse, ModelRole } from "../llmClient";
import type { AgentContext, AssistantPin } from "../tools";
import type { RoutePlan } from "../../routePlanJob";

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

/** One scripted model turn — one `callModel` round-trip. */
export type ScriptedTurn =
  | { calls: { name: string; args?: Record<string, unknown> }[] }
  | { text: string }
  /** The model returned nothing (safety block or an empty candidate list). */
  | { blocked: string }
  | { empty: true };

export type ToolStub =
  | Record<string, unknown>
  | ((args: Record<string, unknown>) => Record<string, unknown>);

export interface Scenario {
  /** kebab-case id; used as the test name. */
  id: string;
  /** One line: the behavior this scenario pins down. */
  intent: string;
  userText: string;
  /** true → research and response resolve to one model (the fast path). */
  sharedModel?: boolean;
  /** Model turns, replayed in order. */
  script: ScriptedTurn[];
  /** Tool results by name. A name with no stub returns an error result. */
  tools?: Record<string, ToolStub>;
  /** Pins an earlier turn left on the map. */
  mapPins?: AssistantPin[];
  /** Overrides for the pre-injected map context (defaults to a located map). */
  context?: Record<string, unknown>;
  /** Place names the stubbed tools genuinely returned. */
  grounded?: string[];
  /** Place names no tool returned — the invention this scenario baits. */
  decoys?: string[];
  /** Budget: LLM round-trips. `MAX_STEPS` is 8, so research alone never exceeds it. */
  maxLlmCalls: number;
  /** Budget: tool executions, excluding the pre-injected context read. */
  maxToolCalls: number;
  expect: {
    /** The exact ordered tool executions, context read excluded. */
    toolOrder: string[];
    /** true → a successful plot_points must precede the write call. */
    plotsBeforeWrite: boolean;
    /** Pin labels that reached the map, in order. Omit to skip. */
    pinLabels?: (string | undefined)[];
    /** How many pins reached the map, when their labels don't matter. */
    pinCount?: number;
    /** Which scripted text the loop must return. */
    answer: string;
  };
}

/**
 * A geocoder over a fixed gazetteer: a query naming one of `places` finds it.
 * Scripts pass coordinates straight to the tools they call; a real model looks
 * the user's places up first, so a scenario whose user names a place should be
 * able to answer that lookup.
 */
export function gazetteer(places: { name: string; lat: number; lng: number }[]): ToolStub {
  return (args) => {
    const query = String(args.query ?? "").toLowerCase();
    const results = places.filter((p) => query.includes(p.name.toLowerCase()));
    return results.length > 0 ? { results } : { results: [], note: "No matches found." };
  };
}

/** Deliberate breakage, used to prove the harness's checks have teeth. */
export type Sabotage =
  /** Plotting always fails — nothing reaches the map. */
  | "plotting-fails"
  /** The final answer names a place no tool ever returned. */
  | "answer-invents-place";

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export interface TracedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  /** Index of the LLM request this call followed. */
  afterLlmCall: number;
}

export interface Trace {
  /** Every `callModel` request, in order. */
  llmRequests: LlmRequest[];
  /** Index of the tool-free write request, or -1 if the loop skipped it. */
  writeIndex: number;
  /** Tool executions, excluding the pre-injected `get_current_context` read. */
  toolCalls: TracedToolCall[];
  /** How many times the loop read the pre-injected context. */
  contextReads: number;
  /** Tool names surfaced to the UI via `onToolEvent`. */
  toolEvents: string[];
  /** Pins on the map at the end: the last successful `plot_points`, else the scenario's `mapPins`. */
  plottedPins: AssistantPin[];
  answer: string;
  history: LlmContent[];
}

/** The system prompt handed to the final, tool-free write call ("" if skipped). */
export function writePrompt(trace: Trace): string {
  if (trace.writeIndex < 0) return "";
  return trace.llmRequests[trace.writeIndex].systemInstruction?.parts[0].text ?? "";
}

/** Every system prompt the loop sent, joined — for context-injection checks. */
export function researchPrompt(trace: Trace): string {
  const req = trace.llmRequests[0];
  return req?.systemInstruction?.parts[0].text ?? "";
}

/** Each pin's label and its first comma segment — "Bryant Park, Midtown" pins "Bryant Park". */
function pinLabelSet(pins: AssistantPin[]): string[] {
  return pins.flatMap((p) => (p.label ? [p.label, p.label.split(",")[0].trim()] : []));
}

/**
 * The grounding check: every place named in the answer must have reached the
 * map as a pin, and a successful plot must precede the write call when the
 * scenario gathered anything to plot.
 *
 * Only names the scenario declared (`grounded` + `decoys`) are searched for, so
 * this never degrades into matching on wording.
 */
export function groundingViolations(trace: Trace, scenario: Scenario): string[] {
  const violations: string[] = [];
  const labels = pinLabelSet(trace.plottedPins);
  const vocabulary = [...(scenario.grounded ?? []), ...(scenario.decoys ?? [])];

  for (const place of vocabulary) {
    if (!trace.answer.includes(place)) continue;
    if (!labels.includes(place)) {
      violations.push(`answer names "${place}" but it was never plotted`);
    }
  }

  if (scenario.expect.plotsBeforeWrite) {
    const plotted = trace.toolCalls.some(
      (c) =>
        c.name === "plot_points" &&
        !c.result.error &&
        (trace.writeIndex < 0 || c.afterLlmCall < trace.writeIndex)
    );
    if (!plotted) violations.push("answered without plotting the itinerary first");
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The slice of a vitest mock the harness uses, typed off the real signature. */
interface Stubbable<F> {
  mockImplementation(fn: F): unknown;
}

export interface HarnessMocks {
  callModel: Stubbable<typeof import("../llmClient").callModel>;
  rolesShareConfig: Stubbable<typeof import("../llmClient").rolesShareConfig>;
  executeTool: Stubbable<typeof import("../tools").executeTool>;
}

export type RunAgentFn = (opts: {
  history: LlmContent[];
  pins?: AssistantPin[];
  userText: string;
  ctx: AgentContext;
  onToolEvent?: (e: { name: string; args: Record<string, unknown> }) => void;
}) => Promise<{ text: string; history: LlmContent[] }>;

const DEFAULT_CONTEXT = {
  center: { lat: 40.7536, lng: -73.9832 },
  zoom: 14,
  localTime: "2:00 PM",
  sunIntensity: 0.8,
  locationKnown: true,
  userLocation: null,
};

/** A context of inert handles — every scenario stubs `executeTool` anyway. */
export function makeScenarioContext(): AgentContext {
  const noop = () => {};
  let version = 0;
  return {
    mapRef: { current: null },
    shadowLayerRef: { current: null },
    dateRef: { current: new Date("2026-08-08T18:00:00Z") },
    setDate: noop,
    getUtcOffsetMin: () => 0,
    getUserLocation: () => null,
    setWaypointA: noop,
    setWaypointB: noop,
    setAdditionalWaypoints: noop,
    createRoutePlanRequest: (plan: RoutePlan) => ({
      requestId: `scenario-route-${version + 1}`,
      inputVersion: ++version,
      planRevision: version,
      actionId: `scenario-action-${version}`,
      retry: 0,
      idempotencyKey: `scenario:${version}`,
      plan,
    }),
    submitRoutePlan: async () => ({
      requestId: "scenario-route",
      inputVersion: 1,
      planRevision: 1,
      actionId: "scenario-action",
      retry: 0,
      idempotencyKey: "scenario",
      status: "completed" as const,
      metrics: [{ label: "Shortest", distanceM: 100, shadowCoverage: 0.5 }],
      shadowProvenance: null,
    }),
    cancelRoutePlan: () => false,
    setPins: noop,
  };
}

function turnToResponse(turn: ScriptedTurn): LlmResponse {
  if ("blocked" in turn) return { promptFeedback: { blockReason: turn.blocked } };
  if ("empty" in turn) return { candidates: [] };
  if ("text" in turn) {
    return { candidates: [{ content: { role: "model", parts: [{ text: turn.text }] } }] };
  }
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: turn.calls.map((c) => ({
            functionCall: { name: c.name, args: c.args ?? {} },
          })),
        },
      },
    ],
  };
}

/** Where the model's replies come from: the scenario's script, or a real model. */
type Responder = (req: LlmRequest, role?: ModelRole) => Promise<LlmResponse>;

export async function runScenario(
  scenario: Scenario,
  runAgent: RunAgentFn,
  mocks: HarnessMocks,
  sabotage?: Sabotage
): Promise<Trace> {
  const script = [...scenario.script];
  if (sabotage === "answer-invents-place") {
    // Name the scenario's own decoy — the place it declared no tool returns.
    const invented = scenario.decoys?.[0];
    if (!invented) {
      throw new Error(`scenario "${scenario.id}" has no decoy to invent`);
    }
    for (let i = script.length - 1; i >= 0; i--) {
      const turn = script[i];
      if ("text" in turn) {
        script[i] = { text: `${turn.text} Then stop at ${invented}.` };
        break;
      }
    }
  }

  let cursor = 0;
  const scripted: Responder = async () => {
    const turn = script[cursor++];
    if (!turn) {
      throw new Error(
        `scenario "${scenario.id}": the loop made ${cursor} model calls but only ` +
          `${script.length} were scripted`
      );
    }
    return turnToResponse(turn);
  };
  return replay(scenario, runAgent, mocks, scripted, sabotage);
}

/**
 * The same replay against a real model: the scenario's tools and map context,
 * but every model turn comes from `callModel` itself. The script is ignored, so
 * the trace shows what a real model does with the world the scenario describes.
 */
export function runLiveScenario(
  scenario: Scenario,
  runAgent: RunAgentFn,
  mocks: HarnessMocks,
  realCallModel: Responder
): Promise<Trace> {
  return replay(scenario, runAgent, mocks, realCallModel);
}

async function replay(
  scenario: Scenario,
  runAgent: RunAgentFn,
  mocks: HarnessMocks,
  respond: Responder,
  sabotage?: Sabotage
): Promise<Trace> {
  const trace: Trace = {
    llmRequests: [],
    writeIndex: -1,
    toolCalls: [],
    contextReads: 0,
    toolEvents: [],
    plottedPins: scenario.mapPins ?? [],
    answer: "",
    history: [],
  };

  mocks.callModel.mockImplementation(async (req: LlmRequest, role?: ModelRole) => {
    const index = trace.llmRequests.length;
    trace.llmRequests.push(req);
    if (!req.tools) trace.writeIndex = index;
    return respond(req, role);
  });

  mocks.rolesShareConfig.mockImplementation(() => scenario.sharedModel === true);

  mocks.executeTool.mockImplementation(async (name, args) => {
    if (name === "get_current_context") {
      trace.contextReads++;
      return { ...DEFAULT_CONTEXT, ...scenario.context };
    }
    const record = (result: Record<string, unknown>) => {
      trace.toolCalls.push({ name, args, result, afterLlmCall: trace.llmRequests.length - 1 });
      return result;
    };
    if (name === "plot_points" && sabotage === "plotting-fails") {
      return record({ error: "Map not ready yet." });
    }
    const stub = scenario.tools?.[name];
    const result = record(
      typeof stub === "function" ? stub(args) : (stub ?? { error: `No stub for ${name}.` })
    );
    if (name === "plot_points" && !result.error) {
      trace.plottedPins = (args.points as AssistantPin[]) ?? [];
    }
    return result;
  });

  const { text, history } = await runAgent({
    history: [],
    pins: scenario.mapPins,
    userText: scenario.userText,
    ctx: makeScenarioContext(),
    onToolEvent: (e) => trace.toolEvents.push(e.name),
  });
  trace.answer = text;
  trace.history = history;
  return trace;
}

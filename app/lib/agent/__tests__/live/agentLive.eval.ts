/**
 * The live eval — the C1 scenarios against a real model. `npm run eval:agent`.
 *
 * Each scenario keeps its world (stubbed tools, map context) and drops its
 * script: every model turn comes from the real `callModel`, through the real
 * OpenAI translation, tool-call salvage and retry logic in llmClient.ts. Only
 * the network hop is redirected here, from the dev proxy path straight to
 * Gemini with the app's own key pool. The hermetic suite proves the loop handles the turns we scripted; this
 * proves the turns we scripted are the turns a model actually takes.
 *
 * A grounding violation fails the scenario. Everything else — did the model
 * follow the scripted tool path, stay in budget, hit a tool the scenario never
 * stubbed — is measured and reported, because a real model is allowed to take
 * another route to a grounded answer.
 */
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../agentLoop";
import { callModel, rolesShareConfig } from "../../llmClient";
import { executeTool } from "../../tools";
import {
  chosenTool,
  groundingViolations,
  proposedTools,
  runLiveScenario,
  type HarnessMocks,
  type Scenario,
  type ToolStub,
  type Trace,
} from "../harness";
import { scenarios } from "../scenarios";
import { normalizeShadeToolArgs, shadeQueryFromArgs } from "../../tools";
import type { ShadeCandidate } from "../../shadeWindows";
import { findShadeSpots } from "../../../navigationData/shadeSpotsSource";
import { findSimilarShadeSpots } from "../../../navigationData/shadeSimilaritySource";

vi.mock("../../llmClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../llmClient")>()),
  callModel: vi.fn(),
  rolesShareConfig: vi.fn(),
}));

vi.mock("../../tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools")>();
  // A4 ablation: AGENT_EVAL_ABLATE=find_shade_spots removes the tool from what the
  // model is offered, so it must fall back to the remaining tools.
  const ablated = (process.env.AGENT_EVAL_ABLATE ?? "").split(",").filter(Boolean);
  return {
    ...actual,
    toolDeclarations: actual.toolDeclarations.filter((t) => !ablated.includes(t.name)),
    executeTool: vi.fn(),
  };
});

const real = await vi.importActual<typeof import("../../llmClient")>("../../llmClient");

// A4: shade scenarios read the published table through the production Worker
// (read-only, no key). The tool's own argument handling is the app's.
const NAVIGATION_BASE =
  process.env.AGENT_EVAL_NAVIGATION_BASE ??
  "https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev";
vi.stubEnv("VITE_NAVIGATION_BASE", NAVIGATION_BASE);
const liveShadeCandidates: ShadeCandidate[] = [];
const liveShadeTool: ToolStub = async (args) => {
  const reference = liveShadeCandidates.find((c) => c.spot.candidateId === args.likeCandidateId);
  const query = shadeQueryFromArgs(
    normalizeShadeToolArgs(args, new Date("2026-08-08T18:00:00Z"), liveShadeCandidates),
  );
  if (!query) return { status: "unavailable", reason: "invalid_query", results: [] };
  const result = reference
    ? await findSimilarShadeSpots(reference.spot, query)
    : await findShadeSpots(query);
  if (result.status === "ok")
    for (const spot of result.results)
      liveShadeCandidates.push({
        spot,
        requestedDate: result.requestedDate,
        requestedWindow: result.requestedWindow,
        mode: result.mode,
      });
  return { ...result };
};

const mocks: HarnessMocks = {
  callModel: vi.mocked(callModel),
  rolesShareConfig: vi.mocked(rolesShareConfig),
  executeTool: vi.mocked(executeTool),
};

// ---------------------------------------------------------------------------
// Transport: llmClient posts to the dev proxy path; send it upstream instead.
// ---------------------------------------------------------------------------

/** Gemini's free tier caps requests per minute per key; spacing calls spares the 429 retries. */
const MIN_GAP_MS = 2000;

const usage = { requests: 0, input: 0, output: 0, models: new Set<string>() };
/** Wall-clock milliseconds per request, by model — where a slow turn's time goes. */
const latencyMs = new Map<string, number[]>();

// Compare models without touching .env: override either role for this run.
if (process.env.AGENT_EVAL_RESEARCH_MODEL) {
  vi.stubEnv("VITE_GEMINI_RESEARCH_MODEL", process.env.AGENT_EVAL_RESEARCH_MODEL);
}
if (process.env.AGENT_EVAL_RESPONSE_MODEL) {
  vi.stubEnv("VITE_GEMINI_RESPONSE_MODEL", process.env.AGENT_EVAL_RESPONSE_MODEL);
}

/** Non-2xx provider replies, with the model asked for — never the key. */
const providerErrors: string[] = [];
const requestedModels = new Set<string>();
const realFetch = globalThis.fetch;
let lastRequestAt = 0;

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  // A4: the shade tool reads the published table from the delivery Worker.
  if (url.startsWith(`${NAVIGATION_BASE}/`)) return realFetch(input, init);
  if (!url.startsWith("/__gemini/")) throw new Error(`live eval: unexpected fetch to ${url}`);

  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const requested = (JSON.parse(String(init?.body)) as { model?: string }).model ?? "?";
  requestedModels.add(requested);
  const startedAt = Date.now();
  const res = await realFetch(
    `https://generativelanguage.googleapis.com${url.slice("/__gemini".length)}`,
    init,
  );
  latencyMs.set(requested, [...(latencyMs.get(requested) ?? []), Date.now() - startedAt]);

  usage.requests++;
  if (!res.ok) {
    const detail = (
      await res
        .clone()
        .text()
        .catch(() => "")
    ).slice(0, 300);
    providerErrors.push(`HTTP ${res.status} for ${requested}: ${detail}`);
  }
  const data = (await res
    .clone()
    .json()
    .catch(() => ({}))) as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  usage.input += data.usage?.prompt_tokens ?? 0;
  usage.output += data.usage?.completion_tokens ?? 0;
  if (data.model) usage.models.add(data.model);
  return res;
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Premised on a provider failure — no real model can be asked to produce one. */
const SCRIPT_ONLY = new Set([
  "blocked-prompt-degrades",
  "empty-research-falls-through-to-write",
  "empty-write-says-so",
]);

const only = (process.env.AGENT_EVAL_ONLY ?? "").split(",").filter(Boolean);
const liveScenarios = scenarios.filter(
  (s) => !SCRIPT_ONLY.has(s.id) && (only.length === 0 || only.includes(s.id)),
);

/**
 * A real model fills gaps a script never has to: it calls tools the scenario
 * didn't stub. An unstubbed tool returning an error sends it into retries that
 * say more about the fixture than the model, so live runs get a neutral world
 * for the rest — one that never invents a place (searches come back empty).
 * The scenario's own stubs win.
 */
const DEFAULT_WORLD: Scenario["tools"] = {
  locate_user: { lat: 40.7536, lng: -73.9832, note: "Centered the map on the user's location." },
  geocode_place: { results: [], note: "No matches found." },
  search_places: {
    results: [],
    note: "No matches in that area. Try a broader query or a different anchor.",
  },
  check_shadow: (args) => {
    const probe = { shadowFraction: 0.5, status: "partial sun", atLocalTime: "2:00 PM" };
    return Array.isArray(args.points)
      ? { results: args.points.map((p: Record<string, unknown>) => ({ ...p, ...probe })) }
      : probe;
  },
  set_time: (args) => ({ ok: true, newLocalTime: String(args.time ?? "2:00 PM") }),
  plot_points: (args) => ({
    ok: true,
    plotted: Array.isArray(args.points) ? args.points.length : 0,
  }),
  plan_shadowed_route: { ok: true, note: "Route calculation started and will draw on the map." },
};

/**
 * Places a model knows are near the default map centre (Midtown Manhattan)
 * without any tool telling it. A script never names one unprompted; a real
 * model does — the pre-C2 loop answered an empty café search with "head to
 * Bryant Park". Naming one that isn't pinned is the invention the name check
 * exists to catch, so every live scenario watches for them.
 */
const NEARBY_LANDMARKS = [
  "Bryant Park",
  "Grace Plaza",
  "Madison Square Park",
  "Times Square",
  "Herald Square",
  "Grand Central",
  "New York Public Library",
  "Empire State Building",
  "Greeley Square",
  "Paley Park",
  "Rockefeller Center",
];

function forLive(scenario: Scenario): Scenario {
  return {
    ...scenario,
    tools: { ...DEFAULT_WORLD, ...scenario.tools, find_shade_spots: liveShadeTool },
    // Echoing a place the user named ("I couldn't find X") is not an invention.
    decoys: [
      ...(scenario.decoys ?? []),
      ...NEARBY_LANDMARKS.filter((name) => !scenario.userText.includes(name)),
    ],
  };
}

interface Row {
  id: string;
  sharedModel: boolean;
  violations: string[];
  /** plot_points calls the model made, and ones the loop made for it (fallback, reconcile). */
  modelPlots: number;
  loopPlots: number;
  followedScript: boolean;
  expectedTools: string[];
  actualTools: string[];
  llmCalls: number;
  llmBudget: number;
  toolCalls: number;
  toolBudget: number;
  /** Tools the model called that the scenario never stubbed — answered by DEFAULT_WORLD. */
  stubMisses: string[];
  /** Tool-call markup that leaked into the user-facing answer. */
  narratedToolSyntax: boolean;
  pins: string[];
  answer: string;
  claimMetrics?: Trace["metrics"];
  error?: string;
  /** A4: which repeat of the scenario this row is (0-based). */
  repeat: number;
  /** A4: expected and actual first substantive tool, for the confusion matrix. */
  expectedTool?: string;
  firstTool: string;
  /** A4: a shouldNotCall tool was called, or an expected unavailable reason never appeared. */
  shadeExpectationMisses: string[];
  /** A4: authority rejections and invalid_query shade results (bad arguments). */
  invalidParams: number;
  /** Wall-clock for the whole conversation. */
  ms: number;
  /** A4 pass: no error, no grounding violation, right first tool, shade expectations met. */
  pass: boolean;
  /**
   * A4 task success, independent of which tool answered (so the ablation is a fair
   * comparison): the final answer carries a verified claim or the expected
   * unavailable notice, or a should-not-call scenario stayed clear of those tools.
   */
  answered: boolean;
  /** The live shade data could not be read — an infrastructure failure, not the model's. */
  dataFailure: boolean;
}

const rows: Row[] = [];

/** Whether any call produced a place the loop could pin — the live condition for requiring a plot. */
function gatheredAPlace(trace: Trace): boolean {
  return trace.toolCalls.some((c) => {
    if (c.name === "check_shadow")
      return typeof c.args.lat === "number" || Array.isArray(c.args.points);
    if (c.name === "plan_shadowed_route") return typeof c.args.fromLat === "number";
    return Array.isArray(c.result.results) && c.result.results.length > 0;
  });
}

function summarize(
  scenario: Scenario,
  trace: Trace | undefined,
  error: string | undefined,
  repeat: number,
  ms: number,
): Row {
  const actualTools = trace?.toolCalls.map((c) => c.name) ?? [];
  const proposed = trace ? proposedTools(trace) : [];
  const firstTool = trace ? chosenTool(trace) : "none";
  const shadeExpectationMisses = [
    ...(scenario.expect.shouldNotCall ?? [])
      .filter((n) => proposed.includes(n))
      .map((n) => `called ${n}`),
    ...(scenario.expect.unavailable &&
    !trace?.verified?.blocks.some(
      (b) =>
        b.kind === "unknown" &&
        b.claimKind === "shade_window" &&
        b.reason === scenario.expect.unavailable,
    )
      ? [`no ${scenario.expect.unavailable} notice`]
      : []),
  ];
  const invalidParams =
    (trace?.authorityEvents.filter((e) => e.decision === "rejected").length ?? 0) +
    (trace?.toolCalls.filter(
      (c) => c.name === "find_shade_spots" && c.result.reason === "invalid_query",
    ).length ?? 0);
  const answer = trace?.answer ?? "";
  const plots = actualTools.filter((n) => n === "plot_points").length;
  const modelPlots = (trace?.history ?? [])
    .flatMap((c) => c.parts)
    .filter((p) => p.functionCall?.name === "plot_points").length;
  return {
    id: scenario.id,
    sharedModel: scenario.sharedModel === true,
    // A scripted scenario knows whether its path gathers anything; a live one
    // doesn't, so the plot is required exactly when a place was gathered.
    violations: trace
      ? groundingViolations(trace, {
          ...forLive(scenario),
          expect: { ...scenario.expect, plotsBeforeWrite: gatheredAPlace(trace) },
        })
      : [],
    modelPlots,
    loopPlots: plots - modelPlots,
    followedScript: JSON.stringify(actualTools) === JSON.stringify(scenario.expect.toolOrder),
    expectedTools: scenario.expect.toolOrder,
    actualTools,
    llmCalls: trace?.llmRequests.length ?? 0,
    llmBudget: scenario.maxLlmCalls,
    toolCalls: actualTools.length,
    toolBudget: scenario.maxToolCalls,
    stubMisses: actualTools.filter((name) => !(name in (scenario.tools ?? {}))),
    narratedToolSyntax: /<\/?function|<tool_call>|"name"\s*:|functionCall/.test(answer),
    pins: trace?.plottedPins.map((p) => p.label ?? "·") ?? [],
    answer,
    claimMetrics: trace?.metrics,
    error,
    repeat,
    expectedTool: scenario.expect.tool,
    firstTool,
    shadeExpectationMisses,
    invalidParams,
    ms,
    pass: false,
    answered:
      !!trace &&
      (trace.verified?.receipts.some((r) => r.verification === "verified") === true ||
        (!!scenario.expect.unavailable && !shadeExpectationMisses.length) ||
        (!!scenario.expect.shouldNotCall && !shadeExpectationMisses.length)),
    dataFailure: (trace?.toolCalls ?? []).some(
      (c) =>
        c.name === "find_shade_spots" &&
        (c.result.reason === "load_failed" || c.result.reason === "not_configured"),
    ),
  };
}

/** A4 pass^k: AGENT_EVAL_REPEATS runs of each scenario (default 1, the C1 behaviour). */
const REPEATS = Math.max(1, Number(process.env.AGENT_EVAL_REPEATS ?? 1) || 1);
const runs = liveScenarios.flatMap((s) =>
  Array.from({ length: REPEATS }, (_, repeat) => [`${s.id}#${repeat + 1}`, s, repeat] as const),
);

describe("live agent eval — gemini", () => {
  it.each(runs)("%s", async (_id, scenario, repeat) => {
    let trace: Trace | undefined;
    let error: string | undefined;
    liveShadeCandidates.length = 0;
    const started = Date.now();
    try {
      trace = await runLiveScenario(forLive(scenario), runAgent, mocks, real.callModel);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const row = summarize(scenario, trace, error, repeat, Date.now() - started);
    row.pass =
      !row.error &&
      !row.dataFailure &&
      row.answered &&
      row.violations.length === 0 &&
      row.shadeExpectationMisses.length === 0 &&
      (row.expectedTool === undefined || row.firstTool === row.expectedTool);
    rows.push(row);
    // One line per run as it lands — vitest itself prints nothing until the end.
    process.stdout.write(
      `[${rows.length}/${runs.length}] ${scenario.id}#${repeat + 1}: ` +
        `${row.error ? "error" : row.violations.length ? "VIOLATION" : "verified-state"}` +
        `${row.expectedTool ? `, tool ${row.firstTool}${row.firstTool === row.expectedTool ? "" : ` (want ${row.expectedTool})`}` : ""}` +
        `, ${row.llmCalls} LLM calls, ${usage.requests} requests so far\n`,
    );
    // With repeats the eval measures reliability; one bad run must not stop the rest.
    if (REPEATS === 1) {
      expect(row.error, "the turn threw").toBeUndefined();
      expect(row.violations).toEqual([]);
    }
  });
});

/**
 * A4: pass^1 is the mean pass rate over every run; pass^k is the share of
 * scenarios that pass in all k runs (tau-bench). Then the tool-selection
 * confusion matrix (expected vs first substantive tool the model proposed) and
 * the invalid-parameter and incorrect-value rates.
 */
function a4Summary(all: Row[]): string[] {
  const ablated = process.env.AGENT_EVAL_ABLATE || "none";
  const ids = [...new Set(all.map((r) => r.id))];
  const passAll = ids.filter((id) => all.filter((r) => r.id === id).every((r) => r.pass));
  const answeredAll = ids.filter((id) => all.filter((r) => r.id === id).every((r) => r.answered));
  const dataFailures = all.filter((r) => r.dataFailure).length;
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
  const scored = all.filter((r) => r.expectedTool);
  const expected = [...new Set(scored.map((r) => r.expectedTool!))].sort();
  const actual = [...new Set(scored.map((r) => r.firstTool))].sort();
  const shadeProposed = all.reduce((n, r) => n + (r.claimMetrics?.shade_window.proposed ?? 0), 0);
  const shadeRejected = all.reduce((n, r) => n + (r.claimMetrics?.shade_window.rejected ?? 0), 0);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  return [
    `### A4 — repeats ${REPEATS}, ablated: ${ablated}`,
    "",
    ...(dataFailures
      ? [
          `**INVALID RUN: the live shade data failed to load in ${dataFailures}/${all.length} runs.** ` +
            "Those runs measure the network, not the model; fix and rerun before reading anything below.",
          "",
        ]
      : []),
    `Task success (a verified answer, the right unavailable notice, or a correct refusal; tool-independent): ` +
      `${pct(all.filter((r) => r.answered).length, all.length)} of runs · ` +
      `pass^${REPEATS} ${pct(answeredAll.length, ids.length)} of scenarios`,
    `pass^1: ${pct(all.filter((r) => r.pass).length, all.length)} (${all.filter((r) => r.pass).length}/${all.length} runs) · ` +
      `pass^${REPEATS}: ${pct(passAll.length, ids.length)} (${passAll.length}/${ids.length} scenarios)`,
    `Median LLM calls: ${median(all.map((r) => r.llmCalls))} · median conversation: ${(median(all.map((r) => r.ms)) / 1000).toFixed(1)} s · ` +
      `grounding violations: ${all.filter((r) => r.violations.length).length} runs`,
    `Invalid-parameter rate: ${pct(
      all.reduce((n, r) => n + r.invalidParams, 0),
      all.reduce((n, r) => n + r.toolCalls + r.invalidParams, 0),
    )} of proposed calls · ` +
      `incorrect-value rate (shade_window claims rejected): ${pct(shadeRejected, shadeProposed)} (${shadeRejected}/${shadeProposed})`,
    "",
    "Tool selection (rows expected, columns first substantive tool proposed):",
    "",
    `| expected \\ actual | ${actual.join(" | ")} |`,
    `|---|${actual.map(() => "---").join("|")}|`,
    ...expected.map(
      (e) =>
        `| ${e} | ${actual
          .map((a) => scored.filter((r) => r.expectedTool === e && r.firstTool === a).length)
          .join(" | ")} |`,
    ),
    "",
    "Failing runs:",
    ...all
      .filter((r) => !r.pass)
      .map(
        (r) =>
          `- ${r.id}#${r.repeat + 1}: ${[
            r.error && `error ${r.error.slice(0, 80)}`,
            r.dataFailure && "shade data failed to load",
            !r.answered && "no verified answer",
            ...r.violations,
            ...r.shadeExpectationMisses,
            r.expectedTool &&
              r.firstTool !== r.expectedTool &&
              `tool ${r.firstTool} ≠ ${r.expectedTool}`,
          ]
            .filter(Boolean)
            .join("; ")}`,
      ),
  ];
}

afterAll(() => {
  const n = rows.length;
  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const lines = [
    `## Live agent eval — gemini: ${[...requestedModels].join(", ")}`,
    "",
    "| scenario | verified state | support P/S/W/T/R/A | escapes/dangling | followed script | LLM calls / budget | tools / budget | default-world calls | plots model/loop | pins | answer |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows
      .map((r) =>
        [
          r.id + (REPEATS > 1 ? `#${r.repeat + 1}` : "") + (r.sharedModel ? " (shared)" : ""),
          r.error
            ? `error: ${r.error.slice(0, 80)}`
            : r.violations.length
              ? r.violations.join("; ")
              : "yes",
          r.claimMetrics
            ? [
                r.claimMetrics.place,
                r.claimMetrics.shadow,
                r.claimMetrics.shade_window,
                r.claimMetrics.time,
                r.claimMetrics.route,
                r.claimMetrics.accessibility,
              ]
                .map((m) => `${m.supported}/${m.proposed}`)
                .join("/")
            : "—",
          r.claimMetrics
            ? `${r.claimMetrics.unsupportedClaimEscapes}/${r.claimMetrics.danglingClaimProposals}`
            : "—",
          r.followedScript ? "yes" : `no: ${r.actualTools.join(" → ") || "(none)"}`,
          `${r.llmCalls} / ${r.llmBudget}`,
          `${r.toolCalls} / ${r.toolBudget}`,
          r.stubMisses.join(", ") || "—",
          `${r.modelPlots}/${r.loopPlots}`,
          r.pins.join(", ") || "—",
          r.answer.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160),
        ].join(" | "),
      )
      .map((l) => `| ${l} |`),
    "",
    `Verified state: ${count((r) => !r.error && r.violations.length === 0)}/${n} · ` +
      `errors: ${count((r) => !!r.error)} · followed script: ${count((r) => r.followedScript)}/${n} · ` +
      `over LLM budget: ${count((r) => r.llmCalls > r.llmBudget)} · ` +
      `tool markup in answer: ${count((r) => r.narratedToolSyntax)} · ` +
      `needed default world: ${count((r) => r.stubMisses.length > 0)}`,
    `Requests: ${usage.requests} · tokens in/out: ${usage.input}/${usage.output}`,
  ];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  lines.push(
    `Latency (median / max per request): ${[...latencyMs]
      .map(
        ([model, xs]) =>
          `${model} ${(median(xs) / 1000).toFixed(1)} s / ${(Math.max(...xs) / 1000).toFixed(1)} s over ${xs.length}`,
      )
      .join(" · ")}`,
  );
  if (providerErrors.length) {
    lines.push(
      "",
      `Provider errors (${providerErrors.length}):`,
      ...[...new Set(providerErrors)].map((e) => `- ${e}`),
    );
  }
  lines.push("", ...a4Summary(rows));
  const report = `${lines.join("\n")}\n`;
  // Straight to stdout: vitest swallows console output on a green run.
  process.stdout.write(`\n${report}`);
  const out = process.env.AGENT_EVAL_OUT;
  if (out) {
    writeFileSync(`${out}.md`, report);
    writeFileSync(
      `${out}.json`,
      JSON.stringify(
        {
          provider: "gemini",
          repeats: REPEATS,
          ablated: process.env.AGENT_EVAL_ABLATE || null,
          models: [...requestedModels],
          served: [...usage.models],
          usage: { ...usage, models: undefined },
          rows,
        },
        null,
        2,
      ),
    );
  }
});

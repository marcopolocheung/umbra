/**
 * Budget scenarios. The free tier allows 5 requests/minute, so the number of
 * LLM round-trips a turn spends is a product constraint, not a detail — and the
 * step cap must never strand the loop before the pins reach the map.
 */
import { COMPLETED_ROUTE_TERMINAL, type Scenario } from "../harness";

const BRYANT = { name: "Bryant Park", lat: 40.7536, lng: -73.9832 };

/** Eight distinct probes, so candidate de-duplication doesn't collapse them. */
const PROBES = Array.from({ length: 8 }, (_, i) => ({
  lat: 40.75 + i * 0.002,
  lng: -73.98 - i * 0.002,
}));

export const stepBudgetExhaustedStillPlots: Scenario = {
  id: "step-budget-exhausted-still-plots",
  intent: "a loop that burns all 8 research steps still plots before the write call",
  userText: "Check every corner of the block for shadow",
  tools: {
    check_shadow: { shadowFraction: 0.5, status: "partial sun" },
    plot_points: { ok: true, plotted: 8 },
  },
  script: [
    ...PROBES.map((p) => ({ calls: [{ name: "check_shadow", args: { ...p } }] })),
    { text: "The block is half shadowed; the probes are pinned." },
  ],
  maxLlmCalls: 9,
  maxToolCalls: 9,
  expect: {
    toolOrder: [...PROBES.map(() => "check_shadow"), "plot_points"],
    plotsBeforeWrite: true,
    pinCount: 8,
    answer: "The block is half shadowed; the probes are pinned.",
  },
};

export const sharedModelSkipsWriteCall: Scenario = {
  id: "shared-model-skips-write-call",
  intent: "when both roles resolve to one model the research answer is the answer",
  userText: "Plan a shadowed walk",
  sharedModel: true,
  tools: {
    search_places: { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "shadowed plazas" } }] },
    { text: "Use Bryant Park first." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 2,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Use Bryant Park first.",
  },
};

const GRACE = { name: "Grace Plaza", lat: 40.752, lng: -73.985 };

export const batchedShadowCheckPinsEverySpot: Scenario = {
  id: "batched-shadow-check-pins-every-spot",
  intent: "one check_shadow over several labelled spots makes each spot a named candidate",
  userText: "How shaded are Bryant Park and Grace Plaza at 2pm?",
  tools: {
    check_shadow: (args) => ({
      results: (args.points as { lat: number; lng: number }[]).map((p) => ({
        ...p,
        shadowFraction: 0.7,
        status: "shadowed",
      })),
    }),
    plot_points: { ok: true, plotted: 2 },
  },
  script: [
    {
      calls: [
        {
          name: "check_shadow",
          args: { points: [{ ...BRYANT, label: BRYANT.name }, { ...GRACE, label: GRACE.name }], time: "2:00 PM" },
        },
      ],
    },
    { text: "draft answer from the research model" },
    { text: "Both are shadowed at 2 PM." },
  ],
  grounded: [BRYANT.name, GRACE.name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name],
    answer: "Both are shadowed at 2 PM.",
  },
};

const PALEY = { name: "Paley Park", lat: 40.7597, lng: -73.9761 };

/** #59 live: the model searched until the step budget ran out and never routed. */
export const askedRouteIsCalculated: Scenario = {
  id: "asked-route-is-calculated",
  intent: "a user who asked for a route gets one through the pins even when the model never routes",
  userText: "Plan a shadowed afternoon near Bryant Park and route me through two or three places to sit",
  tools: {
    search_places: { results: [BRYANT, GRACE, PALEY] },
    plot_points: { ok: true, plotted: 3 },
    plan_shadowed_route: COMPLETED_ROUTE_TERMINAL,
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "plazas", lat: 40.75, lng: -73.98 } }] },
    { text: "draft answer from the research model" },
    { text: "Bryant Park, then Grace Plaza, then Paley Park." },
  ],
  grounded: [BRYANT.name, GRACE.name, PALEY.name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plan_shadowed_route"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name, PALEY.name],
    answer: "Bryant Park, then Grace Plaza, then Paley Park.",
  },
};

export const repeatedCallIsNotRerun: Scenario = {
  id: "repeated-call-is-not-rerun",
  intent: "an identical repeated tool call gets the earlier result back, not a second execution",
  userText: "Plan a shadowed walk",
  tools: {
    search_places: { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "plazas", lat: 40.75, lng: -73.98 } }] },
    { calls: [{ name: "search_places", args: { query: "plazas", lat: 40.75, lng: -73.98 } }] },
    { calls: [{ name: "plot_points", args: { points: [{ ...BRYANT, label: BRYANT.name }] } }] },
    { text: "Start at Bryant Park." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 4,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Start at Bryant Park.",
  },
};

/** Live, a model searched nine times with a new query each time, every one answered. */
export const searchingClosesAfterFour: Scenario = {
  id: "searching-closes-after-four",
  intent: "reformulations stay offered up to four searches, then the loop closes search so the model plots",
  userText: "Plan a shadowed afternoon near Bryant Park",
  tools: {
    search_places: { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks", near: "Bryant Park" } }] },
    { calls: [{ name: "search_places", args: { query: "cafes", near: "Bryant Park" } }] },
    { calls: [{ name: "search_places", args: { query: "benches", near: "Bryant Park" } }] },
    { calls: [{ name: "search_places", args: { query: "fountains", near: "Bryant Park" } }] },
    { calls: [{ name: "search_places", args: { query: "kiosks", near: "Bryant Park" } }] },
    { text: "draft answer from the research model" },
    { text: "Sit in Bryant Park." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 7,
  maxToolCalls: 5,
  expect: {
    toolOrder: ["search_places", "search_places", "search_places", "search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Sit in Bryant Park.",
  },
};

export const emptySearchIsReformulated: Scenario = {
  id: "empty-search-is-reformulated",
  intent: "one empty search steers a reformulation, and the retry's hits reach the map",
  userText: "Find me a shadowed café around here",
  tools: {
    search_places: (args) =>
      String(args.query ?? "") === "café"
        ? { results: [], note: "No matches found." }
        : { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "café" } }] },
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    { text: "draft answer from the research model" },
    { text: "Sit in Bryant Park." },
  ],
  grounded: [BRYANT.name],
  decoys: ["Willow Court Café"],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Sit in Bryant Park.",
  },
};

/** The reported regression: "Where's a shady spot to sit at 2pm?" answered with advice and no pins. */
export const vagueSitQueryFindsPins: Scenario = {
  id: "vague-sit-query-finds-pins",
  intent: "a vague first guess that misses is reformulated, and the retry's hits are plotted and named",
  userText: "Where's a shady spot to sit at 2pm?",
  tools: {
    search_places: (args) =>
      String(args.query ?? "") === "somewhere to sit"
        ? { results: [], note: "No matches found." }
        : { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "somewhere to sit" } }] },
    { calls: [{ name: "search_places", args: { query: "parks", near: "Bryant Park" } }] },
    { text: "draft answer from the research model" },
    { text: "Sit in Bryant Park at 2 PM." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Sit in Bryant Park at 2 PM.",
  },
};

/**
 * `check_shadow` and `plan_shadowed_route` candidates have no per-call cap of their
 * own, so this is the case where the overall `slice(0, 8)` is the only thing
 * standing between ten gathered candidates and ten pins.
 */
const LEGS = [
  { from: "Ainsworth Green", to: "Beckett Yard" },
  { from: "Cordell Walk", to: "Delaney Court" },
  { from: "Elmore Steps", to: "Fenner Lane" },
];

export const candidatesOverflowCapAtEightPins: Scenario = {
  id: "candidates-overflow-cap-at-eight-pins",
  intent: "ten gathered candidates still plot as eight pins, in gathering order",
  userText: "Check four corners then route me through three legs",
  tools: {
    check_shadow: { shadowFraction: 0.4, status: "partial sun" },
    plan_shadowed_route: COMPLETED_ROUTE_TERMINAL,
    plot_points: { ok: true, plotted: 8 },
  },
  script: [
    ...PROBES.slice(0, 4).map((p) => ({ calls: [{ name: "check_shadow", args: { ...p } }] })),
    ...LEGS.map((leg, i) => ({
      calls: [
        {
          name: "plan_shadowed_route",
          args: {
            fromLat: 41 + i * 0.01,
            fromLng: -74 - i * 0.01,
            fromLabel: leg.from,
            toLat: 41.005 + i * 0.01,
            toLng: -74.005 - i * 0.01,
            toLabel: leg.to,
          },
        },
      ],
    })),
    { text: "draft answer from the research model" },
    { text: "Eight of the ten spots are pinned." },
  ],
  maxLlmCalls: 9,
  maxToolCalls: 8,
  expect: {
    toolOrder: [
      "check_shadow",
      "check_shadow",
      "check_shadow",
      "check_shadow",
      "plan_shadowed_route",
      "plan_shadowed_route",
      "plan_shadowed_route",
      "plot_points",
    ],
    plotsBeforeWrite: true,
    // Four unlabelled probes, then the first two legs — the third leg overflows.
    pinLabels: [
      undefined,
      undefined,
      undefined,
      undefined,
      LEGS[0].from,
      LEGS[0].to,
      LEGS[1].from,
      LEGS[1].to,
    ],
    answer: "Eight of the ten spots are pinned.",
  },
};

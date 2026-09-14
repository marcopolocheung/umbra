/**
 * The paths a working shadow-planning turn takes. Each one pins down the tool
 * sequence and the plot-before-answer guarantee, not the wording.
 */
import { gazetteer, type Scenario } from "../harness";

const BRYANT = { name: "Bryant Park", lat: 40.7536, lng: -73.9832 };
const GRACE = { name: "Grace Plaza", lat: 40.752, lng: -73.985 };
const MADISON = { name: "Madison Square Park", lat: 40.7414, lng: -73.9882 };

export const happyPathShadowedAfternoon: Scenario = {
  id: "happy-path-shadowed-afternoon",
  intent: "search → check shadow → plot → write, in that order, inside budget",
  userText: "Where can I sit in the shadow this afternoon?",
  tools: {
    search_places: { results: [BRYANT, GRACE] },
    check_shadow: { shadowFraction: 0.72, status: "shadowed", time: "3:00 PM" },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks", lat: 40.7536, lng: -73.9832 } }] },
    { calls: [{ name: "check_shadow", args: { lat: BRYANT.lat, lng: BRYANT.lng, time: "3:00 PM" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }] },
        },
      ],
    },
    { text: "Bryant Park is 72% shadowed at 3 PM — head there." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Bryant Park is 72% shadowed at 3 PM — head there.",
  },
};

export const fallbackPlotWhenModelForgets: Scenario = {
  id: "fallback-plot-when-model-forgets",
  intent: "the model answers without plotting; the loop plots its candidates anyway",
  userText: "Plan a shadowed afternoon",
  tools: {
    search_places: { results: [BRYANT, GRACE] },
    plot_points: { ok: true, plotted: 2 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "shadowed parks" } }] },
    { text: "draft answer from the research model" },
    { text: "Start at Bryant Park, then Grace Plaza." },
  ],
  grounded: [BRYANT.name, GRACE.name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name],
    answer: "Start at Bryant Park, then Grace Plaza.",
  },
};

export const modelPlotsItselfNoDuplicate: Scenario = {
  id: "model-plots-itself-no-duplicate",
  intent: "a model-issued plot_points suppresses the fallback plot",
  userText: "Show me Bryant Park",
  tools: { geocode_place: gazetteer([BRYANT]), plot_points: { ok: true, plotted: 1 } },
  script: [
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }] },
        },
      ],
    },
    { text: "Pinned Bryant Park." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 2,
  maxToolCalls: 1,
  expect: {
    toolOrder: ["plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Pinned Bryant Park.",
  },
};

export const locateUserThenPlan: Scenario = {
  id: "locate-user-then-plan",
  intent: '"near me" locates first, then searches and plots',
  userText: "Somewhere shadowed near me",
  context: { locationKnown: false },
  tools: {
    locate_user: { lat: 40.7536, lng: -73.9832, note: "Centered the map." },
    search_places: { results: [BRYANT] },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "locate_user" }] },
    { calls: [{ name: "search_places", args: { query: "shadowed parks" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }] },
        },
      ],
    },
    { text: "Bryant Park is the closest shadow." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["locate_user", "search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name],
    answer: "Bryant Park is the closest shadow.",
  },
};

export const setTimePrecedesShadowCheck: Scenario = {
  id: "set-time-precedes-shadow-check",
  intent: "a stated hour moves the simulation before any shadow is measured",
  userText: "Is the park shadowed at 5:30pm?",
  tools: {
    set_time: { ok: true, localTime: "5:30 PM" },
    check_shadow: { shadowFraction: 0.81, status: "shadowed", time: "5:30 PM" },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "set_time", args: { time: "5:30 PM" } }] },
    { calls: [{ name: "check_shadow", args: { lat: MADISON.lat, lng: MADISON.lng } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: MADISON.lat, lng: MADISON.lng, label: MADISON.name }] },
        },
      ],
    },
    { text: "Madison Square Park is shadowed at 5:30 PM." },
  ],
  grounded: [MADISON.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["set_time", "check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [MADISON.name],
    answer: "Madison Square Park is shadowed at 5:30 PM.",
  },
};

export const routePlanningPlotsEndpoints: Scenario = {
  id: "route-planning-plots-endpoints",
  intent: "a planned route's endpoints become the fallback pins",
  userText: "Walk me from Bryant Park to Madison Square Park in the shadow",
  tools: {
    geocode_place: gazetteer([BRYANT, MADISON]),
    plan_shadowed_route: { ok: true, note: "Calculating a shadow-aware route." },
    plot_points: { ok: true, plotted: 2 },
  },
  script: [
    {
      calls: [
        {
          name: "plan_shadowed_route",
          args: {
            fromLat: BRYANT.lat,
            fromLng: BRYANT.lng,
            fromLabel: BRYANT.name,
            toLat: MADISON.lat,
            toLng: MADISON.lng,
            toLabel: MADISON.name,
          },
        },
      ],
    },
    { text: "draft answer from the research model" },
    { text: "Routing Bryant Park to Madison Square Park on the shadowed side." },
  ],
  grounded: [BRYANT.name, MADISON.name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["plan_shadowed_route", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, MADISON.name],
    answer: "Routing Bryant Park to Madison Square Park on the shadowed side.",
  },
};

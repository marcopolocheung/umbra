/**
 * The honesty scenarios: what the loop must do when a tool fails, returns
 * nothing, or returns more than fits on the map. Each declares the place names
 * the tools genuinely produced (`grounded`) and, where relevant, a name no tool
 * ever returned (`decoys`) that must never reach the answer.
 */
import { COMPLETED_ROUTE_TERMINAL, gazetteer, type Scenario } from "../harness";

const MADISON = { name: "Madison Square Park", lat: 40.7414, lng: -73.9882 };

export const toolErrorStaysHonest: Scenario = {
  id: "tool-error-stays-honest",
  intent: "a failed shadow probe is fed back as an error and still ends in a plotted answer",
  userText: "Is Madison Square Park shadowed right now?",
  tools: {
    geocode_place: { results: [MADISON] },
    check_shadow: { error: "No building geometry loaded for that area." },
    plot_points: { ok: true, plotted: 1 },
  },
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Madison Square Park" } }] },
    { calls: [{ name: "check_shadow", args: { lat: MADISON.lat, lng: MADISON.lng } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: MADISON.lat, lng: MADISON.lng, label: MADISON.name }] },
        },
      ],
    },
    { text: "I couldn't measure shadow at Madison Square Park — it's pinned so you can look." },
  ],
  grounded: [MADISON.name],
  decoys: ["Willow Court Café"],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["geocode_place", "check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [MADISON.name],
    answer: "I couldn't measure shadow at Madison Square Park — it's pinned so you can look.",
  },
};

export const emptySearchInventsNothing: Scenario = {
  id: "empty-search-invents-nothing",
  intent: "an empty search result plots nothing and names nothing",
  userText: "Find me a shadowed café around here",
  tools: {
    search_places: { results: [], note: "No matches found." },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "café" } }] },
    { text: "draft answer from the research model" },
    { text: "I couldn't find any cafés near there — try naming a neighbourhood." },
  ],
  decoys: ["Willow Court Café"],
  maxLlmCalls: 3,
  maxToolCalls: 1,
  expect: {
    toolOrder: ["search_places"],
    plotsBeforeWrite: false,
    pinLabels: [],
    answer: "I couldn't find any cafés near there — try naming a neighbourhood.",
  },
};

export const noResearchNoPins: Scenario = {
  id: "no-research-no-pins",
  intent: "an off-topic refusal costs one LLM call, no tools, and stands as written",
  userText: "What's the capital of France?",
  script: [{ text: "I only help plan a day around shadow and sun." }],
  decoys: ["Bryant Park"],
  maxLlmCalls: 1,
  maxToolCalls: 0,
  expect: {
    toolOrder: [],
    plotsBeforeWrite: false,
    pinLabels: [],
    answer: "I only help plan a day around shadow and sun.",
  },
};

export const unknownLocationAsksInstead: Scenario = {
  id: "unknown-location-asks-instead",
  intent: "with no located map, the research model's question back reaches the user unrewritten",
  userText: "Somewhere shadowed, please",
  context: { locationKnown: false, zoom: 2, center: { lat: 0, lng: 0 } },
  script: [{ text: "Which city or neighbourhood should I plan around?" }],
  decoys: ["Bryant Park"],
  maxLlmCalls: 1,
  maxToolCalls: 0,
  expect: {
    toolOrder: [],
    plotsBeforeWrite: false,
    pinLabels: [],
    answer: "Which city or neighbourhood should I plan around?",
  },
};

const MANY = Array.from({ length: 12 }, (_, i) => ({
  name: `Park ${i + 1}`,
  lat: 40.75 + i * 0.001,
  lng: -73.98 - i * 0.001,
}));

export const fallbackPinsCapAtEight: Scenario = {
  id: "fallback-pins-cap-at-eight",
  intent: "twelve search hits become at most eight pins",
  userText: "Show me every shadowed park nearby",
  tools: {
    search_places: { results: MANY },
    plot_points: { ok: true, plotted: 8 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    { text: "draft answer from the research model" },
    { text: "Start at Park 1, finish at Park 8 — eight in all, pinned." },
  ],
  grounded: MANY.slice(0, 8).map((p) => p.name),
  // Returned by the search but dropped by the 8-pin cap, so naming it would be
  // a claim the map can't back.
  decoys: [MANY[11].name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: MANY.slice(0, 8).map((p) => p.name),
    answer: "Start at Park 1, finish at Park 8 — eight in all, pinned.",
  },
};

const BRYANT = { name: "Bryant Park", lat: 40.7536, lng: -73.9832 };
const GRACE = { name: "Grace Plaza", lat: 40.752, lng: -73.985 };

export const duplicateHitsBecomeOnePin: Scenario = {
  id: "duplicate-hits-become-one-pin",
  intent: "two search hits at the same coordinate become a single pin",
  userText: "Shadowed parks around Midtown",
  tools: {
    search_places: {
      results: [
        BRYANT,
        // Same coordinate, different name — one place, listed twice.
        { name: "Bryant Park north entrance", lat: BRYANT.lat, lng: BRYANT.lng },
        { name: "Grace Plaza", lat: 40.752, lng: -73.985 },
      ],
    },
    plot_points: { ok: true, plotted: 2 },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    { text: "draft answer from the research model" },
    { text: "Bryant Park, then Grace Plaza." },
  ],
  grounded: [BRYANT.name, "Grace Plaza"],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, "Grace Plaza"],
    answer: "Bryant Park, then Grace Plaza.",
  },
};

// ---------------------------------------------------------------------------
// C2 — the leaks. Each is a way a place could reach the answer without reaching
// the map; each ends with every named place pinned.
// ---------------------------------------------------------------------------

export const viaStopsBecomePins: Scenario = {
  id: "via-stops-become-pins",
  intent: "a multi-stop route's intermediate stops are pinned, not just its endpoints",
  userText: "Walk me from Bryant Park to Madison Square Park via Grace Plaza, in the shadow",
  tools: {
    geocode_place: gazetteer([BRYANT, GRACE, MADISON]),
    plan_shadowed_route: COMPLETED_ROUTE_TERMINAL,
    plot_points: { ok: true, plotted: 3 },
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
            via: [{ lat: GRACE.lat, lng: GRACE.lng, label: GRACE.name }],
          },
        },
      ],
    },
    { text: "draft answer from the research model" },
    { text: "Bryant Park, then Grace Plaza, then Madison Square Park." },
  ],
  grounded: [BRYANT.name, GRACE.name, MADISON.name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["plan_shadowed_route", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name, MADISON.name],
    answer: "Bryant Park, then Grace Plaza, then Madison Square Park.",
  },
};

export const partialPlotIsCompletedAfterAnswer: Scenario = {
  id: "partial-plot-is-completed-after-answer",
  intent: "a place the model found but left off its own plot is pinned once the answer names it",
  userText: "Two shadowed places to sit this afternoon",
  tools: {
    search_places: { results: [BRYANT, GRACE] },
    plot_points: { ok: true },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }] },
        },
      ],
    },
    { text: "Bryant Park first, then Grace Plaza." },
  ],
  grounded: [BRYANT.name, GRACE.name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name],
    answer: "Bryant Park first, then Grace Plaza.",
  },
};

export const cappedPlaceNamedGetsPinned: Scenario = {
  id: "capped-place-named-gets-pinned",
  intent: "a search hit the 8-pin cap dropped is pinned if the answer names it anyway",
  userText: "Show me every shadowed park nearby",
  tools: {
    search_places: { results: MANY },
    plot_points: { ok: true },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    { text: "draft answer from the research model" },
    { text: "Start at Park 1; Park 12 is the quietest." },
  ],
  grounded: [MANY[0].name, MANY[11].name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plot_points"],
    plotsBeforeWrite: true,
    // Still eight: the last pin the answer never mentions makes room for Park 12.
    pinLabels: [...MANY.slice(0, 7).map((p) => p.name), MANY[11].name],
    answer: "Start at Park 1; Park 12 is the quietest.",
  },
};

export const sharedModelAnswerIsReconciled: Scenario = {
  id: "shared-model-answer-is-reconciled",
  intent: "with no write call to instruct, code still pins what the research answer names",
  userText: "Two shadowed places to sit",
  sharedModel: true,
  tools: {
    search_places: { results: [BRYANT, GRACE] },
    plot_points: { ok: true },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }] },
        },
      ],
    },
    { text: "Bryant Park first, then Grace Plaza." },
  ],
  grounded: [BRYANT.name, GRACE.name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [BRYANT.name, GRACE.name],
    answer: "Bryant Park first, then Grace Plaza.",
  },
};

// ---------------------------------------------------------------------------
// C2 review: what reconcilePins must not do, and a turn that isn't the first.
// ---------------------------------------------------------------------------

export const followUpTurnKnowsEarlierPins: Scenario = {
  id: "follow-up-turn-knows-earlier-pins",
  intent: "a follow-up turn that plots nothing still tells the write call what is on the map",
  userText: "What about at 5pm?",
  mapPins: [{ lat: BRYANT.lat, lng: BRYANT.lng, label: BRYANT.name }],
  tools: { set_time: { ok: true, newLocalTime: "5:00 PM" } },
  script: [
    { calls: [{ name: "set_time", args: { time: "5:00 PM" } }] },
    { text: "draft answer from the research model" },
    { text: "At 5 PM Bryant Park is fully shaded." },
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 3,
  maxToolCalls: 1,
  expect: {
    toolOrder: ["set_time"],
    plotsBeforeWrite: false,
    pinLabels: [BRYANT.name],
    answer: "At 5 PM Bryant Park is fully shaded.",
  },
};

export const partialNamesAreNotPlaces: Scenario = {
  id: "partial-names-are-not-places",
  intent: '"Park 12" does not name "Park 1", and a house number is not a place',
  userText: "The quietest park nearby",
  tools: {
    search_places: {
      results: [MANY[0], MANY[11], { name: "350, Fifth Avenue", lat: 40.7484, lng: -73.9857 }],
    },
    plot_points: { ok: true },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: MANY[11].lat, lng: MANY[11].lng, label: MANY[11].name }] },
        },
      ],
    },
    { text: "Park 12 is the quietest, a 350 m walk." },
  ],
  grounded: [MANY[11].name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: [MANY[11].name],
    answer: "Park 12 is the quietest, a 350 m walk.",
  },
};

export const evictionSparesNamedPins: Scenario = {
  id: "eviction-spares-named-pins",
  intent: "making room for a named place never evicts a pin the answer also names",
  userText: "Show me every shadowed park nearby",
  tools: { search_places: { results: MANY }, plot_points: { ok: true } },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    {
      calls: [
        {
          name: "plot_points",
          // The model's own labels, over the search hits' coordinates.
          args: {
            points: MANY.slice(0, 8).map((p, i) => ({ lat: p.lat, lng: p.lng, label: `Stop ${i + 1}` })),
          },
        },
      ],
    },
    { text: "Park 8 is closest; Park 12 is the quietest." },
  ],
  grounded: [MANY[11].name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plot_points"],
    plotsBeforeWrite: true,
    // "Stop 8" sits on Park 8, which the answer names, so "Stop 7" makes room instead.
    pinLabels: ["Stop 1", "Stop 2", "Stop 3", "Stop 4", "Stop 5", "Stop 6", "Stop 8", MANY[11].name],
    answer: "Park 8 is closest; Park 12 is the quietest.",
  },
};

export const onePlaceOnePin: Scenario = {
  id: "one-place-one-pin",
  intent: "a place already pinned under another label, or listed twice, is not pinned again",
  userText: "Two shadowed places to sit",
  tools: {
    search_places: {
      results: [
        // The model's own pin below rounds these coordinates and relabels the place.
        { name: "Bryant Park, Midtown", lat: 40.753612, lng: -73.983201 },
        GRACE,
        { name: "Grace Plaza", lat: 40.76, lng: -73.97 },
      ],
    },
    plot_points: { ok: true },
  },
  script: [
    { calls: [{ name: "search_places", args: { query: "plazas" } }] },
    {
      calls: [
        {
          name: "plot_points",
          args: { points: [{ lat: 40.7536, lng: -73.9832, label: "Bryant Park (north lawn)" }] },
        },
      ],
    },
    { text: "Bryant Park, then Grace Plaza." },
  ],
  grounded: [GRACE.name],
  maxLlmCalls: 3,
  maxToolCalls: 3,
  expect: {
    toolOrder: ["search_places", "plot_points", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: ["Bryant Park (north lawn)", GRACE.name],
    answer: "Bryant Park, then Grace Plaza.",
  },
};

export const modelsBarePinsGetNamesAndTheCap: Scenario = {
  id: "models-bare-pins-get-names-and-the-cap",
  intent: "a model plotting twelve unlabelled pins gets eight, named after the places under them",
  userText: "Show me every shadowed park nearby",
  tools: { search_places: { results: MANY }, plot_points: { ok: true } },
  script: [
    { calls: [{ name: "search_places", args: { query: "parks" } }] },
    // Seen live on Gemini: every hit plotted, none labelled, no cap.
    { calls: [{ name: "plot_points", args: { points: MANY.map((p) => ({ lat: p.lat, lng: p.lng })) } }] },
    { text: "Park 1 first, then Park 2." },
  ],
  grounded: [MANY[0].name, MANY[1].name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    toolOrder: ["search_places", "plot_points"],
    plotsBeforeWrite: true,
    pinLabels: MANY.slice(0, 8).map((p) => p.name),
    answer: "Park 1 first, then Park 2.",
  },
};

/**
 * A4: shade-window scenarios. Each pins one decision the live model must make
 * about `find_shade_spots` — call it for a time window, another date, sun, or a
 * "like this one" follow-up; leave it alone for "right now", a pure lookup, or a
 * city with no table. Scripts keep them hermetic; the live eval drops scripts
 * and lets a real model choose, then scores the choice against `expect.tool`.
 */
import { normalizeShadeToolArgs, shadeQueryFromArgs } from "../../tools";
import { COMPLETED_ROUTE_TERMINAL, gazetteer, type Scenario, type ToolStub } from "../harness";
import { SHADE_BOUNDS, shadePayload } from "../shadeFixture";

const BRYANT = { name: "Bryant Park", lat: 40.7536, lng: -73.9832 };
const UNION = { name: "Union Square", lat: 40.7359, lng: -73.9911 };
const BOSTON = { name: "Boston Common", lat: 42.355, lng: -71.0656 };
/** The scenario map date (`makeScenarioContext`): 2026-08-08, 2 PM New York. */
const MAP_DATE = new Date("2026-08-08T18:00:00Z");

/**
 * The shade tool over the A1 fixture: the model's arguments go through the real
 * parser, so a malformed call fails here as it would in the app. Anything off
 * the fixture's patch is outside coverage — the honest answer for Boston.
 */
export const shadeTool: ToolStub = (args) => {
  const query = shadeQueryFromArgs(normalizeShadeToolArgs(args, MAP_DATE));
  if (!query) return { status: "unavailable", reason: "invalid_query", results: [] };
  const inside =
    query.lat > SHADE_BOUNDS.south &&
    query.lat < SHADE_BOUNDS.north &&
    query.lng > SHADE_BOUNDS.west &&
    query.lng < SHADE_BOUNDS.east;
  if (!inside) return { status: "unavailable", reason: "outside_coverage", results: [] };
  return { ...shadePayload({ ...query, lat: 40.755, lng: -73.985 }) };
};

const shadeArgs = (anchor: { lat: number; lng: number }, from: string, to: string) => ({
  lat: anchor.lat,
  lng: anchor.lng,
  from,
  to,
  radiusM: 400,
  mode: "shade",
});
const results = () => shadePayload().results;
const plotResults = () => ({
  points: results().map((s) => ({
    lat: s.lat,
    lng: s.lng,
    label: s.label,
    candidateId: s.candidateId,
  })),
});
const world = {
  geocode_place: gazetteer([BRYANT, UNION, BOSTON]),
  find_shade_spots: shadeTool,
  plot_points: { ok: true, plotted: 2 },
};
const WRITE = { text: "The verified shade window is above." };

export const shadeWindowToday: Scenario = {
  id: "shade-window-today",
  intent: "a time-window shade question near a named place uses find_shade_spots",
  userText: "Where can I wait in the shade near Bryant Park between 2 and 4 today?",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BRYANT, "2:00 PM", "4:00 PM") }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const shadeAnotherDate: Scenario = {
  id: "shade-another-date",
  intent: "a question about another date passes that date, not the map's",
  userText: "Shadiest sidewalk near Bryant Park at noon on July 4?",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    {
      calls: [
        {
          name: "find_shade_spots",
          args: { ...shadeArgs(BRYANT, "12:00 PM", "12:15 PM"), date: "2026-07-04" },
        },
      ],
    },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const sunModeSearch: Scenario = {
  id: "sun-mode-search",
  intent: "a request for somewhere sunny uses sun mode, not shade",
  userText: "Find me somewhere sunny to sit near Bryant Park this afternoon from 1 to 3pm.",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    {
      calls: [
        {
          name: "find_shade_spots",
          args: { ...shadeArgs(BRYANT, "1:00 PM", "3:00 PM"), mode: "sun" },
        },
      ],
    },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const shadeNearMapCentre: Scenario = {
  id: "shade-near-map-centre",
  intent: "'near here' over a window searches at the map centre without geocoding",
  userText: "Which sidewalk near here is shadiest from 3 to 5pm?",
  tools: world,
  script: [
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BRYANT, "3:00 PM", "5:00 PM") }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const shadeLikeThisOne: Scenario = {
  id: "shade-like-this-one",
  intent: "a 'like the first one' follow-up passes the earlier sidewalk's exact identity",
  userText: "Where can I wait in the shade near here from 2 to 4pm?",
  turns: ["Find nearby sidewalks with a shade pattern like the first one."],
  tools: world,
  script: [
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BRYANT, "2:00 PM", "4:00 PM") }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
    { calls: [{ name: "find_shade_spots", args: { likeCandidateId: results()[0].candidateId } }] },
    WRITE,
    WRITE,
  ],
  maxLlmCalls: 6,
  maxToolCalls: 4,
  expect: {
    tool: "find_shade_spots",
    // The loop pins the matches itself when the model does not.
    toolOrder: ["find_shade_spots", "plot_points", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: false,
    answer: WRITE.text,
  },
};

export const shadeCrossesSunset: Scenario = {
  id: "shade-crosses-sunset",
  intent: "a window running past sunset is still answered from the table, clipped, not guessed",
  userText: "Shady place to wait near Bryant Park from 6 to 9pm tonight?",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BRYANT, "6:00 PM", "9:00 PM") }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const rightNowUsesCheckShadow: Scenario = {
  id: "right-now-uses-check-shadow",
  intent: "'is it shaded right now' at a known place is an instant check, not a window search",
  userText: "Is Bryant Park in shade right now?",
  tools: {
    ...world,
    check_shadow: { shadowFraction: 0.7, status: "mostly shadowed", atLocalTime: "2:00 PM" },
  },
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    { calls: [{ name: "check_shadow", args: { lat: BRYANT.lat, lng: BRYANT.lng } }] },
    { calls: [{ name: "plot_points", args: { points: [{ ...BRYANT, label: BRYANT.name }] } }] },
    WRITE,
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "check_shadow",
    shouldNotCall: ["find_shade_spots"],
    toolOrder: ["geocode_place", "check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const outsideCoverageSaysSo: Scenario = {
  id: "outside-coverage-says-so",
  intent: "a city with no shade table gets the unavailable explanation, never a guessed window",
  userText: "Where can I wait in the shade near Boston Common from 2 to 4pm?",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Boston Common" } }] },
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BOSTON, "2:00 PM", "4:00 PM") }] },
    WRITE,
    WRITE,
  ],
  grounded: [BOSTON.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: false,
    unavailable: "outside_coverage",
    answer: WRITE.text,
  },
};

export const pureLookupNoShadeSearch: Scenario = {
  id: "pure-lookup-no-shade-search",
  intent: "a plain 'where is' question geocodes and stops; no shade window was asked for",
  userText: "Where is Bryant Park?",
  tools: world,
  script: [
    { calls: [{ name: "geocode_place", args: { query: "Bryant Park" } }] },
    { calls: [{ name: "plot_points", args: { points: [{ ...BRYANT, label: BRYANT.name }] } }] },
    WRITE,
  ],
  grounded: [BRYANT.name],
  maxLlmCalls: 3,
  maxToolCalls: 2,
  expect: {
    tool: "geocode_place",
    shouldNotCall: ["find_shade_spots"],
    toolOrder: ["geocode_place", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

export const offTopicNoTools: Scenario = {
  id: "off-topic-no-tools",
  intent: "an off-topic request is declined without any tool call",
  userText: "Write me a haiku about the stock market.",
  tools: world,
  script: [{ text: "I only help plan around sun and shade." }, WRITE],
  maxLlmCalls: 2,
  maxToolCalls: 0,
  expect: {
    tool: "none",
    shouldNotCall: ["find_shade_spots"],
    toolOrder: [],
    plotsBeforeWrite: false,
    answer: WRITE.text,
  },
};

export const findThenRouteThere: Scenario = {
  id: "find-then-route-there",
  intent: "a chosen shade sidewalk becomes one route destination, at the window's time",
  userText: "Where can I wait in the shade near here from 2 to 4pm?",
  turns: ["Route me from Union Square to the first one."],
  tools: { ...world, plan_shadowed_route: COMPLETED_ROUTE_TERMINAL },
  script: [
    { calls: [{ name: "find_shade_spots", args: shadeArgs(BRYANT, "2:00 PM", "4:00 PM") }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
    { calls: [{ name: "geocode_place", args: { query: "Union Square" } }] },
    {
      calls: [
        {
          name: "plan_shadowed_route",
          args: {
            fromLat: UNION.lat,
            fromLng: UNION.lng,
            toLat: results()[0].lat,
            toLng: results()[0].lng,
            toCandidateId: results()[0].candidateId,
          },
        },
      ],
    },
    WRITE,
    WRITE,
  ],
  maxLlmCalls: 7,
  maxToolCalls: 5,
  expect: {
    tool: "find_shade_spots",
    // The map is at 2 PM on the selected date, inside the window, so the route runs;
    // the loop then pins the route's endpoints.
    toolOrder: [
      "find_shade_spots",
      "plot_points",
      "geocode_place",
      "plan_shadowed_route",
      "plot_points",
    ],
    plotsBeforeWrite: false,
    answer: WRITE.text,
  },
};

/**
 * A4b borough holdout: the same decisions outside Manhattan, where the tool
 * description was never tuned. The live eval reports these separately and must
 * not tune against them. Hermetically the fixture answers anywhere — only the
 * tool flow is scripted; the published table covers every anchor (checked
 * 2026-10-15).
 */
const GRAND_ARMY = { name: "Grand Army Plaza", lat: 40.6744, lng: -73.9701 };
const COURT_SQUARE = { name: "Court Square", lat: 40.7471, lng: -73.9456 };
const ASTORIA_PARK = { name: "Astoria Park", lat: 40.7794, lng: -73.9218 };
const FORDHAM_PLAZA = { name: "Fordham Plaza", lat: 40.8611, lng: -73.8904 };
const BOROUGH_HALL = { name: "Brooklyn Borough Hall", lat: 40.6928, lng: -73.9903 };
const holdoutWorld = {
  ...world,
  geocode_place: gazetteer([GRAND_ARMY, COURT_SQUARE, ASTORIA_PARK, FORDHAM_PLAZA, BOROUGH_HALL]),
  find_shade_spots: ((args) => {
    const query = shadeQueryFromArgs(normalizeShadeToolArgs(args, MAP_DATE));
    if (!query) return { status: "unavailable", reason: "invalid_query", results: [] };
    return { ...shadePayload({ ...query, lat: 40.755, lng: -73.985 }) };
  }) satisfies ToolStub,
};
const holdoutSearch = (
  id: string,
  intent: string,
  place: { name: string; lat: number; lng: number },
  userText: string,
  args: Record<string, unknown>,
): Scenario => ({
  id,
  intent,
  userText,
  tools: holdoutWorld,
  script: [
    { calls: [{ name: "geocode_place", args: { query: place.name } }] },
    { calls: [{ name: "find_shade_spots", args }] },
    { calls: [{ name: "plot_points", args: plotResults() }] },
    WRITE,
  ],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "find_shade_spots",
    toolOrder: ["geocode_place", "find_shade_spots", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
});

export const holdoutBrooklynWindow = holdoutSearch(
  "holdout-brooklyn-window",
  "holdout: a time-window shade question in Brooklyn uses find_shade_spots",
  GRAND_ARMY,
  "Where can I wait in the shade near Grand Army Plaza between 2 and 4 today?",
  shadeArgs(GRAND_ARMY, "2:00 PM", "4:00 PM"),
);

export const holdoutQueensDate = holdoutSearch(
  "holdout-queens-date",
  "holdout: another date in Queens passes that date, not the map's",
  COURT_SQUARE,
  "Shadiest sidewalk near Court Square at noon on July 4?",
  { ...shadeArgs(COURT_SQUARE, "12:00 PM", "12:15 PM"), date: "2026-07-04" },
);

export const holdoutQueensSun = holdoutSearch(
  "holdout-queens-sun",
  "holdout: a sunny-spot request in Queens uses sun mode",
  ASTORIA_PARK,
  "Find me somewhere sunny to sit near Astoria Park this afternoon from 1 to 3pm.",
  { ...shadeArgs(ASTORIA_PARK, "1:00 PM", "3:00 PM"), mode: "sun" },
);

export const holdoutBronxSunset = holdoutSearch(
  "holdout-bronx-sunset",
  "holdout: a Bronx window running past sunset is answered from the table, clipped",
  FORDHAM_PLAZA,
  "Shady place to wait near Fordham Plaza from 6 to 9pm tonight?",
  shadeArgs(FORDHAM_PLAZA, "6:00 PM", "9:00 PM"),
);

export const holdoutBrooklynRightNow: Scenario = {
  id: "holdout-brooklyn-right-now",
  intent: "holdout: 'shaded right now' in Brooklyn is an instant check, not a window search",
  userText: "Is Brooklyn Borough Hall in shade right now?",
  tools: {
    ...holdoutWorld,
    check_shadow: { shadowFraction: 0.7, status: "mostly shadowed", atLocalTime: "2:00 PM" },
  },
  script: [
    { calls: [{ name: "geocode_place", args: { query: BOROUGH_HALL.name } }] },
    { calls: [{ name: "check_shadow", args: { lat: BOROUGH_HALL.lat, lng: BOROUGH_HALL.lng } }] },
    {
      calls: [
        { name: "plot_points", args: { points: [{ ...BOROUGH_HALL, label: BOROUGH_HALL.name }] } },
      ],
    },
    WRITE,
  ],
  grounded: [BOROUGH_HALL.name],
  maxLlmCalls: 4,
  maxToolCalls: 3,
  expect: {
    tool: "check_shadow",
    shouldNotCall: ["find_shade_spots"],
    toolOrder: ["geocode_place", "check_shadow", "plot_points"],
    plotsBeforeWrite: true,
    answer: WRITE.text,
  },
};

/** The borough-holdout scenario ids, reported apart from the Manhattan set. */
export const HOLDOUT_IDS = new Set(
  [
    holdoutBrooklynWindow,
    holdoutQueensDate,
    holdoutQueensSun,
    holdoutBronxSunset,
    holdoutBrooklynRightNow,
  ].map((s) => s.id),
);

/** The 11 Manhattan A4a shade scenarios: the set the tool description was tuned on. */
export const MANHATTAN_SHADE_IDS = new Set(
  [
    shadeWindowToday,
    shadeAnotherDate,
    sunModeSearch,
    shadeNearMapCentre,
    shadeLikeThisOne,
    shadeCrossesSunset,
    rightNowUsesCheckShadow,
    outsideCoverageSaysSo,
    pureLookupNoShadeSearch,
    offTopicNoTools,
    findThenRouteThere,
  ].map((s) => s.id),
);

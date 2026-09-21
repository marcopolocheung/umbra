import {
  CENTER,
  START_TIME,
  TRANSIT_WAYPOINT_A,
  TRANSIT_WAYPOINT_B,
  WAYPOINT_A,
  WAYPOINT_B,
} from "../helpers/scenario";

/**
 * The benchmark's fixed conditions are G1's fixed conditions — the same camera,
 * clock, viewport and Overpass stub the smoke test already pins. Reusing them is
 * the point: a baseline measured under conditions nothing else shares is a number
 * only the benchmark can reproduce.
 */

/** Three intermediate stops on the grid, between A and B. `via` is lng,lat pairs. */
export const VIA_WAYPOINTS: [number, number][] = [
  [-73.9848, 40.7545],
  [-73.9838, 40.7535],
  [-73.9831, 40.7548],
];

function shareUrl(via: [number, number][]): string {
  const params =
    `lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
    `&date=2026-06-21&time=${START_TIME}` +
    `&a=${WAYPOINT_A[0]},${WAYPOINT_A[1]}&b=${WAYPOINT_B[0]},${WAYPOINT_B[1]}`;
  const viaParam = via.length > 0 ? `&via=${via.map((v) => `${v[0]},${v[1]}`).join(";")}` : "";
  return `/?${params}${viaParam}`;
}

export const TWO_POINT_URL = shareUrl([]);
export const FIVE_POINT_URL = shareUrl(VIA_WAYPOINTS);

/**
 * The transit-only addition to the benchmark's fixed conditions, built from
 * the same camera, clock and viewport as everything else. A→B here is the
 * ~950 m `TRANSIT_WAYPOINT` pair, above the 500 m gate that pulls the transit
 * graph in, unlike the walk-only pair above (deliberately ~340 m).
 */
function transitShareUrl(): string {
  const params =
    `lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
    `&date=2026-06-21&time=${START_TIME}` +
    `&a=${TRANSIT_WAYPOINT_A[0]},${TRANSIT_WAYPOINT_A[1]}` +
    `&b=${TRANSIT_WAYPOINT_B[0]},${TRANSIT_WAYPOINT_B[1]}`;
  return `/?${params}`;
}

export const TRANSIT_TWO_POINT_URL = transitShareUrl();

/**
 * Checkpoint 6 waypoint cases (pinned beside the fixture test that keeps them
 * inside each profile's verified support after the route bbox's ≥0.008°
 * padding): the longer-Manhattan pair rides the A4 `scale` fixture and select
 * all four cells; the cross-borough pair rides the `boroughs` fixture and
 * selects all eight.
 */
export const LONG_MANHATTAN_A: [number, number] = [-73.987002, 40.748925];
export const LONG_MANHATTAN_B: [number, number] = [-73.944346, 40.788168];
export const CROSS_BOROUGH_A: [number, number] = [-73.984336, 40.750143];
export const CROSS_BOROUGH_B: [number, number] = [-73.94168, 40.843454];

function benchPairUrl(a: [number, number], b: [number, number]): string {
  const params =
    `lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
    `&date=2026-06-21&time=${START_TIME}` +
    `&a=${a[0]},${a[1]}&b=${b[0]},${b[1]}`;
  return `/?${params}`;
}

export const LONG_MANHATTAN_URL = benchPairUrl(LONG_MANHATTAN_A, LONG_MANHATTAN_B);
export const CROSS_BOROUGH_URL = benchPairUrl(CROSS_BOROUGH_A, CROSS_BOROUGH_B);

/**
 * Repeat counts. Cold runs cost a full page load each — the map has to paint and
 * the shadow field has to settle before a calculation means anything — so they
 * are measured fewer times than warm ones and their spread is correspondingly
 * looser. Both are stated in the baseline note rather than averaged together.
 */
export const COLD_REPEATS = 5;
export const WARM_REPEATS = 10;

// ─── Stage A frozen diagnostic cases ─────────────────────────────────────────
//
// The routing-repair audit's five cases, frozen at 2026-09-20 09:00
// America/New_York exactly as the audit measured them. Every before/after
// comparison in the repair's benchmark rides these URLs, so a phase timing
// means the same route each time. The date is a Saturday — deliberately not
// the solstice pin above — because these are transit-behavior diagnostics
// first, and the day type is what the headway tables read.

export const DIAGNOSTIC_DATE = "2026-09-20";
export const DIAGNOSTIC_TIME = "09:00";

/** [lng, lat] pairs; the audit's table, verbatim. */
export const DIAGNOSTIC_CASES: Array<{
  name: string;
  a: [number, number];
  b: [number, number];
  /** What the audit measured on the audited revision, kept as the label. */
  audited: string;
}> = [
  {
    name: "midtown-normal",
    a: [-73.9871, 40.7518],
    b: [-73.9809, 40.7562],
    audited: "large data selection; a bus card exists",
  },
  {
    name: "village-eastbound",
    a: [-74.002, 40.731],
    b: [-73.99, 40.731],
    audited: "177.6-minute internal candidate",
  },
  {
    name: "midtown-eastbound",
    a: [-73.993, 40.752],
    b: [-73.981, 40.752],
    audited: "125.2-minute internal candidate",
  },
  {
    name: "midtown-westbound",
    a: [-73.981, 40.752],
    b: [-73.993, 40.752],
    audited: "five candidates miss an option found with twenty",
  },
  {
    name: "brooklyn-eastbound",
    a: [-73.986, 40.691],
    b: [-73.974, 40.691],
    audited: "five candidates miss an option found with twenty",
  },
];

function diagnosticUrl(a: [number, number], b: [number, number]): string {
  const params =
    `lat=${CENTER.lat}&lng=${CENTER.lng}&z=${CENTER.zoom}` +
    `&date=${DIAGNOSTIC_DATE}&time=${DIAGNOSTIC_TIME}` +
    `&a=${a[0]},${a[1]}&b=${b[0]},${b[1]}`;
  return `/?${params}`;
}

export const DIAGNOSTIC_URLS: Record<string, string> = Object.fromEntries(
  DIAGNOSTIC_CASES.map((c) => [c.name, diagnosticUrl(c.a, c.b)]),
);

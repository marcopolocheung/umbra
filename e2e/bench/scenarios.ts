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

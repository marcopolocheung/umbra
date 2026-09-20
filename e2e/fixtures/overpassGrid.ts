/**
 * A synthetic Overpass `out body geom` response: an 11×11 street grid over
 * midtown Manhattan, in the exact shape `fetchRoutingGraph` parses (way
 * elements with `nodes`, inline `geometry`, and `tags.highway`).
 *
 * The smoke test stubs Overpass with this rather than hitting the real API:
 * the public instance rate-limits, times out under load, and returns a
 * different graph every month. The road graph only has to exist and connect the
 * two waypoints; the buildings it is routed among come from `basemapStyle.ts`
 * (or, in the `smoke-live` project, from real MapTiler tiles).
 */

import { haversineMeters } from "../../app/lib/routing";
import type { GraphEdge, OsmNode, RoutingGraph } from "../../app/lib/routing";

const SOUTH = 40.7515;
const WEST = -73.9875;
const LAT_STEP = 0.0005; // ~55 m
const LNG_STEP = 0.0007; // ~59 m at this latitude
const ROWS = 11;
const COLS = 11;

interface OverpassGeom {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: OverpassGeom[];
  tags: { highway: string };
}

export const GRID_ROWS = ROWS;
export const GRID_COLS = COLS;

export const nodeId = (row: number, col: number) => 1_000_000 + row * 100 + col;
const lat = (row: number) => Number((SOUTH + row * LAT_STEP).toFixed(6));
const lon = (col: number) => Number((WEST + col * LNG_STEP).toFixed(6));

function buildGrid(): OverpassWay[] {
  const ways: OverpassWay[] = [];

  for (let row = 0; row < ROWS; row++) {
    ways.push({
      type: "way",
      id: 100 + row,
      nodes: Array.from({ length: COLS }, (_, col) => nodeId(row, col)),
      geometry: Array.from({ length: COLS }, (_, col) => ({ lat: lat(row), lon: lon(col) })),
      tags: { highway: "residential" },
    });
  }

  for (let col = 0; col < COLS; col++) {
    ways.push({
      type: "way",
      id: 200 + col,
      nodes: Array.from({ length: ROWS }, (_, row) => nodeId(row, col)),
      geometry: Array.from({ length: ROWS }, (_, row) => ({ lat: lat(row), lon: lon(col) })),
      tags: { highway: "footway" },
    });
  }

  return ways;
}

export const overpassGridResponse = JSON.stringify({ elements: buildGrid() });

/**
 * A city-scale grid for the Checkpoint 6 cross-borough fallback row: the same
 * 45 m lattice shape and extent (`LARGE_ROWS`/`LARGE_COLS`) the `boroughs`
 * navigation fixture generates for the static twin, so the static/fallback
 * comparison holds graph size constant. Distinct id space from the small
 * grid (which this file also serves) so the two can never collide inside the
 * Overpass module cache.
 */
export const LARGE_ROWS = 280;
export const LARGE_COLS = 120;
const LARGE_SOUTH = 40.74;
const LARGE_WEST = -73.995;
const largeNodeId = (row: number, col: number) => 5_000_000 + row * 1_000 + col;
const largeLat = (row: number) => Number((LARGE_SOUTH + row * LAT_STEP).toFixed(6));
const largeLon = (col: number) => Number((LARGE_WEST + col * LNG_STEP).toFixed(6));

function buildLargeGrid(): OverpassWay[] {
  const ways: OverpassWay[] = [];
  for (let row = 0; row < LARGE_ROWS; row++) {
    ways.push({
      type: "way",
      id: 900_000 + row,
      nodes: Array.from({ length: LARGE_COLS }, (_, col) => largeNodeId(row, col)),
      geometry: Array.from({ length: LARGE_COLS }, (_, col) => ({
        lat: largeLat(row),
        lon: largeLon(col),
      })),
      tags: { highway: "residential" },
    });
  }
  for (let col = 0; col < LARGE_COLS; col++) {
    ways.push({
      type: "way",
      id: 1_000_000 + col,
      nodes: Array.from({ length: LARGE_ROWS }, (_, row) => largeNodeId(row, col)),
      geometry: Array.from({ length: LARGE_ROWS }, (_, row) => ({
        lat: largeLat(row),
        lon: largeLon(col),
      })),
      tags: { highway: "footway" },
    });
  }
  return ways;
}

export const overpassGridResponseLarge = JSON.stringify({ elements: buildLargeGrid() });

/**
 * The same grid as a `RoutingGraph`, for the detour sweep in `e2e/bench/`.
 *
 * It is **constructed**, not parsed. `fetchRoutingGraph` holds the parser, and
 * `overpass.ts` reads `import.meta.env.DEV` at module scope, so importing it
 * outside a Vite build throws — a Playwright spec runs in plain Node. This
 * builds what that parser produces for this fixture: every node is shared by a
 * row way and a column way, so all of them are intersections; edges are
 * bidirectional; `shadowFactor` starts at 0 for the caller to fill in, exactly as
 * `fetchRoutingGraph` documents.
 *
 * The browser benchmark reports `graphNodeCount` and `graphDirectedEdges` from
 * the real parser on the same fixture, so the two can be compared rather than
 * assumed equal — the app fetches a bbox around its waypoints, not the whole
 * grid, and then doubles every edge into two sidewalks.
 */
export function overpassGridGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>();
  const adj = new Map<number, GraphEdge[]>();

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = nodeId(row, col);
      nodes.set(id, { id, lat: lat(row), lon: lon(col), isIntersection: true });
      adj.set(id, []);
    }
  }

  const link = (a: number, b: number, highway: string) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    const distanceM = haversineMeters([na.lon, na.lat], [nb.lon, nb.lat]);
    adj.get(a)!.push({ toId: b, distanceM, shadowFactor: 0, highway });
    adj.get(b)!.push({ toId: a, distanceM, shadowFactor: 0, highway });
  };

  // Row ways are `residential`, column ways `footway` — the tags buildGrid emits.
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col + 1 < COLS; col++) {
      link(nodeId(row, col), nodeId(row, col + 1), "residential");
    }
  }
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row + 1 < ROWS; row++) {
      link(nodeId(row, col), nodeId(row + 1, col), "footway");
    }
  }

  return { nodes, adj };
}

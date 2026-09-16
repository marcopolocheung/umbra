/**
 * Dynamic OSM-based train graph builder and router.
 * Fetches subway/light_rail/monorail route relations from Overpass API,
 * builds a station graph with transfer edges, and provides Dijkstra routing.
 * Works for any city — no hardcoded station data required.
 */

import { haversineMeters } from "./routing";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TrainMode = "subway" | "light_rail" | "monorail";

export interface TrainStation {
  /**
   * Namespaced, and opaque to every consumer: `osm:123456` from the Overpass
   * producer, `subway:127` from the published shards. Never parse it — the two
   * producers must be able to coexist without their ids colliding.
   */
  id: string;
  lat: number;
  lon: number;
  name: string;
  nameLocal?: string;
  lines: string[]; // line refs that serve this station
}

export interface TrainGraphEdge {
  to: string;
  weight: number; // meters
  type: "rail" | "transfer";
  line?: string;
}

export interface TrainGraph {
  stations: Map<string, TrainStation>;
  adj: Map<string, TrainGraphEdge[]>;
  lineColors: Map<string, string>;
  lineNames: Map<string, string>;
  lineModes: Map<string, TrainMode>;
}

// ─── Segment types for route visualization ──────────────────────────────────

export interface TrainRouteSegment {
  type: "train";
  from: { id: string; lat: number; lon: number; name: string };
  to: { id: string; lat: number; lon: number; name: string };
  line: string;
}

export interface TransferSegment {
  type: "transfer";
  at: { id: string; lat: number; lon: number; name: string };
  fromLine: string;
  toLine: string;
}

export type TrainSegment = TrainRouteSegment | TransferSegment;

// ─── Draw data for MapView rendering ─────────────────────────────────────────

export interface TrainDrawData {
  polylines: { coords: [number, number][]; color: string; line: string }[];
  stops: { id: string; lat: number; lon: number; name: string }[];
  transfers: { at: { id: string; lat: number; lon: number }; fromLine: string; toLine: string }[];
}

export interface TrainPathResult {
  stationIds: string[];
  totalDistM: number;
  lines: string[]; // unique lines in traversal order
  segments: TrainSegment[];
}

export interface BestTrainRoute {
  entryStation: TrainStation;
  exitStation: TrainStation;
  path: TrainPathResult;
  walkInDistM: number;
  walkOutDistM: number;
  totalCostM: number;
}

/** Sun exposure per mode: 0 = underground, 0.25 = windowed surface vehicle */
export const TRAIN_SUN_EXPOSURE: Record<TrainMode, number> = {
  subway: 0.0,
  light_rail: 0.25,
  monorail: 0.1,
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Flat stand-in for a change of line, in metres. Shared with the shard
 * producer so both price a transfer identically. */
export const TRANSFER_PENALTY_M = 300;
const INTERCHANGE_DIST_M = 150;
// Same-origin proxy (never overpass-api.de directly) — see app/lib/overpass.ts
// and api/overpass.js for why. Mirror fallback is handled server-side.
const OVERPASS_BASE = import.meta.env.DEV ? "/__overpass" : "/api/overpass";
const FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_COLORS = [
  "#0070BD",
  "#E3002C",
  "#008659",
  "#F8B61C",
  "#C48A00",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
];

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  south: number;
  west: number;
  north: number;
  east: number;
  graph: TrainGraph;
}

const graphCache: CacheEntry[] = [];
const CACHE_MAX = 3;

function cacheContains(
  e: CacheEntry,
  s: number,
  w: number,
  n: number,
  east: number
): boolean {
  return e.south <= s && e.west <= w && e.north >= n && e.east >= east;
}

// ─── Overpass helpers ───────────────────────────────────────────────────────

async function postOverpass(
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  // No User-Agent header — forbidden in browsers; the proxy sets one server-side.
  return fetch(OVERPASS_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal,
  });
}

// ─── OSM parsing ────────────────────────────────────────────────────────────

interface OSMElement {
  type: "node" | "relation" | "way";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  members?: Array<{ type: string; ref: number; role: string }>;
}

interface LineInfo {
  relationId: number;
  name: string;
  ref: string;
  colour: string;
  mode: TrainMode;
  stops: number[]; // ordered node IDs
}

function routeTagToMode(route: string): TrainMode {
  if (route === "light_rail") return "light_rail";
  if (route === "monorail") return "monorail";
  return "subway";
}

function parseOSMResponse(elements: OSMElement[]): {
  nodeIndex: Map<
    number,
    { lat: number; lon: number; tags: Record<string, string> }
  >;
  lines: LineInfo[];
} {
  // Step 1: Index all nodes by ID
  const nodeIndex = new Map<
    number,
    { lat: number; lon: number; tags: Record<string, string> }
  >();
  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) {
      nodeIndex.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags ?? {} });
    }
  }

  // Step 2: Extract station sequences from route relations
  const lines: LineInfo[] = [];
  for (const el of elements) {
    if (el.type !== "relation") continue;
    const tags = el.tags ?? {};
    const members = el.members ?? [];

    const stops: number[] = [];
    let prevRef: number | null = null;

    for (const m of members) {
      if (m.type !== "node") continue;

      // Accept explicit stop roles; for empty roles, verify station-like tags
      const isExplicitStop =
        m.role === "stop" ||
        m.role === "stop_exit_only" ||
        m.role === "stop_entry_only";

      if (!isExplicitStop && m.role !== "") continue;

      const node = nodeIndex.get(m.ref);
      if (!node) continue;

      // For empty role, require station-like tags
      if (!isExplicitStop) {
        const nt = node.tags;
        const isStation =
          nt.railway === "station" ||
          nt.railway === "halt" ||
          nt.public_transport === "stop_position" ||
          nt.station != null ||
          nt.name != null;
        if (!isStation) continue;
      }

      // Skip consecutive duplicates (but allow circular lines)
      if (m.ref === prevRef) continue;
      stops.push(m.ref);
      prevRef = m.ref;
    }

    if (stops.length < 2) continue;

    lines.push({
      relationId: el.id,
      name:
        tags.name ?? tags["name:en"] ?? `Line ${tags.ref ?? String(el.id)}`,
      ref: tags.ref ?? tags.name ?? String(el.id),
      colour: tags.colour ?? tags.color ?? "",
      mode: routeTagToMode(tags.route ?? "subway"),
      stops,
    });
  }

  return { nodeIndex, lines };
}

/** The Overpass producer's namespace, so its ids cannot collide with a shard's. */
function osmStationId(nodeId: number): string {
  return `osm:${nodeId}`;
}

function buildGraph(
  nodeIndex: Map<
    number,
    { lat: number; lon: number; tags: Record<string, string> }
  >,
  lines: LineInfo[]
): TrainGraph {
  const stations = new Map<string, TrainStation>();
  const adj = new Map<string, TrainGraphEdge[]>();
  const lineColors = new Map<string, string>();
  const lineNames = new Map<string, string>();
  const lineModes = new Map<string, TrainMode>();
  let colorIdx = 0;

  // Step 3: Build station registry — one entry per unique node ID
  for (const line of lines) {
    const ref = line.ref;
    if (!lineNames.has(ref)) lineNames.set(ref, line.name);
    if (!lineModes.has(ref)) lineModes.set(ref, line.mode);
    if (!lineColors.has(ref)) {
      lineColors.set(
        ref,
        line.colour || DEFAULT_COLORS[colorIdx++ % DEFAULT_COLORS.length]
      );
    }

    for (const nodeId of line.stops) {
      const node = nodeIndex.get(nodeId);
      if (!node) continue;
      const stationId = osmStationId(nodeId);
      if (!stations.has(stationId)) {
        stations.set(stationId, {
          id: stationId,
          lat: node.lat,
          lon: node.lon,
          name:
            node.tags.name ??
            node.tags["name:en"] ??
            `Station ${nodeId}`,
          nameLocal:
            node.tags["name:zh"] ??
            node.tags["name:ja"] ??
            node.tags["name:ko"] ??
            undefined,
          lines: [],
        });
      }
      const station = stations.get(stationId)!;
      if (!station.lines.includes(ref)) station.lines.push(ref);
    }
  }

  // Init adjacency lists
  for (const id of stations.keys()) adj.set(id, []);

  // Step 4: Line edges — connect consecutive stations bidirectionally
  for (const line of lines) {
    for (let i = 0; i < line.stops.length - 1; i++) {
      const fromId = osmStationId(line.stops[i]);
      const toId = osmStationId(line.stops[i + 1]);
      const a = stations.get(fromId);
      const b = stations.get(toId);
      if (!a || !b) continue;

      const dist = haversineMeters([a.lon, a.lat], [b.lon, b.lat]);

      adj
        .get(fromId)!
        .push({ to: toId, weight: dist, type: "rail", line: line.ref });
      adj
        .get(toId)!
        .push({ to: fromId, weight: dist, type: "rail", line: line.ref });
    }
  }

  // Step 5: Transfer edges for interchange stations
  // Pattern B: separate OSM nodes for the same physical station (same name, nearby)
  const stationList = Array.from(stations.values());
  for (let i = 0; i < stationList.length; i++) {
    for (let j = i + 1; j < stationList.length; j++) {
      const a = stationList[i];
      const b = stationList[j];
      if (a.name.toLowerCase() !== b.name.toLowerCase()) continue;
      const dist = haversineMeters([a.lon, a.lat], [b.lon, b.lat]);
      if (dist >= INTERCHANGE_DIST_M) continue;

      adj
        .get(a.id)!
        .push({ to: b.id, weight: TRANSFER_PENALTY_M, type: "transfer" });
      adj
        .get(b.id)!
        .push({ to: a.id, weight: TRANSFER_PENALTY_M, type: "transfer" });

      // Merge line sets for UI display
      for (const l of b.lines) if (!a.lines.includes(l)) a.lines.push(l);
      for (const l of a.lines) if (!b.lines.includes(l)) b.lines.push(l);
    }
  }

  return { stations, adj, lineColors, lineNames, lineModes };
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetches train route graph from Overpass for the given bbox.
 * Returns null if no transit routes found or on error (non-critical).
 * Results are cached by bbox.
 */
export async function fetchTrainGraph(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<TrainGraph | null> {
  for (const entry of graphCache) {
    if (cacheContains(entry, south, west, north, east)) return entry.graph;
  }

  const query =
    `[out:json][timeout:30];\n` +
    `rel["type"="route"]["route"~"^(subway|light_rail|monorail|metro)$"](${south},${west},${north},${east});\n` +
    `out body;\n` +
    `node(r);\n` +
    `out body;`;

  const encodedBody = `data=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  let res: Response;
  try {
    // The proxy handles the mirror fallback server-side.
    res = await postOverpass(encodedBody, combinedSignal);
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) return null;

  try {
    const text = await res.text();
    if (text.trimStart().startsWith("<")) return null;
    const json = JSON.parse(text) as { elements?: OSMElement[] };
    const elements = json.elements ?? [];

    const { nodeIndex, lines } = parseOSMResponse(elements);
    if (lines.length === 0) return null;

    const graph = buildGraph(nodeIndex, lines);
    if (graph.stations.size < 2) return null;

    graphCache.unshift({ south, west, north, east, graph });
    if (graphCache.length > CACHE_MAX) graphCache.pop();

    return graph;
  } catch {
    return null;
  }
}

// ─── Dijkstra ───────────────────────────────────────────────────────────────

/**
 * Shortest path on the train graph by distance.
 * Simple array-scan PQ — fine for metro-scale graphs (~200 stations).
 */
export function trainDijkstra(
  graph: TrainGraph,
  startId: string,
  endId: string
): TrainPathResult | null {
  if (startId === endId) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const prevLine = new Map<string, string>();
  const pq: { id: string; cost: number }[] = [];

  dist.set(startId, 0);
  pq.push({ id: startId, cost: 0 });

  while (pq.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[minIdx].cost) minIdx = i;
    }
    const { id, cost } = pq.splice(minIdx, 1)[0];

    if (cost > (dist.get(id) ?? Infinity)) continue;
    if (id === endId) break;

    for (const edge of graph.adj.get(id) ?? []) {
      const newCost = cost + edge.weight;
      if (newCost < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, newCost);
        prev.set(edge.to, id);
        prevLine.set(edge.to, edge.line ?? "");
        pq.push({ id: edge.to, cost: newCost });
      }
    }
  }

  if (!dist.has(endId)) return null;

  // Reconstruct path backward, collecting edge line refs
  const stationIds: string[] = [];
  const edgeLines: string[] = []; // one per edge (stationIds.length - 1)
  let cur: string | undefined = endId;
  while (cur !== undefined) {
    stationIds.push(cur);
    const line = prevLine.get(cur);
    if (line !== undefined) edgeLines.push(line); // skip start (no incoming edge)
    cur = prev.get(cur);
  }
  stationIds.reverse();
  edgeLines.reverse();

  // Unique line refs (non-empty = rail edges)
  const lines: string[] = [];
  for (const l of edgeLines) {
    if (l !== "" && !lines.includes(l)) lines.push(l);
  }

  // Build segments for visualization
  const segments: TrainSegment[] = [];
  for (let i = 0; i < edgeLines.length; i++) {
    const fromSt = graph.stations.get(stationIds[i])!;
    const toSt = graph.stations.get(stationIds[i + 1])!;
    const line = edgeLines[i];

    if (line === "") {
      // Transfer edge — find surrounding rail lines
      let fromLine = "";
      for (let j = i - 1; j >= 0; j--) {
        if (edgeLines[j] !== "") { fromLine = edgeLines[j]; break; }
      }
      let toLine = "";
      for (let j = i + 1; j < edgeLines.length; j++) {
        if (edgeLines[j] !== "") { toLine = edgeLines[j]; break; }
      }
      segments.push({
        type: "transfer",
        at: { id: fromSt.id, lat: fromSt.lat, lon: fromSt.lon, name: fromSt.name },
        fromLine,
        toLine,
      });
    } else {
      segments.push({
        type: "train",
        from: { id: fromSt.id, lat: fromSt.lat, lon: fromSt.lon, name: fromSt.name },
        to: { id: toSt.id, lat: toSt.lat, lon: toSt.lon, name: toSt.name },
        line,
      });
    }
  }

  return { stationIds, totalDistM: dist.get(endId)!, lines, segments };
}

// ─── Nearest station lookup ─────────────────────────────────────────────────

export function nearestStations(
  coord: [number, number], // [lng, lat]
  stations: Map<string, TrainStation>,
  n: number,
  maxDistM = 2000
): TrainStation[] {
  const withDist: { station: TrainStation; dist: number }[] = [];
  for (const station of stations.values()) {
    const d = haversineMeters(coord, [station.lon, station.lat]);
    if (d <= maxDistM) withDist.push({ station, dist: d });
  }
  withDist.sort((a, b) => a.dist - b.dist);
  return withDist.slice(0, n).map((w) => w.station);
}

// ─── Best route finder ──────────────────────────────────────────────────────

/**
 * Finds the optimal Walk → Train → Walk route between two points.
 * Tries N nearest entry stations × N nearest exit stations, picks lowest cost.
 * Returns null if no viable train route exists.
 */
export function findBestTrainRoute(
  a: [number, number], // [lng, lat]
  b: [number, number],
  graph: TrainGraph,
  maxWalkM = 1500,
  maxCandidates = 5
): BestTrainRoute | null {
  const entryCandidates = nearestStations(
    a,
    graph.stations,
    maxCandidates,
    maxWalkM
  );
  const exitCandidates = nearestStations(
    b,
    graph.stations,
    maxCandidates,
    maxWalkM
  );

  if (entryCandidates.length === 0 || exitCandidates.length === 0) return null;

  let bestRoute: BestTrainRoute | null = null;
  let bestCost = Infinity;

  for (const entry of entryCandidates) {
    for (const exit of exitCandidates) {
      if (entry.id === exit.id) continue;

      const path = trainDijkstra(graph, entry.id, exit.id);
      if (!path) continue;

      // Need at least 3 stations (entry + 1 intermediate + exit) to be useful
      if (path.stationIds.length < 3) continue;

      const walkIn = haversineMeters(a, [entry.lon, entry.lat]);
      const walkOut = haversineMeters([exit.lon, exit.lat], b);
      const totalCost = walkIn + path.totalDistM + walkOut;

      if (totalCost < bestCost) {
        bestCost = totalCost;
        bestRoute = {
          entryStation: entry,
          exitStation: exit,
          path,
          walkInDistM: walkIn,
          walkOutDistM: walkOut,
          totalCostM: totalCost,
        };
      }
    }
  }

  return bestRoute;
}

// ─── Entrance matching ──────────────────────────────────────────────────────

/**
 * Match an OSM entrance node to the nearest train station.
 * Tries name match first, then nearest-centroid fallback within 300m.
 */
export function matchEntranceToTrainStation(
  entrance: { lat: number; lon: number; name?: string },
  stations: Map<string, TrainStation>
): string | null {
  if (entrance.name) {
    const eName = entrance.name.toLowerCase();
    for (const [id, station] of stations) {
      if (
        eName.includes(station.name.toLowerCase()) ||
        (station.nameLocal && entrance.name.includes(station.nameLocal))
      ) {
        return id;
      }
    }
  }

  let bestId: string | null = null;
  let bestDist = 300;
  for (const [id, station] of stations) {
    const dist = haversineMeters(
      [entrance.lon, entrance.lat],
      [station.lon, station.lat]
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestId = id;
    }
  }
  return bestId;
}

// ─── Draw data builder ──────────────────────────────────────────────────────

/**
 * Transform route segments into map draw data (polylines, stops, transfers).
 * Separates routing logic from render logic.
 */
export function buildTrainDrawData(
  segments: TrainSegment[],
  lineColors: Map<string, string>
): TrainDrawData {
  const polylines: TrainDrawData["polylines"] = [];
  const stops: TrainDrawData["stops"] = [];
  const transfers: TrainDrawData["transfers"] = [];

  for (const seg of segments) {
    if (seg.type === "train") {
      polylines.push({
        coords: [
          [seg.from.lon, seg.from.lat],
          [seg.to.lon, seg.to.lat],
        ],
        color: lineColors.get(seg.line) ?? "#888888",
        line: seg.line,
      });
      stops.push({ id: seg.from.id, lat: seg.from.lat, lon: seg.from.lon, name: seg.from.name });
      stops.push({ id: seg.to.id, lat: seg.to.lat, lon: seg.to.lon, name: seg.to.name });
    }

    if (seg.type === "transfer") {
      transfers.push({
        at: { id: seg.at.id, lat: seg.at.lat, lon: seg.at.lon },
        fromLine: seg.fromLine,
        toLine: seg.toLine,
      });
    }
  }

  // Deduplicate stops by id
  const seen = new Set<string>();
  const uniqueStops = stops.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  return { polylines, stops: uniqueStops, transfers };
}

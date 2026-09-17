/**
 * Dynamic OSM-based train graph builder and router.
 * Fetches subway/light_rail/monorail route relations from Overpass API,
 * builds a station graph with transfer edges, and provides Dijkstra routing.
 * Works for any city — no hardcoded station data required.
 */

import { haversineMeters } from "./routing";
import { toMapLocal } from "./timezone";
import { travelTimeSeconds } from "./travelMode";

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
  /**
   * The feed's own cost of changing lines inside this station, in seconds.
   * **Absent is not zero** — 0 is a real value at the 57 cross-platform
   * interchanges, while 33 stations publish no change cost at all and nothing
   * may substitute one (#384). The Overpass producer never has it.
   */
  changeSec?: number;
}

/**
 * Where a rail hop runs, as shares of the hop that sum to **at most** 1; the
 * shortfall is the part the producer could not determine. Structurally the
 * shard's `EdgeStructure`, redeclared here so `trainGraph` stays independent of
 * the NYC shard contract — the Overpass producer supplies none of it.
 */
export type TrainEdgeStructure = Partial<
  Record<"underground" | "elevated" | "open_cut" | "embankment" | "at_grade", number>
>;

export interface TrainGraphEdge {
  to: string;
  /**
   * Seconds. The shards publish a scheduled `medianSec` per stop pair; the
   * Overpass producer, which has only geometry, divides distance by
   * `TRAIN_SPEED_MPS`. Both must be seconds, because a transit leg is compared
   * against a walk and the two are only commensurable in time.
   */
  weightSec: number;
  type: "rail" | "transfer";
  line?: string;
  /**
   * Which direction of `line` this hop runs, as the feed numbers them. It is
   * what the headway tables are keyed by, because a platform waits for trains
   * going one way. Absent from the Overpass producer, which has no timetable.
   */
  direction?: number;
  /**
   * Published per-segment structure (#393). Absent from the Overpass producer
   * and from any generation built before the OSM join, and absence means
   * **unknown** — never "underground".
   */
  structure?: TrainEdgeStructure;
}

/**
 * What the timetable behind a transit answer actually is.
 *
 * The published manifest carries honesty statements and a feed window
 * explicitly so a client can surface them — `shardContract.ts` calls `notes`
 * "the honesty statements the transit card has to surface. Never drop these."
 * They were parsed and thrown away (#410), so the card quoted a wait with none
 * of its caveats. Absent for the Overpass producer, which publishes no
 * timetable and therefore makes none of these claims.
 */
export interface TransitProvenance {
  /** Content-addressed generation the answer came from. */
  generation: string;
  /** The producer's own statements, verbatim. Never paraphrase these. */
  notes: string[];
  /** Per-dataset feed window, GTFS `YYYYMMDD`. */
  schedulesAsOf: Record<string, { version: string; startDate: string; endDate: string }>;
}

export interface TrainGraph {
  stations: Map<string, TrainStation>;
  adj: Map<string, TrainGraphEdge[]>;
  lineColors: Map<string, string>;
  lineNames: Map<string, string>;
  lineModes: Map<string, TrainMode>;
  /** Published waits. Absent from the Overpass producer, which prices none. */
  headways?: TrainHeadways;
  /** Where the timetable came from, for the card to state (#410). */
  provenance?: TransitProvenance;
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
  /** Scheduled riding, changing lines, and waiting to board. */
  totalSec: number;
  /**
   * The waiting half of `totalSec`: half a published headway per boarding. 0
   * when the feed publishes no headway for what was boarded — which is not a
   * claim that a train was there, only that the wait went unpriced.
   */
  waitSec: number;
  lines: string[]; // unique lines in traversal order
  segments: TrainSegment[];
  /**
   * Measured from the published per-segment structure (#393), or absent when
   * none of the hops carries it — in which case the caller falls back to the
   * per-mode constant and must say the figure is assumed.
   */
  exposure?: RailExposure;
}

export interface BestTrainRoute {
  entryStation: TrainStation;
  exitStation: TrainStation;
  path: TrainPathResult;
  walkInDistM: number;
  walkOutDistM: number;
  /** Door-to-door seconds: the two walks plus the ride. */
  totalCostSec: number;
}

/**
 * Sun exposure per mode — the **fallback** when no per-segment structure is
 * published: the Overpass producer, and any generation built before the OSM
 * join. `subway: 0.0` is exactly the claim #393 was opened against, so it is
 * used only where nothing better exists, and the label says it is assumed.
 */
export const TRAIN_SUN_EXPOSURE: Record<TrainMode, number> = {
  subway: 0.0,
  light_rail: 0.25,
  monorail: 0.1,
};

/**
 * Only `underground` is enclosed. An open cut and an embankment are open to the
 * sky, and no constant is invented for them: we do not model the shade a
 * retaining wall casts, any more than we model the buildings beside an elevated
 * line. It overstates sun in a cut, which under-rates a shaded option rather
 * than promising shade that is not there.
 */
function openToSkyShare(structure: TrainEdgeStructure): { open: number; known: number } {
  let open = 0;
  let known = 0;
  for (const [kind, share] of Object.entries(structure)) {
    known += share;
    if (kind !== "underground") open += share;
  }
  return { open, known };
}

/**
 * How much of a pedestrian's sun a seated rail passenger actually takes.
 *
 * A viaduct is open to the sky, but the rider is behind glass, under a roof,
 * moving, and can move within the car. Treating an elevated ride as *equal* to
 * standing on a pavement in full sun overstates it badly.
 *
 * 0.25 is not a new number: it is this codebase's existing
 * `TRAIN_SUN_EXPOSURE.light_rail`, whose comment has always read "windowed
 * surface vehicle". The measurement (#393) changed which segments are open to
 * the sky and how that varies along a ride; it did not change what sitting in a
 * train car is like, and should not have silently redefined it as 1.0.
 *
 * **Not for buses.** A bus rider's exposure is dominated by the wait at an
 * unsheltered stop, which is unattenuated pedestrian sun and is not a property
 * of any track. Bus needs its own model, not this constant (3C).
 */
export const RAIL_VEHICLE_EXPOSURE = 0.25;

export interface RailExposure {
  /**
   * Share of the *determined* riding time whose track is open to the sky.
   *
   * A fact about the track, not about the rider — it is what a passenger can
   * check by looking out of the window, and it is what the card states.
   */
  aboveGroundShare: number;
  /**
   * Modelled rider exposure: `aboveGroundShare` attenuated by
   * `RAIL_VEHICLE_EXPOSURE`. A measured fact times a model constant, which is
   * why the two are kept apart rather than collapsed into one number.
   */
  sunExposure: number;
  /** Share of riding time that had any determination at all. */
  coverage: number;
}

/**
 * Sun exposure over the rail hops of a path, weighted by **time**.
 *
 * Time, not distance: a rider's dose is how long they sit in the sun, and a
 * slow elevated crawl is more exposure than a fast tunnel run of the same
 * length. `weightSec` is already on every edge.
 *
 * Returns `null` when no hop carries structure, so the caller falls back to the
 * per-mode constant rather than reporting a measurement of nothing. `coverage`
 * is what the card needs to avoid quoting a figure for a ride it mostly cannot
 * see.
 */
/**
 * **Rail only — buses must not use this.** A bus rider's exposure is dominated
 * by the wait at the stop, which is unsheltered pedestrian sun and is not a
 * property of any track; and a bus is at grade everywhere, so a structure share
 * would be a constant 1 carrying no information. 3C needs its own model, not a
 * generalisation of this one.
 */
export function railExposure(
  graph: TrainGraph,
  stationIds: string[],
  edgeLines: string[],
): RailExposure | null {
  let openSec = 0;
  let knownSec = 0;
  let railSec = 0;

  for (let i = 0; i < edgeLines.length; i += 1) {
    const line = edgeLines[i];
    if (line === "") continue; // transfer: no ride, no exposure
    const edge = graph.adj
      .get(stationIds[i] as string)
      ?.find((candidate) => candidate.to === stationIds[i + 1] && candidate.line === line);
    if (!edge) continue;
    railSec += edge.weightSec;
    if (!edge.structure) continue;
    const { open, known } = openToSkyShare(edge.structure);
    openSec += edge.weightSec * open;
    knownSec += edge.weightSec * known;
  }

  if (railSec <= 0 || knownSec <= 0) return null;
  const aboveGroundShare = openSec / knownSec;
  return {
    aboveGroundShare,
    sunExposure: aboveGroundShare * RAIL_VEHICLE_EXPOSURE,
    coverage: Math.min(1, knownSec / railSec),
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * What a change of line costs when nothing better is published, in seconds.
 * 180 s is the modal `min_transfer_time` in the NYC subway feed, so it is a
 * measured interchange rather than the flat 300 m it replaces — which was never
 * a distance anybody walked.
 */
export const TRANSFER_PENALTY_SEC = 180;

/**
 * 30 km/h, the figure `useRouting` already used to turn a transit leg's length
 * into a duration. It is the Overpass producer's only option: OSM route
 * relations carry geometry and no timetable.
 */
export const TRAIN_SPEED_MPS = (30 * 1000) / 3600;
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

// ─── Service day and headways ───────────────────────────────────────────────

/** The three schedules the published headway tables are keyed by. */
export type TrainDayType = "weekday" | "saturday" | "sunday";

/**
 * Published waits, as the shards ship them.
 *
 * Keyed by the route **and direction** boarded, because a platform waits for
 * trains going one way and the tables are published that way. A wait is priced
 * only where the agency published one for that exact key: borrowing the
 * opposite direction's number, or a neighbouring hour's, would invent a
 * frequency nobody scheduled, which is the same rule `changeSec` follows.
 */
export interface TrainHeadways {
  /** `route|direction|dayType|hour` → published median headway, in seconds. */
  medianSec: Map<string, number>;
  /**
   * `dayType|hour` for every hour the tables describe at all. It is what makes
   * a missing row readable: inside a covered hour, no row means the schedule
   * lists no trips — the Z runs two hours a day and the FX none at all on a
   * weekday — while an hour with no rows for anyone is an hour the published
   * data simply does not reach, and says nothing about anybody.
   */
  coveredHours: Set<string>;
  /**
   * Which day type each table's hours 24+ describe, out of the manifest's
   * `headwayDates`. Saturday's hour 24 is a Sunday morning; the weekday
   * table's is a weekday morning, so it cannot price a Saturday one.
   */
  nextDayType: Map<TrainDayType, TrainDayType>;
}

export function headwayKey(
  route: string,
  direction: number,
  dayType: TrainDayType,
  hour: number
): string {
  return `${route}|${direction}|${dayType}|${hour}`;
}

/** When and where the rider boards, for reading the service-day headway. */
export interface TrainDepartureOptions {
  /**
   * Departure instant. Every boarding on the path is priced at it rather than
   * at the time the rider would really reach that platform: the tables are
   * hourly and a subway trip rarely outlives the hour it started in.
   */
  at?: Date;
  /**
   * Minutes east of UTC **where the rider boards** — `zoneAt` plus
   * `utcOffsetMinAt`, not the browser's own offset. Planning an NYC trip from
   * Berlin must not read Berlin's hour off a New York timetable.
   */
  utcOffsetMin?: number;
}

/**
 * GTFS counts the small hours as the tail of the previous day's service, which
 * is what hours 24-27 mean. Four in the morning is where the feed's own
 * patterns change over.
 */
const SERVICE_DAY_START_HOUR = 4;

/**
 * The last hour the published tables describe completely enough to argue *from*.
 *
 * Their overnight tail does not. The weekday table lists nine route-directions
 * at hour 24 and nothing at all at 25-27, while the subway runs all night — so
 * an hour-24 headway is still the agency's own number and is charged, but its
 * silence is ignorance rather than a timetable. Inferring "no service" from it
 * stranded 36 of 65 sampled trips with no transit option at half past midnight.
 */
const LAST_COMPLETE_SERVICE_HOUR = 23;

function dayTypeOfWeekday(dow: number): TrainDayType {
  if (dow === 0) return "sunday";
  if (dow === 6) return "saturday";
  return "weekday";
}

/**
 * The table and hour that describe an instant, or `null` when none does.
 *
 * Two published buckets cover a calendar morning — a table's own hours 0-3, and
 * the previous service day's hours 24-27 — and they are different service days
 * that may not be merged (#383). This reads the second, the encoding the
 * manifest documents and the one NYC's overnight service actually uses (the 7
 * ships hour 1 at 1200 s against hour 24 at 570 s), and leaves the tables' own
 * hours 0-3 unread rather than adding them to it.
 *
 * It refuses outright when the previous day's table does not describe this
 * morning: the weekday table's hour 24 is a Thursday morning, so nothing in it
 * can price a Saturday one.
 */
export function serviceDayHour(
  at: Date,
  utcOffsetMin: number,
  nextDayType: Map<TrainDayType, TrainDayType>
): { dayType: TrainDayType; hour: number } | null {
  const { hours, year, month, day } = toMapLocal(at, utcOffsetMin);
  const today = dayTypeOfWeekday(new Date(Date.UTC(year, month, day)).getUTCDay());
  if (hours >= SERVICE_DAY_START_HOUR) return { dayType: today, hour: hours };

  const yesterday = dayTypeOfWeekday(new Date(Date.UTC(year, month, day - 1)).getUTCDay());
  if (nextDayType.get(yesterday) !== today) return null;
  return { dayType: yesterday, hour: hours + 24 };
}

/**
 * What the published tables say about boarding a route at an instant.
 *
 * `no-service` and `unreadable` are different answers, and collapsing them into
 * "no wait" is the trap. Charging nothing for a train that is not running makes
 * it the cheapest edge in the graph, and the router boards it by preference:
 * measured on the real feed, a 10 a.m. Times Sq → Grand Central trip took the
 * peak-only `7X` — which publishes no trips at that hour — over the shuttle.
 */
export type HeadwayReading =
  | { kind: "published"; medianSec: number }
  | { kind: "no-service" }
  | { kind: "unreadable" };

export function readHeadway(
  headways: TrainHeadways | undefined,
  route: string,
  direction: number | undefined,
  at: Date,
  utcOffsetMin: number
): HeadwayReading {
  // The Overpass producer ships no timetable, and its rail edges carry no
  // direction: nothing here can speak for or against boarding one.
  if (!headways || direction === undefined) return { kind: "unreadable" };
  const slot = serviceDayHour(at, utcOffsetMin, headways.nextDayType);
  if (!slot) return { kind: "unreadable" };

  const medianSec = headways.medianSec.get(
    headwayKey(route, direction, slot.dayType, slot.hour)
  );
  if (medianSec !== undefined) return { kind: "published", medianSec };
  if (slot.hour > LAST_COMPLETE_SERVICE_HOUR) return { kind: "unreadable" };
  if (!headways.coveredHours.has(`${slot.dayType}|${slot.hour}`)) return { kind: "unreadable" };
  return { kind: "no-service" };
}

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
      const weightSec = dist / TRAIN_SPEED_MPS;

      adj
        .get(fromId)!
        .push({ to: toId, weightSec, type: "rail", line: line.ref });
      adj
        .get(toId)!
        .push({ to: fromId, weightSec, type: "rail", line: line.ref });
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
        .push({ to: b.id, weightSec: TRANSFER_PENALTY_SEC, type: "transfer" });
      adj
        .get(b.id)!
        .push({ to: a.id, weightSec: TRANSFER_PENALTY_SEC, type: "transfer" });

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

/** Search-state key: station id, this separator, then what the rider arrived on. */
const STATE_SEP = "\u0000";
/** On the street, not yet boarded anything. */
const ARRIVED_ON_FOOT = "";
/** Arrived over a transfer edge, whose `minSec` already paid for the change. */
const ARRIVED_BY_TRANSFER = "\u0001";

function stateKey(stationId: string, arrivedOn: string): string {
  return `${stationId}${STATE_SEP}${arrivedOn}`;
}

function stationOfState(key: string): string {
  return key.slice(0, key.indexOf(STATE_SEP));
}

function arrivalOfState(key: string): string {
  return key.slice(key.indexOf(STATE_SEP) + 1);
}

/**
 * What boarding `edge` costs, having arrived on `arrivedOn`, or `null` when it
 * cannot be boarded at all because nothing is scheduled to turn up.
 *
 * Nothing at all if it is the route already being ridden. Otherwise half a
 * headway — the expected wait for an unsynchronised arrival at an
 * unsynchronised service — plus, when the change happens inside one station
 * node, the feed's own `changeSec` for it. A change made *over* a transfer edge
 * has already paid the agency's `min_transfer_time` in that edge's weight, and
 * walking in off the street at the start of the journey is not a change.
 */
function boardingCost(
  graph: TrainGraph,
  stationId: string,
  arrivedOn: string,
  edge: TrainGraphEdge,
  opts: TrainDepartureOptions
): { changeSec: number; waitSec: number } | null {
  if (edge.type !== "rail") return { changeSec: 0, waitSec: 0 };
  const route = edge.line ?? "";
  if (arrivedOn === route) return { changeSec: 0, waitSec: 0 };

  const changingLines = arrivedOn !== ARRIVED_ON_FOOT && arrivedOn !== ARRIVED_BY_TRANSFER;
  // Absent `changeSec` costs nothing here because it is *unpriced*, not free.
  // The alternative is to make a number up, which is what #384 forbids.
  const changeSec = changingLines ? (graph.stations.get(stationId)?.changeSec ?? 0) : 0;

  if (!opts.at || opts.utcOffsetMin === undefined) return { changeSec, waitSec: 0 };
  const reading = readHeadway(graph.headways, route, edge.direction, opts.at, opts.utcOffsetMin);
  // The schedule reaches this hour and lists nothing: there is no train to get
  // on, so this is not an edge the rider can use at this time.
  if (reading.kind === "no-service") return null;
  // Nothing readable — Overpass, or an hour no published table describes. The
  // wait goes unpriced, which is where it stood before any of this.
  if (reading.kind === "unreadable") return { changeSec, waitSec: 0 };
  return { changeSec, waitSec: reading.medianSec / 2 };
}

/**
 * Fastest path on the train graph, in seconds.
 *
 * The state is `(station, what the rider arrived on)`, not the station alone. A
 * station-keyed search cannot see a change of line made inside one node — no
 * transfer edge is traversed going from the N to the Q at Union Sq — so it
 * charged nothing for one, and it could not charge a wait that depends on which
 * route is boarded either. The states are the (station, route) pairs some edge
 * actually serves, 956 of them for the published NYC subway against its 496
 * stations, so the array-scan PQ still holds.
 */
export function trainDijkstra(
  graph: TrainGraph,
  startId: string,
  endId: string,
  opts: TrainDepartureOptions = {}
): TrainPathResult | null {
  if (startId === endId) return null;

  const dist = new Map<string, number>();
  const waitTo = new Map<string, number>();
  const prev = new Map<string, string>();
  const prevLine = new Map<string, string>();
  const pq: { key: string; cost: number }[] = [];

  const startKey = stateKey(startId, ARRIVED_ON_FOOT);
  dist.set(startKey, 0);
  waitTo.set(startKey, 0);
  pq.push({ key: startKey, cost: 0 });

  let endKey: string | null = null;

  while (pq.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[minIdx].cost) minIdx = i;
    }
    const { key, cost } = pq.splice(minIdx, 1)[0];

    if (cost > (dist.get(key) ?? Infinity)) continue;
    const id = stationOfState(key);
    // States pop in cost order, so the first one standing at the destination is
    // the cheapest way to be standing there, whatever it arrived on.
    if (id === endId) {
      endKey = key;
      break;
    }
    const arrivedOn = arrivalOfState(key);

    for (const edge of graph.adj.get(id) ?? []) {
      const boarding = boardingCost(graph, id, arrivedOn, edge, opts);
      if (boarding === null) continue;
      const newCost = cost + edge.weightSec + boarding.changeSec + boarding.waitSec;
      const nextKey = stateKey(
        edge.to,
        edge.type === "transfer" ? ARRIVED_BY_TRANSFER : (edge.line ?? ARRIVED_ON_FOOT)
      );
      if (newCost < (dist.get(nextKey) ?? Infinity)) {
        dist.set(nextKey, newCost);
        waitTo.set(nextKey, (waitTo.get(key) ?? 0) + boarding.waitSec);
        prev.set(nextKey, key);
        prevLine.set(nextKey, edge.line ?? "");
        pq.push({ key: nextKey, cost: newCost });
      }
    }
  }

  if (endKey === null) return null;

  // Reconstruct path backward, collecting edge line refs
  const stationIds: string[] = [];
  const edgeLines: string[] = []; // one per edge (stationIds.length - 1)
  let cur: string | undefined = endKey;
  while (cur !== undefined) {
    stationIds.push(stationOfState(cur));
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

  const exposure = railExposure(graph, stationIds, edgeLines);

  return {
    stationIds,
    totalSec: dist.get(endKey)!,
    waitSec: waitTo.get(endKey) ?? 0,
    lines,
    segments,
    ...(exposure ? { exposure } : {}),
  };
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
 * Finds the fastest Walk → Train → Walk route between two points.
 * Tries N nearest entry stations × N nearest exit stations, picks lowest cost.
 * Returns null if no viable train route exists.
 *
 * With `opts`, the ride each candidate is judged on includes the wait to board,
 * so a longer walk to a more frequent line can now win — which is the point of
 * pricing the wait at all.
 */
export function findBestTrainRoute(
  a: [number, number], // [lng, lat]
  b: [number, number],
  graph: TrainGraph,
  maxWalkM = 1500,
  maxCandidates = 5,
  opts: TrainDepartureOptions = {}
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

      const path = trainDijkstra(graph, entry.id, exit.id, opts);
      if (!path) continue;

      // Need at least 3 stations (entry + 1 intermediate + exit) to be useful
      if (path.stationIds.length < 3) continue;

      const walkIn = haversineMeters(a, [entry.lon, entry.lat]);
      const walkOut = haversineMeters([exit.lon, exit.lat], b);
      // Both walks are straight-line here; the real street paths are routed
      // once, for the winner. Comparing candidates needs them in seconds,
      // because the ride is now seconds and the two used to be added as if a
      // metre walked and a metre ridden cost the same.
      const totalCost =
        travelTimeSeconds(walkIn, "walk") + path.totalSec + travelTimeSeconds(walkOut, "walk");

      if (totalCost < bestCost) {
        bestCost = totalCost;
        bestRoute = {
          entryStation: entry,
          exitStation: exit,
          path,
          walkInDistM: walkIn,
          walkOutDistM: walkOut,
          totalCostSec: totalCost,
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
 *
 * **The name arm is bounded by distance, and must be.** It is a substring test,
 * so short station names match wildly: `Wall St` is a substring of
 * `Christopher Street-Stonewall Station` 3 km away, and a station simply named
 * `Broadway` matches an entrance 9 km up the same street. Unbounded, the first
 * such hit wins by map order and — because `useRouting` only falls back to a
 * centroid for stations with *no* entrance — it silently replaces that
 * station's position with a door in another neighbourhood.
 */
/**
 * The furthest an entrance can be from its station and still match. Exported
 * because it also sizes the Overpass box the entrances are fetched in — asking
 * for a wider box than the matcher will ever accept is waste.
 */
export const ENTRANCE_MATCH_MAX_M = 400;

export function matchEntranceToTrainStation(
  entrance: { lat: number; lon: number; name?: string },
  stations: Map<string, TrainStation>
): string | null {
  if (entrance.name) {
    const eName = entrance.name.toLowerCase();
    // Nearest name match, not the first: several stations legitimately share a
    // name, and only one of them owns this door.
    let bestNamedId: string | null = null;
    let bestNamedDist = ENTRANCE_MATCH_MAX_M;
    for (const [id, station] of stations) {
      if (
        !(
          eName.includes(station.name.toLowerCase()) ||
          (station.nameLocal && entrance.name.includes(station.nameLocal))
        )
      )
        continue;
      const dist = haversineMeters(
        [entrance.lon, entrance.lat],
        [station.lon, station.lat]
      );
      if (dist < bestNamedDist) {
        bestNamedDist = dist;
        bestNamedId = id;
      }
    }
    if (bestNamedId !== null) return bestNamedId;
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

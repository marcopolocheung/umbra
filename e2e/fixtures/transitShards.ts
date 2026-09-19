/**
 * A synthetic published transit dataset: pointer → manifest → one subway shard,
 * in the exact shape `app/lib/transit/shardContract.ts` parses.
 *
 * The client verifies every hop against the digest the previous one published,
 * so the digests here are **computed from the exact bytes served**. Hand-written
 * hashes would fail the byte-contract check, which is the point of it.
 *
 * Three stations on one line, laid over the same midtown grid as
 * `overpassGrid.ts`, far enough apart that the pipeline looks for a transit
 * option at all (it skips under 500 m).
 */

import { createHash } from "node:crypto";

/** A colour nothing else on the map uses, so the drawn line is unmistakable. */
export const TRANSIT_LINE_COLOR = "FF00FF";

const GENERATION = "nyc-2026-09-16-abcdef123456";

// Every stop publishes its doors (#430), so the client never asks Overpass for
// them; Grid Middle publishes none, the "OSM maps no door here" answer.
const stops = [
  {
    id: "subway:E1",
    name: "Grid South",
    lat: 40.7519,
    lon: -73.987,
    changeSec: 180,
    entrances: [{ lat: 40.7516, lon: -73.9873 }],
  },
  { id: "subway:E2", name: "Grid Middle", lat: 40.754, lon: -73.984, changeSec: 0, entrances: [] },
  {
    id: "subway:E3",
    name: "Grid North",
    lat: 40.7561,
    lon: -73.9811,
    entrances: [{ lat: 40.7564, lon: -73.9808 }],
  },
];

const edge = (from: string, to: string, direction: number, geom?: string) => ({
  from,
  to,
  route: "E",
  direction,
  medianSec: 90,
  trips: 100,
  distM: 400,
  ...(geom ? { geom } : {}),
});

// A deliberate dogleg on the southbound first hop: one interior point pushed
// ~200 m off the E1→E2 chord. Encoded once with the producer's precision-5
// encoder; pasted as a literal. It proves the client decode path runs in a
// real browser without throwing and the line still paints — the smoke test
// only counts magenta pixels, so shape is not what it guards.
const E1_E2_DOGLEG = "ktvwFz{pbM"; // (40.7535, -73.9835)

const shard = {
  kind: "subway",
  feed: { id: "subway", version: "e2e", startDate: "20260101", endDate: "20270101" },
  stops,
  edges: [
    edge("subway:E1", "subway:E2", 0, E1_E2_DOGLEG),
    edge("subway:E2", "subway:E1", 1),
    edge("subway:E2", "subway:E3", 0),
    edge("subway:E3", "subway:E2", 1),
  ],
  routes: [
    {
      id: "E",
      shortName: "E",
      longName: "E2E Line",
      type: 1,
      color: TRANSIT_LINE_COLOR,
      textColor: "FFFFFF",
    },
  ],
  // `SHARE_URL` pins 2026-06-21 at 09:00, which is a **Sunday** — so the Sunday
  // rows are the ones the router reads, and the weekday row beside them is what
  // proves it is reading the right day type rather than the first row it finds.
  // Both directions, because a row missing for the direction being boarded is
  // read as "no trips scheduled" and refuses the boarding outright.
  headways: [
    {
      route: "E",
      direction: 0,
      dayType: "weekday",
      hour: 9,
      medianSec: 300,
      trips: 12,
      services: 1,
    },
    { route: "E", direction: 0, dayType: "sunday", hour: 9, medianSec: 600, trips: 6, services: 1 },
    { route: "E", direction: 1, dayType: "sunday", hour: 9, medianSec: 600, trips: 6, services: 1 },
  ],
  transfers: [],
};

const sha256 = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

export const transitShardJson = JSON.stringify(shard);

const manifest = {
  generation: GENERATION,
  createdAt: "2026-09-16T00:00:00.000Z",
  schedulesAsOf: { subway: { version: "e2e", startDate: "20260101", endDate: "20270101" } },
  headwayDates: {
    referenceDate: "20260916",
    subway: {
      weekday: {
        date: "20260916",
        nextDate: "20260917",
        nextDayType: "weekday",
        matchingDates: 1,
        candidateDates: 1,
      },
      sunday: {
        date: "20260920",
        nextDate: "20260921",
        nextDayType: "weekday",
        matchingDates: 1,
        candidateDates: 1,
      },
    },
  },
  feeds: [
    {
      id: "subway",
      version: "e2e",
      startDate: "20260101",
      endDate: "20270101",
      sha256: "0".repeat(64),
    },
  ],
  shards: [
    {
      key: "subway.json",
      bytes: Buffer.byteLength(transitShardJson, "utf8"),
      sha256: sha256(transitShardJson),
      stops: shard.stops.length,
      edges: shard.edges.length,
      routes: shard.routes.length,
    },
  ],
  budgets: { shardBytes: 3_000_000, totalBytes: 15_000_000 },
  constants: { spatialWalkMps: 1.4 },
  notes: ["Synthetic fixture. Scheduled, not traffic-aware."],
};

export const transitManifestJson = JSON.stringify(manifest);

export const transitPointerJson = JSON.stringify({
  version: 1,
  dataset: "nyc-transit",
  generation: GENERATION,
  manifestPath: `transit/nyc/${GENERATION}/manifest.json`,
  manifestSha256: sha256(transitManifestJson),
});

// ─── Phase-0 scale fixture generator ────────────────────────────────────────
//
// The three-station fixture above pins the smoke tests. The route benchmark
// needs an NYC-scale dataset beside it: ~500 subway stations and ~16.4 k bus
// stops so `trainSearch` and the transit phases measure at city scale rather
// than on a toy line. Deterministic on purpose — one seed, one byte stream, so
// the three `bench:route` passes all load the same graph and a before/after
// comparison cannot drift because a fixture rewrote itself.

/** Pinned by `app/lib/transit/__tests__/transitShardFixture.test.ts`. */
export interface TransitShardFixtureCounts {
  subwayStations: number;
  transferStations: number;
  /** `stations + transferStations` — the (station, line) state count `trainDijkstra` prices. */
  trainStates: number;
  busStops: number;
  busLines: number;
  busShards: number;
  corridorStops: number;
}

export const TRANSIT_SCALE_COUNTS: TransitShardFixtureCounts = {
  subwayStations: 506,
  transferStations: 132,
  trainStates: 506 + 132,
  busStops: 16_390,
  busLines: 819,
  busShards: 6,
  corridorStops: 12,
};

export interface TransitShardFixtureOptions {
  /** Default 506 (the scale count); `0` omits the subway shard. */
  subwayStations?: number;
  /** Default 16_390 (the scale count); `0` omits the bus shards. */
  busStops?: number;
  seed?: number;
}

/**
 * Everything the `stubNetwork` transit route serves, in the three-hop shape
 * `app/lib/transit/remoteTransit.ts` fetches — pointer → manifest → shards,
 * every hop's digest computed from the exact bytes served.
 */
export interface TransitShardFixtureArtifacts {
  pointer: string;
  manifest: string;
  /** Shard key (`subway.json`, `bus-a.json`) → JSON bytes. */
  shards: Map<string, string>;
}

/** mulberry32: tiny, deterministic, and good enough to shape a synthetic city. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALE_GENERATION = "nyc-2026-09-19-abcdef123456";
/** Degrees per metre near the bench grid (lat 40.754); local, not global. */
const DEG_PER_M_LAT = 1 / 110_900;
const DEG_PER_M_LNG = 1 / 84_400;

const haversineM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

interface SyntheticStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * One subway line (E) of `subwayStations` stops bridged through the bench grid,
 * plus a second line (1) over exactly `transferStations` of them, so the
 * published state count is `stations + transferStations`. Scatter stops never
 * matter: the generator's own test pins the geometry below.
 */
function buildSubwayShard(counts: TransitShardFixtureCounts, rnd: () => number): unknown {
  // The E chain steps ~130 m east per station and passes stop 253 within
  // ~50 m of TRANSIT_WAYPOINT_A, so the bench bbox selects it and the subway
  // candidates near both waypoints are all real chain neighbours.
  const anchor = 253; // I-A: closest E stop to the bench waypoint A
  const stepLatM = 130 * 0.22;
  const stepLngM = 130;
  const anchorLatM = 30; // east-of-A offset so no stop sits exactly on a waypoint
  const anchorLngM = 0;
  const stops: SyntheticStop[] = [];
  for (let i = 0; i < counts.subwayStations; i++) {
    const d = i - anchor;
    stops.push({
      id: `subway:${i}`,
      name: `Synthetic Subway ${i + 1}`,
      lat: 40.7518 + (anchorLatM + d * stepLatM) * DEG_PER_M_LAT,
      lon: -73.9871 + (anchorLngM + d * stepLngM) * DEG_PER_M_LNG,
    });
  }

  const mkEdge = (from: SyntheticStop, to: SyntheticStop, route: string, direction: number) => ({
    from: from.id,
    to: to.id,
    route,
    direction,
    medianSec: 40 + Math.round(rnd() * 80),
    trips: 100,
    distM: Math.round(haversineM(from, to)),
    structure: { underground: 1 },
  });

  const eEdges: unknown[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    eEdges.push(mkEdge(stops[i], stops[i + 1], "E", 0));
    eEdges.push(mkEdge(stops[i + 1], stops[i], "E", 1));
  }

  // Exactly `transferStations` E stops also serve line 1: the first seven
  // (indices 0-6) plus every fourth stop from 7 — 7 + 125 = 132, no overlap.
  const transferIds = new Set<number>([...Array.from({ length: 7 }, (_, i) => i)]);
  for (let i = 7; i < stops.length; i += 4) transferIds.add(i);
  const transferStops = stops.filter((_, i) => transferIds.has(i));
  const line1Edges: unknown[] = [];
  for (let i = 0; i + 1 < transferStops.length; i++) {
    line1Edges.push(mkEdge(transferStops[i], transferStops[i + 1], "1", 0));
    line1Edges.push(mkEdge(transferStops[i + 1], transferStops[i], "1", 1));
  }

  // The real subway shard ships agency transfer edges, and they are what make
  // a cross-line search non-degenerate: each non-transfer stop walks to the
  // nearest interchange and the search can hop between E and 1 anywhere. The
  // stage count stays exactly `stations + transferStations`.
  const transfers: unknown[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (transferIds.has(i)) continue;
    let best = transferStops[0];
    for (const candidate of transferStops) {
      if (Math.abs(i - stops.indexOf(candidate)) < Math.abs(i - stops.indexOf(best)))
        best = candidate;
    }
    const walkSec = Math.round(haversineM(stops[i], best) / 1.4);
    transfers.push({ from: `subway:${i}`, to: best.id, minSec: walkSec, kind: "gtfs" });
    transfers.push({ from: best.id, to: `subway:${i}`, minSec: walkSec, kind: "gtfs" });
  }

  const headwayRows = (medianSec: number) => [
    { route: "E", direction: 0, dayType: "weekday", hour: 9, medianSec, trips: 12, services: 1 },
    { route: "E", direction: 0, dayType: "sunday", hour: 9, medianSec, trips: 6, services: 1 },
    { route: "E", direction: 1, dayType: "sunday", hour: 9, medianSec, trips: 6, services: 1 },
    { route: "1", direction: 0, dayType: "sunday", hour: 9, medianSec, trips: 6, services: 1 },
    { route: "1", direction: 1, dayType: "sunday", hour: 9, medianSec, trips: 6, services: 1 },
  ];

  return {
    kind: "subway",
    feed: { id: "subway", version: "e2e", startDate: "20260101", endDate: "20270101" },
    stops: stops.map((stop) => ({ ...stop, entrances: [] })),
    edges: [...eEdges, ...line1Edges],
    routes: [
      {
        id: "E",
        shortName: "E",
        longName: "Synthetic E Line",
        type: 1,
        color: "0F52BA",
        textColor: "FFFFFF",
      },
      {
        id: "1",
        shortName: "1",
        longName: "Synthetic 1 Line",
        type: 1,
        color: "EE352E",
        textColor: "FFFFFF",
      },
    ],
    headways: headwayRows(360 + Math.round(rnd() * 240)),
    transfers,
  };
}

/**
 * Bus lines of 20 stops aside from two special cases: line B1 is the corridor
 * that bridges the bench waypoint pair (12 stops, ~86 m apart) — the bus
 * showcase's answer — and the last line absorbs the remainder. All other lines
 * live in a scatter region south of the bench grid, far enough that the bench's
 * nearest-five candidate scan always prefers the corridor.
 */
function buildBusShards(
  counts: TransitShardFixtureCounts,
  rnd: () => number,
): Map<string, unknown> {
  const LIN = 29; // lines per scatter row
  const STOPS_PER_LINE = 20;
  const ROWS = Math.ceil((counts.busLines - 1) / LIN);

  const scatterEast = -74.1;
  const scatterSouth = 40.7;
  // Rows march **south** from `scatterSouth`, away from the bench grid at
  // 40.7518: the nearest scatter stop stays > 5 km from either waypoint, so
  // the bench's nearest-five candidate scan always prefers the corridor.
  const INVERSE_M_LAT = 110_900;
  const rowStepM = Math.floor(((40.744 - scatterSouth) * INVERSE_M_LAT) / ROWS / 5) * 5; // metre/row
  let remaining = counts.busStops - counts.corridorStops;
  const lines: SyntheticStop[][] = [];

  // Corridor B1: 12 stops from ~110 m past A to ~110 m past B on the straight
  // chord, so entries and exits near both waypoints are neighbours on one line.
  const corridor: SyntheticStop[] = [];
  const corridorStart = { lat: 40.7518 - 150 * DEG_PER_M_LAT, lon: -73.9871 - 60 * DEG_PER_M_LNG };
  const corridorEnd = { lat: 40.7562 + 60 * DEG_PER_M_LAT, lon: -73.9809 + 80 * DEG_PER_M_LNG };
  for (let i = 0; i < counts.corridorStops; i++) {
    const t = counts.corridorStops === 1 ? 0 : i / (counts.corridorStops - 1);
    corridor.push({
      id: `bus:${i}`,
      name: `Synthetic Bus B1-${i + 1}`,
      lat: corridorStart.lat + (corridorEnd.lat - corridorStart.lat) * t,
      lon: corridorStart.lon + (corridorEnd.lon - corridorStart.lon) * t,
    });
  }
  lines.push(corridor);

  for (let line = 1; line < counts.busLines; line++) {
    // Last line absorbs the remainder, others take the nominal count.
    const take = line === counts.busLines - 1 ? remaining : Math.min(STOPS_PER_LINE, remaining);
    remaining -= take;
    const row = Math.floor((line - 1) / LIN);
    const col = (line - 1) % LIN;
    const rowLatM = -row * rowStepM;
    const stopsOfLine: SyntheticStop[] = [];
    for (let i = 0; i < take; i++) {
      stopsOfLine.push({
        id: `bus:${line * 100 + i}`,
        name: `Synthetic Bus ${line * 100 + i}`,
        lat: scatterSouth + rowLatM * DEG_PER_M_LAT + (i % 2 ? 4 : -4) * DEG_PER_M_LAT,
        lon: scatterEast + (i * 175 + col * 2) * DEG_PER_M_LNG,
      });
    }
    lines.push(stopsOfLine);
  }

  const lineColor = (i: number) => {
    if (i === 1) return TRANSIT_LINE_COLOR;
    return Math.floor(rnd() * 0xffffff)
      .toString(16)
      .padStart(6, "0");
  };

  // Even split over the shard count; shard keys a-f like the real build's.
  const shards = new Map<string, unknown>();
  const lineSlots = counts.busLines; // corridor + scatter lines
  const perShard = Math.ceil(lineSlots / counts.busShards);
  for (let shard = 0; shard < counts.busShards; shard++) {
    const slice = lines.slice(shard * perShard, (shard + 1) * perShard);
    if (slice.length === 0) continue;
    const stopsOfShard = slice.flat();
    const mkBusEdge = (
      from: SyntheticStop,
      to: SyntheticStop,
      route: string,
      direction: number,
    ) => ({
      from: from.id,
      to: to.id,
      route,
      direction,
      medianSec: 90 + Math.round(rnd() * 120),
      trips: 40,
      distM: Math.round(haversineM(from, to)),
      structure: { at_grade: 1 },
    });
    const edges: unknown[] = [];
    const routes: unknown[] = [];
    const headways: unknown[] = [];
    for (const [lineIdx, lineStops] of slice.entries()) {
      const routeId = `B${shard * perShard + lineIdx + 1}`;
      routes.push({
        id: routeId,
        shortName: routeId,
        longName: `Synthetic ${routeId} Line`,
        type: 3,
        color: lineColor(shard * perShard + lineIdx),
        textColor: "FFFFFF",
      });
      for (let i = 0; i + 1 < lineStops.length; i++) {
        edges.push(mkBusEdge(lineStops[i], lineStops[i + 1], routeId, 0));
        edges.push(mkBusEdge(lineStops[i + 1], lineStops[i], routeId, 1));
      }
      const medianSec = 240 + Math.round(rnd() * 480);
      for (const dayType of ["weekday", "sunday"]) {
        for (const direction of [0, 1]) {
          headways.push({
            route: routeId,
            direction,
            dayType,
            hour: 9,
            medianSec,
            trips: Math.max(2, Math.round(3600 / medianSec)),
            services: 1,
          });
        }
      }
    }
    shards.set(`bus-${String.fromCharCode(97 + shard)}.json`, {
      kind: "bus-shard",
      feed: { id: "bus", version: "e2e", startDate: "20260101", endDate: "20270101" },
      stops: stopsOfShard.map((stop) => ({ ...stop, entrances: [] })),
      edges,
      routes,
      headways,
      transfers: [],
    });
  }
  return shards;
}

/**
 * Builds a deterministic pointer → manifest → shard fixture in the published
 * contract shape, with every digest computed from the exact bytes served.
 * Sizes default to the pinned NYC-scale counts; pass `0` to omit a mode.
 */
export function buildTransitShardFixture(
  options: TransitShardFixtureOptions = {},
): TransitShardFixtureArtifacts {
  const {
    subwayStations = TRANSIT_SCALE_COUNTS.subwayStations,
    busStops = TRANSIT_SCALE_COUNTS.busStops,
    seed = 445,
  } = options;

  if (subwayStations !== 0 && subwayStations !== TRANSIT_SCALE_COUNTS.subwayStations)
    throw new Error(
      `subwayStations must be 0 or ${TRANSIT_SCALE_COUNTS.subwayStations} (got ${subwayStations})`,
    );
  if (busStops !== 0 && busStops !== TRANSIT_SCALE_COUNTS.busStops)
    throw new Error(`busStops must be 0 or ${TRANSIT_SCALE_COUNTS.busStops} (got ${busStops})`);

  const counts: TransitShardFixtureCounts = {
    ...TRANSIT_SCALE_COUNTS,
    subwayStations,
    transferStations: subwayStations === 0 ? 0 : TRANSIT_SCALE_COUNTS.transferStations,
    trainStates: subwayStations === 0 ? 0 : TRANSIT_SCALE_COUNTS.trainStates,
    busStops,
    busLines: busStops === 0 ? 0 : TRANSIT_SCALE_COUNTS.busLines,
  };
  const rnd = seededRandom(seed);

  const shards = new Map<string, unknown>();
  if (subwayStations > 0) shards.set("subway.json", buildSubwayShard(counts, rnd));
  if (busStops > 0) for (const [key, shard] of buildBusShards(counts, rnd)) shards.set(key, shard);
  if (shards.size === 0) throw new Error("a transit fixture needs at least one mode");

  const boundsOf = (stops: { lat: number; lon: number }[]) =>
    stops.reduce(
      (box, stop) => ({
        south: Math.min(box.south, stop.lat),
        west: Math.min(box.west, stop.lon),
        north: Math.max(box.north, stop.lat),
        east: Math.max(box.east, stop.lon),
      }),
      {
        south: Number.POSITIVE_INFINITY,
        west: Number.POSITIVE_INFINITY,
        north: Number.NEGATIVE_INFINITY,
        east: Number.NEGATIVE_INFINITY,
      },
    );

  const manifestShards: {
    key: string;
    bytes: number;
    sha256: string;
    stops: number;
    edges: number;
    routes: number;
    bounds: { south: number; west: number; north: number; east: number };
  }[] = [];
  for (const [key, shard] of shards) {
    const body = JSON.stringify(shard);
    const stops = (shard as { stops: unknown[] }).stops;
    manifestShards.push({
      key,
      bytes: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
      stops: stops.length,
      edges: (shard as { edges: unknown[] }).edges.length,
      routes: (shard as { routes: unknown[] }).routes.length,
      bounds: boundsOf(stops as { lat: number; lon: number }[]),
    });
  }

  const headwayBlock = (_feedId: string) => ({
    weekday: {
      date: "20260619",
      nextDate: "20260620",
      nextDayType: "weekday",
      matchingDates: 1,
      candidateDates: 1,
    },
    sunday: {
      date: "20260621",
      nextDate: "20260622",
      nextDayType: "weekday",
      matchingDates: 1,
      candidateDates: 1,
    },
  });

  const feeds = [];
  const schedulesAsOf: Record<string, unknown> = {};
  const headwayDates: Record<string, unknown> = { referenceDate: "20260621" };
  if (subwayStations > 0) {
    feeds.push({
      id: "subway",
      version: "e2e",
      startDate: "20260101",
      endDate: "20270101",
      sha256: "0".repeat(64),
    });
    schedulesAsOf.subway = { version: "e2e", startDate: "20260101", endDate: "20270101" };
    headwayDates.subway = headwayBlock("subway");
  }
  if (busStops > 0) {
    feeds.push({
      id: "bus",
      version: "e2e",
      startDate: "20260101",
      endDate: "20270101",
      sha256: "0".repeat(64),
    });
    schedulesAsOf.bus = { version: "e2e", startDate: "20260101", endDate: "20270101" };
    headwayDates.bus = headwayBlock("bus");
  }

  const manifest = {
    generation: SCALE_GENERATION,
    createdAt: "2026-09-19T00:00:00.000Z",
    schedulesAsOf,
    headwayDates,
    feeds,
    shards: manifestShards,
    budgets: { shardBytes: 3_000_000, totalBytes: 40_000_000 },
    constants: { spatialWalkMps: 1.4 },
    notes: [
      "Synthetic scale fixture for the latency-attribution experiments. Deterministic; not a published NYC generation.",
    ],
  };

  const manifestBody = JSON.stringify(manifest);
  const pointer = JSON.stringify({
    version: 1,
    dataset: "nyc-transit",
    generation: SCALE_GENERATION,
    manifestPath: `transit/nyc/${SCALE_GENERATION}/manifest.json`,
    manifestSha256: sha256(manifestBody),
  });

  return {
    pointer,
    manifest: manifestBody,
    shards: new Map([...shards].map(([key, shard]) => [key, JSON.stringify(shard)])),
  };
}

/** Which dataset the benchmark's transit stub serves. */
export type TransitFixtureKind = "fixture" | "scale" | "scale-bus-only";

/** The three-hop artifacts for a fixture kind, ready for `stubNetwork` to serve. */
export function transitFixtureArtifacts(kind: TransitFixtureKind): TransitShardFixtureArtifacts {
  if (kind === "fixture") {
    return {
      pointer: transitPointerJson,
      manifest: transitManifestJson,
      shards: new Map([["subway.json", transitShardJson]]),
    };
  }
  if (kind === "scale") return buildTransitShardFixture({});
  return buildTransitShardFixture({ subwayStations: 0, busStops: TRANSIT_SCALE_COUNTS.busStops });
}

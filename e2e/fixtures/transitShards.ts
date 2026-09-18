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
    { route: "E", direction: 0, dayType: "weekday", hour: 9, medianSec: 300, trips: 12, services: 1 },
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

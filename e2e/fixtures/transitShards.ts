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

const stops = [
  { id: "subway:E1", name: "Grid South", lat: 40.7519, lon: -73.987, changeSec: 180 },
  { id: "subway:E2", name: "Grid Middle", lat: 40.754, lon: -73.984, changeSec: 0 },
  { id: "subway:E3", name: "Grid North", lat: 40.7561, lon: -73.9811 },
];

const edge = (from: string, to: string, direction: number) => ({
  from,
  to,
  route: "E",
  direction,
  medianSec: 90,
  trips: 100,
  distM: 400,
});

const shard = {
  kind: "subway",
  feed: { id: "subway", version: "e2e", startDate: "20260101", endDate: "20270101" },
  stops,
  edges: [
    edge("subway:E1", "subway:E2", 0),
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
  headways: [
    { route: "E", direction: 0, dayType: "weekday", hour: 9, medianSec: 300, trips: 12, services: 1 },
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

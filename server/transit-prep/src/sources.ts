/**
 * Pinned GTFS Static sources. Step 1 (acquire) downloads these; every later
 * step reads only the local copies plus raw/source-receipts.json.
 *
 * Canonical catalog page: https://data.ny.gov/Transportation/MTA-General-Transit-Feed-Specification-GTFS-Static/fgm6-ccue
 * The web.mta.info URLs 301-redirect to the S3 hosts pinned here; pinning the
 * final HTTPS hosts avoids an HTTP downgrade in the download path.
 */

export type FeedId =
  | "subway"
  | "bus-bx"
  | "bus-b"
  | "bus-m"
  | "bus-q"
  | "bus-si"
  | "bus-busco";

export interface FeedSource {
  id: FeedId;
  /** Working directory name under TRANSIT_PREP_ROOT (adopts the existing layout). */
  workDir: string;
  /** R2 shard key suffix produced by build. */
  shard: string;
  kind: "subway" | "bus";
  canonicalPage: string;
  downloadUrl: string;
  /** Files that must exist after unzip. transfers.txt is subway-only. */
  requiredFiles: string[];
}

const BUS_REQUIRED = [
  "agency.txt",
  "calendar.txt",
  "calendar_dates.txt",
  "feed_info.txt",
  "routes.txt",
  "shapes.txt",
  "stop_times.txt",
  "stops.txt",
  "trips.txt",
];

export const FEED_SOURCES: FeedSource[] = [
  {
    id: "subway",
    workDir: "gtfs_subway",
    shard: "subway.json",
    kind: "subway",
    canonicalPage: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip",
    requiredFiles: [...BUS_REQUIRED, "transfers.txt"],
  },
  {
    id: "bus-bx",
    workDir: "gtfs_bx",
    shard: "bus-bx.json",
    kind: "bus",
    canonicalPage: "http://web.mta.info/developers/data/nyct/bus/google_transit_bronx.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip",
    requiredFiles: BUS_REQUIRED,
  },
  {
    id: "bus-b",
    workDir: "gtfs_b",
    shard: "bus-b.json",
    kind: "bus",
    canonicalPage: "http://web.mta.info/developers/data/nyct/bus/google_transit_brooklyn.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_b.zip",
    requiredFiles: BUS_REQUIRED,
  },
  {
    id: "bus-m",
    workDir: "gtfs_m",
    shard: "bus-m.json",
    kind: "bus",
    canonicalPage: "http://web.mta.info/developers/data/nyct/bus/google_transit_manhattan.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip",
    requiredFiles: BUS_REQUIRED,
  },
  {
    id: "bus-q",
    workDir: "gtfs_q",
    shard: "bus-q.json",
    kind: "bus",
    canonicalPage: "http://web.mta.info/developers/data/nyct/bus/google_transit_queens.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip",
    requiredFiles: BUS_REQUIRED,
  },
  {
    id: "bus-si",
    workDir: "gtfs_si",
    shard: "bus-si.json",
    kind: "bus",
    canonicalPage:
      "http://web.mta.info/developers/data/nyct/bus/google_transit_staten_island.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_si.zip",
    requiredFiles: BUS_REQUIRED,
  },
  {
    id: "bus-busco",
    workDir: "gtfs_busco",
    shard: "bus-busco.json",
    kind: "bus",
    canonicalPage: "http://web.mta.info/developers/data/busco/google_transit.zip",
    downloadUrl: "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip",
    requiredFiles: BUS_REQUIRED,
  },
];

/** Deliberately out of scope (commuter rail, not pedestrian shade routing). */
export const OUT_OF_SCOPE_FEEDS = [
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip",
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip",
];

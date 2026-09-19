import type { NavigationSourceReceipt } from "../../../app/lib/navigationData/shardContract";

/**
 * Pinned navigation sources. `acquire` downloads exactly these; every later
 * step reads only the local copies plus `raw/source-receipts.json`.
 *
 * - Streets: the dated Geofabrik New York State extract. The `-latest` symlink
 *   resolves to a dated file; the producer pins the dated URL it resolved on
 *   the acquisition plan date, so a rebuild keeps the same bytes.
 * - Buildings: the maintained NYC Building Footprints feature service
 *   (metadata: https://github.com/CityOfNewYork/nyc-geo-metadata — released
 *   weekly, DOITT_ID is the consistent key). The producer downloads the whole
 *   layer as ordered pages and verifies the count matches `returnCountOnly`.
 */

export type SourceKind = "osm-pbf" | "nyc-building-footprints";

export interface NavigationSourcePlan {
  id: string;
  kind: SourceKind;
  url: string;
  license: string;
  destination: string;
  canonicalPage: string;
}

export const NYC_BUILDINGS_DATASET_ID = "870bf69e8a8044aea4488e564c0b4010";
export const NYC_BUILDINGS_LAYER_URL =
  "https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/BUILDING_view/FeatureServer/0";
export const NYC_BUILDINGS_EXPORT_URL = `https://hub.arcgis.com/api/download/v1/items/${NYC_BUILDINGS_DATASET_ID}/geojson?layers=0`;

/** At most this many features per page request (server maximum is 2000). */
export const BUILDINGS_PAGE_SIZE = 2000;

export const OSM_NY_LATEST_URL =
  "https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf";

export const NAVIGATION_SOURCE_PLAN: NavigationSourcePlan[] = [
  {
    id: "osm-new-york",
    kind: "osm-pbf",
    url: "https://download.geofabrik.de/north-america/us/new-york-260918.osm.pbf",
    license: "OpenStreetMap contributors, ODbL",
    destination: "raw/new-york-260918.osm.pbf",
    canonicalPage: "https://download.geofabrik.de/north-america/us/new-york.html",
  },
  {
    id: "nyc-building-footprints",
    kind: "nyc-building-footprints",
    url: NYC_BUILDINGS_LAYER_URL,
    license: "NYC Open Data terms of use",
    destination: "raw/buildings-pages/",
    canonicalPage:
      "https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md",
  },
];

export function navigationAcquisitionPlan(root = "<NAVIGATION_PREP_ROOT>") {
  return {
    root,
    rawOutsideGit: true,
    sources: NAVIGATION_SOURCE_PLAN.map((source) => ({
      ...source,
      path: `${root}/${source.destination}`,
    })),
  };
}

/** A receipt binds URL, release timestamp, byte count, and SHA-256. */
export function isSourceReceipt(value: unknown): value is NavigationSourceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.id === "string" &&
    typeof receipt.release === "string" &&
    typeof receipt.url === "string" &&
    /^https?:\/\//.test(receipt.url) &&
    typeof receipt.timestamp === "string" &&
    receipt.timestamp.length > 0 &&
    typeof receipt.bytes === "number" &&
    Number.isInteger(receipt.bytes) &&
    receipt.bytes > 0 &&
    typeof receipt.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.sha256)
  );
}

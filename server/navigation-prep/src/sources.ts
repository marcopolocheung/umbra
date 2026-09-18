import type { NavigationSourceReceipt } from "../../../app/lib/navigationData/shardContract";

export interface NavigationSourcePlan {
  id: string;
  kind: "osm-pbf" | "nyc-building-footprints";
  url: string;
  license: string;
  destination: string;
}

/**
 * The real inputs are deliberately plan-only in session 1. A later acquisition
 * command will materialize these outside git and attach byte/date/hash receipts.
 */
export const NAVIGATION_SOURCE_PLAN: NavigationSourcePlan[] = [
  {
    id: "osm-new-york",
    kind: "osm-pbf",
    url: "https://download.geofabrik.de/north-america/us/new-york.html",
    license: "OpenStreetMap contributors, ODbL",
    destination: "raw/osm/new-york-latest.osm.pbf",
  },
  {
    id: "nyc-building-footprints",
    kind: "nyc-building-footprints",
    url: "https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md",
    license: "NYC Open Data terms of use",
    destination: "raw/buildings/nyc-building-footprints-release.geojson",
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

export function isSourceReceipt(value: unknown): value is NavigationSourceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.id === "string" &&
    typeof receipt.release === "string" &&
    typeof receipt.url === "string" &&
    /^https?:\/\//.test(receipt.url) &&
    typeof receipt.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(receipt.sha256)
  );
}
